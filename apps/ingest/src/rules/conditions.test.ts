import { describe, expect, it } from 'vitest';
import { slopePerHour } from './conditions.ts';

/**
 * The rate_of_change rule's whole credibility rests on this function, and the
 * claim made for it is quantitative: ±0.18 K of sensor noise across two samples
 * 60 s apart implies over 20 K/h, so an endpoint difference would fire a 2 K/h
 * rule constantly on a steady zone. That claim is checked here rather than
 * asserted, because end to end the alert engine only reports whether a rule
 * fired — not whether it fired for the right reason.
 */
const NOW = 1_700_000_000_000;

/** `count` samples ending at NOW, `stepS` apart, from `at(tsSeconds)`. */
function series(count: number, stepS: number, at: (tSeconds: number) => number) {
  return Array.from({ length: count }, (_, i) => {
    const secondsAgo = (count - 1 - i) * stepS;
    return { ts: NOW - secondsAgo * 1000, value: at(-secondsAgo) };
  });
}

describe('slopePerHour', () => {
  it('recovers an exact linear trend', () => {
    // +3 K/h — value in K, t in seconds.
    const history = series(31, 60, (t) => 20 + (3 / 3600) * t);
    expect(slopePerHour(history, NOW, 1800)).toBeCloseTo(3, 6);
  });

  it('gets the sign right on a falling trend', () => {
    const history = series(31, 60, (t) => 20 - (3 / 3600) * t);
    expect(slopePerHour(history, NOW, 1800)).toBeCloseTo(-3, 6);
  });

  it('reads a flat series as zero', () => {
    expect(slopePerHour(series(31, 60, () => 21), NOW, 1800)).toBeCloseTo(0, 9);
  });

  it('averages sensor noise out instead of amplifying it — the 20 K/h claim', () => {
    // A steady 21 °C zone, dithering by ±0.18 K sample to sample.
    const noise = [0.18, -0.18];
    const history = series(31, 60, (t) => 21 + noise[Math.round(-t / 60) % 2]!);

    // The endpoint difference the regression replaces: 0.36 K over 60 s.
    const endpoint = ((history.at(-1)!.value - history.at(-2)!.value)
      / ((history.at(-1)!.ts - history.at(-2)!.ts) / 3_600_000));
    expect(Math.abs(endpoint)).toBeGreaterThan(20);

    // The regression sees the trend that is actually there: none.
    const slope = slopePerHour(history, NOW, 1800)!;
    expect(Math.abs(slope)).toBeLessThan(2);
  });

  it('needs at least three samples', () => {
    expect(slopePerHour(series(2, 60, (t) => 20 + t), NOW, 1800)).toBeNull();
    expect(slopePerHour([], NOW, 1800)).toBeNull();
  });

  it('refuses a window it has barely covered', () => {
    // Ten minutes of samples cannot answer a thirty-minute question: a slope
    // from a sliver of the window is not the quantity the threshold describes.
    const history = series(11, 60, (t) => 20 + (3 / 3600) * t);
    expect(slopePerHour(history, NOW, 1800)).toBeNull();
  });

  it('accepts exactly half the window', () => {
    // 16 samples 60 s apart span 900 s, which is windowMs / 2 exactly.
    const history = series(16, 60, (t) => 20 + (3 / 3600) * t);
    expect(slopePerHour(history, NOW, 1800)).toBeCloseTo(3, 6);
  });

  it('drops samples older than the window before fitting', () => {
    // A steep ramp that ended an hour ago, then a flat half hour. Only the
    // trailing window is the rule's business, so this must read flat — an
    // implementation that fitted the whole history would report the ramp.
    const older = Array.from({ length: 60 }, (_, i) => ({
      ts: NOW - 7200_000 + i * 60_000, // ends at NOW - 3660s, well outside
      value: i,
    }));
    const recent = series(31, 60, () => 100);
    expect(slopePerHour([...older, ...recent], NOW, 1800)).toBeCloseTo(0, 9);
  });

  it('returns null when every sample shares a timestamp', () => {
    // Zero variance in x: the normal equations have no solution, and dividing
    // by it would yield NaN or Infinity and be compared against a threshold.
    const history = [
      { ts: NOW, value: 1 }, { ts: NOW, value: 2 }, { ts: NOW, value: 3 },
    ];
    expect(slopePerHour(history, NOW, 1800)).toBeNull();
  });

  it('is unaffected by the absolute epoch, not just the offsets', () => {
    // Timestamps are epoch milliseconds — ~1.7e12 — so an uncentred fit would
    // lose precision in the sum of squares. Centring is what makes this hold.
    const history = series(31, 60, (t) => 20 + (3 / 3600) * t);
    const shifted = history.map((h) => ({ ...h, ts: h.ts + 10 * 365 * 86_400_000 }));
    const a = slopePerHour(history, NOW, 1800)!;
    const b = slopePerHour(shifted, NOW + 10 * 365 * 86_400_000, 1800)!;
    expect(b).toBeCloseTo(a, 9);
  });
});
