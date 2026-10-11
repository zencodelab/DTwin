import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@dtwin/db';

/**
 * A client that counts how many of its queries are in flight at once. The
 * transaction client `withTenant` hands over runs one statement at a time;
 * overlapping calls only work through pg's internal queue, which pg 9 removes.
 */
const seen = { calls: 0, maxInFlight: 0 };
let inFlight = 0;
const serialDb: Db = {
  async query<R>(text: string) {
    inFlight += 1;
    seen.calls += 1;
    seen.maxInFlight = Math.max(seen.maxInFlight, inFlight);
    await new Promise((resolve) => { setTimeout(resolve, 1); });
    inFlight -= 1;
    const rows = (/FROM buildings/.test(text) ? [{ timezone: 'Asia/Dubai' }] : []) as R[];
    return { rows, rowCount: rows.length };
  },
};

vi.mock('@dtwin/db', () => ({
  withTenant: <T>(_ctx: unknown, fn: (db: Db) => Promise<T>) => fn(serialDb),
}));

const { loadSimContext } = await import('./context.ts');

describe('loadSimContext on one transaction client', () => {
  it('issues its queries one at a time', async () => {
    const ctx = await loadSimContext('00000000-0000-4000-8000-000000000001');

    expect(ctx.timezone).toBe('Asia/Dubai');
    expect(seen.calls).toBe(4);
    expect(seen.maxInFlight).toBe(1);
  });
});
