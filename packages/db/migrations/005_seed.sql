-- =============================================================================
-- 005_seed.sql — one synthetic building
--
-- 4 floors x 6 zones, 40 equipment items, ~190 sensors, profiles, schedules and
-- a starter rule set. Enough to exercise every join, the 3D picking path and the
-- simulator before any real GLTF or BMS data exists.
--
-- Geometry is a 40m x 30m footprint tiled 3x2 per floor, in the local metre CRS
-- with floor elevation as Z — the same frame the Three.js scene will use.
-- =============================================================================

DO $seed$
DECLARE
  v_building   UUID;
  v_floor      UUID;
  v_zone       UUID;
  v_ahu        UUID;
  v_vav        UUID;
  v_chiller    UUID;
  v_ct         UUID;

  v_sched_office UUID;
  v_sched_always UUID;
  v_sched_lobby  UUID;

  v_tp_office UUID;
  v_tp_meeting UUID;
  v_tp_circ   UUID;
  v_tp_server UUID;
  v_tp_lobby  UUID;

  f INT; z INT; i INT;
  v_elev  DOUBLE PRECISION;
  v_x0 DOUBLE PRECISION; v_y0 DOUBLE PRECISION;
  v_x1 DOUBLE PRECISION; v_y1 DOUBLE PRECISION;
  v_ztype zone_type;
  v_tp    UUID;
  v_sched UUID;
  v_zname TEXT;
  v_floor_name TEXT;

  BUILDING_W CONSTANT DOUBLE PRECISION := 40.0;
  BUILDING_D CONSTANT DOUBLE PRECISION := 30.0;
  FLOOR_H    CONSTANT DOUBLE PRECISION := 4.0;
  CEIL_H     CONSTANT DOUBLE PRECISION := 3.0;
