-- =============================================================================
-- 006_notifications.sql — delivery record for alert notifications
--
-- `alert_rules.notify` has held channel configuration since 003 and nothing has
-- ever read it. Delivering a notification is not fire-and-forget: the first
-- question after an incident is "was anyone actually told?", and an in-memory
-- counter cannot answer it after a restart.
--
-- One row per (alert, channel, target) attempt, so delivery is auditable and a
-- failed send is visible rather than lost in a log.
-- =============================================================================

CREATE TYPE notification_channel AS ENUM ('webhook', 'email', 'log');

CREATE TYPE notification_status AS ENUM ('pending', 'delivered', 'failed');

CREATE TABLE alert_notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id     UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  channel      notification_channel NOT NULL,
  -- The webhook URL or email address this attempt was aimed at. Recorded
  -- alongside the attempt because `alert_rules.notify` can be edited later, and
  -- the audit answer must be where it WAS sent, not where it would go now.
  target       TEXT NOT NULL,
  status       notification_status NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error   TEXT,
  delivered_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))
);

-- One record per alert+channel+target. A rule that fires repeatedly opens one
-- alert (003's partial unique index), so this is the natural grain and makes
-- retries idempotent.
CREATE UNIQUE INDEX alert_notifications_target_uidx
  ON alert_notifications (alert_id, channel, target);

CREATE INDEX alert_notifications_alert_idx ON alert_notifications (alert_id);
-- The retry sweep only cares about what has not landed.
CREATE INDEX alert_notifications_pending_idx
  ON alert_notifications (created_at)
  WHERE status <> 'delivered';
