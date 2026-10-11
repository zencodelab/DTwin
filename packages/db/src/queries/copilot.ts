import type { AggregateBucket } from '@dtwin/types';
import type { Db } from '../client.ts';
import { getSensorHistory, maxHistoryHours } from './telemetry.ts';

/**
 * The copilot's reads (docs/decisions.md §64): one function per `TwinReader`
 * method in apps/web/lib/copilot/backend.ts, and nothing else. Every one takes
 * a tenant-scoped handle that the caller opened with
 * `withTenant(ctx, fn, { readOnly: true })`, so the tenant comes from RLS
 * (there is no `WHERE tenant_id` anywhere below, and there must not be) and a
 * statement that tried to write would fail with SQLSTATE 25006.
 *
 * WHAT THIS LAYER OWNS, AND WHAT IT LEAVES TO THE TOOL
 *
 * Here: the SQL, and everything that needs it — aggregates, event timestamps,
 * counts, staleness against the database clock, the number of buckets a
 * window SHOULD hold (it is a fact about this file's predicates, so it lives
 * beside them). Every numeric key already ends in its unit suffix, so the
 * row IS the evidence data and the units-in-names rule is mechanical from the
 * first line that produces a number. Instants are ISO-8601 UTC strings; the
 * tool renders them in the building's offset.
 *
 * In apps/web/lib/copilot/tools: every judgement over these rows — coverage
 * percentages, `suspect` meter buckets and the total without them, whether
 * floors are indistinguishable, which caveats apply — so that the tests that
 * pin those judgements exercise the real code against a fake reader, rather
 * than testing a fixture that already holds the answer.
 *
 * THE RULES EVERY QUERY HERE OBEYS (CLAUDE.md, hard rules)
 *
 * - Only the tenant-scoped barrier views: `telemetry_5m_t`, `telemetry_1h_t`.
 *   Never the bare aggregates (dtwin_app has no grant on them) and never raw
 *   `telemetry`. The one exception is `copilotListZones`, v1's latest-GOOD
 *   reading from `telemetry_t`, kept verbatim (§55).
 * - A flagged sample is COUNTED and kept out of every statistic. The rollups
 *   already filter avg/min/max/last/counter_agg on `quality = 0`; a mean here
 *   is weighted by `sample_count - bad_quality_count` so a bucket with one
 *   good sample does not count like a bucket with five, and the flagged total
 *   is always returned beside it.
 * - A capped list says so: `count(*) OVER ()` in the same statement as the
 *   page, returned as `{ items, total, limit, truncated }` (§53, §56).
 * - Cumulative meters are never averaged and never max − min: `delta` and
 *   `num_resets` of `rollup(counter)`, and the window total is its own rollup,
 *   never a sum of per-bucket deltas (that drops every increment that
 *   straddles a bucket boundary — 0.8% low on the seeded main meter).
 * - Local days are the building's, via `time_bucket(…, timezone)`.
 * - Free text people typed (alert messages, command reasons, maintenance
 *   notes, gateway outcomes) is cut to `UNTRUSTED_TEXT_CHARS` in SQL and
 *   returned ONLY under an `*_untrusted` key, with `*_truncated` beside it.
 *   A model reads these results; the key name is the label that says "this
 *   is data somebody wrote, not an instruction".
 */

// ============================================================ shared helpers

/** The most characters of any free-text column a copilot result carries. */
export const UNTRUSTED_TEXT_CHARS = 300;

/**
 * The zone metrics the copilot reads, and the unit suffix each one's
 * statistics carry. A metric's own name already ends in its unit
 * (`temperature_c`, `co2_ppm`), so `mean_c` is simply "the mean of a `_c`
 * quantity" — the map exists so the TYPE of every result key is known.
 */
export const COPILOT_ZONE_METRICS = [
  'temperature_c', 'humidity_pct', 'co2_ppm', 'occupancy_count',
  'airflow_cmh', 'damper_position_pct', 'setpoint_temp_c',
] as const;
export type CopilotZoneMetric = (typeof COPILOT_ZONE_METRICS)[number];

export const ZONE_METRIC_UNIT = {
  temperature_c: 'c',
  humidity_pct: 'pct',
  co2_ppm: 'ppm',
  occupancy_count: 'count',
  airflow_cmh: 'cmh',
  damper_position_pct: 'pct',
  setpoint_temp_c: 'c',
} as const satisfies Record<CopilotZoneMetric, string>;
type UnitOf<M extends CopilotZoneMetric> = (typeof ZONE_METRIC_UNIT)[M];

/**
 * The unit suffix of any metric_type value: the text after its last `_`.
 * `pressure_pa` gives `pa`, which is not a citable unit — correctly, since
 * the copilot has no business quoting a figure it has no unit for.
 */
export function metricSuffix(metric: string): string {
  const i = metric.lastIndexOf('_');
  return i === -1 ? metric : metric.slice(i + 1);
}

/**
 * The unit of a DIFFERENCE between two values of a metric. A temperature
 * difference is kelvin, not degrees Celsius — "2 °C from setpoint" is the
 * mistake units-in-names exists to stop. Every other unit differences to
 * itself.
 */
function differenceSuffix(u: string): string {
  return u === 'c' ? 'k' : u;
}

/**
 * The unit an alert rule's THRESHOLD is in, which is not always the metric's.
 *
 * Read off the rule engine (apps/ingest/src/rules/conditions.ts), which is
 * the only authority on what the number means:
 * - `rate_of_change` compares a least-squares slope PER HOUR, so a
 *   temperature rule's threshold is K/h (`k_per_h`). For other metrics the
 *   key is `<u>_per_h`, which the verifier refuses to cite — honestly, since
 *   no such unit is in its table.
 * - `deviation_from_setpoint` compares |value − setpoint|: a difference, so K.
 * - everything else compares the value itself, in the metric's unit.
 *
 * Null when the metric is unknown: the caller then writes a bare `threshold`
 * key, which is uncitable by construction.
 */
export function thresholdSuffix(metric: string | null, condition: string): string | null {
  if (metric === null) return null;
  const u = metricSuffix(metric);
  if (condition === 'rate_of_change') return `${differenceSuffix(u)}_per_h`;
  if (condition === 'deviation_from_setpoint') return differenceSuffix(u);
  return u;
}

/**
 * The unit an alert's TRIGGER value is in. The engine stores the slope for
 * `rate_of_change` and the READING for every other condition — including
 * `deviation_from_setpoint`, whose trigger is the temperature that breached,
 * in °C, not the deviation.
 */
export function triggerSuffix(metric: string | null, condition: string): string | null {
  if (metric === null) return null;
  if (condition === 'rate_of_change') return thresholdSuffix(metric, condition);
  return metricSuffix(metric);
}

function unitKey(prefix: string, suffix: string | null): string {
  return suffix === null ? prefix : `${prefix}_${suffix}`;
}

/**
 * How many buckets of `widthS` START inside [from, to) — exactly the rows the
 * predicate `a.bucket >= from AND a.bucket < to` can return per sensor, so a
 * coverage figure built on it can never exceed 100%.
 *
 * time_bucket's default origin (2000-01-03T00:00Z) is a multiple of five
 * minutes, of an hour and of a day since the Unix epoch, so epoch-aligned
 * arithmetic here agrees with it for every width this file uses.
 */
export function bucketStartsIn(from: Date, to: Date, widthS: number): number {
  const w = widthS * 1000;
  return Math.max(0, Math.ceil(to.getTime() / w) - Math.ceil(from.getTime() / w));
}

/** Expected buckets in a window that may reach past now: the future holds none. */
function expectedUpToNow(from: Date, to: Date, widthS: number, now: Date = new Date()): number {
  return bucketStartsIn(from, to.getTime() > now.getTime() ? now : to, widthS);
}

function iso(v: Date | string | null | undefined): string | null {
  return v === null || v === undefined ? null : new Date(v).toISOString();
}

/**
 * An instant rendered in SQL exactly as `Date.prototype.toISOString` renders
 * it. For timestamps built into a jsonb detail, which would otherwise arrive
 * as Postgres's `2026-09-24 04:29:20.318+00` and be a second format to parse.
 */
function isoSql(expr: string): string {
  return `to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/** A free-text column as `<name>_untrusted` + `<name>_truncated`. */
function untrustedSql(expr: string, name: string): string {
  return `left(${expr}, ${UNTRUSTED_TEXT_CHARS}) AS "${name}_untrusted",
          coalesce(length(${expr}) > ${UNTRUSTED_TEXT_CHARS}, false) AS "${name}_truncated"`;
}

/** The same pair, as arguments to jsonb_build_object. */
function untrustedJson(expr: string, name: string): string {
  return `'${name}_untrusted', left(${expr}, ${UNTRUSTED_TEXT_CHARS}),
          '${name}_truncated', coalesce(length(${expr}) > ${UNTRUSTED_TEXT_CHARS}, false)`;
}

/**
 * The good-weighted mean of a rollup column, as SQL.
 *
 * Weighted by the GOOD samples in each bucket, because that is how many
 * readings `avg_value` is the mean of: a bucket whose other four samples were
 * flagged is one reading, not five. A bucket holding only flagged samples has
 * a NULL avg and zero weight, so it contributes nothing — and a window with
 * no good sample at all is NULL, never zero.
 */
function goodMeanSql(a: string): string {
  return `(sum(${a}.avg_value * (${a}.sample_count - ${a}.bad_quality_count))::float8
           / nullif(sum(${a}.sample_count - ${a}.bad_quality_count), 0)::float8)`;
}

/**
 * Refuse an unknown IANA zone before Postgres does. Postgres would throw too,
 * but with "time zone not recognized", which reaches the model as "database
 * unavailable" — the wrong diagnosis for a wrong argument.
 */
function assertTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new RangeError(`unknown time zone ${JSON.stringify(tz)}`);
  }
}

/** A capped list, and the truth about the cap (§53). */
export interface Capped<T> {
  items: T[];
  /** Matching rows before the limit. */
  total: number;
  limit: number;
  truncated: boolean;
}

function capped<T>(items: T[], total: number, limit: number): Capped<T> {
  return { items, total, limit, truncated: total > items.length };
}

// ==================================================================== orient

export interface OrientBuilding {
  id: string;
  name: string;
  timezone: string;
  gross_floor_area_m2: number | null;
  grid_carbon_kg_per_kwh: number;
}

/** One zone of the directory every planner and specialist call receives. */
export interface DirectoryRow {
  id: string;
  name: string;
  floor: string;
  level: number;
  type: string;
  area_m2: number | null;
  design_occupancy_count: number | null;
  designed_setpoint_c: number | null;
  deadband_k: number | null;
  /** "AHU-04 (operational)", by tag. Status is current only (no history exists). */
  serving: string[];
}

/**
 * A meter `meter_consumption` can read: an electric or water meter with an
 * active cumulative point in the metric its type implies — the same
 * predicate `copilotMeterConsumption` resolves a tag with, so every tag listed
 * here is one that call accepts.
 */
export interface OrientMeterRow {
  tag: string;
  type: 'electric_meter' | 'water_meter';
  unit: MeterUnit;
}

export interface WeatherSourceRow {
  source: string;
  rows_count: number;
  from: string;
  to: string;
}

export interface OrientSnapshot {
  /** The first building by name, or null when the tenant has none. */
  building: OrientBuilding | null;
  /**
   * True when the tenant has more than one building. The copilot answers for
   * the first and says so (notice `multiple_buildings`); everything below is
   * scoped to that one building except the telemetry span, which is tenant-wide.
   */
  multipleBuildings: boolean;
  directory: DirectoryRow[];
  availability: {
    /** A cumulative energy meter on equipment that belongs to a floor. */
    perFloorEnergyMeter: boolean;
    /** A cumulative energy meter anchored to a zone, directly or via its equipment. */
    perZoneEnergyMeter: boolean;
    /**
     * The building's readable meters, by tag. The copilot's prompts are
     * byte-constant and name no building's equipment, so this is how a model
     * learns which meters exist — as data, from the register.
     */
    meters: OrientMeterRow[];
    /** First hourly bucket, tenant-wide. */
    telemetryFrom: string | null;
    /** End of the last hourly bucket, never later than now. */
    telemetryTo: string | null;
    /** Rows per `weather_observations.source`, for this building, all time. */
    weather: WeatherSourceRow[];
    /**
     * Weather that is neither `synthetic` (the worker's own design day) nor a
     * `forecast`, inside the telemetry span — the only kind that could be
     * compared with what the building measured.
     */
    observedWeather: boolean;
  };
}

/**
 * The most zones the directory will carry. The directory is handed whole to
 * every planner and specialist call, so the bound is set by that consumer; a
 * building past it THROWS rather than sending a partial directory, for the
 * same reason the spatial tree does (§53): a zone missing from the directory
 * is a zone the planner believes does not exist.
 */
export const COPILOT_DIRECTORY_MAX_ZONES = 500;

/**
 * The most meters orient will list. Past it orient THROWS, for the
 * directory's reason: the list is handed whole to every planner and
 * specialist, and a meter missing from it is one they believe does not exist.
 */
export const COPILOT_ORIENT_MAX_METERS = 50;

export class CopilotMetersTooManyError extends Error {
  constructor(readonly limit: number) {
    super(`building has more than ${limit} readable meters; the copilot's meter list is sent whole and cannot be truncated`);
    this.name = 'CopilotMetersTooManyError';
  }
}

