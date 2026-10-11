import type {
  AlertListRow, Capped, CommandHistoryRow, CompareMetric, CompareOrder, CompareZonesRows,
  CopilotZoneMetric, DirectoryRow, EnergyDayRow, EnergyGroupBy, EnergyRow, EnergyRows,
  EquipmentStatusRow, FloorMeanRow, MeterRows, OrientSnapshot, RuleInScopeRow, TimelineRow,
  ZoneConditionMetrics, ZoneConditionsRows, ZoneHistoryRows, ZoneRankRow, ZoneTimelineRows,
} from '@dtwin/db';
import type { ControlSettings } from '@dtwin/types';
import type { ZoneSummary } from '../deps.ts';

/**
 * The seeded Corniche Tower, as data for the fakes (testing/fakes.ts).
 *
 * Every shape is exactly what the packages/db copilot queries return, and
 * the values are the dev database's own where one was captured:
 * scratchpad/dbcheck/samples.json (2026-09-28), the isolated database's asset
 * register (24 zones, 40 equipment), and read-only queries of the dev
 * database's control commands, alerts and maintenance logs. Where the spec's
 * fixture list names a figure (§6: OFF-305's 23.97 °C, 95% damper, 2,862 of
 * 3,000 m³/h, 18.2 of 20 people) it wins over the later capture, so the
 * tests and the spec agree.
 *
 * ONE DELIBERATE DEPARTURE FROM THE SEED: VAV-305 is in `fault`. The fake
 * probe keeps v1's rule that OFF-305 is refused `equipment_unavailable`, and
 * a register that said everything serving OFF-305 was operational would
 * contradict the probe it sits beside.
 *
 * Ids are synthetic and readable — zone `OFF-305` is
 * `00000000-0000-4000-8000-000000000305`, as in v1's tests — so a test can
 * name a zone without looking it up. Nothing here imports a runtime module
 * from `@dtwin/db`, so the fakes load without `pg`.
 */

export const FAKE_NOW_ISO = '2026-09-28T08:40:00.000Z';
export const TENANT_ID = '00000000-0000-4000-a000-000000000001';
export const USER_ID = '00000000-0000-4000-a000-000000000002';
export const BUILDING_ID = '00000000-0000-4000-b000-000000000001';
export const TIMEZONE = 'Asia/Dubai';

const HOUR_MS = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const at = (s: string): number => Date.parse(s);

/** Buckets of `widthS` STARTING in [from, to): the db layer's `bucketStartsIn`, restated so this file needs no `pg`. */
export function bucketsIn(fromMs: number, toMs: number, widthS: number): number {
  const w = widthS * 1000;
  return Math.max(0, Math.ceil(toMs / w) - Math.ceil(fromMs / w));
}

// ===================================================================== zones

export interface SeedZone {
  id: string;
  name: string;
  floor: string;
  level: number;
  type: string;
  area_m2: number;
  design_occupancy_count: number;
  designed_setpoint_c: number;
  deadband_k: number;
  ahu: string;
  vav: string;
}

// name, floor, level, type, area_m2, design occupancy, designed setpoint, deadband
const SEED_ZONES: ReadonlyArray<readonly [string, string, number, string, number, number, number, number]> = [
  ['COR-002', 'Ground Floor', 0, 'corridor', 199.99999999999997, 4, 24.5, 2],
  ['LOB-000', 'Ground Floor', 0, 'lobby', 200, 15, 23.5, 1.5],
  ['MEE-004', 'Ground Floor', 0, 'meeting', 200, 12, 22.5, 1],
  ['OFF-001', 'Ground Floor', 0, 'office', 200, 20, 23, 1],
  ['OFF-003', 'Ground Floor', 0, 'office', 200, 20, 23, 1],
  ['OFF-005', 'Ground Floor', 0, 'office', 199.99999999999997, 20, 23, 1],
  ['COR-102', 'Level 1', 1, 'corridor', 199.99999999999997, 4, 24.5, 2],
  ['MEE-104', 'Level 1', 1, 'meeting', 200, 12, 22.5, 1],
  ['OFF-100', 'Level 1', 1, 'office', 200, 20, 23, 1],
  ['OFF-101', 'Level 1', 1, 'office', 200, 20, 23, 1],
  ['OFF-103', 'Level 1', 1, 'office', 200, 20, 23, 1],
  ['SER-105', 'Level 1', 1, 'server_room', 199.99999999999997, 1, 21, 0.5],
  ['COR-202', 'Level 2', 2, 'corridor', 199.99999999999997, 4, 24.5, 2],
  ['MEE-204', 'Level 2', 2, 'meeting', 200, 12, 22.5, 1],
  ['OFF-200', 'Level 2', 2, 'office', 200, 20, 23, 1],
  ['OFF-201', 'Level 2', 2, 'office', 200, 20, 23, 1],
  ['OFF-203', 'Level 2', 2, 'office', 200, 20, 23, 1],
  ['OFF-205', 'Level 2', 2, 'office', 199.99999999999997, 20, 23, 1],
  ['COR-302', 'Level 3', 3, 'corridor', 199.99999999999997, 4, 24.5, 2],
  ['MEE-304', 'Level 3', 3, 'meeting', 200, 12, 22.5, 1],
  ['OFF-300', 'Level 3', 3, 'office', 200, 20, 23, 1],
  ['OFF-301', 'Level 3', 3, 'office', 200, 20, 23, 1],
  ['OFF-303', 'Level 3', 3, 'office', 200, 20, 23, 1],
  ['OFF-305', 'Level 3', 3, 'office', 199.99999999999997, 20, 23, 1],
];

export const ZONES: readonly SeedZone[] = SEED_ZONES.map(
  ([name, floor, level, type, area_m2, design_occupancy_count, designed_setpoint_c, deadband_k]) => ({
    id: `00000000-0000-4000-8000-000000000${name.slice(-3)}`,
    name, floor, level, type, area_m2, design_occupancy_count, designed_setpoint_c, deadband_k,
    ahu: `AHU-0${level + 1}`,
    vav: `VAV-${name.slice(-3)}`,
  }),
);

export function zoneByName(name: string): SeedZone {
  const z = ZONES.find((x) => x.name === name);
  if (!z) throw new Error(`fixtures: no zone ${name}`);
  return z;
}
export const zoneById = (id: string): SeedZone | undefined => ZONES.find((z) => z.id === id);
export const zoneId = (name: string): string => zoneByName(name).id;

/** The zones tests name most, as v1's tests named them. */
export const Z = {
  off300: zoneId('OFF-300'),
  off301: zoneId('OFF-301'),
  off303: zoneId('OFF-303'),
  off305: zoneId('OFF-305'),
  ser105: zoneId('SER-105'),
  cor302: zoneId('COR-302'),
  mee304: zoneId('MEE-304'),
  off205: zoneId('OFF-205'),
} as const;

// ================================================================= equipment

export interface SeedEquipment {
  tag: string;
  type: string;
  status: string;
  floor: string | null;
  parent: string | null;
  /** Mean of its power_kw point over the last hour; null when it has none. */
  power_kw: number | null;
  rated_airflow_cmh: number | null;
}

