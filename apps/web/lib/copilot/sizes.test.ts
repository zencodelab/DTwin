import { describe, expect, it } from 'vitest';
import type { AlertListRow, CommandHistoryRow, MeterRows, RuleInScopeRow, TimelineRow } from '@dtwin/db';
import type { ZoneSummary } from './deps.ts';
import { DEFAULT_LIMITS } from './limits.ts';
import { toolDefinitions, type SpecialistRole } from './tools/index.ts';
import { Z, cappedOf, listZonesFixture } from './testing/fakes.ts';
import { toolHarness } from './testing/tools.ts';

/**
 * Every capped list the model may ask for fits the 8 KB evidence bound AT ITS
 * MAXIMUM LIMIT, with realistic rows (route stage; the gate's open issue).
 *
 * §8 capped list_alerts, control_history and zone_timeline at 50 while every
 * record is refused past 8 KB. Fifty realistic alerts are about 20 KB, so the
 * largest limit a tool offered was the one limit certain to be refused, and a
 * model that asked for "everything" learnt only that it had to ask again.
 * The caps are now what the bound holds with these rows and room to spare,
 * the meter's hours are columns on an implicit axis, and list_zones fits the
 * seeded building and refuses cleanly — never truncates — past it.
 *
 * The rows below are the dev database's own, captured read-only on
 * 2026-09-28 (the db stage's `samples.json`), as the db layer returns them.
 * Rows of unusual length can still be too large; those are refused with a
 * limit that fits (tools.test.ts "refuses a page too large…").
 */

const BOUND = DEFAULT_LIMITS.maxEvidenceBytes;
/** A page at its cap uses at most this share of the bound: real rows vary, and the cap must not sit on the edge. */
const HEADROOM = 0.9;

const WEEK_AGO = '2026-09-21T12:40:00+04:00';
const NOW_LOCAL = '2026-09-28T12:40:00+04:00';

const cycle = <T,>(rows: readonly T[], n: number): T[] => Array.from({ length: n }, (_, i) => structuredClone(rows[i % rows.length]!));
const dataBytes = (data: unknown) => new TextEncoder().encode(JSON.stringify(data)).length;

const ALERT_ROWS = [
  { rule: 'Thermal drift', zone: 'OFF-301', floor: 'Level 3', equipment: null, severity: 'warning', state: 'resolved', opened_at: '2026-09-24T04:40:00.538Z', resolved_at: '2026-09-24T05:17:56.316Z', duration_s: 2276, metric: 'temperature_c', condition: 'rate_of_change', threshold_k_per_h: 2, trigger_k_per_h: 2.00240712866076, message_untrusted: 'Thermal drift: OFF-301 Zone Temperature changing at 2°C/h (limit 2°C/h)', message_truncated: false },
  { rule: 'Thermal drift', zone: 'OFF-303', floor: 'Level 3', equipment: null, severity: 'warning', state: 'resolved', opened_at: '2026-09-24T04:39:50.559Z', resolved_at: '2026-09-24T05:18:01.314Z', duration_s: 2291, metric: 'temperature_c', condition: 'rate_of_change', threshold_k_per_h: 2, trigger_k_per_h: 2.0043149095134862, message_untrusted: 'Thermal drift: OFF-303 Zone Temperature changing at 2°C/h (limit 2°C/h)', message_truncated: false },
  { rule: 'Thermal drift', zone: 'OFF-300', floor: 'Level 3', equipment: null, severity: 'warning', state: 'resolved', opened_at: '2026-09-24T04:39:50.541Z', resolved_at: '2026-09-24T05:17:56.333Z', duration_s: 2286, metric: 'temperature_c', condition: 'rate_of_change', threshold_k_per_h: 2, trigger_k_per_h: 2.0051860168770252, message_untrusted: 'Thermal drift: OFF-300 Zone Temperature changing at 2.01°C/h (limit 2°C/h)', message_truncated: false },
  { rule: 'Thermal drift', zone: 'OFF-305', floor: 'Level 3', equipment: null, severity: 'warning', state: 'resolved', opened_at: '2026-09-24T04:39:40.541Z', resolved_at: '2026-09-24T05:17:51.311Z', duration_s: 2291, metric: 'temperature_c', condition: 'rate_of_change', threshold_k_per_h: 2, trigger_k_per_h: 2.0041484162898717, message_untrusted: 'Thermal drift: OFF-305 Zone Temperature changing at 2°C/h (limit 2°C/h)', message_truncated: false },
] as unknown as AlertListRow[];

