import type {
  CompareMetric, CompareOrder, EnergyDayRow, EnergyGroupBy, EnergyRow, MeterRows,
} from '@dtwin/db';
import { z } from 'zod';
import type { CaveatId } from '../evidence.ts';
import { DEFAULT_LIMITS } from '../limits.ts';
import {
  Ts, bucketsIn, callService, checkWindow, coveragePct, evidenceTool, hoursAndDays, isRefused, listHint,
  onWholeHour, partial, refuse, shapeData, truncatedMeta, windowLabel, windowOf, zodIssues,
  type EvidenceDraft, type Refused, type Window,
} from './common.ts';
import { METRIC_UNIT } from './diagnose.ts';

/**
 * analyse: WHAT and HOW MUCH (§5.3). Energy by end use from the power gauges,
 * consumption from the cumulative meters, and zones ranked on a metric.
 *
 * Every judgement the §2 data realities call for is made HERE, in code, from
 * the rows — not left to a model reading them:
 *
 * - Per-floor energy in this building is AHU fans and lighting only, and the
 *   floors measure alike to a fraction of a percent. When they are within 2%
 *   the result says so (FLOORS_WITHIN_2PCT) and "which floor used most" has
 *   its honest answer: none stands out.
 * - Chillers, pumps, the cooling tower and the EV charger have no floor.
 *   They are one "building plant" row, never apportioned (PLANT_NOT_ALLOCATED).
 * - The main meter carries the smoke suite's writes in the dev database: a
 *   counter reset and a 15,538 kWh hour. Such buckets are marked SUSPECT and
 *   the total without them is returned BESIDE the raw total — never one
 *   "cleaned" number in place of the measurement.
 */

const ts = (description: string) => ({ type: 'string', format: 'date-time', description });
const OFFSET = 'An ISO 8601 timestamp WITH the building offset, e.g. 2026-09-21T00:00:00+04:00.';

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T | Refused {
  const r = schema.safeParse(input);
  return r.success ? r.data : refuse(`invalid input: ${zodIssues(r.error)}`);
}

/** The db layer's enums, restated so tools need no `pg`; the checks keep them the same sets. */
export const ENERGY_GROUP_BY = ['floor', 'end_use', 'floor_end_use', 'local_day'] as const satisfies readonly EnergyGroupBy[];
export const COMPARE_METRICS = ['temperature_c', 'co2_ppm', 'humidity_pct', 'occupancy_count'] as const satisfies readonly CompareMetric[];
export const COMPARE_ORDER = ['mean', 'max', 'minutes_above_band'] as const satisfies readonly CompareOrder[];
type _GroupByComplete = AssertNever<Exclude<EnergyGroupBy, (typeof ENERGY_GROUP_BY)[number]>>;
type _MetricsComplete = AssertNever<Exclude<CompareMetric, (typeof COMPARE_METRICS)[number]>>;
type _OrderComplete = AssertNever<Exclude<CompareOrder, (typeof COMPARE_ORDER)[number]>>;

/** Every power point without a floor is grouped under this name (the db layer's `BUILDING_PLANT`). */
export const BUILDING_PLANT = 'building plant';

/** Floors whose measured totals are within this ratio are indistinguishable (FLOORS_WITHIN_2PCT). */
const FLOORS_ALIKE_RATIO = 1.02;

/** A meter bucket is suspect above this multiple of the median implied demand. */
export const SUSPECT_MEDIAN_MULTIPLE = 5;

// ========================================================== energy_by_end_use

const EnergyInput = z.object({ from: Ts, to: Ts, groupBy: z.enum(ENERGY_GROUP_BY) }).strict();

const GROUP_LABEL: Readonly<Record<EnergyGroupBy, string>> = {
  floor: 'floor', end_use: 'end use', floor_end_use: 'floor and end use', local_day: 'local day',
};

/**
 * The floors' measured totals are within 2% of each other: at least two
 * floors, every one of them measured something, and the largest is at most
 * 1.02 × the smallest. Plant is not a floor and never counts.
 */
