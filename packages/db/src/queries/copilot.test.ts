import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Db } from '../client.ts';
import {
  bucketStartsIn, compareCovered, copilotCompareZones, copilotMeterConsumption, copilotZoneConditions,
  copilotZoneHistory, metricSuffix, thresholdSuffix, triggerSuffix,
} from './copilot.ts';

/**
 * The copilot's SQL is exercised against a real database by the db smoke
 * suite (section [9]) and was checked READ ONLY against the dev data. What is
 * here is what a database cannot localise: the unit arithmetic every result
 * key is built from, the order of the statements a transaction receives, and
 * a scan of the SQL for the relations it must never name.
 */

/** A Db that records every statement and answers from a script. */
function recordingDb(answer: (sql: string) => unknown[] = () => []) {
  const statements: string[] = [];
  const db: Db = {
    async query<R>(text: string) {
      statements.push(text);
      return { rows: answer(text) as R[], rowCount: 0 };
    },
  };
  return { db, statements };
}

const at = (iso: string) => new Date(iso);
const BUILDING = '00000000-0000-4000-b000-000000000001';

describe('bucketStartsIn', () => {
  it('counts the buckets the predicate bucket >= from AND bucket < to can return', () => {
    expect(bucketStartsIn(at('2026-09-28T09:00:00Z'), at('2026-09-28T09:10:00Z'), 300)).toBe(2);
    // An unaligned start loses its partial bucket: 09:05 is the first start.
    expect(bucketStartsIn(at('2026-09-28T09:02:00Z'), at('2026-09-28T09:10:00Z'), 300)).toBe(1);
    // An unaligned end keeps the bucket that starts before it.
    expect(bucketStartsIn(at('2026-09-28T09:00:00Z'), at('2026-09-28T09:11:00Z'), 300)).toBe(3);
    expect(bucketStartsIn(at('2026-09-28T09:40:00Z'), at('2026-09-28T12:40:00Z'), 3600)).toBe(3);
    expect(bucketStartsIn(at('2026-09-21T00:00:00Z'), at('2026-09-28T00:00:00Z'), 300)).toBe(2016);
  });

  it('is never negative', () => {
    expect(bucketStartsIn(at('2026-09-28T09:10:00Z'), at('2026-09-28T09:00:00Z'), 300)).toBe(0);
    expect(bucketStartsIn(at('2026-09-28T09:01:00Z'), at('2026-09-28T09:02:00Z'), 300)).toBe(0);
  });
});

describe('unit suffixes', () => {
  it('reads a metric\'s unit off its name', () => {
    expect(metricSuffix('temperature_c')).toBe('c');
    expect(metricSuffix('damper_position_pct')).toBe('pct');
    expect(metricSuffix('energy_kwh')).toBe('kwh');
    expect(metricSuffix('water_m3')).toBe('m3');
  });

  it('keys a threshold by what the rule engine compares', () => {
    // A slope per hour; a temperature slope is a rate of DIFFERENCE.
    expect(thresholdSuffix('temperature_c', 'rate_of_change')).toBe('k_per_h');
    expect(thresholdSuffix('co2_ppm', 'rate_of_change')).toBe('ppm_per_h');
    // |value − setpoint|: a difference, so kelvin.
    expect(thresholdSuffix('temperature_c', 'deviation_from_setpoint')).toBe('k');
    expect(thresholdSuffix('temperature_c', 'threshold_above')).toBe('c');
    expect(thresholdSuffix('power_kw', 'threshold_above')).toBe('kw');
    expect(thresholdSuffix(null, 'threshold_above')).toBeNull();
  });

  it('keys a trigger by what the engine stores: the slope, or the reading', () => {
    expect(triggerSuffix('temperature_c', 'rate_of_change')).toBe('k_per_h');
    // The breaching READING, in °C — not the deviation.
    expect(triggerSuffix('temperature_c', 'deviation_from_setpoint')).toBe('c');
    expect(triggerSuffix('co2_ppm', 'threshold_above')).toBe('ppm');
    expect(triggerSuffix(null, 'no_data')).toBeNull();
  });
});

