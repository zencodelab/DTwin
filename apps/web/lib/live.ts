import { Quality, type QualityCode } from '@dtwin/types';

/**
 * What the dashboard remembers about a point, and how it decides whether that
 * memory may still colour a zone.
 *
 * The live map used to keep `Map<sensorId, number>` — the latest value and
 * nothing else. Two things followed. A reading the quality gate had flagged
 * (−273 °C from a failed probe) coloured its zone exactly as a good one would,
 * although the alert engine refuses to evaluate the very same reading
 * (decisions.md §17). And a value never aged: a sensor that stopped reporting
 * an hour ago went on painting its zone the colour it had when it died, under
 * a green "live" light, which is the most misleading thing a live view can do.
 */
export interface LiveReading {
  value: number;
  /** The device's timestamp, epoch ms. */
  ts: number;
  quality: QualityCode;
  /** This browser's clock when the frame arrived, epoch ms. */
  receivedAt: number;
}

/**
 * A point is stale after this many missed samples — the same multiple
 * `getZoneDetail` applies in SQL (`sample_interval_s * 3`), so the panel's
 * first paint and the live view agree on what stale means.
 */
export const STALE_INTERVALS = 3;

/**
 * How long ago the point was last known good, in ms.
 *
 * `min(ts, receivedAt)`: a device clock running ahead cannot make a reading
 * look fresher than its own arrival, and a backfilled reading from yesterday
 * is as old as its timestamp says, however recently it arrived.
 *
 * `listeningSince` is the floor. Silence is only evidence while we were
 * listening: the dashboard subscribes to the floor in frame, so every other
 * floor hears nothing by design, and on returning to the building view those
 * readings must not all flash stale for a sample interval. The same holds
 * across a reconnect.
 */
export function ageMs(reading: LiveReading, now: number, listeningSince: number): number {
  const lastKnown = Math.max(Math.min(reading.ts, reading.receivedAt), listeningSince);
  return Math.max(0, now - lastKnown);
}

export function isStale(
  reading: LiveReading, sampleIntervalS: number, now: number, listeningSince: number,
): boolean {
  return ageMs(reading, now, listeningSince) > sampleIntervalS * STALE_INTERVALS * 1000;
}

/**
 * Keep the newer of two readings for a point.
 *
 * Frames can arrive out of order — a gateway flushing a buffer after a network
 * drop sends old readings after new ones — and "latest" must mean the latest
 * measurement, not the latest packet.
 */
export function newer(held: LiveReading | undefined, incoming: LiveReading): LiveReading {
  return held && held.ts > incoming.ts ? held : incoming;
}

export interface PointInput {
  sampleIntervalS: number;
  /** Undefined when nothing has arrived for this point since the page opened. */
  reading: LiveReading | undefined;
}

export interface ZoneLive {
  /** Mean of the usable readings; null when there are none. */
  value: number | null;
  used: number;
  /** Heard from, but the latest reading is flagged. */
  flagged: number;
  /** Heard from, then silent past the threshold. */
  stale: number;
  /** Never heard from, and not yet silent long enough to say so. */
  waiting: number;
  /** Never heard from, and listening long enough that it should have spoken. */
  silent: number;
  /** Age of the freshest unusable reading, for the label. Null when none. */
  staleForMs: number | null;
}

/**
 * Reduce a zone's points for one metric to what may be drawn.
 *
 * Only good, fresh readings enter the mean. `Uncertain` is excluded along with
 * the rest: the alert engine treats anything but `Good` as unfit for a value
 * condition, and a map that coloured by readings the alerts ignore would show
 * a hot zone with no alert and invite the wrong conclusion about which is
 * broken.
 */
export function reduceZone(points: PointInput[], now: number, listeningSince: number): ZoneLive {
  let sum = 0;
  const out: ZoneLive = {
    value: null, used: 0, flagged: 0, stale: 0, waiting: 0, silent: 0, staleForMs: null,
  };

  for (const { sampleIntervalS, reading } of points) {
    if (!reading) {
      const threshold = sampleIntervalS * STALE_INTERVALS * 1000;
      if (now - listeningSince > threshold) out.silent += 1;
      else out.waiting += 1;
      continue;
    }
    if (isStale(reading, sampleIntervalS, now, listeningSince)) {
      out.stale += 1;
      const age = ageMs(reading, now, listeningSince);
      out.staleForMs = out.staleForMs === null ? age : Math.min(out.staleForMs, age);
      continue;
    }
    if (reading.quality !== Quality.Good) {
      out.flagged += 1;
      continue;
    }
    sum += reading.value;
    out.used += 1;
  }

  if (out.used > 0) out.value = sum / out.used;
  return out;
}

export type ZoneSource = 'live' | 'baseline' | 'stale' | 'flagged' | 'none';

/**
 * Which source a zone is drawn from.
 *
 * The historical baseline exists for the first paint and only for that. It is
 * used while points are still `waiting` — we have not listened long enough to
 * expect them — and never once a point has gone stale or silent, because a
 * one-hour mean fetched when the page opened is older than the reading it
 * would be standing in for.
 */
export function zoneSource(live: ZoneLive, hasBaseline: boolean): ZoneSource {
  if (live.used > 0) return 'live';
  if (live.stale > 0 || live.silent > 0) return 'stale';
  if (live.flagged > 0) return 'flagged';
  if (live.waiting > 0 && hasBaseline) return 'baseline';
  return 'none';
}

export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}