const FLOORS = ['Ground Floor', 'Level 1', 'Level 2', 'Level 3'] as const;

export const EQUIPMENT: readonly SeedEquipment[] = [
  ...FLOORS.map((floor, i) => ({
    tag: `AHU-0${i + 1}`, type: 'ahu', status: 'operational', floor, parent: 'CH-01',
    power_kw: [9.365820299216734, 9.341, 9.352, 9.327612452128447][i]!, rated_airflow_cmh: 18_000,
  })),
  { tag: 'CH-01', type: 'chiller', status: 'operational', floor: null, parent: 'CT-01', power_kw: 198.06994231761269, rated_airflow_cmh: null },
  { tag: 'CH-02', type: 'chiller', status: 'maintenance', floor: null, parent: 'CT-01', power_kw: 0, rated_airflow_cmh: null },
  { tag: 'CT-01', type: 'cooling_tower', status: 'operational', floor: null, parent: null, power_kw: 14.150621328316214, rated_airflow_cmh: null },
  { tag: 'EVC-01', type: 'ev_charger', status: 'operational', floor: null, parent: null, power_kw: 2.13, rated_airflow_cmh: null },
  ...FLOORS.map((floor, i) => ({
    tag: `LTG-0${i + 1}`, type: 'lighting_circuit', status: 'operational', floor, parent: null,
    power_kw: 1.15, rated_airflow_cmh: null,
  })),
  { tag: 'MTR-MAIN', type: 'electric_meter', status: 'operational', floor: null, parent: null, power_kw: null, rated_airflow_cmh: null },
  { tag: 'MTR-WATER', type: 'water_meter', status: 'operational', floor: null, parent: null, power_kw: null, rated_airflow_cmh: null },
  { tag: 'PMP-01', type: 'pump', status: 'operational', floor: null, parent: 'CH-01', power_kw: 13.3, rated_airflow_cmh: null },
  { tag: 'PMP-02', type: 'pump', status: 'operational', floor: null, parent: 'CH-02', power_kw: 13.2, rated_airflow_cmh: null },
  ...ZONES.map((z) => ({
    tag: z.vav, type: 'vav',
    status: z.name === 'OFF-305' ? 'fault' : 'operational',   // the one departure; see the header
    floor: z.floor, parent: z.ahu, power_kw: null, rated_airflow_cmh: 3000,
  })),
].sort((a, b) => a.tag.localeCompare(b.tag));

const equipmentByTag = (tag: string): SeedEquipment | undefined => EQUIPMENT.find((e) => e.tag === tag);
const statusOf = (tag: string): string => equipmentByTag(tag)?.status ?? 'operational';
export const servingOf = (z: SeedZone): string[] => [`${z.ahu} (${statusOf(z.ahu)})`, `${z.vav} (${statusOf(z.vav)})`];

function ancestors(tag: string): string[] {
  const out: string[] = [];
  let parent = equipmentByTag(tag)?.parent ?? null;
  while (parent !== null && out.length < 6 && !out.includes(parent)) {
    out.push(parent);
    parent = equipmentByTag(parent)?.parent ?? null;
  }
  return out;
}

function descendantsAndSelf(tag: string): Set<string> {
  const out = new Set([tag]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of EQUIPMENT) {
      if (e.parent !== null && out.has(e.parent) && !out.has(e.tag)) { out.add(e.tag); grew = true; }
    }
  }
  return out;
}

const byLevelThenName = (a: SeedZone, b: SeedZone) => a.level - b.level || a.name.localeCompare(b.name);

export interface MaintenanceLog {
  tag: string; log_type: string; performed_at: string; downtime_min: number | null;
  next_due_at: string | null; notes: string;
}

const QUARTERLY = 'Quarterly service: filters, belts, coil clean.';
export const MAINTENANCE: readonly MaintenanceLog[] = [
  { tag: 'CH-02', log_type: 'preventive', performed_at: '2026-07-08T11:48:12.674Z', downtime_min: 120, next_due_at: '2026-10-30T11:48:12.674Z', notes: QUARTERLY },
  { tag: 'CH-01', log_type: 'preventive', performed_at: '2026-07-15T11:48:12.674Z', downtime_min: 120, next_due_at: '2026-11-02T11:48:12.674Z', notes: QUARTERLY },
  { tag: 'AHU-04', log_type: 'preventive', performed_at: '2026-07-22T11:48:12.674Z', downtime_min: 120, next_due_at: '2026-11-05T11:48:12.674Z', notes: QUARTERLY },
  { tag: 'AHU-03', log_type: 'preventive', performed_at: '2026-07-29T11:48:12.674Z', downtime_min: 120, next_due_at: '2026-11-08T11:48:12.674Z', notes: QUARTERLY },
  { tag: 'AHU-02', log_type: 'preventive', performed_at: '2026-08-05T11:48:12.674Z', downtime_min: 120, next_due_at: '2026-11-11T11:48:12.674Z', notes: QUARTERLY },
  { tag: 'AHU-01', log_type: 'preventive', performed_at: '2026-08-12T11:48:12.674Z', downtime_min: 120, next_due_at: '2026-11-14T11:48:12.674Z', notes: QUARTERLY },
  {
    tag: 'CH-02', log_type: 'corrective', performed_at: '2026-09-09T11:48:12.674Z', downtime_min: 12_960, next_due_at: null,
    notes: 'Compressor 2 high-pressure trip. Awaiting replacement part; unit offline.',
  },
];

export function equipmentRow(e: SeedEquipment, nowMs: number): EquipmentStatusRow {
  const family = descendantsAndSelf(e.tag);
  const served = ZONES.filter((z) => family.has(z.ahu) || family.has(z.vav)).slice().sort(byLevelThenName);
  const logs = MAINTENANCE.filter((m) => m.tag === e.tag && at(m.performed_at) <= nowMs)
    .slice().sort((a, b) => at(b.performed_at) - at(a.performed_at));
  const last = logs[0] ?? null;
  const nextDue = logs.find((m) => m.next_due_at !== null)?.next_due_at ?? null;
  return {
    tag: e.tag,
    type: e.type,
    status: e.status,
    floor: e.floor,
    chain_up: ancestors(e.tag),
    zones_served: served.slice(0, 8).map((z) => z.name),
    zones_served_count: served.length,
    rated_airflow_cmh: e.rated_airflow_cmh,
    last_maintenance: last === null ? null : {
      performed_at: last.performed_at, log_type: last.log_type, downtime_min: last.downtime_min,
      notes_untrusted: last.notes, notes_truncated: false,
    },
    next_due_at: nextDue,
    overdue: nextDue !== null && at(nextDue) < nowMs,
  };
}

/** The serving chain of a zone and every ancestor, by tag — what `equipmentStatus({zoneId})` answers. */
export function servingChain(z: SeedZone): SeedEquipment[] {
  const tags = new Set<string>();
  for (const direct of [z.ahu, z.vav]) {
    tags.add(direct);
    for (const a of ancestors(direct)) tags.add(a);
  }
  return EQUIPMENT.filter((e) => tags.has(e.tag));
}