describe('statement order', () => {
  it('meter_consumption turns off parallel workers before it touches the rollup', async () => {
    const { db, statements } = recordingDb((sql) =>
      /FROM equipment e\s+JOIN sensors s/.test(sql)
        ? [{ tag: 'MTR-MAIN', type: 'electric_meter', sensor_id: 's1', metric: 'energy_kwh' }]
        : []);
    const out = await copilotMeterConsumption(db, {
      meterTag: 'MTR-MAIN', from: at('2026-09-27T00:00:00Z'), to: at('2026-09-28T00:00:00Z'),
      bucket: 'hour', timezone: 'Asia/Dubai', buildingId: BUILDING,
    });
    const set = statements.findIndex((s) => /SET LOCAL max_parallel_workers_per_gather = 0/.test(s));
    const firstRollup = statements.findIndex((s) => /telemetry_1h_t/.test(s));
    expect(set).toBeGreaterThan(-1);
    expect(set).toBeLessThan(firstRollup);
    // Both the buckets and the window total are rollups of ONE sensor's counter.
    expect(statements.filter((s) => /delta\(rollup\(a\.counter\)\)/.test(s))).toHaveLength(2);
    expect(out).toMatchObject({ unit: 'kwh', total_kwh: null, total_resets_count: 0, buckets: [] });
  });

  it('meter_consumption answers unknownMeter without reading telemetry', async () => {
    const { db, statements } = recordingDb();
    const out = await copilotMeterConsumption(db, {
      meterTag: 'AHU-01', from: at('2026-09-27T00:00:00Z'), to: at('2026-09-28T00:00:00Z'),
      bucket: 'hour', timezone: 'Asia/Dubai', buildingId: BUILDING,
    });
    expect(out).toEqual({ unknownMeter: true });
    expect(statements).toHaveLength(1);
  });

  it('a local-day meter refuses an unknown time zone before any query', async () => {
    const { db, statements } = recordingDb();
    await expect(copilotMeterConsumption(db, {
      meterTag: 'MTR-MAIN', from: at('2026-09-27T00:00:00Z'), to: at('2026-09-28T00:00:00Z'),
      bucket: 'local_day', timezone: 'Mars/Olympus_Mons', buildingId: BUILDING,
    })).rejects.toThrow(RangeError);
    expect(statements).toHaveLength(0);
  });

  it('zone_history refuses a span its reader would truncate, before any query', async () => {
    const { db, statements } = recordingDb();
    await expect(copilotZoneHistory(db, {
      zoneId: 'z', metrics: ['temperature_c'], resolution: '5m',
      from: at('2026-09-20T00:00:00Z'), to: at('2026-09-28T08:00:00Z'),
    })).rejects.toThrow(/answers at most 168 h/);
    expect(statements).toHaveLength(0);
  });

  it('zone_conditions is null for a zone RLS does not show, and stops there', async () => {
    const { db, statements } = recordingDb();
    expect(await copilotZoneConditions(db, {
      zoneId: 'z', from: at('2026-09-28T05:00:00Z'), to: at('2026-09-28T08:40:00Z'),
    })).toBeNull();
    expect(statements).toHaveLength(1);
  });
});

