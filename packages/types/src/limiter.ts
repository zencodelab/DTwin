/**
 * A keyed token bucket.
 *
 * Every other bound in this system is on the SIZE of one request — rows in a
 * batch, bytes in a body, intervals in a simulation. None of them says anything
 * about how many requests arrive, and a caller who may send 10,000 readings
 * may send 10,000 readings a thousand times a second (decisions.md §54).
 *
 * It lives in this package, beside the contracts, because both the ingest
 * service and the web service need it and it depends on nothing: no clock but
 * the one passed in, no timers, no I/O. A limiter that owns a `setInterval`
 * keeps a process alive after everything else has shut down.
 *
 * A token bucket rather than a fixed window because a window admits twice its
 * limit across a boundary (the last second of one, the first of the next), and
 * rather than a sliding log because a log stores a timestamp per request — the
 * memory an attacker controls is then proportional to their request rate,
 * which is the wrong way round for a defence.
 *
 * State is per process. Behind N replicas the effective limit is N times the
 * configured one. That is acceptable for what these protect — a shared
 * connection pool, a write buffer, a password hash's CPU — all of which are
 * per-process resources too. It would NOT be acceptable for a billing quota.
 */
export interface LimiterOptions {
  /** Tokens added per second. */
  ratePerS: number;
  /** Bucket capacity: the largest burst, and the largest single cost, allowed. */
  burst: number;
  /**
   * Most keys tracked at once. The keys are caller-supplied — an IP, an email
   * someone typed — so the map is exactly as large as a stranger wants it to
   * be unless something says otherwise.
   */
  maxKeys: number;
  now?: () => number;
}

export type LimitResult =
  | { ok: true }
  | { ok: false; retryAfterS: number };

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class KeyedLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #options: Required<LimiterOptions>;
  /**
   * The bucket every newcomer shares once the map is full. A field, not a
   * reserved map key: the keys are caller-supplied strings, and any key this
   * class reserved is a key a caller could type.
   */
  #overflow: Bucket | null = null;
  #refused = 0;
  #overflowed = 0;

  constructor(options: LimiterOptions) {
    if (!(options.ratePerS > 0) || !(options.burst > 0) || !(options.maxKeys > 0)) {
      throw new Error('KeyedLimiter: ratePerS, burst and maxKeys must all be positive');
    }
    this.#options = { now: Date.now, ...options };
  }

  /**
   * Spend `cost` tokens for `key`, or say how long until that would succeed.
   *
   * A cost above `burst` can never succeed, and the answer says so with an
   * infinite wait rather than a number the caller would retry against for
   * ever. Configuration is expected to make that unreachable.
   */
  take(key: string, cost = 1): LimitResult {
    const { burst, ratePerS } = this.#options;
    const bucket = this.#bucket(key);

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { ok: true };
    }

    this.#refused += 1;
    return {
      ok: false,
      retryAfterS: cost > burst ? Infinity : Math.ceil((cost - bucket.tokens) / ratePerS),
    };
  }

  /**
   * Whether `key` is currently out of tokens, without spending one.
   *
   * For limiting FAILURES rather than requests: the check happens before the
   * expensive step, the charge only when that step fails, so a caller who
   * keeps succeeding is never slowed by the limiter that exists for the
   * callers who do not.
   */
  exhausted(key: string, cost = 1): LimitResult {
    const held = this.#buckets.get(key);
    if (!held) return { ok: true };
    const bucket = this.#refill(held);
    if (bucket.tokens >= cost) return { ok: true };
    this.#refused += 1;
    return { ok: false, retryAfterS: Math.ceil((cost - bucket.tokens) / this.#options.ratePerS) };
  }

  get stats(): { keys: number; refused: number; overflowed: number } {
    return { keys: this.#buckets.size, refused: this.#refused, overflowed: this.#overflowed };
  }

  #refill(bucket: Bucket): Bucket {
    const now = this.#options.now();
    const elapsedS = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(this.#options.burst, bucket.tokens + elapsedS * this.#options.ratePerS);
    bucket.updatedAt = now;
    return bucket;
  }

  #bucket(key: string): Bucket {
    const held = this.#buckets.get(key);
    if (held) return this.#refill(held);

    if (this.#buckets.size >= this.#options.maxKeys) this.#sweep();

    // Still full after a sweep: every tracked key is mid-burst, which is what
    // an attack rotating its key looks like. New keys then SHARE one bucket.
    // Forgetting an old key instead would hand its owner a fresh burst, so the
    // way to defeat the limiter would be to fill it; refusing new keys outright
    // would let a stranger lock everyone else out. Sharing degrades the
    // newcomers together and leaves the keys already tracked untouched.
    if (this.#buckets.size >= this.#options.maxKeys) {
      this.#overflowed += 1;
      this.#overflow ??= { tokens: this.#options.burst, updatedAt: this.#options.now() };
      return this.#refill(this.#overflow);
    }

    const created = { tokens: this.#options.burst, updatedAt: this.#options.now() };
    this.#buckets.set(key, created);
    return created;
  }

  /**
   * Drop every bucket that has refilled completely.
   *
   * A full bucket and an absent one behave identically, so this loses nothing —
   * which is what lets it run inline, on the request that found the map full,
   * instead of on a timer.
   */
  #sweep(): void {
    for (const [key, bucket] of this.#buckets) {
      if (this.#refill(bucket).tokens >= this.#options.burst) this.#buckets.delete(key);
    }
  }
}

/**
 * The address to hold a failure against.
 *
 * `X-Forwarded-For` is a header, and a header is whatever the caller typed.
 * Reading its FIRST entry — the usual mistake — lets a stranger choose the
 * address their failures are charged to, which both defeats the limit and lets
 * them spend someone else's. Only the entries appended by proxies we operate
 * are trustworthy, and those are the LAST `trustedHops` of the list; the client
 * is the entry just before them.
 *
 * With no trusted proxy (the default) the header is ignored entirely.
 */
export function clientAddress(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustedHops: number,
): string {
  const fallback = remoteAddress ?? 'unknown';
  if (trustedHops <= 0 || forwardedFor === undefined) return fallback;

  const entries = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor)
    .split(',').map((e) => e.trim()).filter((e) => e.length > 0);

  // Fewer entries than hops means the request did not come through the proxies
  // we were told about, so nothing in the header can be believed.
  return entries.length >= trustedHops ? entries[entries.length - trustedHops]! : fallback;
}
