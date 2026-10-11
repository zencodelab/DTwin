/**
 * "Now", as the building sees it.
 *
 * Operators ask in local time — "since 9", "this morning", "last week" — and
 * the device simulator runs occupancy and outdoor temperature on the
 * building's clock (Asia/Dubai for the seeded tower). A model handed a UTC
 * instant resolves "since 9" to 09:00 UTC, which is 13:00 in the building,
 * and answers a question nobody asked. So every request carries now as an
 * ISO timestamp WITH the building's offset, the local date and the weekday,
 * and every tool refuses a timestamp that has no offset.
 *
 * Computed with Intl rather than a date library: the offset is whatever the
 * platform's time-zone database says for that instant, which is right across
 * DST changes and half-hour zones without a table of our own to go stale.
 */

export const WEEKDAYS = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface LocalStamp {
  /** e.g. 2026-09-28T12:40:00+04:00 — whole seconds, the building's offset. */
  nowIso: string;
  /** e.g. 2026-09-28, the building's calendar date. */
  localDate: string;
  weekday: Weekday;
  /** The IANA name it was computed for, e.g. Asia/Dubai. */
  timezone: string;
}

// One formatter per zone. Bounded by the IANA database (a few hundred names):
// an invalid name throws before it is cached.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      // h23, not hour12:false — the latter renders midnight as "24" on some
      // platforms, which would put the stamp a day ahead.
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      weekday: 'long',
    });
    formatters.set(timezone, f);
  }
  return f;
}

/** True for a name the platform's time-zone database accepts. */
export function isValidTimeZone(timezone: string): boolean {
  if (typeof timezone !== 'string' || timezone.length === 0) return false;
  try {
    formatterFor(timezone);
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
  weekday: Weekday;
}

function wallClock(ms: number, timezone: string): WallClock {
  const parts = formatterFor(timezone).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new RangeError(`no ${type} for ${timezone}`);
    return p.value;
  };
  const weekday = get('weekday') as Weekday;
  if (!WEEKDAYS.includes(weekday)) throw new RangeError(`unexpected weekday ${weekday}`);
  return {
    year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    hour: Number(get('hour')), minute: Number(get('minute')), second: Number(get('second')),
    weekday,
  };
}

const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, '0');

/**
 * The zone's offset from UTC at that instant, in minutes (Asia/Dubai: 240).
 * Whole minutes: every zone has kept to them since 1972, and an ISO offset
 * cannot say anything finer.
 */
export function offsetMinutes(ms: number, timezone: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  const w = wallClock(whole, timezone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - whole) / 60_000);
}

/**
 * An instant as local ISO 8601 with its offset: 2026-09-28T12:40:00+04:00.
 * Whole seconds; the milliseconds of "now" are noise to a person.
 * Throws RangeError for a non-finite instant or an unknown zone.
 */
export function toLocalIso(ms: number, timezone: string): string {
  if (!Number.isFinite(ms)) throw new RangeError(`not a finite instant: ${ms}`);
  const whole = Math.floor(ms / 1000) * 1000;
  const w = wallClock(whole, timezone);
  const off = offsetMinutes(whole, timezone);
  const sign = off < 0 ? '-' : '+';
  const offset = `${sign}${pad(Math.trunc(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${offset}`;
}

/**
 * Now, as the building sees it. Throws RangeError for an unknown zone rather
 * than falling back to UTC: a silently wrong offset would move every "since
 * 9" by hours, and the caller is better placed to say the zone is broken.
 */
export function localStamp(nowMs: number, timezone: string): LocalStamp {
  const nowIso = toLocalIso(nowMs, timezone);
  const w = wallClock(Math.floor(nowMs / 1000) * 1000, timezone);
  return {
    nowIso,
    localDate: nowIso.slice(0, 10),
    weekday: w.weekday,
    timezone,
  };
}