export class CopilotDirectoryTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(
      `building has more than ${limit} zones; the copilot's zone directory is ` +
        'sent whole and cannot be truncated without hiding zones from it',
    );
    this.name = 'CopilotDirectoryTooLargeError';
  }
}

export async function copilotOrient(
  db: Db,
  maxZones: number = COPILOT_DIRECTORY_MAX_ZONES,
  maxMeters: number = COPILOT_ORIENT_MAX_METERS,
): Promise<OrientSnapshot> {
  // LIMIT 2: enough to know there is more than one without reading them all.
  const { rows: buildings } = await db.query<OrientBuilding>(
    `SELECT id, name, timezone, gross_floor_area_m2, grid_carbon_kg_per_kwh
       FROM buildings ORDER BY name, id LIMIT 2`,
  );
  const building = buildings[0] ?? null;

  // Tenant-wide and cheap: min/max on the hourly rollup. Hourly because the
  // question is "roughly which days exist", and the 5-minute view is 12x
  // the rows for no gain in the answer.
  const { rows: [span] } = await db.query<{ from: Date | null; to: Date | null }>(
    `SELECT min(bucket) AS "from",
            least(max(bucket) + INTERVAL '1 hour', now()) AS "to"
       FROM telemetry_1h_t`,
  );
  const telemetryFrom = iso(span?.from);
  const telemetryTo = iso(span?.to);

  if (!building) {
    return {
      building: null, multipleBuildings: false, directory: [],
      availability: {
        perFloorEnergyMeter: false, perZoneEnergyMeter: false, meters: [],
        telemetryFrom, telemetryTo, weather: [], observedWeather: false,
      },
    };
  }

  const { rows: directory } = await db.query<DirectoryRow>(
    `SELECT z.id, z.name, f.name AS floor, f.level, z.zone_type::text AS type,
            z.area_m2, z.design_occupancy AS design_occupancy_count,
            p.setpoint_temp_c AS designed_setpoint_c, p.deadband_k,
            coalesce((SELECT array_agg(e.tag || ' (' || e.status::text || ')' ORDER BY e.tag)
                        FROM equipment_zone_service s
                        JOIN equipment e ON e.id = s.equipment_id
                       WHERE s.zone_id = z.id), '{}') AS serving
       FROM zones z
       JOIN floors f ON f.id = z.floor_id
       LEFT JOIN thermal_profiles p ON p.id = z.thermal_profile_id
      WHERE f.building_id = $1
      ORDER BY f.level, z.name
      LIMIT $2`,
    [building.id, maxZones + 1],
  );
  if (directory.length > maxZones) throw new CopilotDirectoryTooLargeError(maxZones);

  // Which questions the metering can answer at all. The seeded building has
  // one main meter and no floor or zone meters, so "which floor used most
  // energy" can only ever be answered from power gauges, and "which zone"
  // not at all — orient says so before any model is asked.
  const { rows: [meters] } = await db.query<{ perFloor: boolean; perZone: boolean }>(
    `SELECT EXISTS (
              SELECT 1 FROM sensors s JOIN equipment e ON e.id = s.equipment_id
               WHERE e.building_id = $1 AND s.is_active AND s.is_cumulative
                 AND s.metric = 'energy_kwh' AND e.floor_id IS NOT NULL) AS "perFloor",
            EXISTS (
              SELECT 1 FROM sensors s
                LEFT JOIN equipment e ON e.id = s.equipment_id
                LEFT JOIN zones z ON z.id = coalesce(s.zone_id, e.zone_id)
                LEFT JOIN floors f ON f.id = z.floor_id
               WHERE f.building_id = $1 AND s.is_active AND s.is_cumulative
                 AND s.metric = 'energy_kwh') AS "perZone"`,
    [building.id],
  );

  // One row per tag: the first qualifying point, as meter_consumption picks it.
  const { rows: meterRows } = await db.query<{ tag: string; type: 'electric_meter' | 'water_meter'; metric: string }>(
    `SELECT DISTINCT ON (e.tag) e.tag, e.equipment_type::text AS type, s.metric::text AS metric
       FROM equipment e
       JOIN sensors s ON s.equipment_id = e.id
      WHERE e.building_id = $1
        AND e.equipment_type IN ('electric_meter', 'water_meter')
        AND s.is_cumulative AND s.is_active
        AND s.metric = CASE e.equipment_type WHEN 'electric_meter' THEN 'energy_kwh'::metric_type
                                             ELSE 'water_m3'::metric_type END
      ORDER BY e.tag, e.id, s.id
      LIMIT $2`,
    [building.id, maxMeters + 1],
  );
  if (meterRows.length > maxMeters) throw new CopilotMetersTooManyError(maxMeters);

  const { rows: weather } = await db.query<{ source: string; rows_count: number; from: Date; to: Date }>(
    `SELECT left(source, 40) AS source, count(*) AS rows_count,
            min(time) AS "from", max(time) AS "to"
       FROM weather_observations
      WHERE building_id = $1
      GROUP BY left(source, 40)
      ORDER BY 1`,
    [building.id],
  );

  const { rows: [observed] } = await db.query<{ observed: boolean }>(
    `SELECT EXISTS (
              SELECT 1 FROM weather_observations
               WHERE building_id = $1 AND source NOT IN ('synthetic', 'forecast')
                 AND time >= $2 AND time <= $3) AS observed`,
    [building.id, span?.from ?? null, span?.to ?? null],
  );

  return {
    building,
    multipleBuildings: buildings.length > 1,
    directory,
    availability: {
      perFloorEnergyMeter: meters?.perFloor ?? false,
      perZoneEnergyMeter: meters?.perZone ?? false,
      meters: meterRows.map((m) => ({ tag: m.tag, type: m.type, unit: m.metric === 'energy_kwh' ? 'kwh' : 'm3' })),
      telemetryFrom,
      telemetryTo,
      weather: weather.map((w) => ({
        source: w.source, rows_count: w.rows_count, from: iso(w.from)!, to: iso(w.to)!,
      })),
      observedWeather: observed?.observed ?? false,
    },
  };
}

// ================================================================ list_zones

/** v1's `ZoneSummary`, field for field (apps/web/lib/copilot/backend.ts). */
export interface CopilotZoneSummary {
  id: string;
  name: string;
  floorName: string;
  zoneType: string;
  areaM2: number | null;
  /** Latest GOOD temperature in the last hour, or null. §55's rule. */
  temperatureC: number | null;
  designedSetpointC: number | null;
  deadbandK: number | null;
  activeOverrideC: number | null;
  overrideUntil: string | null;
  equipment: Array<{ tag: string; status: string }>;
}

/**
 * v1's `list_zones` query, moved here unchanged so every copilot statement
 * lives in one file (§5.2). Its camelCase shape is v1's tool vocabulary,
 * which the controller keeps verbatim; it is the one reader that is not
 * unit-suffixed snake_case, and the one that reads `telemetry_t` — the
 * latest GOOD reading in the last hour, the rule the live map paints by
 * (§55). A value the map would grey out is not a value to plan from.
 */
export async function copilotListZones(db: Db): Promise<CopilotZoneSummary[]> {
  const { rows } = await db.query<CopilotZoneSummary & { equipment: CopilotZoneSummary['equipment'] | null; overrideUntil: Date | string | null }>(
    `SELECT z.id, z.name, f.name AS "floorName", z.zone_type AS "zoneType",
            z.area_m2 AS "areaM2",
            p.setpoint_temp_c AS "designedSetpointC", p.deadband_k AS "deadbandK",
            (SELECT t.value FROM telemetry_t t
               JOIN sensors s ON s.id = t.sensor_id
              WHERE s.zone_id = z.id AND s.metric = 'temperature_c' AND t.quality = 0
                AND t.time > now() - INTERVAL '1 hour'
              ORDER BY t.time DESC LIMIT 1) AS "temperatureC",
            o.setpoint_temp_c AS "activeOverrideC",
            o.effective_until AS "overrideUntil",
            (SELECT json_agg(json_build_object('tag', e.tag, 'status', e.status) ORDER BY e.tag)
               FROM equipment_zone_service s JOIN equipment e ON e.id = s.equipment_id
              WHERE s.zone_id = z.id) AS equipment
       FROM zones z
       JOIN floors f ON f.id = z.floor_id
       LEFT JOIN thermal_profiles p ON p.id = z.thermal_profile_id
       LEFT JOIN LATERAL (
         SELECT c.setpoint_temp_c, c.effective_until
           FROM control_commands c
          WHERE c.zone_id = z.id AND c.state = 'applied' AND c.effective_until > now()
          ORDER BY c.effective_until DESC LIMIT 1
       ) o ON true
      ORDER BY f.name, z.name`,
  );
  return rows.map((r) => ({
    ...r,
    equipment: r.equipment ?? [],
    overrideUntil: iso(r.overrideUntil),
  }));
}

// =========================================================== zone_conditions

type SlopeKey<U extends string> = U extends 'c' ? 'slope_k_per_h' : `slope_${U}_per_h`;