const PRECOOL = "copilot (operator-approved): Pre-cool Level 3 offices ahead of this afternoon's demand peak";
const DEVICE = 'applied by the in-process device simulator';
const COMMAND_ROWS = [
  { zone: 'OFF-305', floor: 'Level 3', setpoint_c: 21, previous_c: 23, state: 'applied', requested_at: '2026-09-24T00:29:27.337Z', applied_at: '2026-09-24T00:29:32.927Z', settled_at: '2026-09-24T00:29:32.927Z', effective_until: '2026-09-24T04:29:27.344Z', active_now: false, from_copilot: true, reason_untrusted: PRECOOL, reason_truncated: false, outcome_untrusted: DEVICE, outcome_truncated: false },
  { zone: 'OFF-303', floor: 'Level 3', setpoint_c: 21, previous_c: 23, state: 'applied', requested_at: '2026-09-24T00:29:25.551Z', applied_at: '2026-09-24T00:29:29.102Z', settled_at: '2026-09-24T00:29:29.102Z', effective_until: '2026-09-24T04:29:25.553Z', active_now: false, from_copilot: true, reason_untrusted: PRECOOL, reason_truncated: false, outcome_untrusted: DEVICE, outcome_truncated: false },
  { zone: 'OFF-301', floor: 'Level 3', setpoint_c: 21, previous_c: 23, state: 'applied', requested_at: '2026-09-24T00:29:23.193Z', applied_at: '2026-09-24T00:29:29.095Z', settled_at: '2026-09-24T00:29:29.095Z', effective_until: '2026-09-24T04:29:23.194Z', active_now: false, from_copilot: true, reason_untrusted: PRECOOL, reason_truncated: false, outcome_untrusted: DEVICE, outcome_truncated: false },
] as unknown as CommandHistoryRow[];

const TIMELINE_ROWS: TimelineRow[] = [
  { at: '2026-09-24T00:29:27.337Z', kind: 'command_requested', detail: { state: 'applied', previous_c: 23, setpoint_c: 21, from_copilot: true, effective_until: '2026-09-24T04:29:27.344Z', reason_truncated: false, reason_untrusted: PRECOOL } },
  { at: '2026-09-24T00:29:32.927Z', kind: 'command_applied', detail: { setpoint_c: 21, effective_until: '2026-09-24T04:29:27.344Z' } },
  { at: '2026-09-24T00:43:01.036Z', kind: 'alert_opened', detail: { rule: 'Thermal drift', metric: 'temperature_c', severity: 'warning', condition: 'rate_of_change', message_truncated: false, message_untrusted: 'Thermal drift: OFF-305 Zone Temperature changing at -2.01°C/h (limit 2°C/h)', threshold_k_per_h: 2, trigger_k_per_h: -2.007565526072755 } },
  { at: '2026-09-24T01:15:51.365Z', kind: 'alert_resolved', detail: { rule: 'Thermal drift', metric: 'temperature_c', severity: 'warning', opened_at: '2026-09-24T00:43:01.036Z', duration_s: 1970 } },
  { at: '2026-09-24T04:29:27.344Z', kind: 'override_lapsed', detail: { applied_at: '2026-09-24T00:29:32.927Z', setpoint_c: 21 } },
  { at: '2026-09-24T04:39:40.541Z', kind: 'alert_opened', detail: { rule: 'Thermal drift', metric: 'temperature_c', severity: 'warning', condition: 'rate_of_change', message_truncated: false, message_untrusted: 'Thermal drift: OFF-305 Zone Temperature changing at 2°C/h (limit 2°C/h)', threshold_k_per_h: 2, trigger_k_per_h: 2.0041484162898717 } },
  { at: '2026-09-24T05:17:51.311Z', kind: 'alert_resolved', detail: { rule: 'Thermal drift', metric: 'temperature_c', severity: 'warning', opened_at: '2026-09-24T04:39:40.541Z', duration_s: 2291 } },
] as TimelineRow[];