describe('compare_zones: the window it was read from', () => {
  const iso = (v: string) => new Date(v).toISOString();

  it('ends at now, never at an hour that has not happened (E2E)', () => {
    // The first real runs labelled a window "until now" 09:00–19:00 at
    // 18:51 and …20:00 at 19:25: the end was `to` rounded up to the hour.
    const now = at('2026-09-28T14:51:00Z');
    expect(compareCovered(at('2026-09-28T05:00:00Z'), now, now))
      .toEqual({ from: iso('2026-09-28T05:00:00Z'), to: iso('2026-09-28T14:51:00Z') });
    // A `to` a little past now (the tool tolerates 300 s) stops at now too.
    expect(compareCovered(at('2026-09-28T05:00:00Z'), at('2026-09-28T14:54:00Z'), now).to).toBe(iso('2026-09-28T14:51:00Z'));
    // So does one that ends later in the hour that is running.
    expect(compareCovered(at('2026-09-28T05:00:00Z'), at('2026-09-28T14:56:00Z'), at('2026-09-28T14:52:00Z')).to)
      .toBe(iso('2026-09-28T14:52:00Z'));
  });

  it('keeps the whole last hour of a window that ended before now: that bucket\'s figures include it', () => {
    // Buckets START in [from, to): 09:40–12:40 reads the 10:00, 11:00 and
    // 12:00 buckets, and the 12:00 one holds readings up to 13:00.
    const now = at('2026-09-28T08:40:00Z');
    expect(compareCovered(at('2026-09-27T05:40:00Z'), at('2026-09-27T08:40:00Z'), now))
      .toEqual({ from: iso('2026-09-27T06:00:00Z'), to: iso('2026-09-27T09:00:00Z') });
    // On the hour it is exact, and never past now.
    expect(compareCovered(at('2026-09-27T05:00:00Z'), at('2026-09-27T09:00:00Z'), now))
      .toEqual({ from: iso('2026-09-27T05:00:00Z'), to: iso('2026-09-27T09:00:00Z') });
    for (const [from, to] of [['2026-09-28T01:10:00Z', '2026-09-28T08:40:00Z'], ['2026-09-21T08:40:00Z', '2026-09-28T08:44:00Z']]) {
      expect(Date.parse(compareCovered(at(from!), at(to!), now).to)).toBeLessThanOrEqual(now.getTime());
    }
  });

  it('is never inverted, even for a window that starts after now', () => {
    const now = at('2026-09-28T08:40:00Z');
    expect(compareCovered(at('2026-09-28T08:42:00Z'), at('2026-09-28T08:44:00Z'), now))
      .toEqual({ from: iso('2026-09-28T09:00:00Z'), to: iso('2026-09-28T09:00:00Z') });
  });

  it('copilotCompareZones reports it on the caller\'s clock', async () => {
    const { db } = recordingDb();
    const out = await copilotCompareZones(db, {
      metric: 'temperature_c', from: at('2026-09-28T05:00:00Z'), to: at('2026-09-28T14:51:00Z'),
      floorLevel: null, orderBy: 'mean', limit: 24, now: at('2026-09-28T14:51:00Z'), buildingId: BUILDING,
    });
    expect(out.covered).toEqual({ from: iso('2026-09-28T05:00:00Z'), to: iso('2026-09-28T14:51:00Z') });
  });

  it('reads the minutes above the band, and the coverage, over the hours it covered — not the window asked (review)', async () => {
    // 09:40–12:40 is answered from the 10:00, 11:00 and 12:00 hours; the band
    // counted 5-minute buckets from 09:40 to 12:35 under a label of 10:00–13:00.
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const db: Db = {
      async query<R>(text: string, params?: unknown[]) {
        calls.push({ text, params: params ?? [] });
        return { rows: [] as R[], rowCount: 0 };
      },
    };
    const out = await copilotCompareZones(db, {
      metric: 'temperature_c', from: at('2026-09-27T05:40:00Z'), to: at('2026-09-27T08:40:00Z'),
      floorLevel: null, orderBy: 'minutes_above_band', limit: 24, now: at('2026-09-28T08:40:00Z'), buildingId: BUILDING,
    });
    const ranked = calls[0]!;
    const bound = (n: number) => (ranked.params[n - 1] as Date).toISOString();
    // Every 5-minute read (the band and the coverage) is bounded by $7 and $8.
    const fiveMinute = ranked.text.match(/telemetry_5m_t a[\s\S]*?a\.bucket >= \$(\d+) AND a\.bucket < \$(\d+)/g) ?? [];
    expect(fiveMinute).toHaveLength(2);
    for (const read of fiveMinute) expect(read).toMatch(/a\.bucket >= \$7 AND a\.bucket < \$8/);
    expect({ from: bound(7), to: bound(8) }).toEqual(out.covered);
  });
});

describe('the SQL itself', () => {
  // Comments stripped, so prose ABOUT a forbidden relation does not count.
  const source = readFileSync(new URL('./copilot.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('reads the barrier views, never a bare aggregate', () => {
    expect(source).not.toMatch(/\btelemetry_(5m|1h|1d)\b(?!_t)/);
  });

  it('reads raw telemetry only through telemetry_t, and only in v1\'s list_zones', () => {
    expect(source).not.toMatch(/\b(FROM|JOIN)\s+telemetry\b(?!_)/i);
    expect(source.match(/\btelemetry_t\b/g)).toHaveLength(1);
  });

  it('never writes', () => {
    expect(source).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|COPY\s|refresh_continuous_aggregate)\b/i);
  });

  it('never averages or subtracts a counter', () => {
    expect(source).not.toMatch(/avg\([^)]*counter/i);
    expect(source).not.toMatch(/sum\(\s*delta\(/i);
    expect(source).not.toMatch(/max\(a\.last_value\)\s*-\s*min/i);
  });

  it('reads people\'s text only through the truncating helpers', () => {
    // Every free-text column appears inside untrustedSql/untrustedJson or a
    // LIKE test, never selected bare.
    for (const col of ['message', 'reason', 'notes', 'outcome_detail']) {
      const bare = new RegExp(`(SELECT|,)\\s*(\\w+\\.)?${col}\\s*(,|\\)|AS|FROM)`, 'i');
      expect(source, col).not.toMatch(bare);
    }
  });
});
