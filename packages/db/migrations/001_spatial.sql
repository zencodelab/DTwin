-- =============================================================================
-- 001_spatial.sql — extensions, enums, spatial hierarchy and asset registry
--
-- COORDINATE SYSTEMS (read this before touching any geometry column):
--   buildings.location  GEOGRAPHY(Point, 4326)  — real WGS84 lat/long. Used for
--                       weather lookup and map placement. ONE row, ONE point.
--   everything else     GEOMETRY(..., 0)        — a LOCAL SITE CRS IN METRES.
--                       Origin is the building datum corner, axes aligned to the
--                       GLTF scene graph, +Z up. This is what makes ST_Contains()
--                       work directly against Three.js world coordinates and
--                       ST_Area() return honest square metres.
--   Do not "fix" the local geometry to 4326. Degrees are not metres: area and
--   containment maths silently go wrong and the geometry stops lining up with
--   the 3D model.
--
-- UNITS: every numeric column carries its unit as a suffix (_c, _kw, _kwh, _m2,
-- _ppm, _pa, _cmh). Unit confusion is the largest bug source in building
-- analytics; the naming convention is the guard rail.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

CREATE TYPE zone_type AS ENUM (
  'office', 'meeting', 'corridor', 'server_room', 'lobby',
  'plant_room', 'retail', 'restroom', 'stairwell', 'parking'
);

CREATE TYPE equipment_type AS ENUM (
  'ahu', 'vav', 'fcu', 'chiller', 'boiler', 'pump', 'cooling_tower',
  'electric_meter', 'water_meter', 'btu_meter',
  'lighting_circuit', 'ev_charger'
);

CREATE TYPE equipment_status AS ENUM (
  'operational', 'degraded', 'fault', 'offline', 'maintenance'
);

CREATE TYPE metric_type AS ENUM (
  'temperature_c', 'humidity_pct', 'co2_ppm',
  'power_kw', 'energy_kwh',
  'occupancy_count', 'pressure_pa', 'airflow_cmh',
  'valve_position_pct', 'damper_position_pct', 'setpoint_temp_c',
  'water_m3', 'illuminance_lux'
);

CREATE TYPE maintenance_type AS ENUM (
  'preventive', 'corrective', 'inspection', 'calibration', 'replacement'
);

CREATE TYPE day_type AS ENUM ('weekday', 'saturday', 'sunday', 'holiday');

-- -----------------------------------------------------------------------------
-- Zone characteristics — construction and usage profiles.
--
-- These live here rather than with the simulation tables because they describe
-- the SPACE, not a simulation run: zones reference them, and the physics engine
-- is one consumer among several (setpoint checks, ventilation compliance).
-- -----------------------------------------------------------------------------