// ==================================================================== orient

export function orientFixture(nowMs: number): OrientSnapshot {
  return {
    building: {
      id: BUILDING_ID, name: 'Corniche Tower', timezone: TIMEZONE,
      gross_floor_area_m2: 4800, grid_carbon_kg_per_kwh: 0.42,
    },
    multipleBuildings: false,
    directory: ZONES.map((z): DirectoryRow => ({
      id: z.id, name: z.name, floor: z.floor, level: z.level, type: z.type, area_m2: z.area_m2,
      design_occupancy_count: z.design_occupancy_count, designed_setpoint_c: z.designed_setpoint_c,
      deadband_k: z.deadband_k, serving: servingOf(z),
    })),
    availability: {
      perFloorEnergyMeter: false,
      perZoneEnergyMeter: false,
      meters: [
        { tag: 'MTR-MAIN', type: 'electric_meter', unit: 'kwh' },
        { tag: 'MTR-WATER', type: 'water_meter', unit: 'm3' },
      ],
      telemetryFrom: '2026-09-18T06:00:00.000Z',
      telemetryTo: iso(nowMs),
      weather: [{ source: 'synthetic', rows_count: 73, from: '2026-06-19T20:00:00.000Z', to: '2026-06-22T20:00:00.000Z' }],
      observedWeather: false,
    },
  };
}

// ================================================================ list_zones

/**
 * The latest good temperature per zone. v1's three (OFF-301 24.2, OFF-303
 * 23.9) and OFF-305's last reading from its conditions; SER-105 is null — a
 * stale sensor, which is why the probe refuses it `feedback_unusable`.
 */
const LATEST_C: Readonly<Record<string, number | null>> = {
  'OFF-301': 24.2, 'OFF-303': 23.9, 'OFF-305': 24.17, 'SER-105': null,
  'COR-002': 25.616137896370066, 'LOB-000': 24.657727631308305, 'MEE-004': 23.505589682051603,
};

export function listZonesFixture(): ZoneSummary[] {
  return ZONES.slice()
    .sort((a, b) => a.floor.localeCompare(b.floor) || a.name.localeCompare(b.name))
    .map((z) => ({
      id: z.id, name: z.name, floorName: z.floor, zoneType: z.type, areaM2: z.area_m2,
      designedSetpointC: z.designed_setpoint_c, deadbandK: z.deadband_k,
      temperatureC: z.name in LATEST_C ? LATEST_C[z.name]! : Number((baseOf(z).temperature_c + 0.12).toFixed(2)),
      activeOverrideC: null, overrideUntil: null,
      equipment: [z.ahu, z.vav].sort().map((tag) => ({ tag, status: statusOf(tag) })),
    }));
}

// ================================================================ conditions

type Base = Record<CopilotZoneMetric, number>;

/** Window means by zone type, from the 7-day compare_zones capture; OFF-305 from §6. */
function baseOf(z: SeedZone): Base {
  const tweak = (Number(z.name.slice(-3)) % 7) * 0.0009;   // no two zones tie
  if (z.name === 'OFF-305') {
    return {
      temperature_c: 23.9712, humidity_pct: 58.3, co2_ppm: 996, occupancy_count: 18.2,
      airflow_cmh: 2862, damper_position_pct: 95.2, setpoint_temp_c: 23,
    };
  }
  const t = {
    office: [23.5706, 57.1, 742, 16.4, 2405, 78.5],
    meeting: [23.0908, 55.4, 812, 7.6, 2110, 70.2],
    corridor: [25.0027, 52.3, 486, 2.1, 1310, 45.8],
    lobby: [24.1043, 54.8, 562, 9.8, 1905, 60.4],
    server_room: [21.2011, 44.9, 431, 0.4, 905, 35.1],
  }[z.type] ?? [23.5, 55, 700, 10, 2000, 70];
  return {
    temperature_c: t[0]! + tweak, humidity_pct: t[1]!, co2_ppm: t[2]!, occupancy_count: t[3]!,
    airflow_cmh: t[4]!, damper_position_pct: t[5]!, setpoint_temp_c: z.designed_setpoint_c,
  };
}

const UNIT: Readonly<Record<CopilotZoneMetric, string>> = {
  temperature_c: 'c', humidity_pct: 'pct', co2_ppm: 'ppm', occupancy_count: 'count',
  airflow_cmh: 'cmh', damper_position_pct: 'pct', setpoint_temp_c: 'c',
};
const slopeKey = (u: string) => (u === 'c' ? 'slope_k_per_h' : `slope_${u}_per_h`);

/** OFF-305 since 09:00 local (§6 and facts): the "why is it warm" fixture. */
const OFF305_STATS: Readonly<Record<CopilotZoneMetric, readonly [number, number, number, string, number, number, number]>> = {
  // mean, min, max, max_at, first, last, slope per hour
  temperature_c: [23.9712, 23.67, 24.26, '2026-09-28T08:30:00.000Z', 23.82, 24.17, 0.046],
  setpoint_temp_c: [23, 23, 23, '2026-09-28T07:45:00.000Z', 23, 23, 0],
  damper_position_pct: [95.2, 85.66, 100, '2026-09-28T06:45:00.000Z', 89.19, 99.18, 0.875],
  airflow_cmh: [2862, 2595.28, 3059.95, '2026-09-28T07:30:00.000Z', 2686.92, 2992.44, 29.56],
  occupancy_count: [18.2, 12, 22, '2026-09-28T07:50:00.000Z', 17.9, 20.3, -0.139],
  co2_ppm: [996, 839.01, 1074.98, '2026-09-28T07:00:00.000Z', 988.35, 1050.94, -5.43],
  humidity_pct: [58.3, 54.62, 61.48, '2026-09-28T06:15:00.000Z', 59.23, 55.96, -0.744],
};

const METRIC_ORDER: readonly CopilotZoneMetric[] = [
  'airflow_cmh', 'co2_ppm', 'damper_position_pct', 'humidity_pct', 'occupancy_count', 'setpoint_temp_c', 'temperature_c',
];