const RULES = [
  { name: 'CO2 breach', metric: 'co2_ppm', condition: 'threshold_above', scope: 'building', threshold_ppm: 1200, window_s: null, consecutive_breaches_count: 2, severity: 'warning', enabled: true },
  { name: 'Chiller power spike', metric: 'power_kw', condition: 'threshold_above', scope: 'equipment', threshold_kw: 320, window_s: null, consecutive_breaches_count: 3, severity: 'critical', enabled: true },
  { name: 'Point offline', metric: 'temperature_c', condition: 'no_data', scope: 'building', threshold_c: null, window_s: 900, consecutive_breaches_count: 1, severity: 'critical', enabled: true },
  { name: 'Stuck sensor', metric: 'temperature_c', condition: 'flatline', scope: 'building', threshold_c: null, window_s: 7200, consecutive_breaches_count: 1, severity: 'info', enabled: true },
  { name: 'Thermal drift', metric: 'temperature_c', condition: 'rate_of_change', scope: 'building', threshold_k_per_h: 2, window_s: 3600, consecutive_breaches_count: 1, severity: 'warning', enabled: true },
  { name: 'Zone overheating', metric: 'temperature_c', condition: 'threshold_above', scope: 'building', threshold_c: 27, window_s: null, consecutive_breaches_count: 3, severity: 'warning', enabled: true },
] as unknown as RuleInScopeRow[];

/** The main meter across the smoke suite's reset and its 15,538 kWh hour. */
const METER_HOUR_DELTAS = [156, 177, 177, 177, 174, 177, 15537.910699824813, 252.07448547175045, 256.79387070817575, 267.3669762665777, 276.7101608962803, 286.3993927130432];
const METER_DAY_DELTAS = [5888.545314759249, 2509.6541336647033, 992508.9828668889, 21808.64606352942, 6802.1940844553355, 6802.066642543166, 6800.685551513459, 4041.4211832654473];

function meterRows(bucket: 'hour' | 'local_day', firstMs: number, n: number): MeterRows {
  const stepMs = bucket === 'hour' ? 3_600_000 : 86_400_000;
  const deltas = bucket === 'hour' ? METER_HOUR_DELTAS : METER_DAY_DELTAS;
  const buckets = Array.from({ length: n }, (_, i) => ({
    bucket_start: new Date(firstMs + i * stepMs).toISOString(),
    delta_kwh: deltas[i % deltas.length]!,
    resets_count: i % 29 === 4 ? 1 : 0,
    hours_with_data_count: bucket === 'hour' ? 1 : 24,
  }));
  return {
    meter: { tag: 'MTR-MAIN', type: 'electric_meter', metric: 'energy_kwh' },
    unit: 'kwh', bucket, buckets,
    total_kwh: buckets.reduce((s, b) => s + b.delta_kwh, 0),
    total_resets_count: buckets.reduce((s, b) => s + b.resets_count, 0),
    total_hours_with_data_count: buckets.reduce((s, b) => s + b.hours_with_data_count, 0),
  } as unknown as MeterRows;
}

