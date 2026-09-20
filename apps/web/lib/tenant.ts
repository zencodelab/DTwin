import { cache } from 'react';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { resolveSession, type SessionRecord, type TenantContext } from '@dtwin/db';
import type { TenantRole } from '@dtwin/types';

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

/**
 * One session resolution per request, shared by every caller below.
 * `cache` is React's request-scoped memo, not a cross-request cache.
 */
const resolve = cache(async (): Promise<SessionRecord | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return resolveSession(token);
});

/** Resolve the request's tenant, or null if the caller is not authenticated. */
export async function currentTenant(): Promise<TenantContext | null> {
  const session = await resolve();
  if (session) return { tenantId: session.tenantId, userId: session.userId };
  return demoTenant();
}

/**
 * The one 401 every route returns.
 *
 * It was written by hand in seven places, which is seven chances for the shape
 * to drift and for a client to meet two different error bodies for the same
 * condition. One function, one shape.
 *
 * This replaces a `requireTenant()` that threw an `UnauthenticatedError` nobody
 * caught — it had no callers, and its own docstring pointed at an
 * `unauthorized()` that had never been written. A throw is the wrong shape for
 * a route handler anyway: every call site would need a try/catch to turn it
 * back into a response, which is more code than the check it replaced.
 */
export function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
}

/**
 * The signed-in person, when there is one.
 *
 * `currentTenant` answers "whose data" and is satisfied by the demo fallback;
 * this answers "who" and is not — configuration is not a person, so in demo
 * mode it returns null and the header renders a demo badge instead of a name.
 *
 * Wrapped in React's `cache` so a page that wants both the tenant and the
 * viewer resolves the session once per request rather than once per caller.
 */
export interface Viewer {
  tenantId: string;
  userId: string;
  sessionId: string;
  displayName: string;
  email: string;
  role: TenantRole;
}

export async function currentViewer(): Promise<Viewer | null> {
  const s = await resolve();
  return s
    ? {
      tenantId: s.tenantId, userId: s.userId, sessionId: s.sessionId,
      displayName: s.displayName, email: s.email, role: s.role,
    }
    : null;
}

/**
 * Cookie attributes, in one place so the login and logout routes cannot
 * disagree about them — a clear that does not match the set leaves the cookie
 * behind and the user apparently signed in forever.
 *
 * `secure` is derived from the request rather than from NODE_ENV. The two are
 * not the same thing: the Compose stack runs NODE_ENV=production over plain
 * HTTP, and a Secure cookie there would be dropped by any browser that does not
 * treat the host as trustworthy — that is, every host except localhost. Reading
 * the forwarded protocol gets both cases right.
 */
export function cookieOptions(request: Request, expires?: Date) {
  const forwarded = request.headers.get('x-forwarded-proto');
  const proto = forwarded?.split(',')[0]?.trim() ?? new URL(request.url).protocol.replace(':', '');
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: proto === 'https',
    path: '/',
    ...(expires ? { expires } : {}),
  };
}
