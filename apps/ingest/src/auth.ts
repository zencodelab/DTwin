import type { IncomingMessage } from 'node:http';
import { resolveApiKey } from '@dtwin/db';
import { hasScope, type ApiScope, type Principal } from '@dtwin/types';

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
  status: 401 | 403;
  error: string;
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
 */
export async function authenticate(
  req: IncomingMessage,
  scope: ApiScope,
): Promise<{ ok: true; principal: Principal } | { ok: false; failure: AuthFailure }> {
  const key = extractKey(req);
  if (!key) {
    return { ok: false, failure: { status: 401, error: 'missing API key' } };
  }

  const principal = await resolveApiKey(key);
  if (!principal) {
    return { ok: false, failure: { status: 401, error: 'invalid API key' } };
  }

  if (!hasScope(principal, scope)) {
    return {
      ok: false,
      failure: { status: 403, error: `key is not scoped for ${scope}` },
    };
  }

  return { ok: true, principal };
}
