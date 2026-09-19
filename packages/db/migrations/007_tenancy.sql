-- =============================================================================
-- 007_tenancy.sql — tenants, identity, and row-level isolation
--
-- Read docs/multi-tenancy.md before changing anything here. The short version:
--
--  * tenant_id is denormalised onto EVERY tenant-owned table rather than being
--    reached by joining up to `buildings`. An RLS policy is evaluated per row,
--    so it must be a local predicate; a policy containing a join becomes a
--    correlated subquery and destroys index use.
--
--  * Drift between a row's tenant_id and its parent's is made IMPOSSIBLE by
--    composite foreign keys on (tenant_id, parent_id), not merely discouraged.
--    That is why each parent also gets a UNIQUE (tenant_id, id).
--
--  * Policies carry WITH CHECK as well as USING. A USING-only policy does not
--    apply to INSERT, and a cross-tenant insert then succeeds.
--
--  * `current_tenant_id()` returns NULL when the GUC is unset, so an unscoped
--    connection sees NO rows rather than every row. Fail closed, always.
--
-- `telemetry` and its continuous aggregates are NOT handled here — TimescaleDB
-- refuses RLS on a compressed hypertable and on a continuous aggregate. See
-- 008_tenancy_timeseries.sql for how those are isolated instead.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tenancy and identity
-- -----------------------------------------------------------------------------

CREATE TYPE tenant_status AS ENUM ('active', 'suspended');

-- Coarse on purpose. Finer-grained permissions belong in application policy,
-- not in an enum that every row of every membership has to agree with.
CREATE TYPE tenant_role AS ENUM ('owner', 'admin', 'operator', 'viewer');

CREATE TYPE api_key_kind AS ENUM ('device', 'service');

