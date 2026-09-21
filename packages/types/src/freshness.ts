/**
 * When a reading is too old to believe.
 *
 * One definition, because there are three consumers and they must not drift:
 * the zone panel's first paint (SQL, `getZoneDetail`), the live map
 * (`apps/web/lib/live.ts`, §55) and — the reason this moved out of the web
 * app — the supervisory control envelope (§62).
 *
 * The display rule and the control rule have to be the same rule. A map that
 * greys a zone because its sensor is dead, beside a control path that would
 * happily command that zone anyway, is a system disagreeing with itself about
 * what it knows, and the half that acts is the half that matters.
 *
 * SQL keeps its own copy of the multiple, necessarily — `now() - t.time >
 * s.sample_interval_s * 3 * INTERVAL '1 second'`. That one is commented to
 * point here. Three copies would be careless; two, one of which cannot import,
 * is the cost of doing the first paint in the database.
 */

/**
 * Missed samples before a point is considered stale.
 *
 * Three rather than one because a single missed sample is ordinary — a
 * gateway's flush landing on the wrong side of a tick — and calling that a
 * fault would make the mark meaningless. Three consecutive misses is a point
 * that has stopped reporting.
 */
export const STALE_INTERVALS = 3;

export function staleAfterMs(sampleIntervalS: number): number {
  return sampleIntervalS * STALE_INTERVALS * 1000;
}

/**
 * Age of a reading in ms, given when it was taken and when it arrived.
 *
 * `min(ts, receivedAt)`: a device clock running ahead cannot make a reading
 * look fresher than its own arrival, and a reading backfilled from yesterday
 * is as old as its timestamp says however recently it turned up.
 */
export function readingAgeMs(
  ts: number, receivedAt: number, now: number, notBefore = 0,
): number {
  return Math.max(0, now - Math.max(Math.min(ts, receivedAt), notBefore));
}

/** Whether a reading of `sampleIntervalS` taken at `ts` is stale at `now`. */
export function isReadingStale(
  ts: number, receivedAt: number, sampleIntervalS: number, now: number, notBefore = 0,
): boolean {
  return readingAgeMs(ts, receivedAt, now, notBefore) > staleAfterMs(sampleIntervalS);
}