BEGIN

  -- ---------------------------------------------------------------- schedules
  INSERT INTO occupancy_schedules (name, description)
    VALUES ('office_standard', 'Sun-Thu working week, 08:00-18:00 ramp')
    RETURNING id INTO v_sched_office;
  INSERT INTO occupancy_schedules (name, description)
    VALUES ('always_on', 'Continuous — server rooms and plant')
    RETURNING id INTO v_sched_always;
  INSERT INTO occupancy_schedules (name, description)
    VALUES ('lobby_extended', 'Reception hours, 07:00-21:00')
    RETURNING id INTO v_sched_lobby;

  INSERT INTO occupancy_schedule_days (schedule_id, day_type, hourly_fractions) VALUES
    (v_sched_office, 'weekday', ARRAY[0,0,0,0,0,0,0.1,0.3,0.7,0.9,1.0,1.0,0.7,0.9,1.0,1.0,0.9,0.6,0.2,0.05,0,0,0,0]::DOUBLE PRECISION[]),
    (v_sched_office, 'saturday', ARRAY[0,0,0,0,0,0,0,0.05,0.15,0.2,0.2,0.15,0.1,0.1,0.1,0.05,0,0,0,0,0,0,0,0]::DOUBLE PRECISION[]),
    (v_sched_office, 'sunday',   ARRAY[0,0,0,0,0,0,0.1,0.3,0.7,0.9,1.0,1.0,0.7,0.9,1.0,1.0,0.9,0.6,0.2,0.05,0,0,0,0]::DOUBLE PRECISION[]),
    (v_sched_office, 'holiday',  ARRAY[0,0,0,0,0,0,0,0,0.05,0.05,0.05,0.05,0.05,0.05,0.05,0,0,0,0,0,0,0,0,0]::DOUBLE PRECISION[]),
    (v_sched_always, 'weekday',  ARRAY[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]::DOUBLE PRECISION[]),
    (v_sched_always, 'saturday', ARRAY[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]::DOUBLE PRECISION[]),
    (v_sched_always, 'sunday',   ARRAY[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]::DOUBLE PRECISION[]),
    (v_sched_always, 'holiday',  ARRAY[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]::DOUBLE PRECISION[]),
    (v_sched_lobby,  'weekday',  ARRAY[0,0,0,0,0,0,0.2,0.5,0.8,0.8,0.7,0.7,0.6,0.7,0.8,0.8,0.8,0.7,0.5,0.4,0.3,0.1,0,0]::DOUBLE PRECISION[]),
    (v_sched_lobby,  'saturday', ARRAY[0,0,0,0,0,0,0.1,0.2,0.3,0.4,0.4,0.4,0.3,0.3,0.3,0.3,0.2,0.2,0.1,0.1,0,0,0,0]::DOUBLE PRECISION[]),
    (v_sched_lobby,  'sunday',   ARRAY[0,0,0,0,0,0,0.2,0.5,0.8,0.8,0.7,0.7,0.6,0.7,0.8,0.8,0.8,0.7,0.5,0.4,0.3,0.1,0,0]::DOUBLE PRECISION[]),
    (v_sched_lobby,  'holiday',  ARRAY[0,0,0,0,0,0,0,0.1,0.2,0.2,0.2,0.2,0.2,0.2,0.2,0.1,0.1,0,0,0,0,0,0,0]::DOUBLE PRECISION[]);

  -- --------------------------------------------------------- thermal profiles
  -- Values are representative of a modern Gulf commercial fit-out: heavy
  -- glazing, low SHGC, cooling-only plant.
  INSERT INTO thermal_profiles (
    name, description, u_value_wall_w_m2k, u_value_window_w_m2k, u_value_roof_w_m2k,
    window_to_wall_ratio, shgc, infiltration_ach, thermal_mass_kj_per_k,
    lighting_power_density_w_m2, equipment_power_density_w_m2, occupancy_heat_gain_w_person,
    setpoint_temp_c, deadband_k, ventilation_l_s_person, hvac_cop
  ) VALUES
    ('open_plan_office', 'Perimeter open-plan office, high glazing',
       0.32, 1.80, 0.25, 0.45, 0.28, 0.35, 45000, 8.0, 12.0, 120, 23.0, 1.0, 10, 3.2),
    ('meeting_room', 'Dense intermittent occupancy',
       0.32, 1.80, 0.25, 0.30, 0.28, 0.30, 22000, 9.0, 8.0, 130, 22.5, 1.0, 12, 3.2),
    ('circulation', 'Corridors, stairs, restrooms — loose control',
       0.35, 1.80, 0.25, 0.10, 0.28, 0.45, 30000, 5.0, 2.0, 100, 24.5, 2.0, 5, 3.0),
    ('server_room', 'Continuous high sensible load, tight setpoint',
       0.30, 1.60, 0.22, 0.00, 0.28, 0.20, 18000, 6.0, 450.0, 0, 21.0, 0.5, 2, 2.6),
    ('lobby_atrium', 'Large glazed volume, high infiltration at entry',
       0.38, 2.10, 0.30, 0.70, 0.32, 0.80, 60000, 10.0, 4.0, 110, 23.5, 1.5, 10, 3.0)
  ;

  SELECT id INTO v_tp_office  FROM thermal_profiles WHERE name = 'open_plan_office';
  SELECT id INTO v_tp_meeting FROM thermal_profiles WHERE name = 'meeting_room';
  SELECT id INTO v_tp_circ    FROM thermal_profiles WHERE name = 'circulation';
  SELECT id INTO v_tp_server  FROM thermal_profiles WHERE name = 'server_room';
  SELECT id INTO v_tp_lobby   FROM thermal_profiles WHERE name = 'lobby_atrium';

  -- ----------------------------------------------------------------- building
  INSERT INTO buildings (
    name, address, timezone, location, gross_floor_area_m2, year_built,
    grid_carbon_kg_per_kwh, gltf_asset_path, metadata
  ) VALUES (
    'Corniche Tower', 'Corniche Road, Abu Dhabi, UAE', 'Asia/Dubai',
    ST_SetSRID(ST_MakePoint(54.3773, 24.4539), 4326)::geography,
    BUILDING_W * BUILDING_D * 4, 2016, 0.42, '/models/sample-building.glb',
    '{"site_datum": "NW corner, ground slab level", "axis": "+X east, +Y north, +Z up"}'::jsonb
  ) RETURNING id INTO v_building;

  -- Building-level plant and metering.
  INSERT INTO equipment (building_id, tag, equipment_type, manufacturer, model,
                         install_date, rated_power_kw, status, position)
  VALUES (v_building, 'MTR-MAIN', 'electric_meter', 'Schneider', 'PM8000',
          DATE '2016-05-01', NULL, 'operational',
          ST_SetSRID(ST_MakePoint(1, 1, 0), 0));

  INSERT INTO equipment (building_id, tag, equipment_type, manufacturer, model,
                         install_date, status, position)
  VALUES (v_building, 'MTR-WATER', 'water_meter', 'Itron', 'Aquadis+',
          DATE '2016-05-01', 'operational',
          ST_SetSRID(ST_MakePoint(2, 1, 0), 0));

  INSERT INTO equipment (building_id, tag, equipment_type, manufacturer, model,
                         install_date, rated_power_kw, status, position)
  VALUES (v_building, 'CT-01', 'cooling_tower', 'BAC', 'VTL-212',
          DATE '2016-05-01', 22.0, 'operational',
          ST_SetSRID(ST_MakePoint(38, 28, 16), 0))
  RETURNING id INTO v_ct;

  FOR i IN 1..2 LOOP
    INSERT INTO equipment (building_id, tag, equipment_type, manufacturer, model,
                           install_date, rated_power_kw, status, position, parent_equipment_id)
    VALUES (v_building, 'CH-0' || i, 'chiller', 'Carrier', '30XA-702',
            DATE '2016-05-01', 320.0,
            CASE WHEN i = 2 THEN 'maintenance' ELSE 'operational' END::equipment_status,
            ST_SetSRID(ST_MakePoint(34 + i * 2, 27, 0), 0), v_ct)
    RETURNING id INTO v_chiller;

    INSERT INTO equipment (building_id, tag, equipment_type, manufacturer, model,
                           install_date, rated_power_kw, status, position, parent_equipment_id)
    VALUES (v_building, 'PMP-0' || i, 'pump', 'Grundfos', 'NK-150',
            DATE '2016-05-01', 18.5, 'operational',
            ST_SetSRID(ST_MakePoint(34 + i * 2, 25, 0), 0), v_chiller);
  END LOOP;

  INSERT INTO equipment (building_id, tag, equipment_type, manufacturer, model,
                         install_date, rated_power_kw, status, position)
  VALUES (v_building, 'EVC-01', 'ev_charger', 'ABB', 'Terra AC W22',
          DATE '2021-09-15', 22.0, 'operational',
          ST_SetSRID(ST_MakePoint(5, 29, -0.2), 0));

  -- Keep a handle on the lead chiller for the AHU serving tree.
  SELECT id INTO v_chiller FROM equipment WHERE building_id = v_building AND tag = 'CH-01';

  -- ------------------------------------------------------- floors, zones, air
  FOR f IN 0..3 LOOP
    v_elev := f * FLOOR_H;
    v_floor_name := CASE f WHEN 0 THEN 'Ground Floor' ELSE 'Level ' || f END;

    INSERT INTO floors (building_id, level, name, elevation_m, floor_height_m,
                        floor_area_m2, footprint, gltf_node_id)
    VALUES (
      v_building, f, v_floor_name, v_elev, FLOOR_H, BUILDING_W * BUILDING_D,
      ST_Force3D(ST_MakeEnvelope(0, 0, BUILDING_W, BUILDING_D, 0), v_elev),
      'Floor_' || f
    ) RETURNING id INTO v_floor;

    -- One AHU per floor, fed by the lead chiller.
    INSERT INTO equipment (building_id, floor_id, parent_equipment_id, tag, equipment_type,
                           manufacturer, model, install_date, rated_power_kw,
                           rated_airflow_cmh, status, position, gltf_node_id)
    VALUES (v_building, v_floor, v_chiller, 'AHU-0' || (f + 1), 'ahu',
            'Systemair', 'Topvex-SR09', DATE '2016-05-01', 15.0, 18000,
            'operational', ST_SetSRID(ST_MakePoint(38, 28, v_elev + 3), 0),
            'AHU_' || f)
    RETURNING id INTO v_ahu;

    -- Lighting circuit per floor.
    INSERT INTO equipment (building_id, floor_id, tag, equipment_type, manufacturer,
                           install_date, rated_power_kw, status, position)
    VALUES (v_building, v_floor, 'LTG-0' || (f + 1), 'lighting_circuit', 'Philips',
            DATE '2016-05-01', BUILDING_W * BUILDING_D * 8.0 / 1000.0, 'operational',
            ST_SetSRID(ST_MakePoint(0.5, 0.5, v_elev + 3), 0));

    -- Six zones in a 3x2 grid.
    FOR z IN 0..5 LOOP
      v_x0 := (z % 3) * (BUILDING_W / 3.0);
      v_x1 := v_x0 + (BUILDING_W / 3.0);
      v_y0 := (z / 3) * (BUILDING_D / 2.0);
      v_y1 := v_y0 + (BUILDING_D / 2.0);

      -- Zone mix: ground floor gets a lobby, level 1 gets the server room,
      -- everything else is office/meeting with a corridor.
      IF f = 0 AND z = 0 THEN
        v_ztype := 'lobby';      v_tp := v_tp_lobby;   v_sched := v_sched_lobby;
      ELSIF f = 1 AND z = 5 THEN
        v_ztype := 'server_room'; v_tp := v_tp_server; v_sched := v_sched_always;
      ELSIF z = 2 THEN
        v_ztype := 'corridor';   v_tp := v_tp_circ;    v_sched := v_sched_office;
      ELSIF z = 4 THEN
        v_ztype := 'meeting';    v_tp := v_tp_meeting; v_sched := v_sched_office;
      ELSE
        v_ztype := 'office';     v_tp := v_tp_office;  v_sched := v_sched_office;
      END IF;

      v_zname := upper(left(v_ztype::text, 3)) || '-' || f || lpad(z::text, 2, '0');

      INSERT INTO zones (floor_id, name, zone_type, area_m2, volume_m3,
                         design_occupancy, exterior_wall_area_m2, boundary,
                         gltf_node_id, thermal_profile_id, occupancy_schedule_id)
      VALUES (
        v_floor, v_zname, v_ztype,
        (v_x1 - v_x0) * (v_y1 - v_y0),
        (v_x1 - v_x0) * (v_y1 - v_y0) * CEIL_H,
        CASE v_ztype WHEN 'office' THEN 20 WHEN 'meeting' THEN 12
                     WHEN 'lobby' THEN 15 WHEN 'server_room' THEN 1 ELSE 4 END,
        -- Only the outer ring of the grid touches the facade.
        CASE WHEN (z % 3) IN (0, 2) OR (z / 3) IN (0, 1)
             THEN (v_x1 - v_x0) * CEIL_H ELSE 0 END,
        ST_Force3D(ST_MakeEnvelope(v_x0, v_y0, v_x1, v_y1, 0), v_elev),
        'Zone_' || f || '_' || z, v_tp, v_sched
      ) RETURNING id INTO v_zone;

      -- One VAV per zone, fed by the floor AHU.
      INSERT INTO equipment (building_id, floor_id, zone_id, parent_equipment_id,
                             tag, equipment_type, manufacturer, model, install_date,
                             rated_power_kw, rated_airflow_cmh, status, position, gltf_node_id)
      VALUES (v_building, v_floor, v_zone, v_ahu,
              'VAV-' || f || lpad(z::text, 2, '0'), 'vav', 'Titus', 'DESV',
              DATE '2016-05-01', 0.4, 3000, 'operational',
              ST_SetSRID(ST_MakePoint((v_x0 + v_x1) / 2, (v_y0 + v_y1) / 2, v_elev + 3), 0),
              'VAV_' || f || '_' || z)
      RETURNING id INTO v_vav;

      INSERT INTO equipment_zone_service (equipment_id, zone_id, role, load_fraction)
        VALUES (v_vav, v_zone, 'primary', 1.0);
      INSERT INTO equipment_zone_service (equipment_id, zone_id, role, load_fraction)
        VALUES (v_ahu, v_zone, 'primary', 1.0);

      -- Zone environmental points.
      INSERT INTO sensors (external_id, name, metric, unit, zone_id,
                           min_plausible, max_plausible, sample_interval_s) VALUES
        ('BAC:' || v_zname || ':ZT',  v_zname || ' Zone Temperature', 'temperature_c', 'degC', v_zone, -10, 60, 60),
        ('BAC:' || v_zname || ':ZH',  v_zname || ' Zone Humidity',    'humidity_pct',  '%',    v_zone, 0, 100, 60),
        ('BAC:' || v_zname || ':CO2', v_zname || ' Zone CO2',         'co2_ppm',       'ppm',  v_zone, 300, 5000, 60),
        ('BAC:' || v_zname || ':OCC', v_zname || ' Occupancy Count',  'occupancy_count', 'persons', v_zone, 0, 200, 300);

      -- VAV points.
      INSERT INTO sensors (external_id, name, metric, unit, equipment_id, zone_id,
                           min_plausible, max_plausible, sample_interval_s) VALUES
        ('BAC:VAV-' || f || lpad(z::text,2,'0') || ':FLOW', 'VAV airflow',  'airflow_cmh', 'm3/h', v_vav, v_zone, 0, 4000, 60),
        ('BAC:VAV-' || f || lpad(z::text,2,'0') || ':DMPR', 'VAV damper',   'damper_position_pct', '%', v_vav, v_zone, 0, 100, 60),
        ('BAC:VAV-' || f || lpad(z::text,2,'0') || ':SP',   'Zone setpoint','setpoint_temp_c', 'degC', v_vav, v_zone, 16, 30, 300);
    END LOOP;

    -- AHU points.
    INSERT INTO sensors (external_id, name, metric, unit, equipment_id,
                         min_plausible, max_plausible, sample_interval_s) VALUES
      ('BAC:AHU-0' || (f+1) || ':SAT', 'AHU supply air temp', 'temperature_c', 'degC', v_ahu, 0, 50, 60),
      ('BAC:AHU-0' || (f+1) || ':KW',  'AHU power',           'power_kw',      'kW',   v_ahu, 0, 30, 60);

    -- Lighting circuit power.
    INSERT INTO sensors (external_id, name, metric, unit, equipment_id,
                         min_plausible, max_plausible, sample_interval_s)
    SELECT 'BAC:LTG-0' || (f+1) || ':KW', 'Lighting circuit power', 'power_kw', 'kW', e.id, 0, 20, 60
    FROM equipment e WHERE e.building_id = v_building AND e.tag = 'LTG-0' || (f + 1);
  END LOOP;

  -- ------------------------------------------------------------ plant sensors
  INSERT INTO sensors (external_id, name, metric, unit, equipment_id, is_cumulative,
                       min_plausible, max_plausible, sample_interval_s)
  SELECT 'MOD:' || e.tag || ':KWH', e.tag || ' cumulative energy', 'energy_kwh', 'kWh',
         e.id, TRUE, 0, NULL, 300
  FROM equipment e
  WHERE e.building_id = v_building AND e.equipment_type = 'electric_meter';

  INSERT INTO sensors (external_id, name, metric, unit, equipment_id, is_cumulative,
                       min_plausible, max_plausible, sample_interval_s)
  SELECT 'MOD:' || e.tag || ':M3', e.tag || ' cumulative water', 'water_m3', 'm3',
         e.id, TRUE, 0, NULL, 900
  FROM equipment e
  WHERE e.building_id = v_building AND e.equipment_type = 'water_meter';

  INSERT INTO sensors (external_id, name, metric, unit, equipment_id,
                       min_plausible, max_plausible, sample_interval_s)
  SELECT 'MOD:' || e.tag || ':KW', e.tag || ' power', 'power_kw', 'kW', e.id, 0,
         COALESCE(e.rated_power_kw, 100) * 1.2, 60
  FROM equipment e
  WHERE e.building_id = v_building
    AND e.equipment_type IN ('chiller', 'pump', 'cooling_tower', 'ev_charger');

  INSERT INTO sensors (external_id, name, metric, unit, equipment_id,
                       min_plausible, max_plausible, sample_interval_s)
  SELECT 'MOD:' || e.tag || ':CHWST', e.tag || ' chilled water supply temp',
         'temperature_c', 'degC', e.id, 0, 30, 60
  FROM equipment e
  WHERE e.building_id = v_building AND e.equipment_type = 'chiller';

  -- --------------------------------------------------------------- alert rules
  INSERT INTO alert_rules (name, description, building_id, metric, condition,
                           threshold, window_s, consecutive_breaches, severity)
  VALUES
    ('Zone overheating', 'Any zone above 27 C for three consecutive reads',
     v_building, 'temperature_c', 'threshold_above', 27.0, NULL, 3, 'warning'),
    ('CO2 breach', 'Ventilation failure indicator',
     v_building, 'co2_ppm', 'threshold_above', 1200.0, NULL, 2, 'warning'),
    ('Thermal drift', 'Zone temperature moving faster than 2 K/hour',
     v_building, 'temperature_c', 'rate_of_change', 2.0, 3600, 1, 'warning'),
    ('Stuck sensor', 'No change in value for 2 hours',
     v_building, 'temperature_c', 'flatline', NULL, 7200, 1, 'info'),
    ('Point offline', 'No reading received for 15 minutes',
     v_building, 'temperature_c', 'no_data', NULL, 900, 1, 'critical');

  INSERT INTO alert_rules (name, description, equipment_id, metric, condition,
                           threshold, consecutive_breaches, severity)
  SELECT 'Chiller power spike', 'Lead chiller drawing above rated power',
         e.id, 'power_kw', 'threshold_above', e.rated_power_kw, 3, 'critical'
  FROM equipment e
  WHERE e.building_id = v_building AND e.tag = 'CH-01';

  INSERT INTO alert_rules (name, description, zone_id, metric, condition,
                           threshold, consecutive_breaches, severity)
  SELECT 'Server room tight band', 'Server room deviating from 21 C setpoint',
         z.id, 'temperature_c', 'deviation_from_setpoint', 2.0, 2, 'critical'
  FROM zones z WHERE z.zone_type = 'server_room';

  -- ------------------------------------------------------- maintenance history
  INSERT INTO maintenance_logs (equipment_id, performed_at, log_type, technician,
                                notes, cost, downtime_minutes, next_due_at)
  SELECT e.id,
         now() - (INTERVAL '1 day' * (30 + (row_number() OVER (ORDER BY e.tag)) * 7)),
         'preventive', 'Al Nahdi FM',
         'Quarterly service: filters, belts, coil clean.',
         450.00, 120,
         now() + (INTERVAL '1 day' * (60 - (row_number() OVER (ORDER BY e.tag)) * 3))
  FROM equipment e
  WHERE e.building_id = v_building AND e.equipment_type IN ('ahu', 'chiller');

  INSERT INTO maintenance_logs (equipment_id, performed_at, log_type, technician,
                                notes, cost, downtime_minutes)
  SELECT e.id, now() - INTERVAL '9 days', 'corrective', 'Carrier Service',
         'Compressor 2 high-pressure trip. Awaiting replacement part; unit offline.',
         0.00, 12960
  FROM equipment e WHERE e.building_id = v_building AND e.tag = 'CH-02';

  RAISE NOTICE 'Seeded building % — % floors, % zones, % equipment, % sensors',
    v_building,
    (SELECT count(*) FROM floors WHERE building_id = v_building),
    (SELECT count(*) FROM zones z JOIN floors fl ON fl.id = z.floor_id WHERE fl.building_id = v_building),
    (SELECT count(*) FROM equipment WHERE building_id = v_building),
    (SELECT count(*) FROM sensors s LEFT JOIN equipment e ON e.id = s.equipment_id
       LEFT JOIN zones z ON z.id = s.zone_id LEFT JOIN floors fl ON fl.id = z.floor_id
       WHERE e.building_id = v_building OR fl.building_id = v_building);
END
$seed$;
