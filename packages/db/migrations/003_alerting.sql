-- =============================================================================
-- 003_alerting.sql — rule definitions and raised alerts
-- =============================================================================

CREATE TYPE alert_condition AS ENUM (
  'threshold_above',          -- value > threshold
  'threshold_below',          -- value < threshold
  'rate_of_change',           -- |d(value)/dt| over window_s > threshold  (thermal drift)
  'deviation_from_setpoint',  -- |value - setpoint| > threshold           (comfort breach)
  'flatline',                 -- value unchanged for window_s             (stuck sensor)
  'no_data',                  -- nothing received for window_s            (dead point)
  'out_of_range'              -- outside the sensor's plausible band
);

CREATE TYPE alert_severity AS ENUM ('info', 'warning', 'critical');
CREATE TYPE alert_state    AS ENUM ('open', 'acknowledged', 'resolved');

-- -----------------------------------------------------------------------------
-- Rules
--
-- Scope is one of five levels, exactly one set. A rule written against a zone or
-- a building fans out to every matching sensor at evaluation time, so adding a
-- point to a zone inherits the zone's rules automatically rather than needing a
-- new rule row.
-- -----------------------------------------------------------------------------

CREATE TABLE alert_rules (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  description           TEXT,

  building_id           UUID REFERENCES buildings(id) ON DELETE CASCADE,
  floor_id              UUID REFERENCES floors(id)    ON DELETE CASCADE,
  zone_id               UUID REFERENCES zones(id)     ON DELETE CASCADE,
  equipment_id          UUID REFERENCES equipment(id) ON DELETE CASCADE,
  sensor_id             UUID REFERENCES sensors(id)   ON DELETE CASCADE,

  -- Which metric this rule watches. Required for scopes broader than a single
  -- sensor (a zone has many points); redundant but harmless when sensor_id is set.
  metric                metric_type,
  condition             alert_condition NOT NULL,
  threshold             DOUBLE PRECISION,
  -- Evaluation window for the windowed conditions.
  window_s              INTEGER CHECK (window_s > 0),
  -- Debounce: how many consecutive breaching evaluations before the alert
  -- opens. Stops a single noisy sample from paging a facility manager.
  consecutive_breaches  INTEGER NOT NULL DEFAULT 1 CHECK (consecutive_breaches >= 1),
  -- Minimum gap before the same rule+target may re-open after resolving.
  cooldown_s            INTEGER NOT NULL DEFAULT 900 CHECK (cooldown_s >= 0),
  severity              alert_severity NOT NULL DEFAULT 'warning',
  enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  -- Channel config, e.g. {"email": ["fm@site"], "webhook": "https://..."}
  notify                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Exactly one scope target.
  CONSTRAINT alert_rules_single_scope CHECK (
    (building_id  IS NOT NULL)::int +
    (floor_id     IS NOT NULL)::int +
    (zone_id      IS NOT NULL)::int +
    (equipment_id IS NOT NULL)::int +
    (sensor_id    IS NOT NULL)::int = 1
  ),
  -- Threshold conditions need a number; window conditions need a window.
  CONSTRAINT alert_rules_threshold_present CHECK (
    condition IN ('flatline', 'no_data', 'out_of_range') OR threshold IS NOT NULL
  ),
  CONSTRAINT alert_rules_window_present CHECK (
    condition NOT IN ('rate_of_change', 'flatline', 'no_data') OR window_s IS NOT NULL
  ),
  -- Anything broader than one point must say what it is watching.
  CONSTRAINT alert_rules_metric_present CHECK (
    sensor_id IS NOT NULL OR metric IS NOT NULL
  )
);

-- -----------------------------------------------------------------------------
-- Raised alerts
--
-- A plain table, not a hypertable. Alerts are low-volume and are almost always
-- queried by state ("what is open right now?") rather than by time range, which
-- is the opposite of the access pattern hypertables optimise for.
-- -----------------------------------------------------------------------------

CREATE TABLE alerts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id         UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,

  -- Resolved target: which concrete point/asset actually breached. A zone-scoped
  -- rule fans out, so these are more specific than the rule's own scope.
  sensor_id       UUID REFERENCES sensors(id)   ON DELETE CASCADE,
  equipment_id    UUID REFERENCES equipment(id) ON DELETE CASCADE,
  zone_id         UUID REFERENCES zones(id)     ON DELETE CASCADE,

  severity        alert_severity NOT NULL,
  state           alert_state NOT NULL DEFAULT 'open',
  message         TEXT NOT NULL,
  trigger_value   DOUBLE PRECISION,
  threshold       DOUBLE PRECISION,   -- snapshot; the rule may be edited later
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  resolved_at     TIMESTAMPTZ,
  context         JSONB NOT NULL DEFAULT '{}'::jsonb,

  CHECK (resolved_at     IS NULL OR resolved_at     >= opened_at),
  CHECK (acknowledged_at IS NULL OR acknowledged_at >= opened_at),
  CHECK ((state = 'resolved') = (resolved_at IS NOT NULL))
);

CREATE INDEX alert_rules_enabled_idx ON alert_rules (enabled) WHERE enabled;
CREATE INDEX alert_rules_sensor_idx  ON alert_rules (sensor_id);
CREATE INDEX alert_rules_zone_idx    ON alert_rules (zone_id);

CREATE INDEX alerts_open_idx      ON alerts (opened_at DESC) WHERE state <> 'resolved';
CREATE INDEX alerts_rule_idx      ON alerts (rule_id, opened_at DESC);
CREATE INDEX alerts_sensor_idx    ON alerts (sensor_id, opened_at DESC);
CREATE INDEX alerts_zone_idx      ON alerts (zone_id, opened_at DESC);

-- One live alert per rule+sensor. Without this a flapping sensor stacks
-- duplicate open alerts for the same underlying problem.
CREATE UNIQUE INDEX alerts_one_open_per_target_uidx
  ON alerts (rule_id, COALESCE(sensor_id, equipment_id, zone_id))
  WHERE state <> 'resolved';

CREATE TRIGGER alert_rules_set_updated_at BEFORE UPDATE ON alert_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