/**
 * One metric over a window, from 5-minute rollups. Keys carry the metric's
 * unit (`mean_c`, `max_ppm`); the slope is per hour, and a temperature slope
 * is in K/h because it is a rate of DIFFERENCE.
 */
export type MetricStats<U extends string> =
  { [K in `mean_${U}` | `min_${U}` | `max_${U}` | `first_${U}` | `last_${U}`]: number | null }
  & { [K in SlopeKey<U>]: number | null }
  & {
    /** Start of the 5-minute bucket that held the highest good sample. */
    max_at: string | null;
    sensors_count: number;
    good_buckets_count: number;
    /** 5-minute buckets starting in [from, min(to, now)), per sensor, summed. */
    expected_buckets_count: number;
    flagged_samples_count: number;
    /** Some sensor has reported nothing for 3× its interval, as of NOW. */
    stale: boolean;
  };

export type ZoneConditionMetrics = { [M in CopilotZoneMetric]?: MetricStats<UnitOf<M>> };

export interface ZoneConditionsRows {
  zone: { id: string; name: string; floor: string; level: number; type: string };
  /** One entry per metric the zone HAS an active sensor for, data or not. */
  metrics: ZoneConditionMetrics;
  /**
   * Minutes (5-minute buckets × 5) while occupied (mean occupancy > 0).
   * Design band = the profile's setpoint ± deadband/2 (the engine's and the
   * dashboard's band, docs/decisions.md; not ± deadband). Effective band =
   * the setpoint the VAV reported in that bucket, override included, with
   * the same half-deadband.
   *
   * All null when no bucket in the window had an occupancy reading: "occupied"
   * cannot be judged, and zero minutes would read as "measured, and fine".
   * The band minutes are also null when the zone has no profile to judge by,
   * and when the zone WAS occupied but no occupied bucket had a good
   * temperature (a flagged or silent probe) — for the effective band, a good
   * temperature and a reported setpoint. Zero minutes out of band there would
   * be the same false "fine" (review, ADR 64). `occupied_with_temperature_min`
   * says how much of the occupied time the band minutes could judge.
   */
  comfort: {
    occupied_min: number | null;
    occupied_with_temperature_min: number | null;
    above_design_band_min: number | null;
    below_design_band_min: number | null;
    above_effective_band_min: number | null;
    below_effective_band_min: number | null;
  };
  design: {
    setpoint_c: number | null;
    deadband_k: number | null;
    design_occupancy_count: number | null;
    area_m2: number | null;
    /** The serving VAV's rating (first by tag), or null with no VAV. */
    vav_rated_airflow_cmh: number | null;
  };
  /** The serving AHU (first by tag) and its supply-air mean over the window. */
  ahu: { tag: string; supply_air_mean_c: number | null } | null;
}

interface MetricRow {
  metric: CopilotZoneMetric;
  mean: number | null;
  min: number | null;
  max: number | null;
  max_at: Date | null;
  first: number | null;
  last: number | null;
  slope_per_h: number | null;
  sensors: number;
  good: number;
  flagged: number;
  stale: boolean;
}

/**
 * Null when the zone does not exist for this tenant — RLS makes another
 * tenant's zone and a missing one the same answer, which is the right one.
 */
export async function copilotZoneConditions(
  db: Db,
  q: { zoneId: string; from: Date; to: Date },
): Promise<ZoneConditionsRows | null> {
  const { rows: [design] } = await db.query<{
    id: string; name: string; floor: string; level: number; type: string;
    setpoint_c: number | null; deadband_k: number | null;
    design_occupancy_count: number | null; area_m2: number | null;
    vav_rated_airflow_cmh: number | null;
    ahu_tag: string | null; supply_air_mean_c: number | null;
  }>(
    `SELECT z.id, z.name, f.name AS floor, f.level, z.zone_type::text AS type,
            p.setpoint_temp_c AS setpoint_c, p.deadband_k,
            z.design_occupancy AS design_occupancy_count, z.area_m2,
            (SELECT e.rated_airflow_cmh
               FROM equipment_zone_service s JOIN equipment e ON e.id = s.equipment_id
              WHERE s.zone_id = z.id AND e.equipment_type = 'vav'
              ORDER BY e.tag LIMIT 1) AS vav_rated_airflow_cmh,
            ahu.tag AS ahu_tag, ahu.supply_air_mean_c
       FROM zones z
       JOIN floors f ON f.id = z.floor_id
       LEFT JOIN thermal_profiles p ON p.id = z.thermal_profile_id
       LEFT JOIN LATERAL (
         SELECT e.tag,
                (SELECT ${goodMeanSql('a')}
                   FROM sensors s JOIN telemetry_5m_t a ON a.sensor_id = s.id
                  WHERE s.equipment_id = e.id AND s.metric = 'temperature_c' AND s.is_active
                    AND a.bucket >= $2 AND a.bucket < $3) AS supply_air_mean_c
           FROM equipment_zone_service es JOIN equipment e ON e.id = es.equipment_id
          WHERE es.zone_id = z.id AND e.equipment_type = 'ahu'
          ORDER BY e.tag LIMIT 1
       ) ahu ON true
      WHERE z.id = $1`,
    [q.zoneId, q.from, q.to],
  );
  if (!design) return null;

  // Every active sensor of each metric, LEFT JOINed to its window so a metric
  // whose sensors reported nothing still appears — with zero good buckets and
  // a null mean, which is a finding, rather than silently missing.
  const { rows: stats } = await db.query<MetricRow>(
    `WITH pts AS (
       SELECT id, metric::text AS metric, sample_interval_s, last_seen_at
         FROM sensors
        WHERE zone_id = $1 AND is_active AND metric::text = ANY($4::text[])
     )
     SELECT p.metric,
            ${goodMeanSql('a')} AS mean,
            min(a.min_value) AS min, max(a.max_value) AS max,
            (array_agg(a.bucket ORDER BY a.max_value DESC) FILTER (WHERE a.max_value IS NOT NULL))[1] AS max_at,
            (array_agg(a.avg_value ORDER BY a.bucket) FILTER (WHERE a.avg_value IS NOT NULL))[1] AS first,
            (array_agg(a.avg_value ORDER BY a.bucket DESC) FILTER (WHERE a.avg_value IS NOT NULL))[1] AS last,
            regr_slope(a.avg_value, extract(epoch FROM a.bucket)::float8 / 3600.0) AS slope_per_h,
            count(DISTINCT p.id) AS sensors,
            count(a.avg_value) AS good,
            coalesce(sum(a.bad_quality_count), 0)::int8 AS flagged,
            bool_or(p.last_seen_at IS NULL
                    OR p.last_seen_at < now() - 3 * p.sample_interval_s * INTERVAL '1 second') AS stale
       FROM pts p
       LEFT JOIN telemetry_5m_t a ON a.sensor_id = p.id AND a.bucket >= $2 AND a.bucket < $3
      GROUP BY p.metric
      ORDER BY p.metric`,
    [q.zoneId, q.from, q.to, [...COPILOT_ZONE_METRICS]],
  );

  // One row per 5-minute bucket with the zone's temperature, VAV setpoint and
  // occupancy side by side, judged against both bands. LEFT JOIN from the
  // design row so an empty window still answers (with zeros), rather than
  // returning no row at all.
  const { rows: [comfort] } = await db.query<ZoneConditionsRows['comfort']>(
    `WITH m AS (
       SELECT a.bucket, s.metric::text AS metric, a.avg_value
         FROM sensors s JOIN telemetry_5m_t a ON a.sensor_id = s.id
        WHERE s.zone_id = $1 AND s.is_active
          AND s.metric IN ('temperature_c', 'setpoint_temp_c', 'occupancy_count')
          AND a.bucket >= $2 AND a.bucket < $3
     ),
     b AS (
       SELECT bucket,
              max(avg_value) FILTER (WHERE metric = 'temperature_c')   AS zt,
              max(avg_value) FILTER (WHERE metric = 'setpoint_temp_c') AS sp,
              max(avg_value) FILTER (WHERE metric = 'occupancy_count') AS occ
         FROM m GROUP BY bucket
     ),
     d AS (
       SELECT p.setpoint_temp_c AS design_c, p.deadband_k AS db_k
         FROM zones z LEFT JOIN thermal_profiles p ON p.id = z.thermal_profile_id
        WHERE z.id = $1
     )
     SELECT CASE WHEN count(b.occ) = 0 THEN NULL ELSE
              5 * count(b.bucket) FILTER (WHERE b.occ > 0) END AS occupied_min,
            CASE WHEN count(b.occ) = 0 THEN NULL ELSE
              5 * count(b.bucket) FILTER (WHERE b.occ > 0 AND b.zt IS NOT NULL) END AS occupied_with_temperature_min,
            -- Occupied, and no occupied bucket with a good temperature: not judged.
            CASE WHEN count(b.occ) = 0 OR d.design_c IS NULL OR d.db_k IS NULL
                   OR (count(b.bucket) FILTER (WHERE b.occ > 0) > 0
                       AND count(b.bucket) FILTER (WHERE b.occ > 0 AND b.zt IS NOT NULL) = 0) THEN NULL ELSE
              5 * count(b.bucket) FILTER (WHERE b.occ > 0 AND b.zt > d.design_c + d.db_k / 2) END
              AS above_design_band_min,
            CASE WHEN count(b.occ) = 0 OR d.design_c IS NULL OR d.db_k IS NULL
                   OR (count(b.bucket) FILTER (WHERE b.occ > 0) > 0
                       AND count(b.bucket) FILTER (WHERE b.occ > 0 AND b.zt IS NOT NULL) = 0) THEN NULL ELSE
              5 * count(b.bucket) FILTER (WHERE b.occ > 0 AND b.zt < d.design_c - d.db_k / 2) END
              AS below_design_band_min,
            CASE WHEN count(b.occ) = 0 OR d.db_k IS NULL
                   OR (count(b.bucket) FILTER (WHERE b.occ > 0) > 0
                       AND count(b.bucket) FILTER (WHERE b.occ > 0 AND b.zt IS NOT NULL AND b.sp IS NOT NULL) = 0)
                 THEN NULL ELSE
              5 * count(b.bucket) FILTER (WHERE b.occ > 0 AND b.zt > b.sp + d.db_k / 2) END
              AS above_effective_band_min,
            CASE WHEN count(b.occ) = 0 OR d.db_k IS NULL
                   OR (count(b.bucket) FILTER (WHERE b.occ > 0) > 0
                       AND count(b.bucket) FILTER (WHERE b.occ > 0 AND b.zt IS NOT NULL AND b.sp IS NOT NULL) = 0)
                 THEN NULL ELSE
              5 * count(b.bucket) FILTER (WHERE b.occ > 0 AND b.zt < b.sp - d.db_k / 2) END
              AS below_effective_band_min
       FROM d LEFT JOIN b ON true
      GROUP BY d.design_c, d.db_k`,
    [q.zoneId, q.from, q.to],
  );

  const now = new Date();
  const perSensor = expectedUpToNow(q.from, q.to, 300, now);
  const metrics: Record<string, Record<string, unknown>> = {};
  for (const r of stats) {
    const u = ZONE_METRIC_UNIT[r.metric];
    metrics[r.metric] = {
      [`mean_${u}`]: r.mean,
      [`min_${u}`]: r.min,
      [`max_${u}`]: r.max,
      max_at: iso(r.max_at),
      [`first_${u}`]: r.first,
      [`last_${u}`]: r.last,
      [u === 'c' ? 'slope_k_per_h' : `slope_${u}_per_h`]: r.slope_per_h,
      sensors_count: r.sensors,
      good_buckets_count: r.good,
      expected_buckets_count: r.sensors * perSensor,
      flagged_samples_count: r.flagged,
      stale: r.stale,
    };
  }

  return {
    zone: { id: design.id, name: design.name, floor: design.floor, level: design.level, type: design.type },
    // Keys built from ZONE_METRIC_UNIT above, which the type is derived from;
    // the cast is where a computed key meets its template-literal type.
    metrics: metrics as ZoneConditionMetrics,
    comfort: comfort ?? {
      occupied_min: null, occupied_with_temperature_min: null, above_design_band_min: null, below_design_band_min: null,
      above_effective_band_min: null, below_effective_band_min: null,
    },
    design: {
      setpoint_c: design.setpoint_c,
      deadband_k: design.deadband_k,
      design_occupancy_count: design.design_occupancy_count,
      area_m2: design.area_m2,
      vav_rated_airflow_cmh: design.vav_rated_airflow_cmh,
    },
    ahu: design.ahu_tag === null ? null : { tag: design.ahu_tag, supply_air_mean_c: design.supply_air_mean_c },
  };
}

