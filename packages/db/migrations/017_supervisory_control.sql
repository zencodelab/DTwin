-- =============================================================================
-- 017_supervisory_control.sql — the twin is allowed to act
--
-- Everything before this reads the building. This is the first thing that
-- writes to it, and the difference is not one of degree: a wrong number on a
-- dashboard is read by someone who can disbelieve it, and a wrong setpoint is
-- obeyed. So the schema carries the safety properties rather than leaving them
-- to whichever service happens to issue the command. See docs/decisions.md §62.
--
-- FOUR DECISIONS ARE IN THIS FILE RATHER THAN IN CODE
--
-- 1. A COMMAND IS AN OVERRIDE WITH AN EXPIRY, NOT AN EDIT TO THE BASELINE.
--
--    `thermal_profiles.setpoint_temp_c` is the building's designed setpoint and
--    this table never touches it. A command is a temporary override that
--    lapses at `effective_until`, after which the zone is back to its baseline
--    because nothing is overriding it any more — no revert command, no
--    cleanup job, no service that has to still be alive.
--
--    That is the deadman. The failure this is built around is not a bad
--    command; it is a good command followed by a dead optimiser, holding every
--    zone at 19 °C through a weekend with nobody able to say why. An override
--    that expires cannot do that. A row that edited the profile could.
--
-- 2. ONE LIVE COMMAND PER ZONE, ENFORCED BY AN INDEX.
--
--    Two operators, or one operator and an optimiser, can both decide a zone
--    is wrong. A queue of pending commands would apply all of them in sequence
--    — every stale intention eventually reaching the equipment. The partial
--    unique index below makes the second request fail loudly at the moment it
--    is made, while the person is still there to be told.
--
-- 3. BOTH CLOCKS ARE IN THE ROW, AND THEY ARE DIFFERENT CLOCKS.
--
--    `expires_at` is how long the INTENT is good for — a command the gateway
--    could not collect because it was offline must not be applied when the
--    network heals twenty minutes later; the operator meant then, not now.
--    `effective_until` is how long the EFFECT lasts once applied. Conflating
--    them gives you either commands that never lapse or overrides that never
--    take.
--
-- 4. THE LEASE IS THE ONE FROM §51, FOR THE SAME REASON.
--
--    A gateway claims a command, may die holding it, and must not hold it
--    forever. At-least-once is the honest limit of a lease: a merely slow
--    gateway can lose its claim and a command can be delivered twice, so the
--    command id is what a gateway keys idempotency on. Applying the same
--    setpoint twice is harmless; that is not an accident of this design, it is
--    why the commandable quantity is a SETPOINT (a level) rather than a
--    relative adjustment (an increment), which would not be safe to repeat.
-- =============================================================================

CREATE TYPE control_command_state AS ENUM (
  'pending',     -- accepted, not yet collected
  'dispatched',  -- claimed by a gateway, under lease
  'applied',     -- the equipment confirmed it
  'failed',      -- the gateway tried and could not
  'expired',     -- nobody collected it in time; never applied
  'cancelled',   -- withdrawn by a person before it was applied
  'superseded'   -- an override replaced by a later one on the same zone
);

CREATE TABLE control_commands (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  zone_id           UUID NOT NULL,

  -- The commanded value, in the unit its name carries, like every other column
  -- in this schema. A LEVEL, never a delta: see decision 4 above.
  setpoint_temp_c   DOUBLE PRECISION NOT NULL,
  -- What it was when the command was issued. Audit, and what a reader needs to
  -- judge the command without reconstructing the profile as it stood.
  previous_temp_c   DOUBLE PRECISION,

  state             control_command_state NOT NULL DEFAULT 'pending',

  -- Why. Free text, required, and not a nicety: a control action with no
  -- recorded reason is indistinguishable six months later from a mistake.
  reason            TEXT NOT NULL,

  -- WHO. A foreign key to users, never a caller-supplied string — the lesson
  -- `alerts.acknowledged_by` had to learn twice (007). An audit trail that
  -- accepts whatever the request body says is worth nothing.
  requested_by      UUID NOT NULL REFERENCES users(id),
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  expires_at        TIMESTAMPTZ NOT NULL,
  effective_until   TIMESTAMPTZ NOT NULL,

  -- Lease, exactly as alert_notifications does it (§51).
  claimed_at        TIMESTAMPTZ,
  claimed_by        TEXT,
  attempts          INT NOT NULL DEFAULT 0,

  applied_at        TIMESTAMPTZ,
  settled_at        TIMESTAMPTZ,
  -- Why it failed, was refused, or was cancelled. Null while it is still live.
  outcome_detail    TEXT,

  CONSTRAINT control_commands_window_ck CHECK (effective_until > expires_at),
  CONSTRAINT control_commands_plausible_ck
    CHECK (setpoint_temp_c > -50.0 AND setpoint_temp_c < 60.0)
);

