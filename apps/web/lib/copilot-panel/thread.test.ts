import { describe, expect, it } from 'vitest';
import {
  THREAD_ID_RE, THREAD_KEY, currentThreadId, loadThreadId, newThreadId, saveThreadId, type StorageSource,
} from './thread.ts';

/**
 * The thread id survives a reload through sessionStorage, and nothing the
 * storage can do — be absent, throw on access, throw on write, hold junk —
 * stops the panel getting a usable id.
 */

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { data, source: (() => ({ getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } })) as StorageSource };
}

const throwing: StorageSource = () => { throw new DOMException('denied', 'SecurityError'); };
const readOnly: StorageSource = () => ({ getItem: () => null, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } });

describe('copilot thread id', () => {
  it('a new id is 32 hex characters and passes the route\'s rule', () => {
    const id = newThreadId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(THREAD_ID_RE.test(id)).toBe(true);
    expect(newThreadId((b) => b.fill(255))).toBe('f'.repeat(32));
    expect(newThreadId()).not.toBe(id);
  });

  it('is kept and read back', () => {
    const m = memory();
    const id = currentThreadId(m.source);
    expect(m.data.get(THREAD_KEY)).toBe(id);
    expect(currentThreadId(m.source)).toBe(id);
  });

  it('a stored value the route would refuse is replaced, not sent', () => {
    const m = memory({ [THREAD_KEY]: 'has spaces and; semicolons' });
    expect(loadThreadId(m.source)).toBeNull();
    const id = currentThreadId(m.source, (b) => b.fill(1));
    expect(id).toBe('01'.repeat(16));
    expect(m.data.get(THREAD_KEY)).toBe(id);
  });

  it('storage that throws on access, throws on write, or is absent still yields an id', () => {
    expect(loadThreadId(throwing)).toBeNull();
    expect(saveThreadId(throwing, 'abc')).toBe(false);
    expect(currentThreadId(throwing)).toMatch(/^[0-9a-f]{32}$/);
    expect(saveThreadId(readOnly, 'abc')).toBe(false);
    expect(currentThreadId(readOnly)).toMatch(/^[0-9a-f]{32}$/);
    expect(currentThreadId(() => null)).toMatch(/^[0-9a-f]{32}$/);
    expect(saveThreadId(() => undefined, 'abc')).toBe(false);
  });
});
