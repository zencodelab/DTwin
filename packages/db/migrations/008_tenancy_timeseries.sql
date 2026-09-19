-- @no-transaction
-- =============================================================================
-- 008_tenancy_timeseries.sql — tenant isolation for telemetry and its rollups
--
-- Marked @no-transaction because TimescaleDB refuses to create a continuous
-- aggregate inside a transaction block. This file can therefore fail
-- part-applied; that is why everything that COULD be transactional lives in
-- 007 instead.
--
-- WHY THIS FILE EXISTS AT ALL
--
-- 007 protects every table it can with row-level security. It cannot protect
-- these, and the reasons are properties of TimescaleDB 2.30.1, both measured:
--
--   ALTER TABLE <compressed hypertable> ENABLE ROW LEVEL SECURITY
--     ERROR:  operation not supported on hypertables that have columnstore enabled
--   ALTER TABLE <rls table> SET (timescaledb.compress, …)
--     ERROR:  columnstore cannot be used on table with row security
--
-- `telemetry` is compressed after 7 days and kept for 2 years. Giving up
-- compression on the highest-volume table in the schema to gain a policy is a
-- bad trade, so telemetry keeps compression and gets no policy.
--
-- A continuous aggregate is a VIEW (pg_class.relkind = 'v'). RLS cannot be
-- enabled on a view, and TimescaleDB rejects both
-- `ALTER VIEW … SET (security_invoker)` and the ALTER MATERIALIZED VIEW form.
--
-- So isolation here is by GRANT plus barrier views that filter explicitly.
--
-- WHY THE VIEWS FILTER EXPLICITLY RATHER THAN JOINING `sensors`
--
-- Letting the join to the RLS-protected `sensors` table do the filtering looks
-- tidier and LEAKS. A view body executes with the privileges of the view's
-- owner; the owner here owns the schema and is a superuser; superusers bypass
-- RLS unconditionally, FORCE included. Tested, it returned both tenants' rows
-- and did not fail closed. Never rely on RLS reaching through a view.
--
-- DESTRUCTIVE: dropping the three continuous aggregates discards their
-- materialised history. The refresh calls below rebuild them from raw
-- telemetry, but raw telemetry is retained for 2 years while the rollups were
-- not dropped at all — on a long-lived database, rollups older than the raw
-- retention window CANNOT be reconstructed. Dump them first if they matter.
-- On the seeded development database this costs nothing.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- telemetry.tenant_id
--
-- Denormalised onto the narrowest table in the schema, whose own header argues
-- against exactly this. The trade has changed: without a local tenant column
-- there is no way to scope a rollup, because a continuous aggregate can only
-- group by columns of the hypertable it reads.
--
-- The storage cost is near zero. tenant_id is functionally dependent on
-- sensor_id, compression already segments by sensor_id, so every segment holds
-- one repeated value.
--
-- compress_segmentby is deliberately NOT changed. Adding tenant_id to it would
-- buy nothing for the same reason, and would require decompressing every chunk.
-- -----------------------------------------------------------------------------

ALTER TABLE telemetry ADD COLUMN tenant_id UUID;

UPDATE telemetry t SET tenant_id = s.tenant_id
  FROM sensors s WHERE s.id = t.sensor_id AND t.tenant_id IS NULL;

-- Any row whose sensor vanished cannot be attributed and must not be kept:
-- an unattributable reading is one a barrier view can never show and no tenant
-- can ever delete.
DELETE FROM telemetry WHERE tenant_id IS NULL;

ALTER TABLE telemetry ALTER COLUMN tenant_id SET NOT NULL;

-- -----------------------------------------------------------------------------
-- Rebuild the continuous aggregates with tenant_id in the grouping.
--
-- Still built from the raw hypertable rather than stacked on one another —
-- 002's reasoning is unchanged: avg(avg) is wrong the moment a sensor drops out
-- of a bucket, and correctness beats refresh cost at this size.
-- -----------------------------------------------------------------------------

DROP MATERIALIZED VIEW telemetry_5m;
DROP MATERIALIZED VIEW telemetry_1h;
DROP MATERIALIZED VIEW telemetry_1d;

CREATE MATERIALIZED VIEW telemetry_5m
  WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '5 minutes', time) AS bucket,
  tenant_id,
  sensor_id,
  avg(value)                 AS avg_value,
  min(value)                 AS min_value,
  max(value)                 AS max_value,
  last(value, time)          AS last_value,
  count(*)                   AS sample_count,
  count(*) FILTER (WHERE quality <> 0) AS bad_quality_count
FROM telemetry
GROUP BY bucket, tenant_id, sensor_id
WITH NO DATA;

CREATE MATERIALIZED VIEW telemetry_1h
  WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 hour', time) AS bucket,
  tenant_id,
  sensor_id,
  avg(value)                 AS avg_value,
  min(value)                 AS min_value,
  max(value)                 AS max_value,
  last(value, time)          AS last_value,
  count(*)                   AS sample_count,
  count(*) FILTER (WHERE quality <> 0) AS bad_quality_count,
  counter_agg(time, value)   AS counter
