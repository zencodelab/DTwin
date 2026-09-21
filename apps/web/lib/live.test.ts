import { describe, expect, it } from 'vitest';
import { Quality } from '@dtwin/types';
import {
  ageMs, formatAge, isStale, newer, reducePower, reduceZone, zoneSource, type LiveReading,
} from './live.ts';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function reading(over: Partial<LiveReading> = {}): LiveReading {
  return { value: 23, ts: NOW - 5_000, quality: Quality.Good, receivedAt: NOW - 4_900, ...over };
}

describe('ageMs', () => {
  it('is measured from the device timestamp', () => {
    expect(ageMs(reading({ ts: NOW - 10 * MIN, receivedAt: NOW - 10 * MIN }), NOW, 0)).toBe(10 * MIN);
  });

  it('does not let a device clock running ahead make a reading fresher than its arrival', () => {
    const r = reading({ ts: NOW + 30_000, receivedAt: NOW - 8 * MIN });
    expect(ageMs(r, NOW, 0)).toBe(8 * MIN);
  });

  it('treats a backfilled reading as old however recently it arrived', () => {
    const r = reading({ ts: NOW - 2 * 24 * 60 * MIN, receivedAt: NOW - 1_000 });
    expect(ageMs(r, NOW, 0)).toBe(2 * 24 * 60 * MIN);
  });

  it('does not count silence from before we were listening', () => {
    const r = reading({ ts: NOW - 30 * MIN, receivedAt: NOW - 30 * MIN });
    expect(ageMs(r, NOW, NOW - 20_000)).toBe(20_000);
  });

  it('is never negative', () => {
    expect(ageMs(reading(), NOW, NOW + 5_000)).toBe(0);
  });
});

describe('isStale', () => {
  it('matches the SQL definition: more than three missed samples', () => {
    const at = (ageS: number) => reading({ ts: NOW - ageS * 1000, receivedAt: NOW - ageS * 1000 });
    expect(isStale(at(180), 60, NOW, 0)).toBe(false);
    expect(isStale(at(181), 60, NOW, 0)).toBe(true);
  });

  it('scales with the point, so a 15-minute meter is not stale at 10 minutes', () => {
    const r = reading({ ts: NOW - 10 * MIN, receivedAt: NOW - 10 * MIN });
    expect(isStale(r, 900, NOW, 0)).toBe(false);
    expect(isStale(r, 60, NOW, 0)).toBe(true);
  });
});

describe('newer', () => {
  it('keeps the held reading when an older one arrives after it', () => {
    const held = reading({ ts: NOW - 1_000, value: 24 });
    const late = reading({ ts: NOW - 60_000, value: 19 });
    expect(newer(held, late)).toBe(held);
  });

  it('takes the incoming reading otherwise, including on a tie', () => {
    const held = reading({ ts: NOW - 1_000, value: 24 });
    const same = reading({ ts: NOW - 1_000, value: 25 });
    expect(newer(held, same)).toBe(same);
    expect(newer(undefined, same)).toBe(same);
  });
});

describe('reduceZone', () => {
  const point = (r: LiveReading | undefined, sampleIntervalS = 60) => ({ sampleIntervalS, reading: r });

  it('averages good, fresh readings', () => {
    const live = reduceZone([point(reading({ value: 22 })), point(reading({ value: 24 }))], NOW, 0);
    expect(live).toMatchObject({ value: 23, used: 2, flagged: 0, stale: 0 });
  });

  it('keeps a flagged reading out of the mean', () => {
    const live = reduceZone([
      point(reading({ value: 23 })),
      point(reading({ value: -273, quality: Quality.OutOfRange })),
    ], NOW, 0);
    expect(live.value).toBe(23);
    expect(live.flagged).toBe(1);
  });

  it('excludes Uncertain along with the rest, as the alert engine does', () => {
    const live = reduceZone([point(reading({ quality: Quality.Uncertain }))], NOW, 0);
    expect(live).toMatchObject({ value: null, flagged: 1 });
  });

  it('keeps a stale reading out of the mean and reports the freshest stale age', () => {
    const live = reduceZone([
      point(reading({ value: 23 })),
      point(reading({ value: 30, ts: NOW - 20 * MIN, receivedAt: NOW - 20 * MIN })),
      point(reading({ value: 31, ts: NOW - 9 * MIN, receivedAt: NOW - 9 * MIN })),
    ], NOW, 0);
    expect(live.value).toBe(23);
    expect(live.stale).toBe(2);
    expect(live.staleForMs).toBe(9 * MIN);
  });

  it('counts staleness before quality: a flagged reading from an hour ago is stale', () => {
    const live = reduceZone([
      point(reading({ quality: Quality.DeviceFault, ts: NOW - 60 * MIN, receivedAt: NOW - 60 * MIN })),
    ], NOW, 0);
    expect(live).toMatchObject({ stale: 1, flagged: 0 });
  });

  it('separates a point not heard yet from one that should have spoken by now', () => {
    expect(reduceZone([point(undefined)], NOW, NOW - 10_000)).toMatchObject({ waiting: 1, silent: 0 });
    expect(reduceZone([point(undefined)], NOW, NOW - 4 * MIN)).toMatchObject({ waiting: 0, silent: 1 });
  });

  it('returns null rather than zero for a zone with no points', () => {
    expect(reduceZone([], NOW, 0).value).toBeNull();
  });
});

