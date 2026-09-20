import type { AlertWithContext } from '@dtwin/types';

/**
 * Reconciling the alert list: a snapshot over HTTP, and events over a socket.
 *
 * The dashboard fetched the open alerts once, when it mounted, and merged live
 * events over them. `alert.resolved` removed the alert from the LIVE list only,
 * so an alert that was already open when the page loaded stayed on screen after
 * it resolved, for as long as the page stayed open. An operator acts on that
 * list. (docs/cto-assessment.md had this as a P0; docs/decisions.md §56.)
 *
 * The rule, in full: **the snapshot is the truth about everything before it
 * was requested, and events are the truth about everything after.**
 *
 *   - An event older than the snapshot is dropped: whatever it said, the
 *     snapshot already reflects it or has superseded it. This is what makes a
 *     refetch after a reconnect correct — an alert raised while connected and
 *     resolved during the gap would otherwise be resurrected from the live
 *     list by a merge that trusted it.
 *   - An event newer than the snapshot is applied on top, in order. A
 *     `resolved` removes the alert wherever it came from.
 *
 * "Requested", not "received": the database was read somewhere between those
 * two moments, and an event in that window may or may not be in the rows.
 * Applying it again is harmless — upsert and remove are both idempotent —
 * whereas dropping it would lose it.
 */
export interface AlertEvent {
  kind: 'upsert' | 'resolved';
  alert: AlertWithContext;
  /** This browser's clock when the frame arrived, epoch ms. */
  at: number;
}

/**
 * Most alerts with a remembered event. Bounds a tab left open for a week.
 *
 * Only the LATEST event per alert is kept, which loses nothing: upsert and
 * resolve are both last-writer-wins for their alert, so every earlier event
 * for the same id is dead the moment a later one arrives. The list is
 * therefore sized by distinct alerts, not by traffic. Past the ceiling the
 * oldest goes — and the dashboard refetches its snapshot every few minutes, so
 * by then that event is older than the snapshot and would be ignored anyway.
 */
export const MAX_ALERT_EVENTS = 500;

export function appendAlertEvent(events: AlertEvent[], event: AlertEvent): AlertEvent[] {
  const next = events.filter((e) => e.alert.id !== event.alert.id);
  next.push(event);
  return next.length > MAX_ALERT_EVENTS ? next.slice(next.length - MAX_ALERT_EVENTS) : next;
}

export function reconcileAlerts(
  snapshot: AlertWithContext[],
  /** When the snapshot was REQUESTED, epoch ms; null before the first one lands. */
  snapshotAt: number | null,
  events: AlertEvent[],
): AlertWithContext[] {
  const open = new Map(snapshot.map((a) => [a.id, a]));

  for (const event of events) {
    if (snapshotAt !== null && event.at < snapshotAt) continue;
    if (event.kind === 'resolved') open.delete(event.alert.id);
    else open.set(event.alert.id, event.alert);
  }

  // A snapshot is "non-resolved" by query, and an upsert never carries
  // `resolved` — but the filter costs nothing and the list is acted on.
  //
  // Sorted the way `/api/alerts` sorts, so an alert does not change position
  // depending on which of the two paths delivered it: a critical raised live
  // belongs at the top, not appended under an hour of warnings.
  return [...open.values()]
    .filter((a) => a.state !== 'resolved')
    .sort((a, b) =>
      severityRank(a.severity) - severityRank(b.severity)
      || new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime());
}

function severityRank(severity: string): number {
  return severity === 'critical' ? 0 : severity === 'warning' ? 1 : 2;
}