FROM telemetry
GROUP BY bucket, tenant_id, sensor_id
WITH NO DATA;

CREATE MATERIALIZED VIEW telemetry_1d
  WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 day', time) AS bucket,
  tenant_id,
  sensor_id,
  avg(value)                 AS avg_value,
  min(value)                 AS min_value,
  max(value)                 AS max_value,
  last(value, time)          AS last_value,
  count(*)                   AS sample_count,
  count(*) FILTER (WHERE quality <> 0) AS bad_quality_count,
  counter_agg(time, value)   AS counter
FROM telemetry
GROUP BY bucket, tenant_id, sensor_id
WITH NO DATA;

-- Same offsets as 002. end_offset holds the materialised edge behind now() so a
-- late reading is not baked into a bucket that is still filling; real-time
-- aggregation covers the gap.
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

-- Backfill over all available history. The policies above only reconsider their
-- start_offset window, so without this the rebuilt views would begin life
-- holding a few hours of the data they used to hold years of.
--
-- Note: the refresh runs with app.tenant_id unset and still sees every row,
-- because refresh does not go through RLS — verified, and the reason the
-- rebuild is possible at all.
CALL refresh_continuous_aggregate('telemetry_5m', NULL, NULL);
CALL refresh_continuous_aggregate('telemetry_1h', NULL, NULL);
CALL refresh_continuous_aggregate('telemetry_1d', NULL, NULL);

-- -----------------------------------------------------------------------------
-- Barrier views
--
-- `_t` for tenant-scoped. The application reads these and never the underlying
-- relations; the GRANTs below make that a rule the database enforces rather
-- than a convention a future query can forget.
--
-- security_barrier stops the planner pushing a user-supplied function down
-- below the tenant filter, where it could observe rows the view exists to hide.
--
-- current_tenant_id() returns NULL when app.tenant_id is unset, and
-- `tenant_id = NULL` is never true, so an unscoped connection reads zero rows.
-- -----------------------------------------------------------------------------

CREATE VIEW telemetry_t WITH (security_barrier = true) AS
  SELECT * FROM telemetry WHERE tenant_id = current_tenant_id();

CREATE VIEW telemetry_5m_t WITH (security_barrier = true) AS
  SELECT * FROM telemetry_5m WHERE tenant_id = current_tenant_id();

CREATE VIEW telemetry_1h_t WITH (security_barrier = true) AS
  SELECT * FROM telemetry_1h WHERE tenant_id = current_tenant_id();

CREATE VIEW telemetry_1d_t WITH (security_barrier = true) AS
  SELECT * FROM telemetry_1d WHERE tenant_id = current_tenant_id();

-- -----------------------------------------------------------------------------
-- Grants
--
-- The application may INSERT into telemetry directly but may not SELECT from
-- it. Reads go through the barrier views; writes cannot, because a view over a
-- compressed hypertable is not insertable and an INSTEAD OF trigger would put a
-- per-row hop on the batch path.
--
-- The write is still safe without a policy, because @dtwin/db derives tenant_id
-- by joining `sensors` — which IS under RLS — instead of trusting the caller:
--
--   INSERT INTO telemetry (time, tenant_id, sensor_id, value, quality)
--   SELECT to_timestamp(t.ts / 1000.0), s.tenant_id, t.sensor_id, t.value, t.quality
--     FROM unnest(…) AS t(ts, sensor_id, value, quality)
--     JOIN sensors s ON s.id = t.sensor_id
--   ON CONFLICT (sensor_id, time) DO NOTHING;
--
-- A reading naming another tenant's sensor does not join and is dropped.
-- Verified: a two-row batch naming one sensor from each of two tenants
-- inserted exactly one row.
--
-- THE COLUMN-LEVEL GRANT IS NOT FUSSINESS. `ON CONFLICT (sensor_id, time)`
-- names an inference target, and inferring a conflict requires SELECT on the
-- table — a bare INSERT succeeds where the same statement with ON CONFLICT
-- fails with `permission denied for table telemetry`. That upsert is what makes
-- a re-delivered gateway batch idempotent instead of double-counting a meter,
-- so it cannot simply be dropped.
--
-- Granting SELECT on the whole table to get it back would hand the application
-- an unscoped read path around the barrier view. Granting SELECT on only the
-- two index columns is enough for the inference and no more: `SELECT value`
-- and `SELECT *` both remain denied. Verified.
-- -----------------------------------------------------------------------------

REVOKE ALL ON telemetry, telemetry_5m, telemetry_1h, telemetry_1d FROM PUBLIC;

GRANT INSERT ON telemetry TO dtwin_app;
GRANT SELECT (sensor_id, "time") ON telemetry TO dtwin_app;
GRANT SELECT ON telemetry_t, telemetry_5m_t, telemetry_1h_t, telemetry_1d_t TO dtwin_app;

COMMENT ON VIEW telemetry_5m_t IS
  'Tenant-scoped view of telemetry_5m. Read this, never telemetry_5m: the '
  'aggregate itself is a view and cannot carry a row-level security policy.';
