-- @no-transaction
-- =============================================================================
-- 004_simulation.sql — energy/thermal simulation runs and results
--
-- Zone characteristics (thermal_profiles, occupancy_schedules) live in
-- 001_spatial.sql, not here: they describe the SPACE and are referenced by
-- `zones`. The simulation engine is one consumer among several.
--
-- Marked @no-transaction for create_hypertable on simulation_results.
-- =============================================================================

CREATE TYPE simulation_status AS ENUM (
  'queued', 'running', 'completed', 'failed', 'cancelled'
);

CREATE TABLE simulation_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id   UUID NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  scenario_name TEXT NOT NULL,
  description   TEXT,

  -- Simulated period and resolution.
  period_start  TIMESTAMPTZ NOT NULL,
  period_end    TIMESTAMPTZ NOT NULL,
  interval_s    INTEGER NOT NULL DEFAULT 3600 CHECK (interval_s > 0),

  -- Scenario overrides applied on top of each zone's stored profile, e.g.
  -- {"setpoint_delta_k": 2, "lighting_scale": 0.8, "weather": "tmy"}.
  -- Free-form because scenario knobs change faster than a schema should.
  params        JSONB NOT NULL DEFAULT '{}'::jsonb,

  status        simulation_status NOT NULL DEFAULT 'queued',
  progress_pct  DOUBLE PRECISION NOT NULL DEFAULT 0
                  CHECK (progress_pct BETWEEN 0 AND 100),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  error         TEXT,

  CHECK (period_end > period_start),
  CHECK ((status = 'failed') = (error IS NOT NULL))
);

-- -----------------------------------------------------------------------------
-- Results — one row per (run, zone, interval).
--
-- A hypertable because a year-long hourly run over 24 zones is ~210k rows and a
-- scenario sweep multiplies that; chunking on interval_start keeps range reads
-- and whole-run deletes cheap.
--
-- Energy is stored DISAGGREGATED (hvac / lighting / plug) rather than as a
-- single total. The total is trivially recoverable, but the split is not, and
-- the split is the entire point of the analysis — a facility manager needs to
-- know which end use to attack.
-- -----------------------------------------------------------------------------

CREATE TABLE simulation_results (
  run_id          UUID NOT NULL REFERENCES simulation_runs(id) ON DELETE CASCADE,
  zone_id         UUID NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  interval_start  TIMESTAMPTZ NOT NULL,

  -- End-use breakdown
  hvac_load_kwh   DOUBLE PRECISION NOT NULL CHECK (hvac_load_kwh >= 0),
  lighting_kwh    DOUBLE PRECISION NOT NULL CHECK (lighting_kwh  >= 0),
  plug_kwh        DOUBLE PRECISION NOT NULL CHECK (plug_kwh      >= 0),
  total_kwh       DOUBLE PRECISION NOT NULL CHECK (total_kwh     >= 0),

  -- Outcomes
  co2_kg          DOUBLE PRECISION NOT NULL CHECK (co2_kg >= 0),
  peak_demand_kw  DOUBLE PRECISION CHECK (peak_demand_kw >= 0),
  indoor_temp_c   DOUBLE PRECISION,
  -- Sensible heat balance terms, kWh per interval. Negative = heat loss.
  -- Kept because "why is this zone expensive?" is unanswerable from kWh alone.
  solar_gain_kwh      DOUBLE PRECISION,
  internal_gain_kwh   DOUBLE PRECISION,
  envelope_loss_kwh   DOUBLE PRECISION,
  ventilation_loss_kwh DOUBLE PRECISION,
  occupancy_count DOUBLE PRECISION CHECK (occupancy_count >= 0),
  unmet_hours     DOUBLE PRECISION CHECK (unmet_hours >= 0)
);

SELECT create_hypertable('simulation_results', by_range('interval_start', INTERVAL '30 days'));

CREATE UNIQUE INDEX simulation_results_uidx
  ON simulation_results (run_id, zone_id, interval_start DESC);
CREATE INDEX simulation_results_zone_idx ON simulation_results (zone_id, interval_start DESC);

CREATE INDEX simulation_runs_building_idx ON simulation_runs (building_id, requested_at DESC);
CREATE INDEX simulation_runs_status_idx   ON simulation_runs (status)
  WHERE status IN ('queued', 'running');