export function floorsAlike(rows: readonly EnergyRow[]): boolean {
  const byFloor = new Map<string, number>();
  for (const r of rows) {
    if (r.floor === null || r.floor === BUILDING_PLANT) continue;
    byFloor.set(r.floor, (byFloor.get(r.floor) ?? 0) + (r.energy_kwh ?? 0));
  }
  const totals = [...byFloor.values()];
  if (totals.length < 2 || totals.some((t) => t <= 0)) return false;
  return Math.max(...totals) / Math.min(...totals) <= FLOORS_ALIKE_RATIO;
}

export const energyByEndUse = evidenceTool<{ w: Window; groupBy: EnergyGroupBy }>({
  name: 'energy_by_end_use',
  service: 'database',
  definition: {
    name: 'energy_by_end_use',
    description:
      'Measured electrical energy from the power gauges (Σ good 5-minute means × 5 min; never extrapolated, ' +
      'never rated power), grouped by floor, end use (equipment type), floor and end use, or the building\'s ' +
      'local day. Each row carries the sensors in scope, good and expected 5-minute buckets and coverage_pct. ' +
      'Per floor this is only the equipment that belongs to that floor; everything with no floor (central ' +
      `plant) is one "${BUILDING_PLANT}" row, never split by floor. Window at most ${hoursAndDays(DEFAULT_LIMITS.energyByEndUseMaxWindowH)}.`,
    input_schema: {
      type: 'object',
      properties: {
        from: ts(`Window start. ${OFFSET}`),
        to: ts(`Window end. ${OFFSET}`),
        groupBy: { type: 'string', enum: [...ENERGY_GROUP_BY] },
      },
      required: ['from', 'to', 'groupBy'],
      additionalProperties: false,
    },
    strict: true,
  },
  prepare(input, env) {
    const p = parse(EnergyInput, input);
    if (isRefused(p)) return p;
    const w = checkWindow('energy_by_end_use', p.from, p.to, env.ctx.limits.energyByEndUseMaxWindowH, env);
    return isRefused(w) ? w : { w, groupBy: p.groupBy };
  },
  async execute({ w, groupBy }, env): Promise<EvidenceDraft | Refused> {
    const res = await callService('database', () => env.ctx.deps.reader.energyByEndUse({
      from: new Date(w.fromMs), to: new Date(w.toMs), groupBy, timezone: env.ctx.orient.building.timezone,
      buildingId: env.ctx.orient.building.id,
    }));
    if (isRefused(res)) return res;

    const counts: Array<{ good_buckets_count: number; expected_buckets_count: number; flagged_samples_count: number }> = res.rows;
    const good = counts.reduce((s, r) => s + r.good_buckets_count, 0);
    const expected = counts.reduce((s, r) => s + r.expected_buckets_count, 0);
    const flagged = counts.reduce((s, r) => s + r.flagged_samples_count, 0);

    const caveats: CaveatId[] = [];
    let rows: unknown[];
    let headline: Array<{ label: string; path: string }>;
    if (res.groupBy === 'local_day') {
      // The local date names the day; its length in hours is kept because a
      // DST day is 23 or 25 h long and a per-day comparison must know it.
      rows = res.rows.map((d: EnergyDayRow) => ({
        day: d.day,
        day_h: (Date.parse(d.day_end) - Date.parse(d.day_start)) / 3_600_000,
        energy_kwh: d.energy_kwh,
        sensors_count: d.sensors_count,
        good_buckets_count: d.good_buckets_count,
        expected_buckets_count: d.expected_buckets_count,
        coverage_pct: coveragePct(d.good_buckets_count, d.expected_buckets_count),
        flagged_samples_count: d.flagged_samples_count,
      }));
      headline = res.rows.slice(0, 6).map((d, i) => ({ label: d.day, path: `rows[${i}].energy_kwh` }));
    } else {
      rows = res.rows.map((r: EnergyRow) => ({
        floor: r.floor,
        level: r.level,
        end_use: r.end_use,
        energy_kwh: r.energy_kwh,
        sensors_count: r.sensors_count,
        good_buckets_count: r.good_buckets_count,
        expected_buckets_count: r.expected_buckets_count,
        coverage_pct: coveragePct(r.good_buckets_count, r.expected_buckets_count),
        flagged_samples_count: r.flagged_samples_count,
      }));
      headline = res.rows.slice(0, 6).map((r, i) => ({
        label: [r.floor, r.end_use].filter((x): x is string => x !== null).join(' · ') || 'all',
        path: `rows[${i}].energy_kwh`,
      }));
      const byFloor = res.groupBy === 'floor' || res.groupBy === 'floor_end_use';
      if (byFloor && res.rows.some((r) => r.floor === BUILDING_PLANT)) caveats.push('PLANT_NOT_ALLOCATED');
      if (byFloor && floorsAlike(res.rows)) caveats.push('FLOORS_WITHIN_2PCT');
    }
    if (counts.some((r) => partial(r.good_buckets_count, r.expected_buckets_count))) caveats.push('PARTIAL_COVERAGE');
    if (flagged > 0) caveats.push('FLAGGED_EXCLUDED');

    return {
      tool: 'energy_by_end_use',
      kind: 'measured',
      source: 'telemetry_5m',
      label: `Measured electrical energy by ${GROUP_LABEL[groupBy]}, ${windowLabel(w, env)}`,
      window: windowOf(w, env),
      coverage: { good_count: good, expected_count: expected },
      flaggedExcluded_count: flagged,
      truncated: null,
      caveats,
      headline,
      data: shapeData({ group_by: groupBy, rows }, env),
    };
  },
});

