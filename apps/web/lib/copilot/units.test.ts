import { describe, expect, it } from 'vitest';
import { UNIT_IDS } from './evidence.ts';
import {
  UNIT_SUFFIXES, UNIT_SYMBOL, defaultDecimals, displayedValue, formatNumber, formatQuantity, unitOfKey,
} from './units.ts';

describe('unit suffix table', () => {
  it('names every unit exactly once', () => {
    const units = UNIT_SUFFIXES.map((s) => s.unit);
    expect([...units].sort()).toEqual([...UNIT_IDS].sort());
    expect(Object.keys(UNIT_SYMBOL).sort()).toEqual([...UNIT_IDS].sort());
  });

  it('puts every longer suffix before any shorter one it ends with', () => {
    // An earlier entry that is the tail of a later one would shadow it.
    UNIT_SUFFIXES.forEach((earlier, i) => {
      for (const later of UNIT_SUFFIXES.slice(i + 1)) {
        expect(later.suffix.endsWith(earlier.suffix), `${earlier.suffix} shadows ${later.suffix}`).toBe(false);
      }
    });
  });
});

describe('unitOfKey', () => {
  it.each([
    ['mean_c', 'c'], ['designed_setpoint_c', 'c'], ['slope_k_per_h', 'k_per_h'],
    ['warm_vs_design_zone_h', 'zone_h'], ['unmet_own_band_zone_h', 'zone_h'], ['total_kwh', 'kwh'],
    ['peak_interval_kw', 'kw'], ['max_ppm', 'ppm'], ['vav_rated_airflow_cmh', 'cmh'],
    ['delta_total_pct', 'pct'], ['area_m2', 'm2'], ['total_m3', 'm3'], ['occupied_min', 'min'],
    ['downtime_min', 'min'], ['zones_count', 'count'], ['co2_kg', 'kg'], ['deadband_k', 'k'],
    ['delta_max_occupied_k', 'k'], ['warmup_h', 'h'], ['duration_s', 's'], ['window_s', 's'],
  ] as const)('%s is in %s', (key, unit) => {
    expect(unitOfKey(key)).toBe(unit);
  });

  it.each([
    'level', 'threshold', 'run_id', 'c', '_c', 'kwh', 'stale', 'suspect',
    // Compound units outside the table must not be read by their tail.
    'implied_m3_per_h', 'grid_carbon_kg_per_kwh', 'per_h',
    // A quantity that lost its suffix: uncitable until the tool renames it.
    'mean_kw_last_hour',
  ])('%s names no unit', (key) => {
    expect(unitOfKey(key)).toBeNull();
  });
});

describe('formatting', () => {
  it('writes each unit as the dashboard does', () => {
    expect(formatQuantity(23.97, 2, 'c')).toBe('23.97 °C');
    expect(formatQuantity(95, 0, 'pct')).toBe('95%');
    expect(formatQuantity(-10.7345, 1, 'pct')).toBe('-10.7%');
    expect(formatQuantity(2862, 0, 'cmh')).toBe('2,862 m³/h');
    expect(formatQuantity(18.2, 1, 'count')).toBe('18.2');
    expect(formatQuantity(3, 0, 'zone_h')).toBe('3 zone-hours');
    expect(formatQuantity(-2, 1, 'k_per_h')).toBe('-2.0 K/h');
    expect(formatQuantity(15537.9, 1, 'kwh')).toBe('15,537.9 kWh');
    expect(formatQuantity(200, 0, 'm2')).toBe('200 m²');
  });

  it('never shows a negative zero', () => {
    expect(formatNumber(-0.01, 1)).toBe('0.0');
    expect(formatNumber(-0.4, 0)).toBe('0');
    expect(formatNumber(-0.06, 1)).toBe('-0.1');
  });

  it('displays the value the verifier then compares', () => {
    expect(displayedValue(1172.456, 1)).toBe(1172.5);
    expect(displayedValue(23.9712, 2)).toBe(23.97);
    expect(displayedValue(-0.01, 1)).toBe(0);
  });

  it('refuses decimals the answer grammar does not allow', () => {
    expect(() => formatNumber(1, 4)).toThrow(RangeError);
    expect(() => formatNumber(1, 1.5)).toThrow(RangeError);
    expect(() => formatNumber(Number.NaN, 1)).toThrow(RangeError);
  });

  it('picks card decimals from the unit, and shows fractional counts', () => {
    expect(defaultDecimals('c', 23.97)).toBe(1);
    expect(defaultDecimals('kwh', 1172.4)).toBe(0);
    expect(defaultDecimals('count', 18)).toBe(0);
    expect(defaultDecimals('count', 18.2)).toBe(1);
  });
});