describe('zoneSource', () => {
  const base = { value: null, used: 0, flagged: 0, stale: 0, waiting: 0, silent: 0, staleForMs: null };

  it('prefers any usable live reading', () => {
    expect(zoneSource({ ...base, value: 23, used: 1, stale: 3 }, true)).toBe('live');
  });

  it('uses the baseline only while still waiting for a first reading', () => {
    expect(zoneSource({ ...base, waiting: 2 }, true)).toBe('baseline');
    expect(zoneSource({ ...base, waiting: 2 }, false)).toBe('none');
  });

  it('never lets the baseline stand in for a point that went quiet', () => {
    expect(zoneSource({ ...base, stale: 1, waiting: 1 }, true)).toBe('stale');
    expect(zoneSource({ ...base, silent: 2 }, true)).toBe('stale');
  });

  it('reports flagged when every point heard from is flagged', () => {
    expect(zoneSource({ ...base, flagged: 2 }, true)).toBe('flagged');
  });
});

describe('formatAge', () => {
  it.each([
    [30_000, '<1 min'], [4 * MIN, '4 min'], [59 * MIN, '59 min'],
    [90 * MIN, '1 h'], [50 * 60 * MIN, '2 d'],
  ])('%d ms → %s', (ms, expected) => expect(formatAge(ms)).toBe(expected));
});

describe('reducePower', () => {
  const meter = (
    floorId: string | null, over: Partial<LiveReading> = {}, sampleIntervalS = 60,
  ) => ({ floorId, sampleIntervalS, reading: reading(over) });
  const dead = (floorId: string | null) =>
    meter(floorId, { ts: NOW - 30 * MIN, receivedAt: NOW - 30 * MIN });

  it('sums the meters that are reporting and counts how many that was', () => {
    const t = reducePower([meter('f1', { value: 10 }), meter('f2', { value: 5 })], null, NOW, 0);
    expect(t).toEqual({ kw: 15, reporting: 2, meters: 2 });
  });

  it('drops a dead meter from the total rather than holding its last value', () => {
    const t = reducePower([meter('f1', { value: 10 }), dead('f2')], null, NOW, 0);
    expect(t).toMatchObject({ kw: 10, reporting: 1, meters: 2 });
  });

  it('drops a flagged meter too', () => {
    const t = reducePower([meter('f1', { value: 10, quality: Quality.DeviceFault })], null, NOW, 0);
    expect(t).toMatchObject({ kw: 0, reporting: 0, meters: 1 });
  });

  it('holds an out-of-scope meter, because we arranged its silence', () => {
    // Focused on f1, so f2's meter hears nothing by design and keeps its value.
    const t = reducePower([meter('f1', { value: 10 }), dead('f2')], 'f1', NOW, 0);
    expect(t).toMatchObject({ kw: 10 + 23, reporting: 2 });
  });

  it('still judges a meter ON the focused floor — the defect this replaced did not', () => {
    // The old code passed `since = now` for EVERY meter as soon as any floor
    // was focused, so this dead in-scope meter went on contributing for ever.
    const t = reducePower([meter('f1', { value: 10 }), dead('f1')], 'f1', NOW, 0);
    expect(t).toMatchObject({ kw: 10, reporting: 1, meters: 2 });
  });

  it('treats a meter of unknown floor as out of scope while a floor is focused', () => {
    expect(reducePower([dead(null)], 'f1', NOW, 0)).toMatchObject({ reporting: 1 });
    expect(reducePower([dead(null)], null, NOW, 0)).toMatchObject({ reporting: 0 });
  });
});