// ============================================================== zone_history

export type HistoryPoint<U extends string> =
  { at: string; flagged_count: number } & { [K in `mean_${U}`]: number | null };

export type ZoneHistorySeries = { [M in CopilotZoneMetric]?: Array<HistoryPoint<UnitOf<M>>> };

export interface ZoneHistoryRows {
  resolution: '5m' | '1h';
  /** One series per requested metric the zone has an active sensor for. */
  series: ZoneHistorySeries;
}

/**
 * Per-metric series for one zone, through `getSensorHistory` — the same
 * rollup reader the dashboard's sparklines use, so the copilot and the chart
 * cannot disagree about a bucket.
 *
 * That reader's LIMIT truncates silently (it keeps the most recent buckets),
 * so a span it cannot answer in full is REFUSED here, naming the limit,
 * before any query runs. The tool's own 48 h window is far inside it; this
 * is the backstop for a caller that forgets.
 *
 * A zone with two sensors of one metric (none in the seed) gets one series:
 * per bucket, the good-weighted mean across them and the flagged total.
 */
export async function copilotZoneHistory(
  db: Db,
  q: { zoneId: string; metrics: readonly CopilotZoneMetric[]; resolution: '5m' | '1h'; from: Date; to: Date },
): Promise<ZoneHistoryRows> {
  const spanH = (q.to.getTime() - q.from.getTime()) / 3_600_000;
  const maxH = maxHistoryHours(q.resolution);
  if (spanH > maxH) {
    throw new RangeError(`history span is ${spanH} h; ${q.resolution} history answers at most ${maxH} h`);
  }

  const { rows: sensors } = await db.query<{ id: string; metric: CopilotZoneMetric }>(
    `SELECT id, metric::text AS metric
       FROM sensors
      WHERE zone_id = $1 AND is_active AND metric::text = ANY($2::text[])
      ORDER BY metric, id`,
    [q.zoneId, [...new Set(q.metrics)]],
  );

  const series: Record<string, Array<Record<string, unknown>>> = {};
  for (const metric of new Set(sensors.map((s) => s.metric))) {
    const u = ZONE_METRIC_UNIT[metric];
    const histories: AggregateBucket[][] = [];
    for (const s of sensors.filter((x) => x.metric === metric)) {
      histories.push(await getSensorHistory(db, s.id, q.resolution, q.from, q.to));
    }
    const byBucket = new Map<number, { sum: number; weight: number; flagged: number }>();
    for (const b of histories.flat()) {
      const t = new Date(b.bucket).getTime();
      const acc = byBucket.get(t) ?? { sum: 0, weight: 0, flagged: 0 };
      const good = b.sampleCount - b.badQualityCount;
      if (b.avgValue !== null && good > 0) {
        acc.sum += b.avgValue * good;
        acc.weight += good;
      }
      acc.flagged += b.badQualityCount;
      byBucket.set(t, acc);
    }
    series[metric] = [...byBucket.entries()]
      .sort(([a], [b]) => a - b)
      .map(([t, acc]) => ({
        at: new Date(t).toISOString(),
        [`mean_${u}`]: acc.weight > 0 ? acc.sum / acc.weight : null,
        flagged_count: acc.flagged,
      }));
  }
  // Keys built from ZONE_METRIC_UNIT, as in copilotZoneConditions.
  return { resolution: q.resolution, series: series as ZoneHistorySeries };
}

// ============================================================= zone_timeline

