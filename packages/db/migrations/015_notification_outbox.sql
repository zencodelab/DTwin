-- =============================================================================
-- 015_notification_outbox.sql — make the delivery record survive a crash, and
-- make two workers stop sending the same alert twice
--
-- 006 recorded delivery so "was anyone told?" had an answer. It had two holes,
-- both named in docs/cto-assessment.md.
--
-- **The record was written after the alert, in a different transaction.** The
-- engine opened the alert, committed, and then called the notifier, which
-- inserted the `pending` rows. A crash in between left an alert with no
-- notification rows at all — and nothing would ever create them, because the
-- retry sweep only retries rows that EXIST. The alert was in the database and
-- the intent to tell someone about it was not.
--
-- The rows are now written in the SAME transaction as the alert (see
-- store.openAlert). That is the whole of the outbox pattern: the table is the
-- source of truth for what must be delivered, and the in-process dispatch that
-- follows is a latency optimisation whose failure costs one sweep interval,
-- not a notification.
--
-- **Nothing stopped two workers delivering the same row.** The sweep did a
-- plain SELECT and then delivered, so two replicas read the same `pending` row
-- and both sent it. `claimed_at` plus `FOR UPDATE SKIP LOCKED` gives each row
-- to one worker; the lease means a worker that dies mid-delivery releases its
-- rows rather than holding them forever.
--
-- A lease can still deliver twice if a worker is slow rather than dead — the
-- honest limit of at-least-once. The receiver's own idempotency is what closes
-- that, and the alert id in every payload is what it would key on.
-- =============================================================================

ALTER TABLE alert_notifications
  ADD COLUMN claimed_at TIMESTAMPTZ;

COMMENT ON COLUMN alert_notifications.claimed_at IS
  'When a worker took this row for delivery. Older than the lease means the '
  'worker is presumed gone and the row is claimable again. See decisions.md 51.';

-- The sweep asks for rows that are undelivered, under their attempt bound, and
-- either unclaimed or whose lease has expired. Ordering by created_at keeps
-- the oldest alert first, which is the one someone is most likely waiting on.
DROP INDEX IF EXISTS alert_notifications_pending_idx;
CREATE INDEX alert_notifications_claimable_idx
  ON alert_notifications (created_at)
  INCLUDE (claimed_at, attempts)
  WHERE status <> 'delivered';
