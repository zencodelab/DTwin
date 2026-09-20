import { describe, expect, it } from 'vitest';
import { KeyedLimiter } from './limiter.ts';

function make(over: Partial<ConstructorParameters<typeof KeyedLimiter>[0]> = {}) {
  let now = 1_000_000;
  const limiter = new KeyedLimiter({ ratePerS: 1, burst: 3, maxKeys: 100, now: () => now, ...over });
  return { limiter, advance: (ms: number) => { now += ms; } };
}

describe('KeyedLimiter', () => {
  it('allows a burst, then refuses with the wait until the next token', () => {
    const { limiter } = make();
    expect([1, 2, 3].map(() => limiter.take('a').ok)).toEqual([true, true, true]);
    expect(limiter.take('a')).toEqual({ ok: false, retryAfterS: 1 });
  });

  it('refills at the configured rate and never past the burst', () => {
    const { limiter, advance } = make();
    for (let i = 0; i < 3; i += 1) limiter.take('a');
    advance(2_000);
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(false);

    advance(3_600_000);
    expect([1, 2, 3, 4].map(() => limiter.take('a').ok)).toEqual([true, true, true, false]);
  });

  it('keeps keys independent', () => {
    const { limiter } = make();
    for (let i = 0; i < 3; i += 1) limiter.take('a');
    expect(limiter.take('a').ok).toBe(false);
    expect(limiter.take('b').ok).toBe(true);
  });

  it('charges a weighted cost and reports the wait for that cost', () => {
    const { limiter } = make({ ratePerS: 100, burst: 1_000 });
    expect(limiter.take('t', 900).ok).toBe(true);
    expect(limiter.take('t', 600)).toEqual({ ok: false, retryAfterS: 5 });
  });

  it('does not spend tokens on a refusal', () => {
    const { limiter } = make({ ratePerS: 100, burst: 1_000 });
    limiter.take('t', 900);
    limiter.take('t', 600);
    expect(limiter.take('t', 100).ok).toBe(true);
  });

  it('answers a cost above the burst with an infinite wait rather than a retryable one', () => {
    const { limiter } = make();
    expect(limiter.take('a', 4)).toEqual({ ok: false, retryAfterS: Infinity });
  });

  it('exhausted() checks without spending, and an unknown key is never exhausted', () => {
    const { limiter } = make();
    expect(limiter.exhausted('a').ok).toBe(true);
    for (let i = 0; i < 3; i += 1) limiter.take('a');
    expect(limiter.exhausted('a')).toEqual({ ok: false, retryAfterS: 1 });
    expect(limiter.exhausted('never-seen').ok).toBe(true);
    expect(limiter.stats.keys).toBe(1);
  });

  it('tolerates a clock that steps backwards', () => {
    const { limiter, advance } = make();
    for (let i = 0; i < 3; i += 1) limiter.take('a');
    advance(-60_000);
    expect(limiter.take('a').ok).toBe(false);
  });

  describe('at maxKeys', () => {
    it('reclaims buckets that have refilled, since full and absent are the same', () => {
      const { limiter, advance } = make({ maxKeys: 3 });
      for (const key of ['a', 'b', 'c']) limiter.take(key);
      advance(10_000);
      expect(limiter.take('d').ok).toBe(true);
      expect(limiter.stats).toMatchObject({ keys: 1, overflowed: 0 });
    });

    it('makes new keys share one bucket rather than forgetting a key mid-burst', () => {
      const { limiter } = make({ maxKeys: 2 });
      for (let i = 0; i < 3; i += 1) { limiter.take('a'); limiter.take('b'); }

      // Rotating the key buys nothing: all newcomers draw on the same burst.
      const results = ['n1', 'n2', 'n3', 'n4'].map((key) => limiter.take(key).ok);
      expect(results).toEqual([true, true, true, false]);
      expect(limiter.stats.overflowed).toBe(4);

      // And filling the map did not reset anyone already being limited.
      expect(limiter.take('a').ok).toBe(false);
    });
  });

  it('rejects a configuration that could never admit anything', () => {
    expect(() => new KeyedLimiter({ ratePerS: 0, burst: 1, maxKeys: 1 })).toThrow();
    expect(() => new KeyedLimiter({ ratePerS: 1, burst: 0, maxKeys: 1 })).toThrow();
  });
});
