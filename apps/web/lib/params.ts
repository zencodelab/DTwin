import { NextResponse } from 'next/server';

/**
 * Query-string parsing for the API routes.
 *
 * Two routes read `?hours=` with a bare `Number(...)`. That accepts `abc`,
 * which becomes NaN, then an Invalid Date, then a Postgres error and a 500 —
 * and it accepts `1e9`, which becomes a rollup scan across every chunk the
 * hypertable has. Neither is a request the server should attempt, and both are
 * the caller's to fix, so both are a 400 that says what the limit is.
 *
 * Rejected rather than clamped. Clamping answers a different question from the
 * one asked without saying so: a chart requesting ten years and silently given
 * a week draws a week and labels it ten years.
 */
export type Parsed<T> = { ok: true; value: T } | { ok: false; response: NextResponse };

export function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

export function parseHours(
  raw: string | null,
  options: { fallback: number; max: number },
): Parsed<number> {
  if (raw === null) return { ok: true, value: options.fallback };

  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    return { ok: false, response: badRequest('hours must be a positive number') };
  }
  if (hours > options.max) {
    return {
      ok: false,
      response: badRequest(`hours must be at most ${options.max} for this query`),
    };
  }
  return { ok: true, value: hours };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An id that is going into a `uuid` column comparison.
 *
 * Postgres raises on a malformed uuid rather than matching nothing, so an
 * unchecked path segment turns a typo into a 500.
 */
export function parseUuid(raw: string | null, name: string): Parsed<string> {
  if (!raw) return { ok: false, response: badRequest(`${name} is required`) };
  if (!UUID.test(raw)) return { ok: false, response: badRequest(`${name} must be a uuid`) };
  return { ok: true, value: raw };
}