export function zoneConditionsFixture(z: SeedZone, fromMs: number, toMs: number, nowMs: number): ZoneConditionsRows {
  const expected = bucketsIn(fromMs, Math.min(toMs, nowMs), 300);
  const base = baseOf(z);
  const metrics: Record<string, Record<string, unknown>> = {};
  for (const m of METRIC_ORDER) {
    const u = UNIT[m];
    const staleSensor = z.name === 'SER-105' && m === 'temperature_c';
    const s = OFF305_STATS[m];
    const mean = base[m];
    const spread = m === 'temperature_c' ? 0.33 : m === 'setpoint_temp_c' ? 0 : mean * 0.08;
    const row = z.name === 'OFF-305'
      ? { mean: s[0], min: s[1], max: s[2], maxAt: s[3], first: s[4], last: s[5], slope: s[6] }
      : {
        mean, min: mean - spread, max: mean + spread, maxAt: iso(fromMs + Math.max(0, expected - 2) * 300_000),
        first: mean - spread / 2, last: mean + spread / 2, slope: 0,
      };
    metrics[m] = {
      [`mean_${u}`]: staleSensor ? null : row.mean,
      [`min_${u}`]: staleSensor ? null : row.min,
      [`max_${u}`]: staleSensor ? null : row.max,
      max_at: staleSensor || expected === 0 ? null : row.maxAt,
      [`first_${u}`]: staleSensor ? null : row.first,
      [`last_${u}`]: staleSensor ? null : row.last,
      [slopeKey(u)]: staleSensor ? null : row.slope,
      sensors_count: 1,
      good_buckets_count: staleSensor ? 0 : expected,
      expected_buckets_count: expected,
      flagged_samples_count: 0,
      stale: staleSensor,
    };
  }
  const occupied = expected * 5;
  const band = z.deadband_k / 2;
  // SER-105's temperature probe is silent: occupied, and never judged against a band.
  const noTemperature = z.name === 'SER-105';
  const warm = !noTemperature && base.temperature_c > z.designed_setpoint_c + band;
  const judged = (minutes: number) => (noTemperature ? null : minutes);
  return {
    zone: { id: z.id, name: z.name, floor: z.floor, level: z.level, type: z.type },
    metrics: metrics as ZoneConditionMetrics,
    comfort: {
      occupied_min: occupied,
      occupied_with_temperature_min: noTemperature ? 0 : occupied,
      above_design_band_min: judged(warm ? occupied : 0),
      below_design_band_min: judged(0),
      above_effective_band_min: judged(warm ? occupied : 0),
      below_effective_band_min: judged(0),
    },
    design: {
      setpoint_c: z.designed_setpoint_c, deadband_k: z.deadband_k,
      design_occupancy_count: z.design_occupancy_count, area_m2: z.area_m2, vav_rated_airflow_cmh: 3000,
    },
    ahu: { tag: z.ahu, supply_air_mean_c: z.ahu === 'AHU-04' ? 14.997173604734025 : 15.02 },
  };
}

// =================================================================== history

export function zoneHistoryFixture(
  z: SeedZone, metrics: readonly CopilotZoneMetric[], resolution: '5m' | '1h', fromMs: number, toMs: number, nowMs: number,
): ZoneHistoryRows {
  const widthMs = (resolution === '5m' ? 300 : 3600) * 1000;
  const base = baseOf(z);
  const series: Record<string, Array<Record<string, unknown>>> = {};
  for (const m of [...new Set(metrics)].sort()) {
    const u = UNIT[m];
    const points: Array<Record<string, unknown>> = [];
    if (!(z.name === 'SER-105' && m === 'temperature_c')) {   // a stale sensor has no buckets at all
      const end = Math.min(toMs, nowMs);
      for (let t = Math.ceil(fromMs / widthMs) * widthMs, i = 0; t < end; t += widthMs, i += 1) {
        const wobble = m === 'setpoint_temp_c' ? 0 : Math.sin(i / 3) * (m === 'temperature_c' ? 0.12 : base[m] * 0.02);
        points.push({ at: iso(t), [`mean_${u}`]: base[m] + wobble, flagged_count: 0 });
      }
    }
    series[m] = points;
  }
  return { resolution, series: series as ZoneHistoryRows['series'] };
}

// ================================================================== commands

export interface SeedCommand {
  zone: string; setpoint_c: number; previous_c: number; state: string;
  requested_at: string; applied_at: string; effective_until: string; reason: string; outcome: string;
}

export const COPILOT_PRECOOL_REASON =
  "copilot (operator-approved): Pre-cool Level 3 offices ahead of this afternoon's demand peak";
const DEVICE_SIM = 'applied by the in-process device simulator';

/** The dev database's five commands: one manual test on 21 Sep, four copilot pre-cools at 00:29Z on 24 Sep. */
export const COMMANDS: readonly SeedCommand[] = [
  { zone: 'COR-302', setpoint_c: 23, previous_c: 24.5, state: 'applied', requested_at: '2026-09-21T08:59:28.334Z',
    applied_at: '2026-09-21T08:59:29.163Z', effective_until: '2026-09-21T09:59:28.331Z', reason: 'test', outcome: DEVICE_SIM },
  { zone: 'OFF-300', setpoint_c: 21, previous_c: 23, state: 'applied', requested_at: '2026-09-24T00:29:20.336Z',
    applied_at: '2026-09-24T00:29:23.701Z', effective_until: '2026-09-24T04:29:20.318Z', reason: COPILOT_PRECOOL_REASON, outcome: DEVICE_SIM },
  { zone: 'OFF-301', setpoint_c: 21, previous_c: 23, state: 'applied', requested_at: '2026-09-24T00:29:23.193Z',
    applied_at: '2026-09-24T00:29:29.095Z', effective_until: '2026-09-24T04:29:23.194Z', reason: COPILOT_PRECOOL_REASON, outcome: DEVICE_SIM },
  { zone: 'OFF-303', setpoint_c: 21, previous_c: 23, state: 'applied', requested_at: '2026-09-24T00:29:25.551Z',
    applied_at: '2026-09-24T00:29:29.102Z', effective_until: '2026-09-24T04:29:25.553Z', reason: COPILOT_PRECOOL_REASON, outcome: DEVICE_SIM },
  { zone: 'OFF-305', setpoint_c: 21, previous_c: 23, state: 'applied', requested_at: '2026-09-24T00:29:27.337Z',
    applied_at: '2026-09-24T00:29:32.927Z', effective_until: '2026-09-24T04:29:27.344Z', reason: COPILOT_PRECOOL_REASON, outcome: DEVICE_SIM },
];

export function commandRow(c: SeedCommand, nowMs: number): CommandHistoryRow {
  const z = zoneByName(c.zone);
  return {
    zone: c.zone, floor: z.floor, setpoint_c: c.setpoint_c, previous_c: c.previous_c, state: c.state,
    requested_at: c.requested_at, applied_at: c.applied_at, settled_at: c.applied_at,
    effective_until: c.effective_until,
    active_now: c.state === 'applied' && at(c.effective_until) > nowMs,
    from_copilot: c.reason.startsWith('copilot (operator-approved):'),
    reason_untrusted: c.reason, reason_truncated: false,
    outcome_untrusted: c.outcome, outcome_truncated: false,
  };
}

// ==================================================================== alerts

export interface SeedAlert {
  rule: 'Thermal drift' | 'Zone overheating'; zone: string; opened_at: string; resolved_at: string | null;
  threshold: number; trigger: number;
}