CREATE TABLE thermal_profiles (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        TEXT NOT NULL UNIQUE,
  description                 TEXT,

  -- Envelope
  u_value_wall_w_m2k          DOUBLE PRECISION NOT NULL CHECK (u_value_wall_w_m2k   > 0),
  u_value_window_w_m2k        DOUBLE PRECISION NOT NULL CHECK (u_value_window_w_m2k > 0),
  u_value_roof_w_m2k          DOUBLE PRECISION          CHECK (u_value_roof_w_m2k   > 0),
  window_to_wall_ratio        DOUBLE PRECISION NOT NULL CHECK (window_to_wall_ratio BETWEEN 0 AND 1),
  shgc                        DOUBLE PRECISION NOT NULL DEFAULT 0.4
                                CHECK (shgc BETWEEN 0 AND 1),  -- solar heat gain coefficient
  infiltration_ach            DOUBLE PRECISION NOT NULL CHECK (infiltration_ach >= 0),
  thermal_mass_kj_per_k       DOUBLE PRECISION NOT NULL CHECK (thermal_mass_kj_per_k > 0),

  -- Internal gains
  lighting_power_density_w_m2 DOUBLE PRECISION NOT NULL CHECK (lighting_power_density_w_m2  >= 0),
  equipment_power_density_w_m2 DOUBLE PRECISION NOT NULL CHECK (equipment_power_density_w_m2 >= 0),
  occupancy_heat_gain_w_person DOUBLE PRECISION NOT NULL DEFAULT 120
                                CHECK (occupancy_heat_gain_w_person >= 0),

  -- Control and plant
  setpoint_temp_c             DOUBLE PRECISION NOT NULL CHECK (setpoint_temp_c BETWEEN 10 AND 35),
  deadband_k                  DOUBLE PRECISION NOT NULL DEFAULT 1.0 CHECK (deadband_k >= 0),
  ventilation_l_s_person      DOUBLE PRECISION NOT NULL DEFAULT 10 CHECK (ventilation_l_s_person >= 0),
  hvac_cop                    DOUBLE PRECISION NOT NULL CHECK (hvac_cop > 0),

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE thermal_profiles IS
  'Reusable construction/plant characteristics, typically one per zone archetype.';

CREATE TABLE occupancy_schedules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (schedule, day type) holding 24 hourly occupancy fractions.
-- Stored as a real array, not jsonb: it is fixed-width numeric data that the
-- simulator indexes by hour, and an array keeps that a cheap subscript.
CREATE TABLE occupancy_schedule_days (
  schedule_id       UUID NOT NULL REFERENCES occupancy_schedules(id) ON DELETE CASCADE,
  day_type          day_type NOT NULL,
  hourly_fractions  DOUBLE PRECISION[] NOT NULL
                      CHECK (array_length(hourly_fractions, 1) = 24),
  PRIMARY KEY (schedule_id, day_type)
);

-- -----------------------------------------------------------------------------
-- Building -> Floor -> Zone
-- -----------------------------------------------------------------------------

CREATE TABLE buildings (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    TEXT NOT NULL,
  address                 TEXT,
  timezone                TEXT NOT NULL DEFAULT 'UTC',
  -- WGS84. The only geography column in the schema.
  location                GEOGRAPHY(Point, 4326),
  gross_floor_area_m2     DOUBLE PRECISION CHECK (gross_floor_area_m2 > 0),
  year_built              INTEGER CHECK (year_built BETWEEN 1800 AND 2200),
  -- Grid emission factor for carbon output; UAE grid is roughly 0.40-0.45.
  grid_carbon_kg_per_kwh  DOUBLE PRECISION NOT NULL DEFAULT 0.42
                            CHECK (grid_carbon_kg_per_kwh >= 0),
  gltf_asset_path         TEXT,
  metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE floors (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id     UUID NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  -- Signed: basements are negative, ground is 0.
  level           INTEGER NOT NULL,
  name            TEXT NOT NULL,
  elevation_m     DOUBLE PRECISION NOT NULL,
  floor_height_m  DOUBLE PRECISION CHECK (floor_height_m > 0),
  floor_area_m2   DOUBLE PRECISION CHECK (floor_area_m2 > 0),
  footprint       GEOMETRY(PolygonZ, 0),   -- local metres
  gltf_node_id    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (building_id, level)
);

CREATE TABLE zones (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  floor_id              UUID NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  zone_type             zone_type NOT NULL,
  area_m2               DOUBLE PRECISION CHECK (area_m2 > 0),
  volume_m3             DOUBLE PRECISION CHECK (volume_m3 > 0),
  design_occupancy      INTEGER CHECK (design_occupancy >= 0),
  exterior_wall_area_m2 DOUBLE PRECISION CHECK (exterior_wall_area_m2 >= 0),
  boundary              GEOMETRY(PolygonZ, 0),   -- local metres
  gltf_node_id          TEXT,
  thermal_profile_id    UUID REFERENCES thermal_profiles(id) ON DELETE SET NULL,
  occupancy_schedule_id UUID REFERENCES occupancy_schedules(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (floor_id, name)
);

-- -----------------------------------------------------------------------------
-- Equipment
-- -----------------------------------------------------------------------------

CREATE TABLE equipment (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Always anchored to a building. floor_id/zone_id are the PHYSICAL location
  -- and are nullable because plant (chillers, main meters) serves the whole
  -- site. What the asset SERVES is equipment_zone_service, not this column.
  building_id           UUID NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  floor_id              UUID REFERENCES floors(id) ON DELETE SET NULL,
  zone_id               UUID REFERENCES zones(id)  ON DELETE SET NULL,
  -- Serving tree: chiller -> AHU -> VAV. Drives fault-impact propagation.
  parent_equipment_id   UUID REFERENCES equipment(id) ON DELETE SET NULL,

  tag                   TEXT NOT NULL,          -- e.g. 'AHU-03', the FM-facing name
  equipment_type        equipment_type NOT NULL,
  manufacturer          TEXT,
  model                 TEXT,
  serial_number         TEXT,
  install_date          DATE,
  rated_power_kw        DOUBLE PRECISION CHECK (rated_power_kw >= 0),
  rated_airflow_cmh     DOUBLE PRECISION CHECK (rated_airflow_cmh >= 0),
  status                equipment_status NOT NULL DEFAULT 'operational',
  position              GEOMETRY(PointZ, 0),    -- local metres, for 3D placement
  gltf_node_id          TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (building_id, tag),
  CHECK (parent_equipment_id IS NULL OR parent_equipment_id <> id)
);

CREATE TYPE service_role AS ENUM ('primary', 'secondary', 'backup', 'metered_by');

-- An AHU serves many zones; a VAV serves one. A single FK on equipment cannot
-- express that, which is why the air/water side mapping is its own table.
CREATE TABLE equipment_zone_service (
  equipment_id  UUID NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  zone_id       UUID NOT NULL REFERENCES zones(id)     ON DELETE CASCADE,
  role          service_role NOT NULL DEFAULT 'primary',
  -- Fraction of the zone's load this asset carries; lets a zone be split
  -- between two units without double-counting energy.
  load_fraction DOUBLE PRECISION NOT NULL DEFAULT 1.0
                  CHECK (load_fraction > 0 AND load_fraction <= 1),
  PRIMARY KEY (equipment_id, zone_id)
);

-- -----------------------------------------------------------------------------
-- Sensors (points/channels)
--
-- A sensor row is the durable CHANNEL — its device tag, what it measures, its
-- plausible range and what it is attached to. Readings in `telemetry` reference
-- it by id. Keeping the channel separate from its readings is what lets a point
-- be recalibrated, re-pointed or decommissioned without rewriting history.
-- -----------------------------------------------------------------------------

CREATE TABLE sensors (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Device-side identity: BACnet object id, Modbus register tag, gateway topic.
  external_id       TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  metric            metric_type NOT NULL,
  unit              TEXT NOT NULL,

  equipment_id      UUID REFERENCES equipment(id) ON DELETE CASCADE,
  zone_id           UUID REFERENCES zones(id)     ON DELETE CASCADE,

  -- Readings outside this band are flagged as bad quality rather than stored as
  -- truth — a disconnected thermistor reading -273 must not skew an average.
  min_plausible     DOUBLE PRECISION,
  max_plausible     DOUBLE PRECISION,
  -- Cumulative counters (energy_kwh, water_m3) need delta/counter_agg on read,
  -- never a plain avg. See 002_timeseries.sql.
  is_cumulative     BOOLEAN NOT NULL DEFAULT FALSE,
  sample_interval_s INTEGER NOT NULL DEFAULT 60 CHECK (sample_interval_s > 0),
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A point must hang off something we can locate in the twin.
  CHECK (equipment_id IS NOT NULL OR zone_id IS NOT NULL),
  CHECK (min_plausible IS NULL OR max_plausible IS NULL OR min_plausible < max_plausible)
);

-- -----------------------------------------------------------------------------
-- Maintenance
-- -----------------------------------------------------------------------------

CREATE TABLE maintenance_logs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id     UUID NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  performed_at     TIMESTAMPTZ NOT NULL,
  log_type         maintenance_type NOT NULL,
  technician       TEXT,
  notes            TEXT,
  cost             NUMERIC(12, 2) CHECK (cost >= 0),
  downtime_minutes INTEGER CHECK (downtime_minutes >= 0),
  next_due_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX floors_building_idx        ON floors (building_id);
CREATE INDEX zones_floor_idx            ON zones (floor_id);
CREATE INDEX zones_thermal_profile_idx  ON zones (thermal_profile_id);
CREATE INDEX equipment_building_idx     ON equipment (building_id);
CREATE INDEX equipment_floor_idx        ON equipment (floor_id);
CREATE INDEX equipment_zone_idx         ON equipment (zone_id);
CREATE INDEX equipment_parent_idx       ON equipment (parent_equipment_id);
CREATE INDEX equipment_type_idx         ON equipment (equipment_type);
CREATE INDEX eqzone_zone_idx            ON equipment_zone_service (zone_id);
CREATE INDEX sensors_equipment_idx      ON sensors (equipment_id);
CREATE INDEX sensors_zone_idx           ON sensors (zone_id);
CREATE INDEX sensors_metric_idx         ON sensors (metric);
-- The ingest hot path only ever resolves live points.
CREATE INDEX sensors_active_idx         ON sensors (id) WHERE is_active;
CREATE INDEX maintenance_equipment_idx  ON maintenance_logs (equipment_id, performed_at DESC);
CREATE INDEX maintenance_due_idx        ON maintenance_logs (next_due_at) WHERE next_due_at IS NOT NULL;

-- Spatial indexes — every geometry column gets one.
CREATE INDEX buildings_location_gix ON buildings USING GIST (location);
CREATE INDEX floors_footprint_gix   ON floors    USING GIST (footprint);
CREATE INDEX zones_boundary_gix     ON zones     USING GIST (boundary);
CREATE INDEX equipment_position_gix ON equipment USING GIST (position);

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'thermal_profiles', 'buildings', 'floors', 'zones', 'equipment', 'sensors'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
