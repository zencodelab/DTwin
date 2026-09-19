import { cookies } from 'next/headers';
import { resolveSession, type TenantContext } from '@dtwin/db';

/**
 * Who the dashboard is rendering for.
 *
 * The web service is the one place in the system that authenticates a *person*.
 * Devices and the simulation worker present API keys to ingest; a browser
 * presents this cookie here, and the tenant comes out of the session row rather
 * than out of the request. A `?tenantId=` parameter would be a value the caller
 * can change, which is the whole failure mode row-level security exists to stop.
 *
 * Every read in `app/` goes through the context this returns, into
 * `withTenant`. There is no unscoped query path in the web app — under RLS an
 * unscoped connection sees no tenant rows at all, so a missed call site fails
 * as an empty dashboard rather than as a cross-tenant leak.
 */

export const SESSION_COOKIE = 'dtwin_session';

/**
 * The seeded single-tenant demo has no login screen yet, so a tenant id may be
 * supplied by configuration instead.
 *
 * This **fails closed in production**: the fallback is ignored unless
 * `NODE_ENV` is not `production`, so a demo convenience cannot become the way
 * a deployment authenticates. A default that works everywhere is a default
 * that ships, which is the same reason `AUTH_SECRET` has no fallback value.
 */
function demoTenant(): TenantContext | null {
  if (process.env.NODE_ENV === 'production') return null;
  const tenantId = process.env.DTWIN_DEMO_TENANT_ID;
  return tenantId ? { tenantId } : null;
}

/** Resolve the request's tenant, or null if the caller is not authenticated. */
export async function currentTenant(): Promise<TenantContext | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;

  if (token) {
    const session = await resolveSession(token);
    if (session) {
      return { tenantId: session.tenantId, userId: session.userId };
    }
  }

  return demoTenant();
}

/**
 * Resolve the tenant or throw.
 *
 * For API routes, where the alternative is returning data from no tenant at
 * all. Callers turn this into a 401; see `unauthorized()` below.
 */
export async function requireTenant(): Promise<TenantContext> {
  const ctx = await currentTenant();
  if (!ctx) throw new UnauthenticatedError();
  return ctx;
}

export class UnauthenticatedError extends Error {
  constructor() {
    super('no session');
    this.name = 'UnauthenticatedError';
  }
}
