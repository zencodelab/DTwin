import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isValidTimeZone, localStamp, offsetMinutes, toLocalIso } from './time.ts';

const at = (iso: string) => Date.parse(iso);

describe('localStamp', () => {
  it('stamps now in the building offset: Asia/Dubai is +04:00', () => {
    expect(localStamp(at('2026-09-28T08:40:00Z'), 'Asia/Dubai')).toEqual({
      nowIso: '2026-09-28T12:40:00+04:00',
      localDate: '2026-09-28',
      weekday: 'Monday',
      timezone: 'Asia/Dubai',
    });
  });

  it('takes the date and weekday from the building, not from UTC', () => {
    const s = localStamp(at('2026-09-28T21:30:00Z'), 'Asia/Dubai');
    expect(s.nowIso).toBe('2026-09-29T01:30:00+04:00');
    expect(s.localDate).toBe('2026-09-29');
    expect(s.weekday).toBe('Tuesday');
  });

  it('writes local midnight as 00, never 24', () => {
    expect(localStamp(at('2026-09-27T20:00:00Z'), 'Asia/Dubai').nowIso).toBe('2026-09-28T00:00:00+04:00');
  });

  it('drops milliseconds and names the same instant', () => {
    const ms = at('2026-09-28T08:40:07.891Z');
    const { nowIso } = localStamp(ms, 'Asia/Dubai');
    expect(nowIso).toBe('2026-09-28T12:40:07+04:00');
    expect(Date.parse(nowIso)).toBe(Math.floor(ms / 1000) * 1000);
  });

  it('is accepted by the tools\' timestamp schema, which refuses naive times', () => {
    const Ts = z.string().datetime({ offset: true });
    expect(Ts.safeParse(localStamp(at('2026-09-28T08:40:00Z'), 'Asia/Dubai').nowIso).success).toBe(true);
    expect(Ts.safeParse('2026-09-28T12:40:00').success).toBe(false);
  });

  it('refuses an unknown zone rather than guessing UTC', () => {
    expect(() => localStamp(at('2026-09-28T08:40:00Z'), 'Mars/Olympus_Mons')).toThrow(RangeError);
    expect(() => localStamp(Number.NaN, 'Asia/Dubai')).toThrow(RangeError);
  });
});

describe('toLocalIso and offsets', () => {
  it.each([
    ['2026-07-01T12:00:00Z', 'Europe/London', '2026-07-01T13:00:00+01:00'],
    ['2026-12-01T12:00:00Z', 'Europe/London', '2026-12-01T12:00:00+00:00'],
    ['2026-09-28T12:00:00Z', 'Asia/Kathmandu', '2026-09-28T17:45:00+05:45'],
    ['2026-09-28T12:00:00Z', 'America/St_Johns', '2026-09-28T09:30:00-02:30'],
    ['2026-09-28T02:00:00Z', 'America/Los_Angeles', '2026-09-27T19:00:00-07:00'],
    ['2026-09-28T12:00:00Z', 'UTC', '2026-09-28T12:00:00+00:00'],
  ])('%s in %s is %s', (utc, tz, local) => {
    expect(toLocalIso(at(utc), tz)).toBe(local);
    expect(Date.parse(local)).toBe(at(utc));
  });

  it('follows a DST change within one day', () => {
    // Europe/London springs forward at 01:00 UTC on 29 Mar 2026.
    expect(offsetMinutes(at('2026-03-29T00:59:00Z'), 'Europe/London')).toBe(0);
    expect(offsetMinutes(at('2026-03-29T01:00:00Z'), 'Europe/London')).toBe(60);
  });

  it('knows which zone names are real', () => {
    expect(isValidTimeZone('Asia/Dubai')).toBe(true);
    expect(isValidTimeZone('Asia/Nowhere')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});
