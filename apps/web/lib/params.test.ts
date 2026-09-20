import { describe, expect, it } from 'vitest';
import { parseHours, parseUuid } from './params.ts';

/**
 * Both routes read `?hours=` with a bare Number(). These are the inputs that
 * turned into a 500 or a full-table scan, and the ones that must keep working.
 */
describe('parseHours', () => {
  const opts = { fallback: 6, max: 168 };

  it('uses the fallback when the parameter is absent', () => {
    expect(parseHours(null, opts)).toEqual({ ok: true, value: 6 });
  });

  it('accepts a positive number inside the limit, including a fraction', () => {
    expect(parseHours('24', opts)).toEqual({ ok: true, value: 24 });
    expect(parseHours('0.5', opts)).toEqual({ ok: true, value: 0.5 });
    expect(parseHours('168', opts)).toEqual({ ok: true, value: 168 });
  });

  it.each(['abc', '', 'NaN', 'Infinity', '-Infinity', '0', '-3'])(
    'refuses %j rather than passing it to a Date', (raw) => {
      const r = parseHours(raw, opts);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.response.status).toBe(400);
    });

  it('refuses a span over the limit and names the limit', async () => {
    const r = parseHours('1e9', opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect((await r.response.json()).error).toContain('168');
  });

  it('refuses rather than clamps', () => {
    // Clamping would answer a different question without saying so.
    expect(parseHours('169', opts).ok).toBe(false);
  });
});

describe('parseUuid', () => {
  it('accepts a uuid in either case', () => {
    expect(parseUuid('246e02dc-e011-4a8e-80b0-9e47680e0b09', 'id').ok).toBe(true);
    expect(parseUuid('246E02DC-E011-4A8E-80B0-9E47680E0B09', 'id').ok).toBe(true);
  });

  it.each([null, '', 'nope', '246e02dc', '../weather/generate',
           '246e02dc-e011-4a8e-80b0-9e47680e0b09/../x',
           "246e02dc-e011-4a8e-80b0-9e47680e0b09' OR 1=1"])(
    'refuses %j', (raw) => {
      const r = parseUuid(raw, 'runId');
      expect(r.ok).toBe(false);
      expect(!r.ok && r.response.status).toBe(400);
    });
});
