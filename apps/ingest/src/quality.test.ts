import { describe, expect, it } from 'vitest';
import { Quality } from '@dtwin/types';
import { assessQuality, isCounterReset } from './quality.ts';
import type { RegisteredSensor } from './registry.ts';

/**
 * The quality gate decides what a value *means*, and two rules downstream
 * depend on getting it right: a flagged reading must never drive a value
 * condition (decisions.md §17), and a meter reset must never be mistaken for a
 * fault (§10). Both are visible end to end only as an alert that did or did not
 * fire, which is a slow way to learn that a boundary is off by one.
 */
function sensor(over: Partial<RegisteredSensor> = {}): RegisteredSensor {
  return {
    id: 's1', externalId: 'BAC:T-01', name: 'Zone temp',
    metric: 'temperature_c', unit: '°C',
    minPlausible: -10, maxPlausible: 60,
    isCumulative: false, sampleIntervalS: 60,
    equipmentId: null, zoneId: 'z1', floorId: 'f1', buildingId: 'b1',
    tenantId: 't1',
    ...over,
  } as RegisteredSensor;
}

describe('assessQuality', () => {
  it('passes a plausible value', () => {
    expect(assessQuality(sensor(), 21.5)).toBe(Quality.Good);
  });

  it('believes a device that reports its own fault', () => {
    // The device knows more than the range check does: a sensor reporting
    // DeviceFault with a value inside the plausible band is still faulty.
    expect(assessQuality(sensor(), 21.5, Quality.DeviceFault)).toBe(Quality.DeviceFault);
    expect(assessQuality(sensor(), 21.5, Quality.Uncertain)).toBe(Quality.Uncertain);
  });

  it('does not let a declared Good override the range check', () => {
    // Otherwise any device could assert its way past the plausible band.
    expect(assessQuality(sensor(), 999, Quality.Good)).toBe(Quality.OutOfRange);
  });

  it('flags values outside the plausible band', () => {
    expect(assessQuality(sensor(), -273)).toBe(Quality.OutOfRange);
    expect(assessQuality(sensor(), 61)).toBe(Quality.OutOfRange);
  });

  it('treats the bounds as inclusive', () => {
    // The band is "plausible", not "strictly inside" — a sensor pinned at its
    // stated minimum is reporting a real reading.
    expect(assessQuality(sensor(), -10)).toBe(Quality.Good);
    expect(assessQuality(sensor(), 60)).toBe(Quality.Good);
  });

  it('skips a bound that is null', () => {
    const open = sensor({ minPlausible: null, maxPlausible: null });
    expect(assessQuality(open, -1e9)).toBe(Quality.Good);
    expect(assessQuality(open, 1e9)).toBe(Quality.Good);
  });

  it('applies only the bound that exists', () => {
    expect(assessQuality(sensor({ maxPlausible: null }), 1e9)).toBe(Quality.Good);
    expect(assessQuality(sensor({ maxPlausible: null }), -11)).toBe(Quality.OutOfRange);
  });

  it('calls a non-finite value a device fault, not out of range', () => {
    // NaN fails every comparison silently, so it has to be caught before the
    // band check rather than falling through it as Good.
    expect(assessQuality(sensor(), Number.NaN)).toBe(Quality.DeviceFault);
    expect(assessQuality(sensor(), Number.POSITIVE_INFINITY)).toBe(Quality.DeviceFault);
    expect(assessQuality(sensor(), Number.NEGATIVE_INFINITY)).toBe(Quality.DeviceFault);
  });
});

describe('isCounterReset', () => {
  const meter = sensor({ isCumulative: true, minPlausible: 0, maxPlausible: null });

  it('recognises a cumulative meter going backwards', () => {
    expect(isCounterReset(meter, 5, 1_000_000)).toBe(true);
  });

  it('is not a reset when the meter advances or holds', () => {
    expect(isCounterReset(meter, 1_000_001, 1_000_000)).toBe(false);
    expect(isCounterReset(meter, 1_000_000, 1_000_000)).toBe(false);
  });

  it('needs a previous value', () => {
    expect(isCounterReset(meter, 5, undefined)).toBe(false);
  });

  it('does not apply to a non-cumulative sensor', () => {
    // A temperature falling is not a reset; it is Tuesday.
    expect(isCounterReset(sensor(), 18, 22)).toBe(false);
  });

  it('a reset is not a quality problem', () => {
    // The whole point of §10: counter_agg handles the discontinuity, so
    // flagging it would misreport a normal event as a fault.
    expect(assessQuality(meter, 5)).toBe(Quality.Good);
  });
});