-- Composite, so a command cannot be re-parented onto another tenant's zone
-- (§39). The tenant travels in the key, not merely alongside it.
ALTER TABLE control_commands
  ADD CONSTRAINT control_commands_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE control_commands
  ADD CONSTRAINT control_commands_zone_fk
  FOREIGN KEY (tenant_id, zone_id) REFERENCES zones (tenant_id, id) ON DELETE CASCADE;

-- Decision 2. `pending` and `dispatched` are the live states; everything else
-- is history and may repeat freely.
CREATE UNIQUE INDEX control_commands_one_live_idx
  ON control_commands (tenant_id, zone_id)
  WHERE state IN ('pending', 'dispatched');

-- The gateway's poll: its own tenant's collectable commands, oldest first.
CREATE INDEX control_commands_collectable_idx
  ON control_commands (tenant_id, requested_at)
  WHERE state IN ('pending', 'dispatched');

-- "What is overriding this zone right now" — asked on every simulator tick and
-- every dashboard read, so it gets an index rather than a scan of history.
CREATE INDEX control_commands_active_idx
  ON control_commands (tenant_id, zone_id, effective_until DESC)
  WHERE state = 'applied';

COMMENT ON TABLE control_commands IS
  'Supervisory setpoint overrides. An override EXPIRES (effective_until) rather '
  'than being reverted, so a dead optimiser cannot hold a building. Never edit '
  'thermal_profiles.setpoint_temp_c to apply one — that is the baseline.';

-- -----------------------------------------------------------------------------
-- The envelope, and the switch
--
-- Per tenant, because "how far may the twin move a setpoint" is a question
-- about a building and its operator's appetite, not about this deployment.
--
-- `enabled` DEFAULTS TO FALSE, and that default is the important line in this
-- file. Notifications are off by default so a development database does not
-- start calling someone's webhook; control is off by default because an
-- outward-ACTING capability must never switch itself on merely because a
-- service booted and a table existed. Turning it on is a decision somebody has
-- to make, on the record.
-- -----------------------------------------------------------------------------

CREATE TABLE control_settings (
  tenant_id            UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,

  -- The kill switch. One row, one boolean, and the dispatch path reads it every
  -- time rather than caching it — a kill switch you have to restart to use is
  -- not one.
  enabled              BOOLEAN NOT NULL DEFAULT false,

  -- How far from the zone's OWN designed setpoint a command may move it. Not a
  -- global temperature range: §14 says the register governs, and a server room
  -- and an open-plan floor do not share an envelope. ±3 K of the profile is a
  -- comfort-band reset, which is what supervisory control is for.
  max_deviation_k      DOUBLE PRECISION NOT NULL DEFAULT 3.0,

  -- The largest single step. Bounds the blast radius of one fat finger, and
  -- keeps the building from being walked to an extreme in one move.
  max_step_k           DOUBLE PRECISION NOT NULL DEFAULT 2.0,

  -- Anti-hunting. Equipment life is spent in cycles, so a setpoint that can be
  -- moved every ten seconds is a compressor being destroyed on purpose.
  min_interval_s       INT NOT NULL DEFAULT 900,

  -- How long an override lasts if the requester does not say.
  default_duration_s   INT NOT NULL DEFAULT 3600,
  -- And the longest it may last. An override is supervisory, not permanent;
  -- something that should hold for a week is a change to the profile, made by
  -- a person who has to look at the profile.
  max_duration_s       INT NOT NULL DEFAULT 43200,

  -- How long a command may sit uncollected before the intent goes stale.
  command_ttl_s        INT NOT NULL DEFAULT 300,

  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by           UUID REFERENCES users(id),

  CONSTRAINT control_settings_sane_ck CHECK (
    max_deviation_k > 0 AND max_step_k > 0 AND min_interval_s >= 0
    AND default_duration_s > 0 AND max_duration_s >= default_duration_s
    AND command_ttl_s > 0
  )
);

COMMENT ON COLUMN control_settings.enabled IS
  'Kill switch. Read on every dispatch, never cached: a kill switch that needs '
  'a restart is not a kill switch. Defaults to FALSE — control is opt-in.';

-- -----------------------------------------------------------------------------
-- Row-level security, as every tenant-owned table gets (§40). FORCE so the
-- table owner is not exempt, and WITH CHECK so a write cannot place a row
-- outside the tenant that wrote it.
-- -----------------------------------------------------------------------------

ALTER TABLE control_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY control_commands_tenant ON control_commands
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE control_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY control_settings_tenant ON control_settings
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON control_commands TO dtwin_app;
GRANT SELECT, INSERT, UPDATE ON control_settings TO dtwin_app;

-- No DELETE, deliberately. A control action is an audit record; the way to end
-- one is to cancel it or let it lapse, both of which leave the history intact.
-- A tenant being deleted still cascades, which is the one case where the
-- history should go.