CREATE TABLE tenants (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- URL-safe handle. Stable, lowercase, and the thing that appears in a path
  -- or a subdomain — never the UUID, and never the display name.
  slug       TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name       TEXT NOT NULL,
  status     tenant_status NOT NULL DEFAULT 'active',
  metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE tenants IS
  'A customer organisation owning one or more buildings. NOT a building tenant '
  '(a commercial occupier) — if that concept is added, call it `occupier`.';

-- Users are GLOBAL, not tenant-scoped: one person can work for two operators,
-- and duplicating them per tenant would mean two passwords for one human.
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  -- argon2id, encoded PHC string. Nullable so an SSO-only user can exist later
  -- without a password to steal.
  password_hash TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness without depending on the citext extension.
-- Addresses are stored as entered and compared folded.
CREATE UNIQUE INDEX users_email_uidx ON users (lower(email));

CREATE TABLE tenant_members (
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  role       tenant_role NOT NULL DEFAULT 'viewer',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX tenant_members_user_idx ON tenant_members (user_id);

CREATE TABLE sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 of the cookie token, never the token. A database leak must not hand
  -- the attacker live sessions.
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The ACTIVE tenant. Switching tenant is a server-side state change, not a
  -- parameter the client gets to supply on each request.
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent   TEXT,
  ip           INET,
  -- A session is only valid for a tenant the user is actually a member of.
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_members (tenant_id, user_id)
    ON DELETE CASCADE
);

CREATE INDEX sessions_user_idx    ON sessions (user_id);
CREATE INDEX sessions_expiry_idx  ON sessions (expires_at);

CREATE TABLE api_keys (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        api_key_kind NOT NULL,
  name        TEXT NOT NULL,
  -- First 8 characters, for display and for narrowing the hash lookup. The
  -- secret itself is only ever shown once, at creation.
  key_prefix  TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  scopes      TEXT[] NOT NULL DEFAULT '{}',
  last_used_at TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX api_keys_prefix_idx ON api_keys (key_prefix)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE api_keys IS
  'Device and service credentials. Devices authenticate POST /ingest; the '
  'simulation worker authenticates POST /internal/sim-event, replacing '
  'INGEST_INTERNAL_TOKEN.';

CREATE TRIGGER tenants_set_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- The scoping functions
--
-- STABLE and PARALLEL SAFE so the planner can inline them as a plain filter;
-- a VOLATILE function here would be re-evaluated per row and would block
-- parallel plans.
--
-- The `true` second argument to current_setting means "return NULL if unset"
-- rather than raising. Combined with `tenant_id = NULL` never being true, an
-- unscoped connection reads nothing.
-- -----------------------------------------------------------------------------

CREATE FUNCTION current_tenant_id() RETURNS UUID
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION current_user_id() RETURNS UUID
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

COMMENT ON FUNCTION current_tenant_id() IS
  'Reads the app.tenant_id GUC. Callers MUST set it transaction-locally '
  '(set_config(..., true)) so a pooled connection cannot carry one request''s '
  'tenant into the next.';

-- -----------------------------------------------------------------------------
-- tenant_id columns
--
-- Added nullable, backfilled, then constrained. The seeded database holds one
-- building, so the backfill is a single tenant; on an empty database every
-- UPDATE is a no-op and the NOT NULL still applies.
-- -----------------------------------------------------------------------------

ALTER TABLE thermal_profiles        ADD COLUMN tenant_id UUID;
ALTER TABLE occupancy_schedules     ADD COLUMN tenant_id UUID;
ALTER TABLE occupancy_schedule_days ADD COLUMN tenant_id UUID;
ALTER TABLE buildings               ADD COLUMN tenant_id UUID;
ALTER TABLE floors                  ADD COLUMN tenant_id UUID;
ALTER TABLE zones                   ADD COLUMN tenant_id UUID;
ALTER TABLE equipment               ADD COLUMN tenant_id UUID;
ALTER TABLE equipment_zone_service  ADD COLUMN tenant_id UUID;
ALTER TABLE sensors                 ADD COLUMN tenant_id UUID;
ALTER TABLE maintenance_logs        ADD COLUMN tenant_id UUID;
ALTER TABLE alert_rules             ADD COLUMN tenant_id UUID;
ALTER TABLE alerts                  ADD COLUMN tenant_id UUID;
ALTER TABLE alert_notifications     ADD COLUMN tenant_id UUID;
ALTER TABLE simulation_runs         ADD COLUMN tenant_id UUID;
ALTER TABLE simulation_results      ADD COLUMN tenant_id UUID;
ALTER TABLE weather_observations    ADD COLUMN tenant_id UUID;

-- -----------------------------------------------------------------------------
-- Backfill: everything that exists today belongs to one tenant.
-- -----------------------------------------------------------------------------

INSERT INTO tenants (slug, name)
SELECT 'corniche', 'Corniche Facilities'
 WHERE EXISTS (SELECT 1 FROM buildings);

-- Reference data (profiles, schedules) is assigned to the same tenant rather
-- than being left as a shared library. A shared catalogue is a real option, but
-- it needs a nullable tenant_id and a NULLS NOT DISTINCT unique index, and
-- "whose profile is this and who may edit it" becomes a question with no owner.
-- One tenant, one catalogue, until a second tenant proves otherwise.
UPDATE buildings b SET tenant_id = t.id FROM tenants t WHERE t.slug = 'corniche';
UPDATE thermal_profiles p SET tenant_id = t.id FROM tenants t WHERE t.slug = 'corniche';
UPDATE occupancy_schedules s SET tenant_id = t.id FROM tenants t WHERE t.slug = 'corniche';

UPDATE occupancy_schedule_days d SET tenant_id = s.tenant_id
  FROM occupancy_schedules s WHERE s.id = d.schedule_id;
UPDATE floors f SET tenant_id = b.tenant_id
  FROM buildings b WHERE b.id = f.building_id;
UPDATE zones z SET tenant_id = f.tenant_id
  FROM floors f WHERE f.id = z.floor_id;
UPDATE equipment e SET tenant_id = b.tenant_id
  FROM buildings b WHERE b.id = e.building_id;
UPDATE equipment_zone_service es SET tenant_id = e.tenant_id
  FROM equipment e WHERE e.id = es.equipment_id;
-- A sensor hangs off equipment OR a zone; take whichever is present.
UPDATE sensors s SET tenant_id = e.tenant_id
  FROM equipment e WHERE e.id = s.equipment_id;
UPDATE sensors s SET tenant_id = z.tenant_id
  FROM zones z WHERE z.id = s.zone_id AND s.tenant_id IS NULL;
UPDATE maintenance_logs m SET tenant_id = e.tenant_id
  FROM equipment e WHERE e.id = m.equipment_id;
-- A rule names exactly one scope (alert_rules_single_scope); COALESCE picks it.
UPDATE alert_rules r SET tenant_id = COALESCE(
    (SELECT tenant_id FROM buildings WHERE id = r.building_id),
    (SELECT tenant_id FROM floors    WHERE id = r.floor_id),
    (SELECT tenant_id FROM zones     WHERE id = r.zone_id),
    (SELECT tenant_id FROM equipment WHERE id = r.equipment_id),
    (SELECT tenant_id FROM sensors   WHERE id = r.sensor_id));
UPDATE alerts a SET tenant_id = r.tenant_id
  FROM alert_rules r WHERE r.id = a.rule_id;
UPDATE alert_notifications n SET tenant_id = a.tenant_id
  FROM alerts a WHERE a.id = n.alert_id;
UPDATE simulation_runs sr SET tenant_id = b.tenant_id
  FROM buildings b WHERE b.id = sr.building_id;
UPDATE simulation_results res SET tenant_id = sr.tenant_id
  FROM simulation_runs sr WHERE sr.id = res.run_id;
UPDATE weather_observations w SET tenant_id = b.tenant_id
  FROM buildings b WHERE b.id = w.building_id;

-- -----------------------------------------------------------------------------
-- Constrain
-- -----------------------------------------------------------------------------

ALTER TABLE thermal_profiles        ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE occupancy_schedules     ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE occupancy_schedule_days ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE buildings               ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE floors                  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE zones                   ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE equipment               ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE equipment_zone_service  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sensors                 ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE maintenance_logs        ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE alert_rules             ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE alerts                  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE alert_notifications     ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE simulation_runs         ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE simulation_results      ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE weather_observations    ALTER COLUMN tenant_id SET NOT NULL;

-- Direct tenant references, so deleting a tenant removes its world.
ALTER TABLE buildings ADD CONSTRAINT buildings_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE thermal_profiles ADD CONSTRAINT thermal_profiles_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE occupancy_schedules ADD CONSTRAINT occupancy_schedules_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

-- -----------------------------------------------------------------------------
-- Composite keys: a child's tenant_id must equal its parent's.
--
-- This is the structural half of the design. Without it, tenant_id is a
-- denormalised column maintained by convention, and one buggy INSERT puts a
-- zone in a tenant its floor does not belong to — invisible until it leaks.
--
-- The single-column FKs from 001/003/004 are deliberately LEFT IN PLACE. They
-- enforce a strict subset of what these do, cost only index maintenance, and
-- dropping them means guessing auto-generated constraint names.
--
-- ON DELETE SET NULL names its column list (PG15+). Plain SET NULL would try to
-- null tenant_id too, which is NOT NULL, and every parent delete would fail.
-- -----------------------------------------------------------------------------

ALTER TABLE buildings          ADD CONSTRAINT buildings_tenant_id_uq          UNIQUE (tenant_id, id);
ALTER TABLE floors             ADD CONSTRAINT floors_tenant_id_uq             UNIQUE (tenant_id, id);
ALTER TABLE zones              ADD CONSTRAINT zones_tenant_id_uq              UNIQUE (tenant_id, id);
ALTER TABLE equipment          ADD CONSTRAINT equipment_tenant_id_uq          UNIQUE (tenant_id, id);
ALTER TABLE sensors            ADD CONSTRAINT sensors_tenant_id_uq            UNIQUE (tenant_id, id);
ALTER TABLE alert_rules        ADD CONSTRAINT alert_rules_tenant_id_uq        UNIQUE (tenant_id, id);
ALTER TABLE alerts             ADD CONSTRAINT alerts_tenant_id_uq             UNIQUE (tenant_id, id);
ALTER TABLE simulation_runs    ADD CONSTRAINT simulation_runs_tenant_id_uq    UNIQUE (tenant_id, id);
ALTER TABLE thermal_profiles   ADD CONSTRAINT thermal_profiles_tenant_id_uq   UNIQUE (tenant_id, id);
ALTER TABLE occupancy_schedules ADD CONSTRAINT occupancy_schedules_tenant_id_uq UNIQUE (tenant_id, id);

ALTER TABLE occupancy_schedule_days ADD CONSTRAINT osd_schedule_tenant_fk
  FOREIGN KEY (tenant_id, schedule_id) REFERENCES occupancy_schedules (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE floors ADD CONSTRAINT floors_building_tenant_fk
  FOREIGN KEY (tenant_id, building_id) REFERENCES buildings (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE zones ADD CONSTRAINT zones_floor_tenant_fk
  FOREIGN KEY (tenant_id, floor_id) REFERENCES floors (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE zones ADD CONSTRAINT zones_thermal_profile_tenant_fk
  FOREIGN KEY (tenant_id, thermal_profile_id) REFERENCES thermal_profiles (tenant_id, id)
  ON DELETE SET NULL (thermal_profile_id);
ALTER TABLE zones ADD CONSTRAINT zones_occupancy_schedule_tenant_fk
  FOREIGN KEY (tenant_id, occupancy_schedule_id) REFERENCES occupancy_schedules (tenant_id, id)
  ON DELETE SET NULL (occupancy_schedule_id);

ALTER TABLE equipment ADD CONSTRAINT equipment_building_tenant_fk
  FOREIGN KEY (tenant_id, building_id) REFERENCES buildings (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE equipment ADD CONSTRAINT equipment_floor_tenant_fk
  FOREIGN KEY (tenant_id, floor_id) REFERENCES floors (tenant_id, id)
  ON DELETE SET NULL (floor_id);
ALTER TABLE equipment ADD CONSTRAINT equipment_zone_tenant_fk
  FOREIGN KEY (tenant_id, zone_id) REFERENCES zones (tenant_id, id)
  ON DELETE SET NULL (zone_id);
ALTER TABLE equipment ADD CONSTRAINT equipment_parent_tenant_fk
  FOREIGN KEY (tenant_id, parent_equipment_id) REFERENCES equipment (tenant_id, id)
  ON DELETE SET NULL (parent_equipment_id);

ALTER TABLE equipment_zone_service ADD CONSTRAINT eqzs_equipment_tenant_fk
  FOREIGN KEY (tenant_id, equipment_id) REFERENCES equipment (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE equipment_zone_service ADD CONSTRAINT eqzs_zone_tenant_fk
  FOREIGN KEY (tenant_id, zone_id) REFERENCES zones (tenant_id, id) ON DELETE CASCADE;

-- MATCH SIMPLE (the default) skips the check when any referencing column is
-- NULL, which is exactly right here: a sensor has equipment_id OR zone_id.
ALTER TABLE sensors ADD CONSTRAINT sensors_equipment_tenant_fk
  FOREIGN KEY (tenant_id, equipment_id) REFERENCES equipment (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE sensors ADD CONSTRAINT sensors_zone_tenant_fk
  FOREIGN KEY (tenant_id, zone_id) REFERENCES zones (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE maintenance_logs ADD CONSTRAINT maintenance_equipment_tenant_fk
  FOREIGN KEY (tenant_id, equipment_id) REFERENCES equipment (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_building_tenant_fk
  FOREIGN KEY (tenant_id, building_id) REFERENCES buildings (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_floor_tenant_fk
  FOREIGN KEY (tenant_id, floor_id) REFERENCES floors (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_zone_tenant_fk
  FOREIGN KEY (tenant_id, zone_id) REFERENCES zones (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_equipment_tenant_fk
  FOREIGN KEY (tenant_id, equipment_id) REFERENCES equipment (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_sensor_tenant_fk
  FOREIGN KEY (tenant_id, sensor_id) REFERENCES sensors (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE alerts ADD CONSTRAINT alerts_rule_tenant_fk
  FOREIGN KEY (tenant_id, rule_id) REFERENCES alert_rules (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE alerts ADD CONSTRAINT alerts_sensor_tenant_fk
  FOREIGN KEY (tenant_id, sensor_id) REFERENCES sensors (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE alerts ADD CONSTRAINT alerts_equipment_tenant_fk
  FOREIGN KEY (tenant_id, equipment_id) REFERENCES equipment (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE alerts ADD CONSTRAINT alerts_zone_tenant_fk
  FOREIGN KEY (tenant_id, zone_id) REFERENCES zones (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE alert_notifications ADD CONSTRAINT alert_notifications_alert_tenant_fk
  FOREIGN KEY (tenant_id, alert_id) REFERENCES alerts (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE simulation_runs ADD CONSTRAINT simulation_runs_building_tenant_fk
  FOREIGN KEY (tenant_id, building_id) REFERENCES buildings (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE simulation_results ADD CONSTRAINT simulation_results_run_tenant_fk
  FOREIGN KEY (tenant_id, run_id) REFERENCES simulation_runs (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE weather_observations ADD CONSTRAINT weather_building_tenant_fk
  FOREIGN KEY (tenant_id, building_id) REFERENCES buildings (tenant_id, id) ON DELETE CASCADE;

-- -----------------------------------------------------------------------------
-- Uniqueness that was global becomes per-tenant
--
-- Two operators will both run an 'AHU-03/SAT' and both call a profile
-- 'Perimeter office'. A global unique constraint makes the second tenant
-- unonboardable.
-- -----------------------------------------------------------------------------

ALTER TABLE sensors DROP CONSTRAINT sensors_external_id_key;
ALTER TABLE sensors ADD CONSTRAINT sensors_tenant_external_id_uq
  UNIQUE (tenant_id, external_id);

ALTER TABLE thermal_profiles DROP CONSTRAINT thermal_profiles_name_key;
ALTER TABLE thermal_profiles ADD CONSTRAINT thermal_profiles_tenant_name_uq
  UNIQUE (tenant_id, name);

ALTER TABLE occupancy_schedules DROP CONSTRAINT occupancy_schedules_name_key;
ALTER TABLE occupancy_schedules ADD CONSTRAINT occupancy_schedules_tenant_name_uq
  UNIQUE (tenant_id, name);

-- -----------------------------------------------------------------------------
-- Acknowledgement identity
--
-- `acknowledged_by TEXT` accepted whatever the caller sent — a P0 in the CTO
-- assessment. It becomes a real reference, resolved from the session.
-- The old free-text value is preserved rather than discarded: it is the only
-- record of who acknowledged the alerts raised before this migration.
-- -----------------------------------------------------------------------------

ALTER TABLE alerts RENAME COLUMN acknowledged_by TO acknowledged_by_legacy;
ALTER TABLE alerts ADD COLUMN acknowledged_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- Indexes on tenant_id
--
-- Leading tenant_id on the paths that filter by it. Every RLS-protected query
-- carries `tenant_id = …`, so a composite starting with it serves both the
-- policy and the query's own predicate from one index.
-- -----------------------------------------------------------------------------

CREATE INDEX buildings_tenant_idx        ON buildings (tenant_id);
CREATE INDEX floors_tenant_building_idx  ON floors (tenant_id, building_id);
CREATE INDEX zones_tenant_floor_idx      ON zones (tenant_id, floor_id);
CREATE INDEX equipment_tenant_bldg_idx   ON equipment (tenant_id, building_id);
CREATE INDEX sensors_tenant_active_idx   ON sensors (tenant_id) WHERE is_active;
CREATE INDEX alert_rules_tenant_idx      ON alert_rules (tenant_id) WHERE enabled;
CREATE INDEX alerts_tenant_open_idx      ON alerts (tenant_id, opened_at DESC)
  WHERE state <> 'resolved';
CREATE INDEX simulation_runs_tenant_idx  ON simulation_runs (tenant_id, requested_at DESC);
CREATE INDEX weather_tenant_idx          ON weather_observations (tenant_id, time DESC);

-- -----------------------------------------------------------------------------
-- Row-level security
--
-- FORCE as well as ENABLE: without FORCE the table owner bypasses its own
-- policies, and the owner is who the migration runner and any psql session
-- connect as. A policy nobody in practice is subject to is decoration.
--
-- `telemetry` is absent on purpose — it is compressed, and TimescaleDB 2.30
-- refuses RLS on a compressed hypertable. See 008.
-- -----------------------------------------------------------------------------

DO $rls$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'thermal_profiles', 'occupancy_schedules', 'occupancy_schedule_days',
    'buildings', 'floors', 'zones', 'equipment', 'equipment_zone_service',
    'sensors', 'maintenance_logs', 'alert_rules', 'alerts',
    'alert_notifications', 'simulation_runs', 'simulation_results',
    'weather_observations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I
         USING      (tenant_id = current_tenant_id())
         WITH CHECK (tenant_id = current_tenant_id())', t || '_tenant', t);
  END LOOP;
END $rls$;

-- -----------------------------------------------------------------------------
-- The application role
--
-- Services stop connecting as the superuser that owns the schema. This is not
-- hygiene, it is load-bearing: a superuser bypasses RLS unconditionally,
-- including FORCE, so every policy above is inert for `dtwin`.
--
-- Roles are cluster-scoped, not database-scoped, so this survives a DROP
-- DATABASE and must be created conditionally or re-migrating fails.
--
-- The development password matches the convention already used for
-- POSTGRES_PASSWORD. ROTATE IT ANYWHERE THAT IS NOT A LAPTOP:
--   ALTER ROLE dtwin_app PASSWORD '…';
-- -----------------------------------------------------------------------------

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dtwin_app') THEN
    CREATE ROLE dtwin_app LOGIN PASSWORD 'dtwin_app_dev_pwd';
  END IF;
END $role$;

GRANT USAGE ON SCHEMA public TO dtwin_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  thermal_profiles, occupancy_schedules, occupancy_schedule_days,
  buildings, floors, zones, equipment, equipment_zone_service,
  sensors, maintenance_logs, alert_rules, alerts, alert_notifications,
  simulation_runs, simulation_results, weather_observations
TO dtwin_app;

-- Identity tables are NOT under tenant RLS, and cannot be: authentication runs
-- before a tenant is known. Looking up a session by its token hash, or an API
-- key by its hash, has to happen with app.tenant_id unset. Scoping for these is
-- the auth code path's job, and it is the one place that has to be read
-- carefully rather than trusted to the database.
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, users, tenant_members, sessions, api_keys
  TO dtwin_app;

GRANT EXECUTE ON FUNCTION current_tenant_id(), current_user_id() TO dtwin_app;

-- Read-only visibility into migration state, for the smoke suites.
GRANT SELECT ON schema_migrations TO dtwin_app;