/** Every alert the dev database holds: the 24 Sep drift pairs follow the pre-cools by 14 min and their lapse by 10. */
export const ALERTS: readonly SeedAlert[] = [
  { rule: 'Zone overheating', zone: 'OFF-205', opened_at: '2026-09-21T08:52:55.032Z', resolved_at: '2026-09-21T08:52:57.425Z', threshold: 27, trigger: 33.66077779038403 },
  { rule: 'Thermal drift', zone: 'COR-302', opened_at: '2026-09-21T09:23:28.757Z', resolved_at: '2026-09-21T09:27:13.810Z', threshold: 2, trigger: -2.526732181128275 },
  { rule: 'Thermal drift', zone: 'COR-302', opened_at: '2026-09-21T10:23:53.470Z', resolved_at: '2026-09-21T10:29:53.589Z', threshold: 2, trigger: 2.73761158874264 },
  { rule: 'Thermal drift', zone: 'OFF-300', opened_at: '2026-09-24T00:42:56.002Z', resolved_at: '2026-09-24T01:15:41.360Z', threshold: 2, trigger: -2.0031255130112027 },
  { rule: 'Thermal drift', zone: 'OFF-305', opened_at: '2026-09-24T00:43:01.036Z', resolved_at: '2026-09-24T01:15:51.365Z', threshold: 2, trigger: -2.007565526072755 },
  { rule: 'Thermal drift', zone: 'OFF-301', opened_at: '2026-09-24T00:43:01.137Z', resolved_at: '2026-09-24T01:15:51.379Z', threshold: 2, trigger: -2.0089145056257833 },
  { rule: 'Thermal drift', zone: 'OFF-303', opened_at: '2026-09-24T00:43:05.981Z', resolved_at: '2026-09-24T01:15:51.379Z', threshold: 2, trigger: -2.0058646471487585 },
  { rule: 'Thermal drift', zone: 'OFF-305', opened_at: '2026-09-24T04:39:40.541Z', resolved_at: '2026-09-24T05:17:51.311Z', threshold: 2, trigger: 2.0041484162898717 },
  { rule: 'Thermal drift', zone: 'OFF-300', opened_at: '2026-09-24T04:39:50.541Z', resolved_at: '2026-09-24T05:17:56.333Z', threshold: 2, trigger: 2.0051860168770252 },
  { rule: 'Thermal drift', zone: 'OFF-303', opened_at: '2026-09-24T04:39:50.559Z', resolved_at: '2026-09-24T05:18:01.314Z', threshold: 2, trigger: 2.0043149095134862 },
  { rule: 'Thermal drift', zone: 'OFF-301', opened_at: '2026-09-24T04:40:00.538Z', resolved_at: '2026-09-24T05:17:56.316Z', threshold: 2, trigger: 2.00240712866076 },
];

const short = (n: number): string => String(Number(n.toFixed(2)));

function alertShape(a: SeedAlert) {
  const drift = a.rule === 'Thermal drift';
  return {
    severity: 'warning',
    metric: 'temperature_c',
    condition: drift ? 'rate_of_change' : 'threshold_above',
    // The unit of a rate-of-change threshold is K/h; of a threshold, °C
    // (packages/db thresholdSuffix / triggerSuffix).
    thresholdKey: drift ? 'threshold_k_per_h' : 'threshold_c',
    triggerKey: drift ? 'trigger_k_per_h' : 'trigger_c',
    message: drift
      ? `Thermal drift: ${a.zone} Zone Temperature changing at ${short(a.trigger)}°C/h (limit ${short(a.threshold)}°C/h)`
      : `Zone overheating: ${a.zone} Zone Temperature at ${short(a.trigger)}°C (limit ${short(a.threshold)}°C)`,
  };
}

export function alertRow(a: SeedAlert, nowMs: number): AlertListRow {
  const s = alertShape(a);
  const end = a.resolved_at === null ? nowMs : at(a.resolved_at);
  return {
    rule: a.rule, zone: a.zone, floor: zoneByName(a.zone).floor, equipment: null, severity: s.severity,
    state: a.resolved_at === null ? 'open' : 'resolved',
    opened_at: a.opened_at, resolved_at: a.resolved_at,
    duration_s: Math.round((end - at(a.opened_at)) / 1000),
    metric: s.metric, condition: s.condition,
    [s.thresholdKey]: a.threshold, [s.triggerKey]: a.trigger,
    message_untrusted: s.message, message_truncated: false,
  } as AlertListRow;
}

// ================================================================== timeline

export const RULES_IN_SCOPE: readonly RuleInScopeRow[] = [
  { name: 'CO2 breach', metric: 'co2_ppm', condition: 'threshold_above', scope: 'building', threshold_ppm: 1200, window_s: null, consecutive_breaches_count: 2, severity: 'warning', enabled: true },
  { name: 'Chiller power spike', metric: 'power_kw', condition: 'threshold_above', scope: 'equipment', threshold_kw: 320, window_s: null, consecutive_breaches_count: 3, severity: 'critical', enabled: true },
  { name: 'Point offline', metric: 'temperature_c', condition: 'no_data', scope: 'building', threshold_c: null, window_s: 900, consecutive_breaches_count: 1, severity: 'critical', enabled: true },
  { name: 'Stuck sensor', metric: 'temperature_c', condition: 'flatline', scope: 'building', threshold_c: null, window_s: 7200, consecutive_breaches_count: 1, severity: 'info', enabled: true },
  { name: 'Thermal drift', metric: 'temperature_c', condition: 'rate_of_change', scope: 'building', threshold_k_per_h: 2, window_s: 3600, consecutive_breaches_count: 1, severity: 'warning', enabled: true },
  { name: 'Zone overheating', metric: 'temperature_c', condition: 'threshold_above', scope: 'building', threshold_c: 27, window_s: null, consecutive_breaches_count: 3, severity: 'warning', enabled: true },
];

/** Three 15-minute holes in OFF-305's temperature feed on 24 Sep, as the 7-day capture showed. */
const OFF305_GAPS: readonly string[] = ['2026-09-24T14:25:00.000Z', '2026-09-24T15:00:00.000Z', '2026-09-24T15:25:00.000Z'];

/** Every event the timeline query would find for a zone, before windowing. */
export function timelineEvents(z: SeedZone, nowMs: number): TimelineRow[] {
  const out: TimelineRow[] = [];
  for (const c of COMMANDS.filter((x) => x.zone === z.name)) {
    out.push({ at: c.requested_at, kind: 'command_requested', detail: {
      setpoint_c: c.setpoint_c, previous_c: c.previous_c, state: c.state, effective_until: c.effective_until,
      from_copilot: c.reason.startsWith('copilot (operator-approved):'),
      reason_untrusted: c.reason, reason_truncated: false,
    } });
    out.push({ at: c.applied_at, kind: 'command_applied', detail: { setpoint_c: c.setpoint_c, effective_until: c.effective_until } });
    if (c.state === 'applied' && at(c.effective_until) < nowMs) {
      out.push({ at: c.effective_until, kind: 'override_lapsed', detail: { setpoint_c: c.setpoint_c, applied_at: c.applied_at } });
    }
  }
  for (const a of ALERTS.filter((x) => x.zone === z.name)) {
    const s = alertShape(a);
    out.push({ at: a.opened_at, kind: 'alert_opened', detail: {
      rule: a.rule, severity: s.severity, metric: s.metric, equipment: null, condition: s.condition,
      message_untrusted: s.message, message_truncated: false,
      [s.thresholdKey]: a.threshold, [s.triggerKey]: a.trigger,
    } });
    if (a.resolved_at !== null) {
      out.push({ at: a.resolved_at, kind: 'alert_resolved', detail: {
        rule: a.rule, severity: s.severity, metric: s.metric, equipment: null, opened_at: a.opened_at,
        duration_s: Math.round((at(a.resolved_at) - at(a.opened_at)) / 1000),
      } });
    }
  }
  const chain = new Set(servingChain(z).map((e) => e.tag));
  for (const m of MAINTENANCE.filter((x) => chain.has(x.tag))) {
    out.push({ at: m.performed_at, kind: 'maintenance', detail: {
      tag: m.tag, log_type: m.log_type, downtime_min: m.downtime_min, next_due_at: m.next_due_at,
      notes_untrusted: m.notes, notes_truncated: false,
    } });
  }
  if (z.name === 'OFF-305') {
    for (const g of OFF305_GAPS) {
      out.push({ at: g, kind: 'data_gap', detail: { metric: 'temperature_c', duration_min: 15, until: iso(at(g) + 15 * 60_000) } });
    }
  }
  return out;
}

