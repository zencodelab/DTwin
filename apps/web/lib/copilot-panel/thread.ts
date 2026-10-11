/**
 * Which copilot conversation this tab is in (design §9.4 "Lifetime").
 *
 * The thread id lives in sessionStorage, so a reload comes back to the same
 * conversation — and to a plan still awaiting a decision — while a new tab
 * starts its own. Every access is guarded: the storage can be missing (the
 * server render), refused (a privacy mode throws SecurityError on the mere
 * property read) or full, and none of those may stop the panel working. The
 * worst case is a thread that does not survive a reload, which is what v1
 * always had.
 */

export const THREAD_KEY = 'dtwin.copilot.threadId';

/** The route's own rule for a thread id. */
export const THREAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A getter, not the object: reading `window.sessionStorage` is itself what throws. */
export type StorageSource = () => Pick<Storage, 'getItem' | 'setItem'> | null | undefined;

/**
 * A fresh id: 32 hex characters. `crypto.getRandomValues`, not
 * `randomUUID` — the second exists only on a secure origin, and Compose
 * serves the dashboard over plain HTTP.
 */
export function newThreadId(fill: (bytes: Uint8Array) => void = defaultFill): string {
  const bytes = new Uint8Array(16);
  fill(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function defaultFill(bytes: Uint8Array): void {
  try {
    globalThis.crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
}

export function loadThreadId(source: StorageSource): string | null {
  try {
    const value = source()?.getItem(THREAD_KEY) ?? null;
    return value !== null && THREAD_ID_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** False if it could not be kept; the id still works for this page's life. */
export function saveThreadId(source: StorageSource, id: string): boolean {
  try {
    const storage = source();
    if (!storage) return false;
    storage.setItem(THREAD_KEY, id);
    return true;
  } catch {
    return false;
  }
}

/** The stored thread, or a new one (kept if it can be). */
export function currentThreadId(source: StorageSource, fill?: (bytes: Uint8Array) => void): string {
  const stored = loadThreadId(source);
  if (stored) return stored;
  const id = newThreadId(fill);
  saveThreadId(source, id);
  return id;
}

/** The browser's sessionStorage, or null where there is none. For `StorageSource`. */
export const browserSessionStorage: StorageSource = () =>
  (typeof window === 'undefined' ? null : window.sessionStorage);