/** The limit a capped tool's own description offers, "limit 1–N". */
function offeredLimit(role: SpecialistRole, tool: string): number {
  const d = toolDefinitions(role).find((t) => t.name === tool)!;
  return Number(/limit 1–(\d+)/.exec(d.description ?? '')?.[1]);
}

describe('capped lists at their maximum limit, with realistic rows', () => {
  const total = 60;

  it.each([
    ['list_alerts', DEFAULT_LIMITS.listAlertsMaxItems, 15],
    ['control_history', DEFAULT_LIMITS.controlHistoryMaxItems, 12],
    ['zone_timeline', DEFAULT_LIMITS.zoneTimelineMaxItems, 25],
  ] as const)('%s: the cap is %i, the description offers it, and a full page fits with room to spare', async (tool, cap, expected) => {
    expect(cap).toBe(expected);
    expect(offeredLimit('diagnose', tool)).toBe(cap);
    const h = toolHarness({
      reader: {
        listAlerts: async (q) => cappedOf(cycle(ALERT_ROWS, total), q.limit, total),
        controlHistory: async (q) => cappedOf(cycle(COMMAND_ROWS, total), q.limit, total),
        zoneTimeline: async (q) => ({
          items: cycle(TIMELINE_ROWS, q.limit), total, limit: q.limit, truncated: true,
          rulesInScope: { items: structuredClone(RULES), total: RULES.length, limit: 50, truncated: false },
        }),
      },
    });
    const input = tool === 'zone_timeline'
      ? { zoneId: Z.off305, from: WEEK_AGO, to: NOW_LOCAL, limit: cap }
      : tool === 'list_alerts'
        ? { state: 'any', from: null, to: null, zoneId: null, limit: cap }
        : { zoneId: null, from: null, to: null, limit: cap };
    const r = await h.call('diagnose', tool, input);
    expect(r.isError, r.content).toBeUndefined();
    const data = r.evidence!.data as { items: unknown[]; total_count: number; limit_count: number; truncated: boolean };
    expect(data).toMatchObject({ total_count: total, limit_count: cap, truncated: true });
    expect(data.items).toHaveLength(cap);
    expect(dataBytes(data)).toBeLessThanOrEqual(BOUND * HEADROOM);

    // One more is refused by name, before the reader — never clamped (§53).
    const over = await h.call('diagnose', tool, { ...input, limit: cap + 1 });
    expect(over).toMatchObject({ isError: true, content: expect.stringContaining(`limit is at most ${cap}`) });
  });

  it('compare_zones at 24 (every seeded zone) and equipment_status\'s whole register fit', async () => {
    expect(offeredLimit('analyse', 'compare_zones')).toBe(DEFAULT_LIMITS.compareZonesMaxItems);
    const h = toolHarness();
    for (const input of [
      { metric: 'temperature_c', from: WEEK_AGO, to: NOW_LOCAL, floorLevel: null, orderBy: 'minutes_above_band', limit: 24 },
      { metric: 'co2_ppm', from: '2026-09-01T00:00:00+04:00', to: NOW_LOCAL, floorLevel: null, orderBy: 'mean', limit: 24 },
    ]) {
      const r = await h.call('analyse', 'compare_zones', input);
      expect(r.isError, r.content).toBeUndefined();
      expect((r.evidence!.data as { items: unknown[] }).items).toHaveLength(24);
      expect(dataBytes(r.evidence!.data)).toBeLessThanOrEqual(BOUND * HEADROOM);
    }
    const all = await h.call('diagnose', 'equipment_status', { tag: null, zoneId: null });
    expect(all.evidence!.data).toMatchObject({ total_count: 40, limit_count: DEFAULT_LIMITS.equipmentStatusMaxItems, truncated: false });
    expect(dataBytes(all.evidence!.data)).toBeLessThanOrEqual(BOUND * HEADROOM);
  });
});