// ========================================================== meter_consumption

const MeterInput = z.object({
  meterTag: z.string().trim().min(1, 'a meter tag is not empty').max(40, 'a meter tag is at most 40 characters'),
  from: Ts.refine(onWholeHour, 'from must be on a whole hour'),
  to: Ts.refine(onWholeHour, 'to must be on a whole hour'),
  bucket: z.enum(['hour', 'local_day']),
}).strict();

interface MeterPrepared {
  meterTag: string;
  w: Window;
  bucket: 'hour' | 'local_day';
}

/** The median of the positive values, or null with none. */
function median(values: readonly number[]): number | null {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/** One step between consecutive buckets: the next bucket's first reading less this one's last. */
interface BetweenStep {
  from: string;
  to: string;
  increment: number;
  reset: boolean;
  suspect: boolean;
}

/**
 * The meter answer, with the judgement a raw rollup cannot make:
 *
 * - implied demand per bucket = delta ÷ hours with data;
 * - SUSPECT = a counter reset in the bucket, or implied demand above five
 *   times the median bucket's (a counter jump no building draws);
 * - the STEPS BETWEEN buckets — from one bucket's last reading to the next
 *   one's first — are judged the same way. The window total counts them and
 *   no bucket's delta holds them, so a jump that lands on a bucket boundary,
 *   or across a gap in the data, was once counted in full as clean energy:
 *   999,144 kWh "without suspect buckets" for 23 hours of a building drawing
 *   about 200 kW (review, ADR 64). A step is suspect when the counter went
 *   DOWN across it (a reset between buckets), or when it implies more than
 *   five times the median demand over the time it spans — never less than an
 *   hour, the resolution a bucket is judged at, so a one-second step between
 *   two samples of a quantised counter is not a spike;
 * - `total_excluding_suspect_<u>` = the clean buckets' deltas plus the clean
 *   steps between them — beside `total_<u>`, never instead of it — and null
 *   when no bucket is clean: a "clean total" made of nothing but the steps
 *   between suspect days is not one.
 *
 * When the window saw more resets than the buckets and the steps between them
 * did, a reset could not be placed: the total without suspects falls back to
 * the sum of the clean buckets (a lower bound, missing every step between
 * them) and `reset_on_bucket_boundary` says so, as it does for a reset that
 * WAS placed between two buckets.
 *
 * Water has no demand in kW; its implied rate is `implied_m3_per_h`, which
 * the unit table deliberately cannot cite.
 *
 * COLUMNS, NOT ROWS. `buckets` holds one array per field, index-aligned, as
 * zone_history's series do. As one object per bucket, seven days of hours
 * (168 buckets) came to about 25 KB — three times the evidence bound, so the
 * longest window the tool offered was certain to be refused. Hourly buckets
 * go further: they sit on an implicit axis (`first_bucket_start`, `step_s`,
 * `buckets_count`), every hour of the window present and an hour with no
 * data null, because 168 timestamps alone are 4.7 KB. A building's local
 * days vary in length (DST), so they keep their own `bucket_start` column.
 */
export function meterData(
  rows: MeterRows, axis: { fromMs: number; count: number } | null = null,
): { data: Record<string, unknown>; suspect: number; boundary: boolean } {
  const u = rows.unit;
  const got = rows.buckets as Array<Record<string, number | string | null>>;
  // On the hourly axis, each bucket lands at its hour; every other hour is null.
  let buckets: Array<Record<string, number | string | null> | null> = got;
  if (axis !== null) {
    buckets = Array.from({ length: axis.count }, () => null);
    for (const b of got) {
      const i = (Date.parse(String(b.bucket_start)) - axis.fromMs) / 3_600_000;
      if (Number.isInteger(i) && i >= 0 && i < axis.count) buckets[i] = b;
    }
  }
  const delta = (b: Record<string, number | string | null> | null): number | null => {
    const v = b?.[`delta_${u}`];
    return typeof v === 'number' ? v : null;
  };
  const implied = buckets.map((b) => {
    const d = delta(b);
    const h = Number(b?.hours_with_data_count ?? 0);
    return d !== null && h > 0 ? d / h : null;
  });
  const med = median(implied.filter((x): x is number => x !== null));
  const isSuspect = buckets.map((b, i) => b !== null && (
    Number(b.resets_count) > 0 || (med !== null && implied[i] !== null && implied[i]! > SUSPECT_MEDIAN_MULTIPLE * med)));

  // The steps between consecutive buckets that hold readings, in order.
  const read = got.filter((b) => typeof b[`first_reading_${u}`] === 'number' && typeof b[`last_reading_${u}`] === 'number'
    && typeof b.first_at === 'string' && typeof b.last_at === 'string');
  const between: BetweenStep[] = [];
  for (let i = 1; i < read.length; i += 1) {
    const prev = read[i - 1]!;
    const next = read[i]!;
    const last = prev[`last_reading_${u}`] as number;
    const first = next[`first_reading_${u}`] as number;
    // A counter that went DOWN restarted from zero: what it counted since is
    // its reading, as the reset-aware rollup counts it.
    const reset = first < last;
    const increment = reset ? first : first - last;
    const spanH = Math.max(1, (Date.parse(String(next.first_at)) - Date.parse(String(prev.last_at))) / 3_600_000);
    const suspect = reset || (med !== null && increment / spanH > SUSPECT_MEDIAN_MULTIPLE * med);
    between.push({ from: String(prev.last_at), to: String(next.first_at), increment, reset, suspect });
  }

  const total = (rows as Record<string, unknown>)[`total_${u}`];
  const bucketResets = got.reduce((s, b) => s + Number(b.resets_count), 0);
  const betweenResets = between.filter((b) => b.reset).length;
  const unplaced = rows.total_resets_count > bucketResets + betweenResets;
  const boundary = unplaced || betweenResets > 0;
  const cleanSum = buckets.reduce((s, b, i) => s + (isSuspect[i] ? 0 : delta(b) ?? 0), 0);
  const cleanBetween = between.reduce((s, b) => s + (b.suspect ? 0 : b.increment), 0);
  const anyClean = buckets.some((b, i) => !isSuspect[i] && delta(b) !== null);
  const excluding = typeof total !== 'number' || !anyClean ? null
    : unplaced ? cleanSum : cleanSum + cleanBetween;
  const impliedKey = u === 'kwh' ? 'implied_mean_kw' : 'implied_m3_per_h';

  const columns: Record<string, unknown[]> = {};
  if (axis === null) columns.bucket_start = buckets.map((b) => b!.bucket_start);
  columns[`delta_${u}`] = buckets.map(delta);
  columns.resets_count = buckets.map((b) => (b === null ? 0 : b.resets_count));
  columns.hours_with_data_count = buckets.map((b) => (b === null ? 0 : b.hours_with_data_count));
  columns[impliedKey] = implied;
  columns.suspect = isSuspect;

  const suspectBetween = between.filter((b) => b.suspect);
  return {
    data: {
      meter: rows.meter,
      unit: u,
      bucket: rows.bucket,
      ...(axis === null ? {} : {
        first_bucket_start: new Date(axis.fromMs).toISOString(), step_s: 3600, buckets_count: axis.count,
      }),
      buckets: columns,
      [`total_${u}`]: typeof total === 'number' ? total : null,
      [`total_excluding_suspect_${u}`]: excluding,
      [`between_buckets_${u}`]: between.reduce((s, b) => s + b.increment, 0),
      total_resets_count: rows.total_resets_count,
      total_hours_with_data_count: rows.total_hours_with_data_count,
      reset_on_bucket_boundary: boundary,
      suspect_buckets: buckets.flatMap((b, i) => (isSuspect[i] && b !== null ? [b.bucket_start] : [])),
      suspect_between_buckets: suspectBetween.map((b) => ({
        from: b.from, to: b.to, [`increment_${u}`]: b.increment, reset: b.reset,
      })),
    },
    suspect: isSuspect.filter(Boolean).length + suspectBetween.length,
    boundary,
  };
}

export const meterConsumption = evidenceTool<MeterPrepared>({
  name: 'meter_consumption',
  service: 'database',
  definition: {
    name: 'meter_consumption',
    description:
      'Consumption from a cumulative meter (a tag from the meters availability lists) by ' +
      "hour or by the building's local day, from the reset-aware counter: each bucket's delta, resets, hours " +
      'with data, implied mean demand, and whether it is SUSPECT (a counter reset, or implied demand above ' +
      'five times the median). The steps BETWEEN buckets are judged the same way; a suspect one is listed in ' +
      'suspect_between_buckets. Buckets are COLUMNS: `buckets.delta_kwh[i]` is bucket i. By hour, bucket i ' +
      'starts at first_bucket_start + i × step_s and an hour with no data is null; by local day, ' +
      '`buckets.bucket_start[i]` names it. The raw window total and the total without suspect buckets are ' +
      'given side by side. from and to must be on whole hours. Window at most ' +
      `${hoursAndDays(DEFAULT_LIMITS.meterHourMaxWindowH)} by hour, ${hoursAndDays(DEFAULT_LIMITS.meterLocalDayMaxWindowH)} by local day.`,
    input_schema: {
      type: 'object',
      properties: {
        meterTag: { type: 'string', description: 'The meter\'s tag, as availability.meters lists it.' },
        from: ts(`Window start, on a whole hour. ${OFFSET}`),
        to: ts(`Window end, on a whole hour. ${OFFSET}`),
        bucket: { type: 'string', enum: ['hour', 'local_day'] },
      },
      required: ['meterTag', 'from', 'to', 'bucket'],
      additionalProperties: false,
    },
    strict: true,
  },
  prepare(input, env) {
    const p = parse(MeterInput, input);
    if (isRefused(p)) return p;
    const { limits } = env.ctx;
    const maxH = p.bucket === 'hour' ? limits.meterHourMaxWindowH : limits.meterLocalDayMaxWindowH;
    const w = checkWindow('meter_consumption', p.from, p.to, maxH, env,
      p.bucket === 'hour' ? ' by hour; use bucket local_day for longer windows' : ' by local day');
    return isRefused(w) ? w : { meterTag: p.meterTag, w, bucket: p.bucket };
  },
  async execute({ meterTag, w, bucket }, env): Promise<EvidenceDraft | Refused> {
    const res = await callService('database', () => env.ctx.deps.reader.meterConsumption({
      meterTag, from: new Date(w.fromMs), to: new Date(w.toMs), bucket, timezone: env.ctx.orient.building.timezone,
      buildingId: env.ctx.orient.building.id,
    }));
    if (isRefused(res)) return res;
    if ('unknownMeter' in res) {
      return refuse(`no meter ${JSON.stringify(meterTag.slice(0, 40))}: meter_consumption reads an electric_meter ` +
        'or water_meter that has an active cumulative point; use a tag from availability.meters');
    }

    // Hourly buckets on the window's own axis, up to now: whole hours, so the
    // window start IS the first bucket's start (from is checked on the hour).
    const axis = bucket === 'hour'
      ? { fromMs: w.fromMs, count: bucketsIn(w.fromMs, Math.min(w.toMs, env.ctx.now()), 3600) }
      : null;
    const { data, suspect, boundary } = meterData(res, axis);
    const u = res.unit;
    const caveats: CaveatId[] = [];
    if (suspect > 0 || boundary) caveats.push('METER_SUSPECT_BUCKETS');
    // The main electricity meter and the per-floor gauges are generated
    // independently and do not reconcile; any difference is unattributed.
    if (res.meter.type === 'electric_meter') caveats.push('MAIN_VS_SUBMETERS_UNRECONCILED');

    const expectedHours = bucketsIn(w.fromMs, Math.min(w.toMs, env.ctx.now()), 3600);
    return {
      tool: 'meter_consumption',
      kind: 'measured',
      source: 'telemetry_1h',
      label: `${res.meter.tag} consumption by ${bucket === 'hour' ? 'hour' : 'local day'}, ${windowLabel(w, env)}`,
      window: windowOf(w, env),
      coverage: { good_count: res.total_hours_with_data_count, expected_count: expectedHours },
      flaggedExcluded_count: null,
      truncated: null,
      caveats,
      headline: [
        { label: 'Total (raw)', path: `total_${u}` },
        { label: 'Total without suspect buckets', path: `total_excluding_suspect_${u}` },
      ],
      data: shapeData(data, env),
    };
  },
});

// ============================================================== compare_zones

const CompareInput = z.object({
  metric: z.enum(COMPARE_METRICS),
  from: Ts,
  to: Ts,
  floorLevel: z.number().int('floorLevel is a whole number').nullable(),
  orderBy: z.enum(COMPARE_ORDER),
  limit: z.number().int('limit is a whole number').min(1, 'limit is at least 1')
    .max(DEFAULT_LIMITS.compareZonesMaxItems, `limit is at most ${DEFAULT_LIMITS.compareZonesMaxItems}`),
}).strict();

interface ComparePrepared {
  metric: CompareMetric;
  w: Window;
  floorLevel: number | null;
  orderBy: CompareOrder;
  limit: number;
}

const ORDER_LABEL: Readonly<Record<CompareOrder, string>> = {
  mean: 'mean', max: 'highest', minutes_above_band: 'occupied minutes above the designed band,',
};

export const compareZones = evidenceTool<ComparePrepared>({
  name: 'compare_zones',
  service: 'database',
  definition: {
    name: 'compare_zones',
    description:
      'Zones ranked on one metric over a window, from hourly rollups (good-sample mean and highest good ' +
      'sample), optionally on one floor, plus each floor\'s AREA-WEIGHTED mean over every zone in scope. ' +
      'orderBy minutes_above_band ranks temperature_c by occupied minutes above the DESIGNED band from ' +
      `5-minute data, for windows up to ${hoursAndDays(DEFAULT_LIMITS.compareZonesBandMaxWindowH)}. Hourly buckets start on the hour, so ` +
      'the window actually covered is returned, and every figure (the minutes above the band included) is over it; ' +
      'good_buckets_count is the 5-minute periods in it with a good reading. ' +
      `Window at most ${hoursAndDays(DEFAULT_LIMITS.compareZonesMaxWindowH)}; ` +
      `limit 1–${DEFAULT_LIMITS.compareZonesMaxItems}.`,
    input_schema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: [...COMPARE_METRICS] },
        from: ts(`Window start. ${OFFSET}`),
        to: ts(`Window end. ${OFFSET}`),
        floorLevel: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'A floor level from the directory, or null for every floor.' },
        orderBy: { type: 'string', enum: [...COMPARE_ORDER] },
        limit: { type: 'integer', description: `Most zones to return, 1–${DEFAULT_LIMITS.compareZonesMaxItems}.` },
      },
      required: ['metric', 'from', 'to', 'floorLevel', 'orderBy', 'limit'],
      additionalProperties: false,
    },
    strict: true,
  },
  prepare(input, env) {
    const p = parse(CompareInput, input);
    if (isRefused(p)) return p;
    const { limits, orient } = env.ctx;
    if (p.limit > limits.compareZonesMaxItems) return refuse(`limit is at most ${limits.compareZonesMaxItems}`);
    if (p.floorLevel !== null && !orient.directory.some((z) => z.level === p.floorLevel)) {
      return refuse(`no floor at level ${p.floorLevel} in the directory`);
    }
    if (p.orderBy === 'minutes_above_band' && p.metric !== 'temperature_c') {
      return refuse('orderBy minutes_above_band ranks temperature_c only');
    }
    const band = p.orderBy === 'minutes_above_band';
    const w = checkWindow('compare_zones', p.from, p.to,
      band ? limits.compareZonesBandMaxWindowH : limits.compareZonesMaxWindowH, env,
      band ? ' with orderBy minutes_above_band' : '');
    if (isRefused(w)) return w;
    return { metric: p.metric, w, floorLevel: p.floorLevel, orderBy: p.orderBy, limit: p.limit };
  },
  async execute(p, env): Promise<EvidenceDraft | Refused> {
    const res = await callService('database', () => env.ctx.deps.reader.compareZones({
      metric: p.metric, from: new Date(p.w.fromMs), to: new Date(p.w.toMs),
      floorLevel: p.floorLevel, orderBy: p.orderBy, limit: p.limit, now: new Date(env.ctx.now()),
      buildingId: env.ctx.orient.building.id,
    }));
    if (isRefused(res)) return res;

    const u = METRIC_UNIT[p.metric];
    const covered = { fromMs: Date.parse(res.covered.from), toMs: Date.parse(res.covered.to) };
    // Judged on 5-minute periods, as every other tool's coverage is: an hour
    // with one good sample in it is not a covered hour (review, ADR 64).
    const expected5m = bucketsIn(covered.fromMs, Math.min(covered.toMs, env.ctx.now()), 300);
    const flagged = res.items.reduce((s, r) => s + r.flagged_samples_count, 0);
    const caveats: CaveatId[] = [];
    if (flagged > 0) caveats.push('FLAGGED_EXCLUDED');
    if (res.items.some((r) => partial(r.good_buckets_count, expected5m))) caveats.push('PARTIAL_COVERAGE');
    const rankKey = p.orderBy === 'minutes_above_band' ? 'minutes_above_band_min' : `${p.orderBy}_${u}`;
    const floorName = p.floorLevel === null ? ''
      : ` on ${env.ctx.orient.directory.find((z) => z.level === p.floorLevel)?.floor ?? `level ${p.floorLevel}`}`;

    return {
      tool: 'compare_zones',
      kind: 'measured',
      source: 'telemetry_1h',
      label: `Zones by ${ORDER_LABEL[p.orderBy]} ${p.metric}${floorName}, ${windowLabel(covered, env)}`,
      window: windowOf(covered, env),
      coverage: null,
      flaggedExcluded_count: flagged,
      truncated: truncatedMeta(res),
      caveats,
      headline: res.items.slice(0, 5).map((r, i) => ({ label: r.zone, path: `items[${i}].${rankKey}` })),
      data: shapeData({
        metric: p.metric,
        order_by: p.orderBy,
        // Each zone's area is a configured figure in a measured record; it
        // is dropped for the same reason zone_conditions has no design block.
        // The floor means were area-weighted in SQL before this point.
        items: res.items.map(({ area_m2: _area, ...row }) => row),
        floor_means: res.floor_means,
        total_count: res.total,
        limit_count: res.limit,
        truncated: res.truncated,
      }, env),
    };
  },
  tooLarge: ({ limit }, bytes, env) => listHint(limit, bytes, env.ctx.limits.maxEvidenceBytes),
});

export const ANALYSE_TOOL_SET = [energyByEndUse, meterConsumption, compareZones] as const;

type AssertNever<T extends never> = T;