export function zoneTimelineFixture(z: SeedZone, fromMs: number, toMs: number, limit: number, nowMs: number): ZoneTimelineRows {
  const inWindow = timelineEvents(z, nowMs).filter((e) => at(e.at) >= fromMs && at(e.at) < toMs && at(e.at) <= nowMs);
  // Newest first under the limit, then oldest first — as the query does.
  const newest = inWindow.slice().sort((a, b) => at(b.at) - at(a.at) || a.kind.localeCompare(b.kind)).slice(0, limit);
  return {
    items: newest.reverse(),
    total: inWindow.length,
    limit,
    truncated: inWindow.length > newest.length,
    rulesInScope: { items: RULES_IN_SCOPE.map((r) => ({ ...r })), total: RULES_IN_SCOPE.length, limit: 50, truncated: false },
  };
}

// ==================================================================== energy

const floorRow = (floor: string | null, level: number | null, end_use: string | null, energy_kwh: number, sensors: number, good: number): EnergyRow =>
  ({ floor, level, end_use, energy_kwh, sensors_count: sensors, good_buckets_count: good, expected_buckets_count: sensors * 2016, flagged_samples_count: 0 });

/**
 * Seven days to 28 Sep, measured from the power gauges. Every floor is the
 * same to within 0.03% (AHU ≈1,172 kWh and lighting ≈167 kWh each): the
 * device simulator draws them alike, which is why "which floor used most"
 * has the honest answer "indistinguishable" (FLOORS_WITHIN_2PCT).
 */
const AHU_KWH = [1171.6874959976442, 1171.556821543994, 1171.8673203539272, 1171.4957714]; // L3 derived
const LTG_KWH = [166.8580631645993, 166.61663444460888, 166.61762883845213, 166.7830211];
const PLANT: ReadonlyArray<readonly [string, number, number]> = [
  ['chiller', 25461.7755027352, 2], ['cooling_tower', 1846.2185566726616, 1],
  ['ev_charger', 308.6138268561224, 1], ['pump', 3855.808192434838, 2],
];

export function energyFixture(groupBy: EnergyGroupBy, fromMs: number, toMs: number): EnergyRows {
  if (groupBy === 'local_day') {
    return { groupBy, rows: ENERGY_DAYS.filter((d) => at(d.day_end) > fromMs && at(d.day_start) < toMs).map((d) => ({ ...d })) };
  }
  if (groupBy === 'floor') {
    return { groupBy, rows: [
      ...FLOORS.map((f, i) => floorRow(f, i, null, AHU_KWH[i]! + LTG_KWH[i]!, 2, 3474)),
      floorRow('building plant', null, null, PLANT.reduce((s, p) => s + p[1], 0), 6, 10_422),
    ] };
  }
  if (groupBy === 'end_use') {
    return { groupBy, rows: [
      floorRow(null, null, 'ahu', AHU_KWH.reduce((s, v) => s + v, 0), 4, 6948),
      ...PLANT.filter((p) => p[0] === 'chiller' || p[0] === 'cooling_tower' || p[0] === 'ev_charger')
        .map(([use, kwh, n]) => floorRow(null, null, use, kwh, n, 1737 * n)),
      floorRow(null, null, 'lighting_circuit', LTG_KWH.reduce((s, v) => s + v, 0), 4, 6948),
      floorRow(null, null, 'pump', PLANT[3]![1], 2, 3474),
    ] };
  }
  return { groupBy, rows: [
    ...FLOORS.flatMap((f, i) => [
      floorRow(f, i, 'ahu', AHU_KWH[i]!, 1, 1737),
      floorRow(f, i, 'lighting_circuit', LTG_KWH[i]!, 1, 1737),
    ]),
    ...PLANT.map(([use, kwh, n]) => floorRow('building plant', null, use, kwh, n, 1737 * n)),
  ] };
}

const day = (d: string, start: string, end: string, energy_kwh: number, good: number, expected: number): EnergyDayRow =>
  ({ day: d, day_start: start, day_end: end, energy_kwh, sensors_count: 14, good_buckets_count: good, expected_buckets_count: expected, flagged_samples_count: 0 });

export const ENERGY_DAYS: readonly EnergyDayRow[] = [
  day('2026-09-21', '2026-09-20T20:00:00.000Z', '2026-09-21T20:00:00.000Z', 1127.9488015105994, 686, 1554),
  day('2026-09-22', '2026-09-21T20:00:00.000Z', '2026-09-22T20:00:00.000Z', 2249.0249544986254, 1442, 4032),
  day('2026-09-23', '2026-09-22T20:00:00.000Z', '2026-09-23T20:00:00.000Z', 6097.418211983833, 4032, 4032),
  day('2026-09-24', '2026-09-23T20:00:00.000Z', '2026-09-24T20:00:00.000Z', 5489.3865570606995, 3640, 4032),
  day('2026-09-25', '2026-09-24T20:00:00.000Z', '2026-09-25T20:00:00.000Z', 6098.4600586496235, 4032, 4032),
  day('2026-09-26', '2026-09-25T20:00:00.000Z', '2026-09-26T20:00:00.000Z', 6028.9349759964825, 3990, 4032),
  day('2026-09-27', '2026-09-26T20:00:00.000Z', '2026-09-27T20:00:00.000Z', 6099.718411379104, 4032, 4032),
  day('2026-09-28', '2026-09-27T20:00:00.000Z', '2026-09-28T20:00:00.000Z', 3635.0068644732723, 2464, 2478),
];

// ===================================================================== meter

/**
 * One meter bucket as the db layer returns it: its reset-aware delta, and its
 * first and last RAW readings with when they were taken — the step from one
 * bucket's last reading to the next one's first is counted by the window
 * total and by no bucket.
 */
function bucket<U extends 'kwh' | 'm3'>(
  unit: U, bucket_start: string, delta: number, resets_count: number, hours_with_data_count: number,
  readings: readonly [first: number, last: number], times: readonly [firstAt: string, lastAt: string],
) {
  return {
    bucket_start, [`delta_${unit}`]: delta, resets_count, hours_with_data_count,
    [`first_reading_${unit}`]: readings[0], [`last_reading_${unit}`]: readings[1],
    first_at: times[0], last_at: times[1],
  } as { bucket_start: string; resets_count: number; hours_with_data_count: number; first_at: string; last_at: string }
    & Record<`delta_${U}` | `first_reading_${U}` | `last_reading_${U}`, number>;
}

