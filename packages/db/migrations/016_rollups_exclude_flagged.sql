-- @no-transaction
-- =============================================================================
-- 016_rollups_exclude_flagged.sql — a flagged reading must not enter a mean
--
-- Marked @no-transaction: TimescaleDB refuses to create a continuous aggregate
-- inside a transaction block. Like 008 it can fail part-applied, and like 008
-- every statement here is safe to reason about on its own.
--
-- WHAT WAS WRONG
--
-- The quality gate stores a bad reading with a flag instead of dropping it, on
-- purpose (002): "the sensor reported -273 for six hours" is a diagnosis, and
-- discarding it turns a visible fault into an unexplained gap. The rollups then
-- counted those samples in `bad_quality_count` — and ALSO averaged them. A
-- probe that failed to -273 C for one minute in an hour pulled that hour's mean
-- down by five degrees; a spike to 9,999 ppm set the day's max. Every consumer
-- read the contaminated number and had a count beside it that it could not use
-- to repair it, because you cannot subtract a sample from a mean you were not
-- given the sum of.
--
-- The alert engine has refused flagged readings since §17 and the live map
-- since §55. This is the third and last place, and the one the other two fall
-- back on: the map's first paint is a mean from `telemetry_5m`.
--
-- WHAT CHANGES
--
-- avg / min / max / last, and counter_agg, are computed over `quality = 0`
-- only. A bucket with no good sample has NULL there, which is the truth, and
-- which every reader already handles (the columns were always nullable in the
-- Zod schema, because a bucket can be empty). `sample_count` still counts
-- everything and `bad_quality_count` still counts the flagged, so coverage is
-- (sample_count - bad_quality_count) / expected, as before. Nothing is hidden:
-- the flagged rows remain in `telemetry` with their flags.
--
-- counter_agg too, not only the means. One out-of-range value on a cumulative
-- meter reads to a reset-aware counter as a reset followed by a jump, and
-- `delta()` then reports energy that was never used.
--
-- The column NAMES are kept. A second set (`good_avg_value` beside
-- `avg_value`) would leave the wrong number in place under the obvious name,
-- for the next query to pick up.
--
-- WHY A REBUILD
--
-- A continuous aggregate's query cannot be altered; the only way to change an
-- aggregate expression is to drop the view and create it again. History is
-- re-materialised from `telemetry`, which is kept for two years.
--
-- *** Rollup rows older than that retention window cannot be reconstructed. ***
-- On a deployment old enough to have any, dump telemetry_1h and telemetry_1d
-- first. (There is no such deployment today.)
--
-- TWO THINGS 008 GOT WRONG, NOT REPEATED HERE
--
-- 1. 008 dropped the views while their refresh policies were live, and on a
--    fresh database raced TimescaleDB's scheduler into `tuple concurrently
--    deleted`. The runner now retries that class of error, but the right fix
--    is not to race: the policies are removed FIRST, so no job is left that
--    could be touching the catalog rows the DROP is about to delete.
--
-- 2. 008 backfilled with `refresh_continuous_aggregate(view, NULL, NULL)`. A
--    NULL end leaves the materialisation watermark AHEAD of now(), and
--    real-time aggregation only covers buckets at or after the watermark — so
--    every reading written afterwards sat in the hypertable, invisible in the
--    rollup, until a policy run healed it (decisions.md §46). 008 is applied
--    and cannot be edited; this file rebuilds the same three views and names
--    an end in the past, which also repairs that for any database that still
--    carries it.
-- =============================================================================

SELECT remove_continuous_aggregate_policy('telemetry_5m', if_exists => true);
SELECT remove_continuous_aggregate_policy('telemetry_1h', if_exists => true);
SELECT remove_continuous_aggregate_policy('telemetry_1d', if_exists => true);

-- The barrier views select from the aggregates, so they go first and come back
-- last. Between these statements the application has no rollup to read — this
-- migration is run with the services stopped, like every other.
DROP VIEW IF EXISTS telemetry_5m_t;
DROP VIEW IF EXISTS telemetry_1h_t;
DROP VIEW IF EXISTS telemetry_1d_t;

DROP MATERIALIZED VIEW IF EXISTS telemetry_5m;
DROP MATERIALIZED VIEW IF EXISTS telemetry_1h;
DROP MATERIALIZED VIEW IF EXISTS telemetry_1d;

-- Still built from the raw hypertable rather than stacked on one another:
-- avg(avg) is wrong the moment a sensor drops out of a bucket (002).
CREATE MATERIALIZED VIEW telemetry_5m
  WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '5 minutes', time) AS bucket,
  tenant_id,
  sensor_id,
  avg(value)        FILTER (WHERE quality = 0) AS avg_value,
  min(value)        FILTER (WHERE quality = 0) AS min_value,
  max(value)        FILTER (WHERE quality = 0) AS max_value,
  last(value, time) FILTER (WHERE quality = 0) AS last_value,
  count(*)                                     AS sample_count,
  count(*)          FILTER (WHERE quality <> 0) AS bad_quality_count
FROM telemetry
GROUP BY bucket, tenant_id, sensor_id
WITH NO DATA;

CREATE MATERIALIZED VIEW telemetry_1h
  WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 hour', time) AS bucket,
  tenant_id,
  sensor_id,
  avg(value)        FILTER (WHERE quality = 0) AS avg_value,
  min(value)        FILTER (WHERE quality = 0) AS min_value,
  max(value)        FILTER (WHERE quality = 0) AS max_value,
  last(value, time) FILTER (WHERE quality = 0) AS last_value,
  count(*)                                     AS sample_count,
  count(*)          FILTER (WHERE quality <> 0) AS bad_quality_count,
  counter_agg(time, value) FILTER (WHERE quality = 0) AS counter
FROM telemetry
GROUP BY bucket, tenant_id, sensor_id
WITH NO DATA;

CREATE MATERIALIZED VIEW telemetry_1d
  WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 day', time) AS bucket,
  tenant_id,
  sensor_id,
  avg(value)        FILTER (WHERE quality = 0) AS avg_value,
  min(value)        FILTER (WHERE quality = 0) AS min_value,
  max(value)        FILTER (WHERE quality = 0) AS max_value,
  last(value, time) FILTER (WHERE quality = 0) AS last_value,
  count(*)                                     AS sample_count,
  count(*)          FILTER (WHERE quality <> 0) AS bad_quality_count,
  counter_agg(time, value) FILTER (WHERE quality = 0) AS counter
FROM telemetry
GROUP BY bucket, tenant_id, sensor_id
WITH NO DATA;

-- Backfill all available history, to an end IN THE PAST (§46). Each end is the
-- policy's own end_offset, so the policy picks up exactly where this stops and
-- real-time aggregation covers the tail in the meantime.
--
-- Before the policies are added, so that nothing else is refreshing a view
-- while its first refresh is still running.
CALL refresh_continuous_aggregate('telemetry_5m', NULL, now() - INTERVAL '5 minutes');
CALL refresh_continuous_aggregate('telemetry_1h', NULL, now() - INTERVAL '1 hour');
CALL refresh_continuous_aggregate('telemetry_1d', NULL, now() - INTERVAL '1 day');

-- Same offsets as 002 and 008.
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

-- Barrier views and grants, exactly as 008 left them. A recreated view starts
-- with no privileges, so forgetting the GRANT would look like every tenant
-- having no history.
CREATE VIEW telemetry_5m_t WITH (security_barrier = true) AS
  SELECT * FROM telemetry_5m WHERE tenant_id = current_tenant_id();

CREATE VIEW telemetry_1h_t WITH (security_barrier = true) AS
  SELECT * FROM telemetry_1h WHERE tenant_id = current_tenant_id();

CREATE VIEW telemetry_1d_t WITH (security_barrier = true) AS
  SELECT * FROM telemetry_1d WHERE tenant_id = current_tenant_id();

REVOKE ALL ON telemetry_5m, telemetry_1h, telemetry_1d FROM PUBLIC;
GRANT SELECT ON telemetry_5m_t, telemetry_1h_t, telemetry_1d_t TO dtwin_app;

COMMENT ON VIEW telemetry_5m_t IS
  'Tenant-scoped view of telemetry_5m. Read this, never telemetry_5m: the '
  'aggregate itself is a view and cannot carry a row-level security policy.';

COMMENT ON VIEW telemetry_5m IS
  'avg/min/max/last are over quality = 0 only and are NULL for a bucket with no '
  'good sample. sample_count counts everything; bad_quality_count the flagged.';
