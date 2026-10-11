import { describe, expect, it } from 'vitest';
import type { Db } from '../client.ts';
import { getSpatialTree } from './spatial.ts';

/**
 * A client that counts how many of its queries are in flight at once.
 *
 * A real transaction client runs one statement at a time; issuing a second
 * before the first has settled only works because pg queues it internally,
 * and pg 9 removes that queue. Each query yields to the event loop before it
 * answers, so a caller that fires several without awaiting each one is caught
 * with more than one in flight.
 */
function serialDb(answer: (text: string) => unknown[] = () => []) {
  const seen = { calls: 0, maxInFlight: 0 };
  let inFlight = 0;
  const db: Db = {
    async query<R>(text: string) {
      inFlight += 1;
      seen.calls += 1;
      seen.maxInFlight = Math.max(seen.maxInFlight, inFlight);
      await new Promise((resolve) => { setTimeout(resolve, 1); });
      inFlight -= 1;
      const rows = answer(text) as R[];
      return { rows, rowCount: rows.length };
    },
  };
  return { db, seen };
}

describe('getSpatialTree on one transaction client', () => {
  it('issues its queries one at a time', async () => {
    const { db, seen } = serialDb((text) =>
      /FROM buildings/.test(text) ? [{ id: 'b1', name: 'Building' }] : []);

    const tree = await getSpatialTree(db, 'b1');

    expect(tree).not.toBeNull();
    expect(seen.calls).toBe(6);            // the building, then its five collections
    expect(seen.maxInFlight).toBe(1);
  });
});
