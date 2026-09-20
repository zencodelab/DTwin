import type { IncomingMessage } from 'node:http';
import { resolveApiKey } from '@dtwin/db';
import { hasScope, type ApiScope, type KeyedLimiter, type Principal } from '@dtwin/types';

/**
 * Request authentication for the ingest service.
 *
 * Two kinds of caller reach this service and neither is a browser session:
 * devices pushing telemetry, and the simulation worker relaying run events.
 * Both present an API key, and the key is what supplies the tenant — a device
 * never names the tenant it is writing into, because a value a caller supplies
 * is a value a caller can change.
 *
 * The dashboard's own reads (`GET /alerts`) come from the web service, which
 * holds the user's session; it presents a ticket on the socket and a key here.
 */

const BEARER = /^Bearer\s+(.+)$/i;

export function extractKey(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const match = BEARER.exec(header);
    if (match) return match[1]!.trim();
  }
  // `x-api-key` as well as Bearer: BMS gateways are not always in a position to
  // set an Authorization header, and refusing them over header style would be
  // a protocol argument with a device that cannot answer back.
  const alt = req.headers['x-api-key'];
  return typeof alt === 'string' && alt.length > 0 ? alt : null;
}

export interface AuthFailure {
  status: 401 | 403 | 429;
  error: string;
  /** Present on 429. */
  retryAfterS?: number;
}

/** Where failures are counted, and against whom. */
export interface FailureBudget {
  limiter: KeyedLimiter;
  address: string;
}

/**
 * Authenticate a request and check it carries the scope the route needs.
 *
 * Returns a discriminated result rather than throwing: an unauthenticated
 * request is an expected condition on a public endpoint, not an exception.
 *
 * 401 and 403 are kept distinct because they tell the operator different
 * things — a wrong key versus a key that is real but not allowed to do this.
 * Neither response says which tenant the key belongs to.
 *
 * With a `budget`, failures are rationed per address — and the check comes
 * BEFORE the lookup, because the lookup is the thing being protected: every
 * key that does not resolve is still a query on a pool the telemetry writer
 * shares. Only failures are charged. A 403 counts as one; it cost the same
 * query, and a key being tried against routes it is not scoped for is not
 * traffic to be generous with.
 */
export async function authenticate(
  req: IncomingMessage,
  scope: ApiScope,
  budget?: FailureBudget,
): Promise<{ ok: true; principal: Principal } | { ok: false; failure: AuthFailure }> {
  if (budget) {
    const allowed = budget.limiter.exhausted(budget.address);
    if (!allowed.ok) {
      return {
        ok: false,
        failure: {
          status: 429,
          error: 'too many failed authentication attempts from this address',
          retryAfterS: allowed.retryAfterS,
        },
      };
    }
  }

  const key = extractKey(req);
  if (!key) {
    // Not charged: no lookup was made, so nothing was spent.
    return { ok: false, failure: { status: 401, error: 'missing API key' } };
  }

  const principal = await resolveApiKey(key);
  if (!principal) {
    budget?.limiter.take(budget.address);
    return { ok: false, failure: { status: 401, error: 'invalid API key' } };
  }

  if (!hasScope(principal, scope)) {
    budget?.limiter.take(budget.address);
    return {
      ok: false,
      failure: { status: 403, error: `key is not scoped for ${scope}` },
    };
  }

  return { ok: true, principal };
}