describe('the meter over its longest windows', () => {
  it('seven days of hours (168 buckets) fit, as columns on one axis — they were about 25 KB as rows', async () => {
    const from = '2026-09-21T12:00:00+04:00';
    const h = toolHarness({ reader: { meterConsumption: async () => meterRows('hour', Date.parse(from), 168) } });
    const r = await h.call('analyse', 'meter_consumption', { meterTag: 'MTR-MAIN', from, to: '2026-09-28T12:00:00+04:00', bucket: 'hour' });
    expect(r.isError, r.content).toBeUndefined();
    const data = r.evidence!.data as { buckets: Record<string, unknown[]>; buckets_count: number; first_bucket_start: string };
    expect(data.buckets_count).toBe(168);
    expect(data.first_bucket_start).toBe(from);
    for (const column of Object.values(data.buckets)) expect(column).toHaveLength(168);
    expect(data.buckets).not.toHaveProperty('bucket_start');   // the axis says it once
    expect(dataBytes(data)).toBeLessThanOrEqual(BOUND * HEADROOM);
  });

  it('ninety-two local days fit, each naming its own start', async () => {
    const from = '2026-06-28T00:00:00+04:00';
    const h = toolHarness({ reader: { meterConsumption: async () => meterRows('local_day', Date.parse(from), 92) } });
    const r = await h.call('analyse', 'meter_consumption', { meterTag: 'MTR-MAIN', from, to: '2026-09-28T00:00:00+04:00', bucket: 'local_day' });
    expect(r.isError, r.content).toBeUndefined();
    const data = r.evidence!.data as { buckets: Record<string, unknown[]> };
    expect(data.buckets.bucket_start).toHaveLength(92);
    expect(data.buckets.bucket_start![0]).toBe(from);
    expect(dataBytes(data)).toBeLessThanOrEqual(BOUND * HEADROOM);
  });

  it('an hour with no data is a null on the axis, not a missing bucket', async () => {
    const from = '2026-09-28T08:00:00+04:00';
    const rows = meterRows('hour', Date.parse(from), 4);
    (rows.buckets as unknown[]).splice(1, 1);   // no row for 09:00
    const h = toolHarness({ reader: { meterConsumption: async () => rows } });
    const r = await h.call('analyse', 'meter_consumption', { meterTag: 'MTR-MAIN', from, to: '2026-09-28T12:00:00+04:00', bucket: 'hour' });
    const data = r.evidence!.data as { buckets: Record<string, unknown[]>; buckets_count: number };
    expect(data.buckets_count).toBe(4);
    expect(data.buckets.delta_kwh).toEqual([156, null, 177, 177]);
    expect(data.buckets.hours_with_data_count).toEqual([1, 0, 1, 1]);
    expect(data.buckets.implied_mean_kw![1]).toBeNull();
  });
});

describe('list_zones', () => {
  it('fits the seeded building (24 zones), and refuses a building too large for one result — cleanly, never a partial list', async () => {
    const h = toolHarness();
    const r = await h.call('control', 'list_zones', {});
    expect(r.isError, r.content).toBeUndefined();
    expect(r.evidence!.data as unknown[]).toHaveLength(24);
    expect(dataBytes(r.evidence!.data)).toBeLessThanOrEqual(BOUND * HEADROOM);

    // Twice the building: every zone again under a new id.
    const doubled: ZoneSummary[] = [
      ...listZonesFixture(),
      ...listZonesFixture().map((z, i) => ({ ...z, id: `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`, name: `${z.name}B` })),
    ];
    const big = toolHarness({ reader: { listZones: async () => doubled } });
    const refused = await big.call('control', 'list_zones', {});
    expect(refused.isError).toBe(true);
    expect(refused.evidence).toBeUndefined();
    expect(refused.content).toMatch(/^result too large \(\d+(\.\d)? KB > 8 KB\); the building has more zones than one result can carry/);
    // No evidence id was spent on it.
    const next = await big.call('control', 'control_envelope', {});
    expect(next.evidence?.id).toBe('T1.E1');
  });
});
