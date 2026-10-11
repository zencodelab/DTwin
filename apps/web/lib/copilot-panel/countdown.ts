/**
 * The plan card's countdown to `expiresAt` (design §8 "Plan TTL", §9.4).
 *
 * A plan is reviewed with a fresh dry run and is good for PLAN_TTL_S after
 * it. Past that the route refuses a decision (409 plan_expired) and nothing
 * is issued, so the card must not invite a click the server will refuse —
 * and the operator should see the window closing, not discover it.
 *
 * The expiry is the SERVER's instant and the tick is the browser's clock. A
 * laptop a few minutes off would show a plan as live that the route has
 * already refused, or refused that it would still take. The response's
 * `Date` header gives the offset; seconds of it are the header's own
 * resolution and are ignored.
 */

/** Below this, an offset is the Date header's one-second resolution, not a wrong clock. */
const SKEW_FLOOR_MS = 2_000;

/** How far the server's clock is ahead of this one, from a response's `Date` header. */
export function clockSkewMs(dateHeader: string | null | undefined, receivedAtMs: number): number {
  if (!dateHeader) return 0;
  const server = Date.parse(dateHeader);
  if (!Number.isFinite(server)) return 0;
  const skew = server - receivedAtMs;
  return Math.abs(skew) < SKEW_FLOOR_MS ? 0 : skew;
}

export interface Countdown {
  /** Whole seconds left, never negative. */
  secondsLeft: number;
  expired: boolean;
  /** The last minute: the card says so louder. */
  urgent: boolean;
  text: string;
}

/**
 * Time left on a plan. An unparseable expiry counts as expired: the card
 * then asks for a fresh plan rather than offering a decision it cannot time.
 */
/**
 * The zones the building view lights for a plan: its commands' zones while
 * the plan can still be decided, and none once it has expired. The glow says
 * "this is being decided"; past `expiresAt` the route refuses any decision,
 * and a building still glowing — while the card, hidden behind a zone panel,
 * said "expired" — told the operator a decision was open that was not
 * (review, ADR 64).
 */
export function planHighlight(
  plan: { expiresAt: string; commands: ReadonlyArray<{ zoneId: string }> } | null, nowMs: number, skewMs = 0,
): string[] {
  if (plan === null || countdown(plan.expiresAt, nowMs, skewMs).expired) return [];
  return plan.commands.map((c) => c.zoneId);
}

export function countdown(expiresAt: string, nowMs: number, skewMs = 0): Countdown {
  const end = Date.parse(expiresAt);
  const left = Number.isFinite(end) ? Math.floor((end - (nowMs + skewMs)) / 1000) : 0;
  if (left <= 0) return { secondsLeft: 0, expired: true, urgent: true, text: 'expired' };
  const m = Math.floor(left / 60);
  const s = left % 60;
  return { secondsLeft: left, expired: false, urgent: left <= 60, text: `${m}:${String(s).padStart(2, '0')} left` };
}
