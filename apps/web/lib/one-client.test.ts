import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@dtwin/db';

/**
 * Route handlers that read several things inside one `withTenant` transaction
 * must issue them one at a time. The transaction's client runs one statement
 * at a time anyway; firing several with Promise.all only worked through pg's
 * internal queue, which is deprecated and removed in pg 9.
 *
 * The client here counts how many of its queries are in flight at once. Each
 * one yields to the event loop before answering, so a handler that starts a
 * second query without awaiting the first is caught with two in flight.
 */
const seen = { calls: 0, maxInFlight: 0 };
let inFlight = 0;
const serialDb: Db = {
  async query<R>() {
    inFlight += 1;
    seen.calls += 1;
    seen.maxInFlight = Math.max(seen.maxInFlight, inFlight);
    await new Promise((resolve) => { setTimeout(resolve, 1); });
    inFlight -= 1;
    return { rows: [] as R[], rowCount: 0 };
  },
};

vi.mock('@dtwin/db', () => ({
  withTenant: <T>(_ctx: unknown, fn: (db: Db) => Promise<T>) => fn(serialDb),
}));
vi.mock('@/lib/tenant', () => ({
  currentTenant: async () => ({ tenantId: '00000000-0000-4000-8000-000000000001' }),
  unauthorized: () => new Response(null, { status: 401 }),
}));

const BUILDING = '00000000-0000-4000-8000-0000000000b1';
const ZONE = '00000000-0000-4000-8000-000000000301';

beforeEach(() => {
  seen.calls = 0;
  seen.maxInFlight = 0;
  inFlight = 0;
});

describe('reads that share one transaction client', () => {
  it('GET /api/heatmap issues its queries one at a time', async () => {
    const { GET } = await import('@/app/api/heatmap/route');
    const res = await GET(new Request(`http://test/api/heatmap?buildingId=${BUILDING}`));

    expect(res.status).toBe(200);
    expect(seen.calls).toBe(2);
    expect(seen.maxInFlight).toBe(1);
  });

  it('GET /api/zones/[id] issues its queries one at a time', async () => {
    const { GET } = await import('@/app/api/zones/[id]/route');
    const res = await GET(new Request(`http://test/api/zones/${ZONE}`),
      { params: Promise.resolve({ id: ZONE }) });

    expect(res.status).toBe(200);
    expect(seen.calls).toBe(4);
    expect(seen.maxInFlight).toBe(1);
  });
});
