import { describe, expect, it } from 'vitest';
import { GRAPHS_BUSY_RETRY_AFTER_S, GraphCache, GraphsBusy } from './graph-cache.ts';
import { readBoundedText } from './http.ts';

/**
 * The route's per-person graphs (review, ADR 64). The Map it replaced evicted
 * by creation order and ignored what a graph was doing: the person who had
 * used the copilot longest lost it first, an approval mid-`apply` lost its
 * thread, and the next request on that thread built a second graph with a
 * second lock.
 */

interface G { name: string; busy: boolean }

function cache(max: number) {
  const built: string[] = [];
  const graphs = new GraphCache<G>({ max, busy: (g) => g.busy });
  const get = (name: string) => graphs.getOrBuild(name, () => { built.push(name); return { name, busy: false }; });
  return { graphs, get, built };
}

describe('GraphCache', () => {
  it('evicts the least recently USED graph, not the first one built', () => {
    const { graphs, get, built } = cache(2);
    get('a');
    get('b');
    expect(graphs.get('a')?.name).toBe('a');   // a is used again: b is now the oldest
    get('c');
    expect(graphs.get('a')).toBeDefined();
    expect(graphs.get('b')).toBeUndefined();
    expect(built).toEqual(['a', 'b', 'c']);
  });

  it('never evicts a busy graph: it passes over it to the next', () => {
    const { graphs, get } = cache(2);
    get('a').busy = true;   // an approval mid-apply, say
    get('b');
    get('c');
    expect(graphs.get('a')?.busy).toBe(true);
    expect(graphs.get('b')).toBeUndefined();
  });

  it('refuses a new person when every graph is busy, rather than drop someone\'s work', () => {
    const { graphs, get, built } = cache(2);
    get('a').busy = true;
    get('b').busy = true;
    let refused: unknown = null;
    try {
      get('c');
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(GraphsBusy);
    expect((refused as GraphsBusy).retryAfterS).toBe(GRAPHS_BUSY_RETRY_AFTER_S);
    expect(built).toEqual(['a', 'b']);
    expect(graphs.size).toBe(2);
    // Someone already held is still served.
    expect(get('a').name).toBe('a');
  });
});

describe('readBoundedText', () => {
  const req = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request('http://localhost/api/copilot', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);

  it('reads a body within the bound', async () => {
    expect(await readBoundedText(req('{"a":1}'), 16)).toBe('{"a":1}');
  });

  it('refuses a declared length over the bound without reading it', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { pulled += 1; c.enqueue(new Uint8Array(8)); c.close(); },
    }, { highWaterMark: 0 });   // pulled only when read
    expect(await readBoundedText(req(body, { 'content-length': '100000' }), 16)).toBeNull();
    expect(pulled).toBe(0);
  });

  it('stops reading a chunked body the moment it passes the bound', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(new Uint8Array(10));
        if (pulled > 1000) c.close();
      },
    });
    expect(await readBoundedText(req(body), 25)).toBeNull();
    expect(pulled).toBeLessThan(10);
  });
});
