import { KeyedLimiter, clientAddress } from '@dtwin/types';

/**
 * What the login route rations, and why there are three of them
 * (docs/decisions.md §54).
 *
 * A password check here is scrypt at N=2^15: about 100 ms of CPU and 32 MB of
 * memory, by design, and `login()` runs it whether or not the address exists so
 * that timing reveals nothing. That is the right trade for a stored hash and it
 * makes the unauthenticated login form the most expensive thing a stranger can
 * ask this service to do.
 *
 *   inFlight    a CEILING, not a rate. Fifty simultaneous attempts are 1.6 GB
 *               however slowly they arrived. THREE, not four: libuv runs scrypt
 *               on a four-thread pool that it also uses to resolve hostnames
 *               and read files, so four hashes at once leave nothing for
 *               opening a database connection. That was measured, not
 *               supposed — the db smoke suite's pool went from 54% idle to 98%
 *               once connections no longer had to be opened behind hashes.
 *   perEmail    password guessing against one account, from any number of
 *               addresses. Keyed on the address AS TYPED, never on whether a
 *               user exists — so a 429 says nothing a 401 did not, and the
 *               limiter cannot become the enumeration oracle `login()` was
 *               written not to be.
 *   perAddress  one source trying many accounts. Only when a proxy we operate
 *               tells us the address; see `addressOf`.
 *
 * Only FAILURES are charged. Someone who signs in correctly is never slowed by
 * a limit that exists for people who cannot.
 *
 * The cost, stated plainly: `perEmail` lets anyone who knows an address slow
 * its owner's sign-in by failing on purpose. The bucket refills one attempt a
 * minute, so the owner is delayed, not locked out — a hard lockout would turn
 * the same defence into a way to deny service to a named person.
 */
const MAX_KEYS = 10_000;

function numberFrom(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const loginLimits = {
  perEmail: new KeyedLimiter({
    ratePerS: numberFrom('LOGIN_RATE_PER_EMAIL_PER_MIN', 1) / 60,
    burst: numberFrom('LOGIN_RATE_PER_EMAIL_BURST', 10),
    maxKeys: MAX_KEYS,
  }),
  perAddress: new KeyedLimiter({
    ratePerS: numberFrom('LOGIN_RATE_PER_ADDRESS_PER_MIN', 6) / 60,
    burst: numberFrom('LOGIN_RATE_PER_ADDRESS_BURST', 30),
    maxKeys: MAX_KEYS,
  }),
};

const MAX_IN_FLIGHT = numberFrom('LOGIN_MAX_IN_FLIGHT', 3);
let inFlight = 0;

/** Run `work` if a verification slot is free; null when none is. */
export async function withVerificationSlot<T>(work: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  if (inFlight >= MAX_IN_FLIGHT) return { ran: false };
  inFlight += 1;
  try {
    return { ran: true, value: await work() };
  } finally {
    inFlight -= 1;
  }
}

/**
 * The caller's address, or null when nothing trustworthy says what it is.
 *
 * A route handler has no socket. All it sees is `X-Forwarded-For`, which Next
 * fills from the socket only when the header is ABSENT — so with no proxy in
 * front, a caller who sends the header chooses their own address, and a limit
 * keyed on it is a limit they can step around by changing a string. Rather than
 * pretend, the address limit is simply off until `WEB_TRUSTED_PROXY_HOPS` says a
 * proxy we run is appending the real one. The other two limits do not depend
 * on it.
 */
export function addressOf(request: Request): string | null {
  const hops = Math.floor(numberFrom('WEB_TRUSTED_PROXY_HOPS', 0));
  if (hops <= 0) return null;
  const resolved = clientAddress(undefined, request.headers.get('x-forwarded-for') ?? undefined, hops);
  return resolved === 'unknown' ? null : resolved;
}
