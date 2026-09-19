-- @no-transaction
-- =============================================================================
-- 002_timeseries.sql — telemetry hypertable, rollups, weather
--
-- Marked @no-transaction: TimescaleDB refuses to create a continuous aggregate
-- inside a transaction block. The runner executes this file statement-by-
-- statement without a surrounding BEGIN and only records it once every
-- statement succeeds.
--
-- WHY THE HYPERTABLE IS NARROW
-- `telemetry` carries (time, sensor_id, value, quality) and nothing else — no
-- denormalized zone_id or metric. Denormalizing looks tempting because it saves
-- a join, but at ~500 points sampled every second it multiplies storage and
-- hurts the compression ratio (repeated low-cardinality text per row). Timescale
-- joins a narrow hypertable against the small `sensors` dimension table cheaply,
-- and the dashboard reads the continuous aggregates below rather than raw rows.
-- =============================================================================

CREATE TABLE telemetry (
  time      TIMESTAMPTZ      NOT NULL,
  sensor_id UUID             NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  value     DOUBLE PRECISION NOT NULL,
  -- 0 good | 1 uncertain | 2 out_of_plausible_range | 3 stale | 4 device_fault
  quality   SMALLINT         NOT NULL DEFAULT 0
);

SELECT create_hypertable('telemetry', by_range('time', INTERVAL '1 day'));

-- Also the upsert target: re-delivered readings collapse via ON CONFLICT
-- instead of duplicating. Includes `time` because Timescale requires the
-- partitioning column in any unique index.
CREATE UNIQUE INDEX telemetry_sensor_time_uidx ON telemetry (sensor_id, time DESC);

-- -----------------------------------------------------------------------------
-- Compression and retention
-- -----------------------------------------------------------------------------

ALTER TABLE telemetry SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'sensor_id',
  timescaledb.compress_orderby   = 'time DESC'
);

SELECT add_compression_policy('telemetry', INTERVAL '7 days');

-- Raw readings age out after two years; the rollups below are not dropped, so
-- long-range trend and year-on-year comparison survive.
SELECT add_retention_policy('telemetry', INTERVAL '2 years');

-- -----------------------------------------------------------------------------
-- Continuous aggregates
--
-- All three are built directly from the raw hypertable rather than stacking
-- 1h on 5m and 1d on 1h. Stacking is cheaper but the naive rollup is WRONG:
-- avg(avg) is only correct when every bucket holds the same number of samples,
-- which is never true once a sensor drops out. Correctness first; at one
-- building the refresh cost is negligible.
--
-- counter_agg is carried on the hourly view for CUMULATIVE points (energy
-- meters, water meters). Those report a monotonic counter, so a plain avg or a
-- naive last-minus-first is meaningless and a meter reset invents a megawatt
-- spike. Use delta(counter) / extract from it. For gauge points the counter
-- columns are present but meaningless — ignore them, and read avg/min/max.
-- -----------------------------------------------------------------------------

CREATE MATERIALIZED VIEW telemetry_5m
  WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '5 minutes', time) AS bucket,
  sensor_id,
  avg(value)                 AS avg_value,
  min(value)                 AS min_value,
  max(value)                 AS max_value,
  last(value, time)          AS last_value,
  count(*)                   AS sample_count,
  count(*) FILTER (WHERE quality <> 0) AS bad_quality_count
FROM telemetry
GROUP BY bucket, sensor_id
WITH NO DATA;

CREATE MATERIALIZED VIEW telemetry_1h
  WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 hour', time) AS bucket,
  sensor_id,
  avg(value)                 AS avg_value,
  min(value)                 AS min_value,
  max(value)                 AS max_value,
  last(value, time)          AS last_value,
  count(*)                   AS sample_count,
  count(*) FILTER (WHERE quality <> 0) AS bad_quality_count,
  -- Reset-aware counter summary; only meaningful where sensors.is_cumulative.
  counter_agg(time, value)   AS counter
FROM telemetry
GROUP BY bucket, sensor_id
WITH NO DATA;

CREATE MATERIALIZED VIEW telemetry_1d
  WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 day', time) AS bucket,
  sensor_id,
  avg(value)                 AS avg_value,
  min(value)                 AS min_value,
  max(value)                 AS max_value,
  last(value, time)          AS last_value,
  count(*)                   AS sample_count,
  count(*) FILTER (WHERE quality <> 0) AS bad_quality_count,
  counter_agg(time, value)   AS counter
FROM telemetry
GROUP BY bucket, sensor_id
WITH NO DATA;

-- start_offset bounds how far back each refresh reconsiders; end_offset keeps
-- the materialized edge slightly behind now() so late-arriving readings are not
-- baked into a bucket that is still filling. Real-time aggregation covers the
-- gap between the materialized edge and now().
SELECT add_continuous_aggregate_policy('telemetry_5m',
  start_offset => INTERVAL '3 hours',
  end_offset   => INTERVAL '5 minutes',
  schedule_interval => INTERVAL '5 minutes');

SELECT add_continuous_aggregate_policy('telemetry_1h',
  start_offset => INTERVAL '3 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes');

SELECT add_continuous_aggregate_policy('telemetry_1d',
  start_offset => INTERVAL '30 days',
  end_offset   => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 hour');

-- -----------------------------------------------------------------------------
-- Weather
--
-- Drives the simulation's external boundary condition. A cooling-dominated
-- climate makes the solar terms (ghi/dni) matter as much as dry bulb.
-- -----------------------------------------------------------------------------

CREATE TABLE weather_observations (
  time        TIMESTAMPTZ NOT NULL,
  building_id UUID NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  dry_bulb_c  DOUBLE PRECISION NOT NULL,
  rh_pct      DOUBLE PRECISION CHECK (rh_pct BETWEEN 0 AND 100),
  ghi_w_m2    DOUBLE PRECISION CHECK (ghi_w_m2 >= 0),  -- global horizontal irradiance
  dni_w_m2    DOUBLE PRECISION CHECK (dni_w_m2 >= 0),  -- direct normal irradiance
  wind_m_s    DOUBLE PRECISION CHECK (wind_m_s >= 0),
  cloud_pct   DOUBLE PRECISION CHECK (cloud_pct BETWEEN 0 AND 100),
  -- 'observed' from a site station, or 'forecast' when pulled ahead of time.
  source      TEXT NOT NULL DEFAULT 'observed'
);

SELECT create_hypertable('weather_observations', by_range('time', INTERVAL '7 days'));

CREATE UNIQUE INDEX weather_building_time_uidx
  ON weather_observations (building_id, time DESC, source);