/** An hour of MTR-MAIN, its readings and their times as the dev database holds them. */
const hour = (bucket_start: string, delta_kwh: number, resets_count: number,
  readings: readonly [number, number], times: readonly [string, string]) =>
  bucket('kwh', bucket_start, delta_kwh, resets_count, 1, readings, times);

/**
 * MTR-MAIN by hour across 24 Sep 00:00Z, as the dev database holds it: one
 * reset at 22:00Z and a 15,537.9 kWh hour at 00:00Z — the smoke suite's
 * writes into the seeded meter, which is why the tool reports
 * `total_kwh` and `total_excluding_suspect_kwh` side by side. The window
 * total (17,944.4) is the window's own delta, not the bucket sum: the eleven
 * steps between buckets add 29.1 kWh.
 */
export const METER_MAIN_HOURLY: MeterRows = {
  meter: { tag: 'MTR-MAIN', type: 'electric_meter', metric: 'energy_kwh' },
  unit: 'kwh',
  bucket: 'hour',
  buckets: [
    hour('2026-09-23T18:00:00.000Z', 156, 0, [1000003, 1000159], ['2026-09-23T18:07:32.076Z', '2026-09-23T18:59:32.076Z']),
    hour('2026-09-23T19:00:00.000Z', 177, 0, [1000162, 1000339], ['2026-09-23T19:00:32.076Z', '2026-09-23T19:59:32.076Z']),
    hour('2026-09-23T20:00:00.000Z', 177, 0, [1000342, 1000519], ['2026-09-23T20:00:32.076Z', '2026-09-23T20:59:32.076Z']),
    hour('2026-09-23T21:00:00.000Z', 177, 0, [1000522, 1000699], ['2026-09-23T21:00:32.076Z', '2026-09-23T21:59:32.076Z']),
    hour('2026-09-23T22:00:00.000Z', 174, 1, [1000702, 156], ['2026-09-23T22:00:32.076Z', '2026-09-23T22:59:32.076Z']),
    hour('2026-09-23T23:00:00.000Z', 177, 0, [159, 336], ['2026-09-23T23:00:32.076Z', '2026-09-23T23:59:32.076Z']),
    hour('2026-09-24T00:00:00.000Z', 15537.910699824813, 0, [339, 15876.910699824813],
      ['2026-09-24T00:00:32.076Z', '2026-09-24T00:59:50.285Z']),
    hour('2026-09-24T01:00:00.000Z', 252.07448547175045, 0, [15879.004855627792, 16131.079341099543],
      ['2026-09-24T01:00:20.314Z', '2026-09-24T01:59:55.335Z']),
    hour('2026-09-24T02:00:00.000Z', 256.79387070817575, 0, [16133.224269691173, 16390.01814039935],
      ['2026-09-24T02:00:25.380Z', '2026-09-24T02:59:31.403Z']),
    hour('2026-09-24T03:00:00.000Z', 267.3669762665777, 0, [16392.228371588237, 16659.595347854814],
      ['2026-09-24T03:00:01.456Z', '2026-09-24T03:59:37.545Z']),
    hour('2026-09-24T04:00:00.000Z', 276.7101608962803, 0, [16661.880960440572, 16938.591121336853],
      ['2026-09-24T04:00:07.598Z', '2026-09-24T04:59:43.613Z']),
    hour('2026-09-24T05:00:00.000Z', 286.3993927130432, 0, [16940.957313147963, 17227.356705861006],
      ['2026-09-24T05:00:13.662Z', '2026-09-24T05:59:49.773Z']),
  ],
  total_kwh: 17944.35670586105,
  total_resets_count: 1,
  total_hours_with_data_count: 12,
};

/**
 * MTR-MAIN by local day over the week: 23 Sep reads 992,509 kWh — smoke
 * contamination, not a building. The readings between days are the dev
 * database's; the first day's are consistent with its delta and its reset.
 */
export const METER_MAIN_DAILY: MeterRows = {
  meter: { tag: 'MTR-MAIN', type: 'electric_meter', metric: 'energy_kwh' },
  unit: 'kwh',
  bucket: 'local_day',
  buckets: [
    bucket('kwh', '2026-09-20T20:00:00.000Z', 5888.545314759249, 1, 7, [1000486, 5315.545314759236],
      ['2026-09-21T09:00:35.172Z', '2026-09-21T16:00:24.168Z']),
    bucket('kwh', '2026-09-21T20:00:00.000Z', 2509.6541336647033, 0, 9, [5318.21764251154, 7827.871776176244],
      ['2026-09-22T11:26:25.657Z', '2026-09-22T19:59:35.779Z']),
    bucket('kwh', '2026-09-22T20:00:00.000Z', 992508.9828668889, 0, 24, [7830.017133111077, 1000339],
      ['2026-09-22T20:00:05.830Z', '2026-09-23T19:59:32.076Z']),
    bucket('kwh', '2026-09-23T20:00:00.000Z', 21808.64606352942, 1, 24, [1000342, 21430.646063529384],
      ['2026-09-23T20:00:32.076Z', '2026-09-24T19:59:31.428Z']),
    bucket('kwh', '2026-09-24T20:00:00.000Z', 6802.1940844553355, 0, 24, [21432.79127768315, 28234.985362138486],
      ['2026-09-24T20:00:01.477Z', '2026-09-25T19:59:43.816Z']),
    bucket('kwh', '2026-09-25T20:00:00.000Z', 6802.066642543166, 0, 24, [28237.130576292253, 35039.19721883542],
      ['2026-09-25T20:00:13.865Z', '2026-09-26T19:59:56.467Z']),
    bucket('kwh', '2026-09-26T20:00:00.000Z', 6800.685551513459, 0, 24, [35041.342932722924, 41842.02848423638],
      ['2026-09-26T20:00:26.523Z', '2026-09-27T19:59:46.998Z']),
    bucket('kwh', '2026-09-27T20:00:00.000Z', 4041.4211832654473, 0, 15, [41844.17376978068, 45885.59495304613],
      ['2026-09-27T20:00:17.048Z', '2026-09-28T10:59:34.337Z']),
  ],
  total_kwh: 1047178.5949530462,
  total_resets_count: 2,
  total_hours_with_data_count: 151,
};

/**
 * Consecutive buckets of one meter with no reset, their readings chained so
 * that the steps between them add up to what the window total holds beyond
 * the bucket deltas.
 */
function chained<U extends 'kwh' | 'm3'>(
  unit: U, startReading: number, total: number,
  spec: ReadonlyArray<{ start: string; delta: number; hours: number }>,
) {
  const between = (total - spec.reduce((s, b) => s + b.delta, 0)) / Math.max(1, spec.length - 1);
  let reading = startReading;
  return spec.map((b, i) => {
    if (i > 0) reading += between;
    const first = reading;
    reading += b.delta;
    const t0 = at(b.start);
    return bucket(unit, b.start, b.delta, 0, b.hours, [first, reading],
      [iso(t0 + 15_000), iso(t0 + b.hours * HOUR_MS - 45_000)]);
  });
}