export const TIMELINE_KINDS = [
  'alert_opened', 'alert_resolved',
  'command_requested', 'command_applied', 'override_lapsed',
  'command_failed', 'command_expired', 'command_cancelled', 'command_superseded',
  'maintenance', 'flag_episode', 'data_gap',
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export interface TimelineRow {
  at: string;
  kind: TimelineKind;
  /**
   * Per kind; numeric keys carry their unit (`setpoint_c`, `duration_min`,
   * `threshold_k_per_h`), people's text only under `*_untrusted`.
   */
  detail: Record<string, string | number | boolean | null>;
}

export interface RuleInScopeRow {
  name: string;
  metric: string | null;
  condition: string;
  /** Where the rule is attached: building, floor, zone, equipment or sensor. */
  scope: 'building' | 'floor' | 'zone' | 'equipment' | 'sensor';
  window_s: number | null;
  consecutive_breaches_count: number;
  severity: string;
  enabled: boolean;
  /** `threshold_<unit>` — see `thresholdSuffix`; a bare `threshold` if the metric is unknown. */
  [threshold: `threshold${string}`]: number | null;
}

export type ZoneTimelineRows = Capped<TimelineRow> & { rulesInScope: Capped<RuleInScopeRow> };

/** Rules are operator-configured and unbounded in principle; the list says when it stops. */
export const RULES_IN_SCOPE_LIMIT = 50;

/**
 * Everything that happened TO one zone in a window, as one chronological
 * list: alerts on its points and on the equipment serving it (each naming its
 * `equipment` tag, null for a zone point's), setpoint commands, the
 * moment an override lapsed, maintenance on anything in its serving chain,
 * runs of flagged samples, and gaps in its temperature feed.
 *
 * This is the join a "why" question needs and no single table answers: the
 * seeded 24 Sep drift alerts are only explained by the copilot-approved
 * overrides 14 minutes before them, and by those overrides lapsing 10 minutes
 * before the second set.
 *
 * Selected newest-first under the LIMIT, so a truncated timeline keeps the
 * most recent events (the part a "why now" question is about), then returned
 * oldest-first because that is how a sequence reads. `total` counts every
 * event in the window.
 *
 * Gaps are found on the 5-minute temperature rollup between two virtual
 * buckets — the one just before the window and the one just after its last
 * elapsed bucket — so a feed that was silent at the START of the window, or
 * is silent NOW, is a gap too, not only one between two readings. A bucket
 * holding only flagged samples is not a gap: something arrived. A zone with
 * no active temperature point has no feed, and so no gaps.
 */
export async function copilotZoneTimeline(
  db: Db,
  q: { zoneId: string; from: Date; to: Date; limit: number },
): Promise<ZoneTimelineRows> {
  const { rows } = await db.query<{ at: Date; kind: TimelineKind; detail: Record<string, unknown>; total: number }>(
    `WITH RECURSIVE serving AS (
       SELECT e.id, e.parent_equipment_id
         FROM equipment e JOIN equipment_zone_service s ON s.equipment_id = e.id
        WHERE s.zone_id = $1
       UNION   -- UNION, not UNION ALL: a repeated row ends the walk, so a cycle in the tree terminates
       SELECT p.id, p.parent_equipment_id
         FROM equipment p JOIN serving c ON p.id = c.parent_equipment_id
     ),
     zs AS (SELECT id, metric::text AS metric FROM sensors WHERE zone_id = $1 AND is_active),
     za AS (
       SELECT a.opened_at, a.resolved_at, a.severity::text AS severity,
              ${untrustedSql('a.message', 'message')},
              a.threshold, a.trigger_value, r.name AS rule, r.condition::text AS condition,
              coalesce(r.metric, s.metric)::text AS metric, e.tag AS equipment
         FROM alerts a
         JOIN alert_rules r ON r.id = a.rule_id
         LEFT JOIN sensors s   ON s.id = a.sensor_id
         LEFT JOIN equipment e ON e.id = coalesce(a.equipment_id, s.equipment_id)
        -- The zone's own points, AND the equipment serving it: an AHU or a
        -- chiller has no zone, so its alerts resolve to none (review, ADR 64).
        WHERE coalesce(a.zone_id, s.zone_id, e.zone_id) = $1
           OR e.id IN (SELECT id FROM serving)
     ),
     cc AS (SELECT * FROM control_commands WHERE zone_id = $1),
     zt_buckets AS (
       SELECT a.bucket
         FROM zs JOIN telemetry_5m_t a ON a.sensor_id = zs.id
        WHERE zs.metric = 'temperature_c' AND a.bucket >= $2 AND a.bucket < $3
     ),
     -- The virtual edges only for a zone that HAS a temperature point: with
     -- none there is no feed to be down, and the two edges alone read as one
     -- gap the length of the window (review, ADR 64).
     edges AS (
       SELECT bucket FROM zt_buckets
       UNION ALL SELECT time_bucket(INTERVAL '5 minutes', $2::timestamptz + INTERVAL '5 minutes' - INTERVAL '1 microsecond')
                        - INTERVAL '5 minutes'
                  WHERE EXISTS (SELECT 1 FROM zs WHERE metric = 'temperature_c')
       UNION ALL SELECT time_bucket(INTERVAL '5 minutes', least($3::timestamptz, now()) - INTERVAL '1 microsecond')
                        + INTERVAL '5 minutes'
                  WHERE EXISTS (SELECT 1 FROM zs WHERE metric = 'temperature_c')
     ),
     ev AS (
       SELECT opened_at AS at, 'alert_opened' AS kind,
              jsonb_build_object('rule', rule, 'severity', severity, 'metric', metric,
                                 'equipment', equipment,
                                 'condition', condition, 'threshold', threshold,
                                 'trigger_value', trigger_value,
                                 'message_untrusted', message_untrusted,
                                 'message_truncated', message_truncated) AS detail
         FROM za WHERE opened_at >= $2 AND opened_at < $3
       UNION ALL
       SELECT resolved_at, 'alert_resolved',
              jsonb_build_object('rule', rule, 'severity', severity, 'metric', metric,
                                 'equipment', equipment,
                                 'opened_at', ${isoSql('opened_at')},
                                 'duration_s', round(extract(epoch FROM resolved_at - opened_at))::int8)
         FROM za WHERE resolved_at >= $2 AND resolved_at < $3
       UNION ALL
       SELECT requested_at, 'command_requested',
              jsonb_build_object('setpoint_c', setpoint_temp_c, 'previous_c', previous_temp_c,
                                 'state', state::text,
                                 'effective_until', ${isoSql('effective_until')},
                                 'from_copilot', reason LIKE 'copilot (operator-approved):%',
                                 ${untrustedJson('reason', 'reason')})
         FROM cc WHERE requested_at >= $2 AND requested_at < $3
       UNION ALL
       SELECT applied_at, 'command_applied',
              jsonb_build_object('setpoint_c', setpoint_temp_c,
                                 'effective_until', ${isoSql('effective_until')})
         FROM cc WHERE applied_at >= $2 AND applied_at < $3
       UNION ALL
       -- An override is never reverted; it stops being returned when its
       -- time runs out (§62). A still-applied row whose end has passed is
       -- therefore the moment the zone went back to its profile.
       SELECT effective_until, 'override_lapsed',
              jsonb_build_object('setpoint_c', setpoint_temp_c, 'applied_at', ${isoSql('applied_at')})
         FROM cc WHERE state = 'applied' AND effective_until >= $2 AND effective_until < least($3, now())
       UNION ALL
       SELECT settled_at, 'command_' || state::text,
              jsonb_build_object('setpoint_c', setpoint_temp_c, ${untrustedJson('outcome_detail', 'outcome')})
         FROM cc WHERE state IN ('failed', 'expired', 'cancelled', 'superseded')
                   AND settled_at >= $2 AND settled_at < $3
       UNION ALL
       SELECT m.performed_at, 'maintenance',
              jsonb_build_object('tag', e.tag, 'log_type', m.log_type::text,
                                 'downtime_min', m.downtime_minutes,
                                 'next_due_at', ${isoSql('m.next_due_at')},
                                 ${untrustedJson('m.notes', 'notes')})
         FROM maintenance_logs m JOIN equipment e ON e.id = m.equipment_id
        WHERE m.equipment_id IN (SELECT id FROM serving)
          AND m.performed_at >= $2 AND m.performed_at < $3
       UNION ALL
       -- Runs of consecutive 5-minute buckets holding flagged samples, one
       -- event per run per point (gaps-and-islands on bucket − row_number).
       SELECT min(bucket), 'flag_episode',
              jsonb_build_object('metric', metric, 'flagged_samples_count', sum(bad)::int8,
                                 'duration_min', 5 * count(*),
                                 'until', ${isoSql("max(bucket) + INTERVAL '5 minutes'")})
         FROM (SELECT zs.id AS sid, zs.metric, a.bucket, a.bad_quality_count AS bad,
                      a.bucket - (row_number() OVER (PARTITION BY zs.id ORDER BY a.bucket))
                                 * INTERVAL '5 minutes' AS grp
                 FROM zs JOIN telemetry_5m_t a ON a.sensor_id = zs.id
                WHERE a.bucket >= $2 AND a.bucket < $3 AND a.bad_quality_count > 0) f
        GROUP BY sid, metric, grp
       UNION ALL
       SELECT prev + INTERVAL '5 minutes', 'data_gap',
              jsonb_build_object('metric', 'temperature_c',
                                 'duration_min', (extract(epoch FROM bucket - prev) / 60)::int8 - 5,
                                 'until', ${isoSql('bucket')})
         FROM (SELECT bucket, lag(bucket) OVER (ORDER BY bucket) AS prev FROM edges) g
        WHERE bucket - prev > INTERVAL '15 minutes'
     )
     SELECT at, kind, detail, count(*) OVER () AS total
       FROM ev
      ORDER BY at DESC, kind
      LIMIT $4`,
    [q.zoneId, q.from, q.to, q.limit],
  );

  const total = rows[0]?.total ?? 0;
  const items: TimelineRow[] = rows.reverse().map((r) => ({
    at: iso(r.at)!,
    kind: r.kind,
    detail: r.kind === 'alert_opened' ? alertDetail(r.detail) : (r.detail as TimelineRow['detail']),
  }));

  const { rows: rules } = await db.query<{
    name: string; metric: string | null; condition: string; scope: RuleInScopeRow['scope'];
    threshold: number | null; window_s: number | null; consecutive_breaches: number;
    severity: string; enabled: boolean; total: number;
  }>(
    `WITH RECURSIVE serving AS (
       SELECT e.id, e.parent_equipment_id
         FROM equipment e JOIN equipment_zone_service s ON s.equipment_id = e.id
        WHERE s.zone_id = $1
       UNION
       SELECT p.id, p.parent_equipment_id
         FROM equipment p JOIN serving c ON p.id = c.parent_equipment_id
     ),
     zone AS (
       SELECT z.id, z.floor_id, f.building_id
         FROM zones z JOIN floors f ON f.id = z.floor_id WHERE z.id = $1
     )
     SELECT r.name, coalesce(r.metric, s.metric)::text AS metric, r.condition::text AS condition,
            CASE WHEN r.building_id IS NOT NULL THEN 'building'
                 WHEN r.floor_id IS NOT NULL THEN 'floor'
                 WHEN r.zone_id IS NOT NULL THEN 'zone'
                 WHEN r.equipment_id IS NOT NULL THEN 'equipment'
                 ELSE 'sensor' END AS scope,
            r.threshold, r.window_s, r.consecutive_breaches, r.severity::text AS severity, r.enabled,
            count(*) OVER () AS total
       FROM alert_rules r
       LEFT JOIN sensors s ON s.id = r.sensor_id
       JOIN zone ON r.zone_id = zone.id
                 OR r.floor_id = zone.floor_id
                 OR r.building_id = zone.building_id
                 OR r.sensor_id IN (SELECT id FROM sensors WHERE zone_id = $1)
                 OR r.equipment_id IN (SELECT id FROM serving)
      ORDER BY r.name, r.id
      LIMIT $2`,
    [q.zoneId, RULES_IN_SCOPE_LIMIT],
  );

  return {
    ...capped(items, total, q.limit),
    rulesInScope: capped(
      rules.map((r) => ({
        name: r.name,
        metric: r.metric,
        condition: r.condition,
        scope: r.scope,
        [unitKey('threshold', thresholdSuffix(r.metric, r.condition))]: r.threshold,
        window_s: r.window_s,
        consecutive_breaches_count: r.consecutive_breaches,
        severity: r.severity,
        enabled: r.enabled,
      }) as RuleInScopeRow),
      rules[0]?.total ?? 0,
      RULES_IN_SCOPE_LIMIT,
    ),
  };
}

/** An alert's raw threshold and trigger, renamed to the units they are in. */
function alertDetail(raw: Record<string, unknown>): TimelineRow['detail'] {
  const { threshold, trigger_value: trigger, ...rest } = raw;
  const metric = typeof raw.metric === 'string' ? raw.metric : null;
  const condition = String(raw.condition);
  return {
    ...(rest as TimelineRow['detail']),
    [unitKey('threshold', thresholdSuffix(metric, condition))]: (threshold as number | null) ?? null,
    [unitKey('trigger', triggerSuffix(metric, condition))]: (trigger as number | null) ?? null,
  };
}

// ========================================================== equipment_status

export interface EquipmentStatusRow {
  tag: string;
  type: string;
  /** Current only: nothing records when it changed (NO_STATUS_HISTORY). */
  status: string;
  floor: string | null;
  /** Ancestors, nearest first, at most six levels. */
  chain_up: string[];
  /** The first eight zones served by it or anything below it, by level and name. */
  zones_served: string[];
  zones_served_count: number;
  rated_airflow_cmh: number | null;
  last_maintenance: {
    performed_at: string;
    log_type: string;
    downtime_min: number | null;
    notes_untrusted: string | null;
    notes_truncated: boolean;
  } | null;
  /** From the most recent log that set one; the corrective log after a trip usually does not. */
  next_due_at: string | null;
  overdue: boolean;
}

/**
 * The asset register for the equipment a question is about: one tag, or the
 * serving chain of one zone (its direct equipment plus every ancestor), or
 * all of it — capped, by tag. Of ONE building, the one orient answers about:
 * RLS scopes a read to the tenant, and a tenant may hold several (§64).
 *
 * `rated_power_kw` is deliberately absent: it is thermal capacity on a chiller
 * and electrical input on an AHU, and nothing that reads it here could tell
 * which (CLAUDE.md).
 *
 * So is any MEASURED figure. The copilot records this result as CONFIGURED
 * evidence, and an answer citing it is labelled "configured" — a power
 * reading inside it (as there was: a last-hour mean draw) would reach the
 * operator as configuration. The register says what a thing is and how it
 * stands; what it drew comes from telemetry, through a measured tool.
 */
export async function copilotEquipmentStatus(
  db: Db,
  q: { tag: string | null; zoneId: string | null; limit: number; buildingId: string },
): Promise<Capped<EquipmentStatusRow>> {
  if (q.tag !== null && q.zoneId !== null) {
    throw new RangeError('equipment status takes a tag or a zone, not both');
  }
  const { rows } = await db.query<{
    tag: string; type: string; status: string; floor: string | null;
    chain_up: string[] | null; zones_served: string[] | null; zones_served_count: number;
    rated_airflow_cmh: number | null;
    performed_at: Date | null; log_type: string | null; downtime_min: number | null;
    notes_untrusted: string | null; notes_truncated: boolean | null;
    next_due_at: Date | null; overdue: boolean; total: number;
  }>(
    `WITH RECURSIVE chain AS (
       SELECT e.id, e.parent_equipment_id
         FROM equipment e JOIN equipment_zone_service s ON s.equipment_id = e.id
        WHERE s.zone_id = $2::uuid
       UNION
       SELECT p.id, p.parent_equipment_id
         FROM equipment p JOIN chain c ON p.id = c.parent_equipment_id
     ),
     matched AS (
       SELECT e.id, count(*) OVER () AS total
         FROM equipment e
        WHERE e.building_id = $4::uuid
          AND ($1::text IS NULL OR e.tag = $1::text)
          AND ($2::uuid IS NULL OR e.id IN (SELECT id FROM chain))
        ORDER BY e.tag
        LIMIT $3
     ),
     up AS (
       SELECT m.id AS base, e.parent_equipment_id AS id, 1 AS depth
         FROM matched m JOIN equipment e ON e.id = m.id
        WHERE e.parent_equipment_id IS NOT NULL
       UNION ALL
       SELECT u.base, p.parent_equipment_id, u.depth + 1
         FROM up u JOIN equipment p ON p.id = u.id
        WHERE p.parent_equipment_id IS NOT NULL AND u.depth < 6
     ),
     down AS (
       SELECT m.id AS base, m.id AS id, 0 AS depth FROM matched m
       UNION ALL
       SELECT d.base, c.id, d.depth + 1
         FROM down d JOIN equipment c ON c.parent_equipment_id = d.id
        WHERE d.depth < 6
     ),
     served AS (
       SELECT DISTINCT d.base, z.id, z.name, f.level
         FROM down d
         JOIN equipment_zone_service s ON s.equipment_id = d.id
         JOIN zones z ON z.id = s.zone_id
         JOIN floors f ON f.id = z.floor_id
     )
     SELECT e.tag, e.equipment_type::text AS type, e.status::text AS status, f.name AS floor,
            (SELECT array_agg(pe.tag ORDER BY u.depth)
               FROM up u JOIN equipment pe ON pe.id = u.id WHERE u.base = e.id) AS chain_up,
            (SELECT array_agg(x.name ORDER BY x.level, x.name)
               FROM (SELECT sv.name, sv.level FROM served sv WHERE sv.base = e.id
                      ORDER BY sv.level, sv.name LIMIT 8) x) AS zones_served,
            (SELECT count(*) FROM served sv WHERE sv.base = e.id) AS zones_served_count,
            e.rated_airflow_cmh,
            ml.performed_at, ml.log_type, ml.downtime_min, ml.notes_untrusted, ml.notes_truncated,
            nd.next_due_at, coalesce(nd.next_due_at < now(), false) AS overdue,
            m.total
       FROM matched m
       JOIN equipment e ON e.id = m.id
       LEFT JOIN floors f ON f.id = e.floor_id
       LEFT JOIN LATERAL (
         SELECT l.performed_at, l.log_type::text AS log_type, l.downtime_minutes AS downtime_min,
                ${untrustedSql('l.notes', 'notes')}
           FROM maintenance_logs l WHERE l.equipment_id = e.id
          ORDER BY l.performed_at DESC LIMIT 1
       ) ml ON true
       LEFT JOIN LATERAL (
         SELECT l.next_due_at FROM maintenance_logs l
          WHERE l.equipment_id = e.id AND l.next_due_at IS NOT NULL
          ORDER BY l.performed_at DESC LIMIT 1
       ) nd ON true
      ORDER BY e.tag`,
    [q.tag, q.zoneId, q.limit, q.buildingId],
  );

  return capped(
    rows.map((r) => ({
      tag: r.tag,
      type: r.type,
      status: r.status,
      floor: r.floor,
      chain_up: r.chain_up ?? [],
      zones_served: r.zones_served ?? [],
      zones_served_count: r.zones_served_count,
      rated_airflow_cmh: r.rated_airflow_cmh,
      last_maintenance: r.performed_at === null ? null : {
        performed_at: iso(r.performed_at)!,
        log_type: r.log_type!,
        downtime_min: r.downtime_min,
        notes_untrusted: r.notes_untrusted,
        notes_truncated: r.notes_truncated ?? false,
      },
      next_due_at: iso(r.next_due_at),
      overdue: r.overdue,
    })),
    rows[0]?.total ?? 0,
    q.limit,
  );
}

// =============================================================== list_alerts

export interface AlertListRow {
  rule: string;
  zone: string | null;
  floor: string | null;
  equipment: string | null;
  severity: string;
  state: string;
  opened_at: string;
  resolved_at: string | null;
  /** To resolution; for a live alert, to now. */
  duration_s: number;
  metric: string | null;
  condition: string;
  message_untrusted: string;
  message_truncated: boolean;
  /** `threshold_<unit>` and `trigger_<unit>` — see `thresholdSuffix` / `triggerSuffix`. */
  [unitKeyed: `threshold${string}` | `trigger${string}`]: number | null;
}

/**
 * Alerts in a window, with their spatial context — a copy of ingest's
 * SELECT_WITH_CONTEXT join (apps/ingest/src/rules/store.ts) plus the count.
 * It is the third copy of that join (ingest, /api/alerts, here); the
 * duplication is known and consolidating it is out of scope (§64).
 *
 * The window selects alerts that were OPEN DURING it — opened before `to`
 * and not resolved before `from` — not merely those opened inside it. An
 * alert opened eight days ago and still open is the most important row on a
 * "what is live" list, and filtering on opened_at alone would hide it behind
 * the default seven-day window.
 *
 * The threshold is the alert's own snapshot, not the rule's: the rule may
 * have been edited since.
 *
 * Of one building (orient's): an alert belongs to its zone's floor's building,
 * or its equipment's.
 */
export async function copilotListAlerts(
  db: Db,
  q: { state: 'live' | 'resolved' | 'any'; from: Date; to: Date; zoneId: string | null; limit: number; buildingId: string },
): Promise<Capped<AlertListRow>> {
  const stateSql =
    q.state === 'live' ? `AND a.state <> 'resolved'`
    : q.state === 'resolved' ? `AND a.state = 'resolved'`
    : '';
  const { rows } = await db.query<{
    rule: string; zone: string | null; floor: string | null; equipment: string | null;
    severity: string; state: string; opened_at: Date; resolved_at: Date | null; duration_s: number;
    metric: string | null; condition: string; threshold: number | null; trigger_value: number | null;
    message_untrusted: string; message_truncated: boolean; total: number;
  }>(
    `SELECT r.name AS rule, z.name AS zone, f.name AS floor, e.tag AS equipment,
            a.severity::text AS severity, a.state::text AS state,
            a.opened_at, a.resolved_at,
            round(extract(epoch FROM coalesce(a.resolved_at, now()) - a.opened_at))::int8 AS duration_s,
            coalesce(r.metric, s.metric)::text AS metric, r.condition::text AS condition,
            a.threshold, a.trigger_value,
            ${untrustedSql('a.message', 'message')},
            count(*) OVER () AS total
       FROM alerts a
       JOIN alert_rules r ON r.id = a.rule_id
       LEFT JOIN sensors   s ON s.id = a.sensor_id
       LEFT JOIN equipment e ON e.id = coalesce(a.equipment_id, s.equipment_id)
       LEFT JOIN zones     z ON z.id = coalesce(a.zone_id, s.zone_id, e.zone_id)
       LEFT JOIN floors    f ON f.id = coalesce(z.floor_id, e.floor_id)
      WHERE a.opened_at < $2 AND (a.resolved_at IS NULL OR a.resolved_at >= $1)
        AND coalesce(f.building_id, e.building_id) = $5::uuid
        AND ($3::uuid IS NULL OR coalesce(a.zone_id, s.zone_id, e.zone_id) = $3::uuid)
        ${stateSql}
      ORDER BY a.opened_at DESC, a.id
      LIMIT $4`,
    [q.from, q.to, q.zoneId, q.limit, q.buildingId],
  );

  return capped(
    rows.map((r) => ({
      rule: r.rule,
      zone: r.zone,
      floor: r.floor,
      equipment: r.equipment,
      severity: r.severity,
      state: r.state,
      opened_at: iso(r.opened_at)!,
      resolved_at: iso(r.resolved_at),
      duration_s: r.duration_s,
      metric: r.metric,
      condition: r.condition,
      [unitKey('threshold', thresholdSuffix(r.metric, r.condition))]: r.threshold,
      [unitKey('trigger', triggerSuffix(r.metric, r.condition))]: r.trigger_value,
      message_untrusted: r.message_untrusted,
      message_truncated: r.message_truncated,
    }) as AlertListRow),
    rows[0]?.total ?? 0,
    q.limit,
  );
}

// =========================================================== control_history

export interface CommandHistoryRow {
  zone: string;
  floor: string;
  setpoint_c: number;
  previous_c: number | null;
  state: string;
  requested_at: string;
  applied_at: string | null;
  settled_at: string | null;
  effective_until: string;
  /** Applied and not yet past its end — the zone is on this setpoint now. */
  active_now: boolean;
  /**
   * The reason starts with the prefix `apply` writes. A hint, not proof: the
   * reason is text, and a person could type the same words.
   */
  from_copilot: boolean;
  reason_untrusted: string;
  reason_truncated: boolean;
  outcome_untrusted: string | null;
  outcome_truncated: boolean;
}

/**
 * Setpoint commands whose life overlaps the window — requested before `to`
 * and not ending before `from` — newest request first. An override asked for
 * at 08:00 and still holding at 09:30 is part of "what happened since 9";
 * filtering on requested_at alone would drop it.
 *
 * dtwin_app has SELECT on control_commands (017). Nothing here can write one,
 * and the READ ONLY transaction makes that a fact of the connection too.
 * Of one building, orient's.
 */
export async function copilotControlHistory(
  db: Db,
  q: { zoneId: string | null; from: Date; to: Date; limit: number; buildingId: string },
): Promise<Capped<CommandHistoryRow>> {
  const { rows } = await db.query<Omit<CommandHistoryRow, 'requested_at' | 'applied_at' | 'settled_at' | 'effective_until'> & {
    requested_at: Date; applied_at: Date | null; settled_at: Date | null; effective_until: Date; total: number;
  }>(
    `SELECT z.name AS zone, f.name AS floor,
            c.setpoint_temp_c AS setpoint_c, c.previous_temp_c AS previous_c,
            c.state::text AS state,
            c.requested_at, c.applied_at, c.settled_at, c.effective_until,
            (c.state = 'applied' AND c.effective_until > now()) AS active_now,
            c.reason LIKE 'copilot (operator-approved):%' AS from_copilot,
            ${untrustedSql('c.reason', 'reason')},
            ${untrustedSql('c.outcome_detail', 'outcome')},
            count(*) OVER () AS total
       FROM control_commands c
       JOIN zones z  ON z.id = c.zone_id
       JOIN floors f ON f.id = z.floor_id
      WHERE c.requested_at < $2 AND c.effective_until >= $1
        AND f.building_id = $5::uuid
        AND ($3::uuid IS NULL OR c.zone_id = $3::uuid)
      ORDER BY c.requested_at DESC, c.id
      LIMIT $4`,
    [q.from, q.to, q.zoneId, q.limit, q.buildingId],
  );

  return capped(
    rows.map(({ total: _total, ...r }) => ({
      ...r,
      requested_at: iso(r.requested_at)!,
      applied_at: iso(r.applied_at),
      settled_at: iso(r.settled_at),
      effective_until: iso(r.effective_until)!,
    })),
    rows[0]?.total ?? 0,
    q.limit,
  );
}

// ========================================================= energy_by_end_use

export const ENERGY_GROUP_BY = ['floor', 'end_use', 'floor_end_use', 'local_day'] as const;
export type EnergyGroupBy = (typeof ENERGY_GROUP_BY)[number];

/** The name every power point without a floor is grouped under. */
export const BUILDING_PLANT = 'building plant';

interface EnergyCounts {
  /** Σ over good 5-minute means × 5 min; null with no good bucket. Never extrapolated. */
  energy_kwh: number | null;
  sensors_count: number;
  good_buckets_count: number;
  expected_buckets_count: number;
  flagged_samples_count: number;
}

export interface EnergyRow extends EnergyCounts {
  /** A floor's name, BUILDING_PLANT for equipment with no floor, or null when not grouped by floor. */
  floor: string | null;
  level: number | null;
  /** equipment_type, or null when not grouped by end use. */
  end_use: string | null;
}

export interface EnergyDayRow extends EnergyCounts {
  /** The building's local calendar date, YYYY-MM-DD. */
  day: string;
  /** Local midnight to local midnight, as UTC instants (23 or 25 h across a DST change). */
  day_start: string;
  day_end: string;
}

export type EnergyRows =
  | { groupBy: 'floor' | 'end_use' | 'floor_end_use'; rows: EnergyRow[] }
  | { groupBy: 'local_day'; rows: EnergyDayRow[] };

/**
 * Measured electrical energy from the power_kw GAUGES, by floor, end use or
 * local day: Σ 5-minute good mean × 5/60 h. Only the measured periods count;
 * a sensor that was silent for an hour contributes nothing for that hour and
 * the expected-bucket count says so. Nothing is extrapolated, and
 * `rated_power_kw` is never read.
 *
 * Every active power point is in scope even when it reported nothing, so
 * `sensors_count` and `expected_buckets_count` describe what SHOULD have
 * reported, not what happened to.
 *
 * Per floor this is AHU fans and lighting only — plant has no floor and is
 * grouped as BUILDING_PLANT, never apportioned (PLANT_NOT_ALLOCATED).
 *
 * Of ONE building, orient's: RLS scopes a read to the tenant, and summed over
 * a tenant's buildings the rows were labelled as one building's (review,
 * ADR 64).
 */
export async function copilotEnergyByEndUse(
  db: Db,
  q: { from: Date; to: Date; groupBy: EnergyGroupBy; timezone: string; buildingId: string },
): Promise<EnergyRows> {
  const now = new Date();
  // The building is the LAST parameter of either statement below.
  const pts = (building: string) => `
    pts AS (
      SELECT s.id, e.equipment_type::text AS end_use, f.name AS floor, f.level
        FROM sensors s
        JOIN equipment e ON e.id = s.equipment_id
        LEFT JOIN floors f ON f.id = e.floor_id
       WHERE s.metric = 'power_kw' AND s.is_active AND e.building_id = ${building}::uuid
    )`;

  if (q.groupBy === 'local_day') {
    assertTimezone(q.timezone);
    // Days are generated, not discovered, so a day with no data at all is a
    // row with zero good buckets rather than a missing row. Generated on the
    // local calendar and converted back, so a DST day is 23 or 25 hours.
    const { rows } = await db.query<{
      day: string; day_start: Date; day_end: Date; energy_kwh: number | null;
      good: number | null; flagged: number | null; sensors: number;
    }>(
      `WITH ${pts('$4')},
       days AS (
         SELECT to_char(g.d, 'YYYY-MM-DD') AS day,
                (g.d::timestamp AT TIME ZONE $3) AS day_start,
                ((g.d + 1)::timestamp AT TIME ZONE $3) AS day_end
           FROM (SELECT gs::date AS d
                   FROM generate_series(($1::timestamptz AT TIME ZONE $3)::date,
                                        (($2::timestamptz - INTERVAL '1 microsecond') AT TIME ZONE $3)::date,
                                        INTERVAL '1 day') AS gs) g
       ),
       agg AS (
         SELECT time_bucket(INTERVAL '1 day', a.bucket, $3) AS day_start,
                sum(a.avg_value * 5 / 60.0)::float8 AS energy_kwh,
                count(a.avg_value) AS good,
                sum(a.bad_quality_count)::int8 AS flagged
           FROM pts p JOIN telemetry_5m_t a ON a.sensor_id = p.id
          WHERE a.bucket >= $1 AND a.bucket < $2
          GROUP BY 1
       )
       SELECT days.day, days.day_start, days.day_end, agg.energy_kwh, agg.good, agg.flagged,
              (SELECT count(*) FROM pts) AS sensors
         FROM days LEFT JOIN agg ON agg.day_start = days.day_start
        ORDER BY days.day_start`,
      [q.from, q.to, q.timezone, q.buildingId],
    );
    return {
      groupBy: 'local_day',
      rows: rows.map((r) => {
        const from = new Date(Math.max(q.from.getTime(), r.day_start.getTime()));
        const to = new Date(Math.min(q.to.getTime(), r.day_end.getTime()));
        return {
          day: r.day,
          day_start: iso(r.day_start)!,
          day_end: iso(r.day_end)!,
          energy_kwh: r.energy_kwh,
          sensors_count: r.sensors,
          good_buckets_count: r.good ?? 0,
          expected_buckets_count: r.sensors * expectedUpToNow(from, to, 300, now),
          flagged_samples_count: r.flagged ?? 0,
        };
      }),
    };
  }

  const byFloor = q.groupBy !== 'end_use';
  const byUse = q.groupBy !== 'floor';
  const floorSql = byFloor ? `coalesce(p.floor, '${BUILDING_PLANT}')` : 'NULL::text';
  const levelSql = byFloor ? 'p.level' : 'NULL::int';
  const useSql = byUse ? 'p.end_use' : 'NULL::text';
  const { rows } = await db.query<{
    floor: string | null; level: number | null; end_use: string | null;
    energy_kwh: number | null; good: number; sensors: number; flagged: number;
  }>(
    `WITH ${pts('$3')}
     SELECT ${floorSql} AS floor, ${levelSql} AS level, ${useSql} AS end_use,
            sum(a.avg_value * 5 / 60.0)::float8 AS energy_kwh,
            count(a.avg_value) AS good,
            count(DISTINCT p.id) AS sensors,
            coalesce(sum(a.bad_quality_count), 0)::int8 AS flagged
       FROM pts p
       LEFT JOIN telemetry_5m_t a ON a.sensor_id = p.id AND a.bucket >= $1 AND a.bucket < $2
      GROUP BY 1, 2, 3
      ORDER BY 2 NULLS LAST, 1, 3`,
    [q.from, q.to, q.buildingId],
  );
  const perSensor = expectedUpToNow(q.from, q.to, 300, now);
  return {
    groupBy: q.groupBy,
    rows: rows.map((r) => ({
      floor: r.floor,
      level: r.level,
      end_use: r.end_use,
      energy_kwh: r.energy_kwh,
      sensors_count: r.sensors,
      good_buckets_count: r.good,
      expected_buckets_count: r.sensors * perSensor,
      flagged_samples_count: r.flagged,
    })),
  };
}

// ========================================================= meter_consumption

export type MeterUnit = 'kwh' | 'm3';

export type MeterBucket<U extends MeterUnit> =
  {
    bucket_start: string; resets_count: number; hours_with_data_count: number;
    /**
     * The bucket's first and last RAW counter readings and when they were
     * taken — never reset-adjusted. The step from one bucket's last reading
     * to the next one's first is an increment the window total counts and no
     * bucket's delta holds; the tool judges each such step as it judges a
     * bucket. Null with no good sample in the bucket.
     */
    first_at: string | null;
    last_at: string | null;
  }
  & { [K in `delta_${U}` | `first_reading_${U}` | `last_reading_${U}`]: number | null };

export type MeterRowsFor<U extends MeterUnit> = {
  meter: { tag: string; type: 'electric_meter' | 'water_meter'; metric: string };
  unit: U;
  bucket: 'hour' | 'local_day';
  /** Each bucket's own reset-aware delta: `delta(rollup(counter))` over its hours. */
  buckets: Array<MeterBucket<U>>;
  /** Resets over the WHOLE window — more than Σ bucket resets means one fell on a bucket boundary. */
  total_resets_count: number;
  total_hours_with_data_count: number;
} & {
  /**
   * The window's own `delta(rollup(counter))` — NOT Σ bucket deltas, which
   * drops every increment that straddles a bucket boundary.
   */
  [K in `total_${U}`]: number | null
};

export type MeterRows = MeterRowsFor<'kwh'> | MeterRowsFor<'m3'>;

/**
 * Consumption from a cumulative meter, by hour or by local day, from the
 * hourly rollup's reset-aware counter.
 *
 * `SET LOCAL max_parallel_workers_per_gather = 0` first: a parallel plan over
 * the real-time tail can hand counter_agg its points out of order and fail
 * with "out of order points" — observed on the 1d view as the owner, and
 * plan-dependent (docs/decisions.md §64). Transaction-local, so it cannot
 * leak to the pooled connection's next user, and allowed in READ ONLY.
 *
 * ONE sensor: the meter's active cumulative point of its own metric, first
 * by id, on orient's building — a tag is unique per building, not per
 * tenant, and two buildings may each have an MTR-MAIN. Rolling up two counters into one aggregate interleaves two series,
 * which a reset-aware counter reads as a reset at every crossing — exactly
 * how the smoke suite's writes manufacture GWh "days" on the dev main meter.
 *
 * Hour buckets are the rollup's own UTC hours. Local-day buckets group those
 * hours by the building's midnight; in a zone with a half-hour offset the
 * hour that straddles midnight goes to the day it starts in.
 *
 * `{ unknownMeter: true }` when the tag is not a meter with such a point.
 */
export async function copilotMeterConsumption(
  db: Db,
  q: { meterTag: string; from: Date; to: Date; bucket: 'hour' | 'local_day'; timezone: string; buildingId: string },
): Promise<MeterRows | { unknownMeter: true }> {
  if (q.bucket === 'local_day') assertTimezone(q.timezone);

  const { rows: [meter] } = await db.query<{
    tag: string; type: 'electric_meter' | 'water_meter'; sensor_id: string; metric: string;
  }>(
    `SELECT e.tag, e.equipment_type::text AS type, s.id AS sensor_id, s.metric::text AS metric
       FROM equipment e
       JOIN sensors s ON s.equipment_id = e.id
      WHERE e.tag = $1 AND e.building_id = $2::uuid
        AND e.equipment_type IN ('electric_meter', 'water_meter')
        AND s.is_cumulative AND s.is_active
        AND s.metric = CASE e.equipment_type WHEN 'electric_meter' THEN 'energy_kwh'::metric_type
                                             ELSE 'water_m3'::metric_type END
      ORDER BY e.id, s.id
      LIMIT 1`,
    [q.meterTag, q.buildingId],
  );
  if (!meter) return { unknownMeter: true };
  const unit: MeterUnit = meter.metric === 'energy_kwh' ? 'kwh' : 'm3';

  await db.query('SET LOCAL max_parallel_workers_per_gather = 0');

  const bucketSql = q.bucket === 'hour' ? 'a.bucket' : `time_bucket(INTERVAL '1 day', a.bucket, $4)`;
  const params: unknown[] = [meter.sensor_id, q.from, q.to];
  if (q.bucket === 'local_day') params.push(q.timezone);
  const { rows: buckets } = await db.query<{
    bucket_start: Date; delta: number | null; resets: number | null; hours: number;
    first_reading: number | null; last_reading: number | null; first_at: Date | null; last_at: Date | null;
  }>(
    `SELECT ${bucketSql} AS bucket_start,
            delta(rollup(a.counter)) AS delta,
            num_resets(rollup(a.counter))::int8 AS resets,
            count(a.counter) AS hours,
            first_val(rollup(a.counter)) AS first_reading,
            last_val(rollup(a.counter)) AS last_reading,
            first_time(rollup(a.counter)) AS first_at,
            last_time(rollup(a.counter)) AS last_at
       FROM telemetry_1h_t a
      WHERE a.sensor_id = $1 AND a.bucket >= $2 AND a.bucket < $3
      GROUP BY 1
      ORDER BY 1`,
    params,
  );

  const { rows: [total] } = await db.query<{ delta: number | null; resets: number | null; hours: number }>(
    `SELECT delta(rollup(a.counter)) AS delta,
            num_resets(rollup(a.counter))::int8 AS resets,
            count(a.counter) AS hours
       FROM telemetry_1h_t a
      WHERE a.sensor_id = $1 AND a.bucket >= $2 AND a.bucket < $3`,
    [meter.sensor_id, q.from, q.to],
  );

  // Keys built from `unit`, which is the discriminant of the union.
  return {
    meter: { tag: meter.tag, type: meter.type, metric: meter.metric },
    unit,
    bucket: q.bucket,
    buckets: buckets.map((b) => ({
      bucket_start: iso(b.bucket_start)!,
      [`delta_${unit}`]: b.delta,
      resets_count: b.resets ?? 0,
      hours_with_data_count: b.hours,
      [`first_reading_${unit}`]: b.first_reading,
      [`last_reading_${unit}`]: b.last_reading,
      first_at: iso(b.first_at),
      last_at: iso(b.last_at),
    })),
    [`total_${unit}`]: total?.delta ?? null,
    total_resets_count: total?.resets ?? 0,
    total_hours_with_data_count: total?.hours ?? 0,
  } as MeterRows;
}

// ============================================================= compare_zones

export const COMPARE_METRICS = ['temperature_c', 'co2_ppm', 'humidity_pct', 'occupancy_count'] as const;
export type CompareMetric = (typeof COMPARE_METRICS)[number];
export const COMPARE_ORDER = ['mean', 'max', 'minutes_above_band'] as const;
export type CompareOrder = (typeof COMPARE_ORDER)[number];

export type ZoneRankRow<U extends string = string> = {
  zone_id: string;
  zone: string;
  floor: string;
  level: number;
  area_m2: number | null;
  /**
   * 5-MINUTE periods of the covered window in which the zone had a good
   * reading — not hours: an hour with one good sample in it is not a covered
   * hour, and counting hours let a feed that reported ten minutes of every
   * hour read as complete (review, ADR 64). The same measure the other
   * tools' PARTIAL_COVERAGE is judged on.
   */
  good_buckets_count: number;
  flagged_samples_count: number;
  /**
   * Only when ordering by it: occupied 5-minute buckets × 5 whose temperature
   * was above the DESIGNED band (setpoint + deadband/2), over the covered
   * window — the same hours the means are read from. Null without a profile,
   * null when no occupancy was reported (occupied is unknowable), and null
   * when the zone was occupied but no occupied bucket had a good temperature.
   */
  minutes_above_band_min?: number | null;
} & { [K in `mean_${U}` | `max_${U}`]: number | null };

export type FloorMeanRow<U extends string = string> = {
  floor: string;
  level: number;
  /** Zones on the floor that had data and an area — the ones in the mean. */
  zones_with_data_count: number;
  zones_count: number;
} & { [K in `mean_${U}`]: number | null };

export type CompareZonesRows<U extends string = string> = Capped<ZoneRankRow<U>> & {
  /**
   * AREA-weighted per floor over EVERY zone in scope, not only this page —
   * a floor mean computed from the top five zones would be the mean of the
   * worst five. Never a plain mean of zone means.
   */
  floor_means: Array<FloorMeanRow<U>>;
  /** What the rows were read from (`compareCovered`): hourly buckets starting in [from, to), ending no later than now. */
  covered: { from: string; to: string };
};

/**
 * The window a compare_zones result was actually read from, for its label.
 *
 * The rows are the hourly buckets that START in [from, to). The first starts
 * at `from` rounded UP to the hour, so that is where the data begins. The
 * last ends at `to` rounded up — but nothing was read after now, and the
 * label said otherwise: at 18:51 a window "until now" was labelled
 * 09:00–19:00, at 19:25 …20:00, a label running into the future (the first
 * real runs, ADR 64). So the end is the rounded-up hour or now, whichever is
 * earlier: a window ending now is labelled up to now, and a window ending
 * inside an hour already over keeps the whole hour, whose readings the last
 * bucket's figures include. Never later than now, never earlier than the
 * data under it.
 */
export function compareCovered(from: Date, to: Date, now: Date): { from: string; to: string } {
  const hourMs = 3_600_000;
  const start = Math.ceil(from.getTime() / hourMs) * hourMs;
  const end = Math.min(Math.ceil(to.getTime() / hourMs) * hourMs, now.getTime());
  return { from: new Date(start).toISOString(), to: new Date(Math.max(start, end)).toISOString() };
}

/**
 * Rank zones on one metric from hourly rollups (good-weighted mean, highest
 * good sample), optionally on one floor of orient's building.
 * `minutes_above_band` reads 5-minute rollups, so the tool keeps its window
 * to seven days — over the same whole hours the means cover, so the minutes
 * and the label describe one window. Coverage is counted on 5-minute
 * rollups too (`good_buckets_count`).
 *
 * Hourly buckets start on the hour: a window of 09:40–12:40 is answered from
 * 10:00–13:00, and `covered` says so, so a label is never more precise than
 * the data under it — and, when that hour is still running, from 10:00 to
 * now, never to an hour that has not happened (`compareCovered`).
 */
export async function copilotCompareZones(
  db: Db,
  q: {
    metric: CompareMetric; from: Date; to: Date; floorLevel: number | null; orderBy: CompareOrder; limit: number;
    buildingId: string;
    /** The caller's clock, for `covered`; the process clock when absent. */
    now?: Date;
  },
): Promise<CompareZonesRows> {
  const now = q.now ?? new Date();
  if (q.orderBy === 'minutes_above_band' && q.metric !== 'temperature_c') {
    throw new RangeError('minutes_above_band ranks temperature_c only');
  }
  const withBand = q.orderBy === 'minutes_above_band';
  // The hourly buckets that START in [from, to) span [from, to) rounded UP
  // to the hour; the 5-minute reads below take exactly those bounds.
  const hourMs = 3_600_000;
  const hoursFrom = new Date(Math.ceil(q.from.getTime() / hourMs) * hourMs);
  const hoursTo = new Date(Math.max(hoursFrom.getTime(), Math.ceil(q.to.getTime() / hourMs) * hourMs));
  const zs = `
    zs AS (
      SELECT z.id, z.name AS zone, f.name AS floor, f.level, z.area_m2,
             ${goodMeanSql('a')} AS mean,
             max(a.max_value) AS max,
             coalesce(sum(a.bad_quality_count), 0)::int8 AS flagged
        FROM zones z
        JOIN floors f ON f.id = z.floor_id
        LEFT JOIN sensors s ON s.zone_id = z.id AND s.metric = $1::metric_type AND s.is_active
        LEFT JOIN telemetry_1h_t a ON a.sensor_id = s.id AND a.bucket >= $2 AND a.bucket < $3
       WHERE f.building_id = $5::uuid AND ($4::int IS NULL OR f.level = $4::int)
       GROUP BY z.id, z.name, f.name, f.level, z.area_m2
    )`;
  const cov = `
    cov AS (
      SELECT s.zone_id, count(DISTINCT a.bucket) AS good
        FROM sensors s JOIN telemetry_5m_t a ON a.sensor_id = s.id
       WHERE s.zone_id IN (SELECT id FROM zs) AND s.metric = $1::metric_type AND s.is_active
         AND a.avg_value IS NOT NULL AND a.bucket >= $7 AND a.bucket < $8
       GROUP BY s.zone_id
    )`;
  const band = `
    band AS (
      SELECT b.zone_id,
             CASE WHEN count(b.occ) = 0 OR p.setpoint_temp_c IS NULL OR p.deadband_k IS NULL
                   OR (count(*) FILTER (WHERE b.occ > 0) > 0
                       AND count(*) FILTER (WHERE b.occ > 0 AND b.zt IS NOT NULL) = 0) THEN NULL ELSE
               5 * count(*) FILTER (WHERE b.occ > 0 AND b.zt > p.setpoint_temp_c + p.deadband_k / 2) END
               AS minutes_above_band
        FROM (SELECT s.zone_id, a.bucket,
                     max(a.avg_value) FILTER (WHERE s.metric = 'temperature_c')   AS zt,
                     max(a.avg_value) FILTER (WHERE s.metric = 'occupancy_count') AS occ
                FROM sensors s JOIN telemetry_5m_t a ON a.sensor_id = s.id
               WHERE s.zone_id IN (SELECT id FROM zs) AND s.is_active
                 AND s.metric IN ('temperature_c', 'occupancy_count')
                 AND a.bucket >= $7 AND a.bucket < $8
               GROUP BY s.zone_id, a.bucket) b
        JOIN zones z ON z.id = b.zone_id
        LEFT JOIN thermal_profiles p ON p.id = z.thermal_profile_id
       GROUP BY b.zone_id, p.setpoint_temp_c, p.deadband_k
    )`;
  const orderSql = q.orderBy === 'mean' ? 'zs.mean' : q.orderBy === 'max' ? 'zs.max' : 'band.minutes_above_band';

  const { rows } = await db.query<{
    id: string; zone: string; floor: string; level: number; area_m2: number | null;
    mean: number | null; max: number | null; good: number; flagged: number;
    minutes_above_band: number | null; total: number;
  }>(
    `WITH ${zs}, ${cov}${withBand ? `, ${band}` : ''}
     SELECT zs.id, zs.zone, zs.floor, zs.level, zs.area_m2, zs.mean, zs.max, zs.flagged,
            coalesce(cov.good, 0) AS good,
            ${withBand ? 'band.minutes_above_band' : 'NULL::int8 AS minutes_above_band'},
            count(*) OVER () AS total
       FROM zs LEFT JOIN cov ON cov.zone_id = zs.id
            ${withBand ? 'LEFT JOIN band ON band.zone_id = zs.id' : ''}
      ORDER BY ${orderSql} DESC NULLS LAST, zs.level, zs.zone
      LIMIT $6`,
    [q.metric, q.from, q.to, q.floorLevel, q.buildingId, q.limit, hoursFrom, hoursTo],
  );

  const { rows: floors } = await db.query<{
    floor: string; level: number; mean: number | null; with_data: number; zones: number;
  }>(
    `WITH ${zs}
     SELECT floor, level,
            (sum(area_m2 * mean) FILTER (WHERE mean IS NOT NULL AND area_m2 IS NOT NULL)
              / nullif(sum(area_m2) FILTER (WHERE mean IS NOT NULL AND area_m2 IS NOT NULL), 0))::float8 AS mean,
            count(*) FILTER (WHERE mean IS NOT NULL AND area_m2 IS NOT NULL) AS with_data,
            count(*) AS zones
       FROM zs GROUP BY floor, level ORDER BY level`,
    [q.metric, q.from, q.to, q.floorLevel, q.buildingId],
  );

  const u = metricSuffix(q.metric);
  return {
    ...capped(
      rows.map((r) => ({
        zone_id: r.id,
        zone: r.zone,
        floor: r.floor,
        level: r.level,
        area_m2: r.area_m2,
        [`mean_${u}`]: r.mean,
        [`max_${u}`]: r.max,
        good_buckets_count: r.good,
        flagged_samples_count: r.flagged,
        ...(withBand ? { minutes_above_band_min: r.minutes_above_band } : {}),
      }) as ZoneRankRow),
      rows[0]?.total ?? 0,
      q.limit,
    ),
    floor_means: floors.map((f) => ({
      floor: f.floor,
      level: f.level,
      [`mean_${u}`]: f.mean,
      zones_with_data_count: f.with_data,
      zones_count: f.zones,
    }) as FloorMeanRow),
    covered: compareCovered(q.from, q.to, now),
  };
}