export const METER_WATER_DAILY: MeterRows = {
  meter: { tag: 'MTR-WATER', type: 'water_meter', metric: 'water_m3' },
  unit: 'm3',
  bucket: 'local_day',
  buckets: chained('m3', 4210.5, 75.44852869862552, [
    { start: '2026-09-24T20:00:00.000Z', delta: 11.177094619788477, hours: 10 },
    { start: '2026-09-25T20:00:00.000Z', delta: 24.86456485839335, hours: 24 },
    { start: '2026-09-26T20:00:00.000Z', delta: 24.851630731809564, hours: 24 },
    { start: '2026-09-27T20:00:00.000Z', delta: 14.489586359273744, hours: 15 },
  ]),
  total_m3: 75.44852869862552,
  total_resets_count: 0,
  total_hours_with_data_count: 73,
};

export const METER_WATER_HOURLY: MeterRows = {
  meter: { tag: 'MTR-WATER', type: 'water_meter', metric: 'water_m3' },
  unit: 'm3',
  bucket: 'hour',
  buckets: chained('m3', 4290.25, 8.49, Array.from({ length: 8 }, (_, i) => ({
    start: iso(at('2026-09-28T00:00:00.000Z') + i * HOUR_MS), delta: 1.02 + i * 0.01, hours: 1,
  }))),
  total_m3: 8.49,
  total_resets_count: 0,
  total_hours_with_data_count: 8,
};

/**
 * The meter answer for a tag and bucketing. The window is NOT applied: each
 * fixture is one fixed series, returned whole, so a test that asks for 24 Sep
 * gets the reset and the spike it is about. A test that needs other hours
 * overrides `meterConsumption`.
 */
export function meterFixture(tag: string, bucket: 'hour' | 'local_day'): MeterRows | { unknownMeter: true } {
  if (tag === 'MTR-MAIN') return structuredClone(bucket === 'hour' ? METER_MAIN_HOURLY : METER_MAIN_DAILY);
  if (tag === 'MTR-WATER') return structuredClone(bucket === 'hour' ? METER_WATER_HOURLY : METER_WATER_DAILY);
  return { unknownMeter: true };
}

// ============================================================= compare_zones

/** Minutes above the designed band over the capture's day, occupied time only (compare_zones band sample). */
const MINUTES_ABOVE_BAND: Readonly<Record<string, number>> = {
  office: 700, meeting: 715, corridor: 0, lobby: 120, server_room: 0,
};

export function compareZonesFixture(q: {
  metric: CompareMetric; fromMs: number; toMs: number; floorLevel: number | null; orderBy: CompareOrder; limit: number; nowMs: number;
}): CompareZonesRows {
  if (q.orderBy === 'minutes_above_band' && q.metric !== 'temperature_c') {
    throw new RangeError('minutes_above_band ranks temperature_c only');
  }
  const u = UNIT[q.metric];
  const hours = bucketsIn(q.fromMs, Math.min(q.toMs, q.nowMs), 3600);
  // Coverage is counted in 5-minute periods of the covered window: every one of them, here.
  const coveredFrom = Math.ceil(q.fromMs / HOUR_MS) * HOUR_MS;
  const periods = bucketsIn(coveredFrom, Math.max(coveredFrom, Math.min(Math.ceil(q.toMs / HOUR_MS) * HOUR_MS, q.nowMs)), 300);
  const scope = ZONES.filter((z) => q.floorLevel === null || z.level === q.floorLevel);
  const ranked = scope.map((z) => {
    const mean = baseOf(z)[q.metric];
    const minutes = z.name === 'OFF-305'
      ? 710
      : Math.max(0, (MINUTES_ABOVE_BAND[z.type] ?? 0) - (Number(z.name.slice(-3)) % 3) * 5);
    return {
      z, mean, max: mean * (q.metric === 'temperature_c' ? 1.0315 : 1.18),
      minutes: q.metric === 'temperature_c' ? minutes : null,
    };
  });
  const key = (r: (typeof ranked)[number]) =>
    q.orderBy === 'mean' ? r.mean : q.orderBy === 'max' ? r.max : (r.minutes ?? -1);
  ranked.sort((a, b) => key(b) - key(a) || a.z.name.localeCompare(b.z.name));

  const floors = [...new Set(scope.map((z) => z.level))].sort((a, b) => a - b);
  return {
    items: ranked.slice(0, q.limit).map((r) => ({
      zone_id: r.z.id, zone: r.z.name, floor: r.z.floor, level: r.z.level, area_m2: r.z.area_m2,
      [`mean_${u}`]: hours > 0 ? r.mean : null,
      [`max_${u}`]: hours > 0 ? r.max : null,
      good_buckets_count: periods,
      flagged_samples_count: 0,
      ...(q.orderBy === 'minutes_above_band' ? { minutes_above_band_min: r.minutes } : {}),
    }) as ZoneRankRow),
    total: ranked.length,
    limit: q.limit,
    truncated: ranked.length > q.limit,
    // Area-weighted over every zone in scope, never a mean of zone means.
    floor_means: floors.map((level) => {
      const on = ranked.filter((r) => r.z.level === level);
      const area = on.reduce((s, r) => s + r.z.area_m2, 0);
      return {
        floor: on[0]!.z.floor, level,
        [`mean_${u}`]: hours > 0 ? on.reduce((s, r) => s + r.mean * r.z.area_m2, 0) / area : null,
        zones_with_data_count: hours > 0 ? on.length : 0,
        zones_count: on.length,
      } as FloorMeanRow;
    }),
    // packages/db's compareCovered, restated (nothing here loads a runtime
    // module from @dtwin/db): buckets starting in [from, to), ending at the
    // later hour or now, whichever is earlier.
    covered: {
      from: iso(Math.ceil(q.fromMs / HOUR_MS) * HOUR_MS),
      to: iso(Math.max(Math.ceil(q.fromMs / HOUR_MS) * HOUR_MS, Math.min(Math.ceil(q.toMs / HOUR_MS) * HOUR_MS, q.nowMs))),
    },
  };
}

// ================================================================== control

/** v1's envelope: control on, ±3 K of design, 2 K steps, 15 min apart, 1 h default, 12 h ceiling. */
export const CONTROL_SETTINGS: ControlSettings = {
  enabled: true, maxDeviationK: 3, maxStepK: 2, minIntervalS: 900,
  defaultDurationS: 3600, maxDurationS: 43_200, commandTtlS: 300,
};

// ==================================================================== lists

/** A capped page of `items` — the db layer's `capped`, for tests that build their own list fixtures. */
export function cappedOf<T>(items: readonly T[], limit: number, total: number = items.length): Capped<T> {
  const page = items.slice(0, limit);
  return { items: page, total, limit, truncated: total > page.length };
}
