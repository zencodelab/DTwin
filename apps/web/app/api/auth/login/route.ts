import { NextResponse } from 'next/server';
import { LoginRequest } from '@dtwin/types';
import { login } from '@dtwin/db/queries';
import { SESSION_COOKIE, cookieOptions } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * Exchange an email and password for a session cookie.
 *
 * All the work is in `login()` — it verifies against a dummy hash when no user
 * matched so the timing does not reveal whether an address exists, and returns
 * null identically for a bad address, a bad password, an inactive user and a
 * suspended tenant. This route must not undo that: there is exactly one failure
 * message and one status code on the way out, because a form that distinguishes
 * "no such user" from "wrong password" is an account-enumeration oracle with a
 * friendly tone.
 *
 * The token is never handed to JavaScript. It goes straight into an HttpOnly
 * cookie, which is also why ingest gets a separate short-lived signed ticket
 * rather than this value — the page cannot read this one to forward it.
 */
export async function POST(request: Request) {
  let parsed;
  try {
    parsed = LoginRequest.safeParse(await request.json());
  } catch {
    return NextResponse.json({ error: 'malformed request body' }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: 'email and password are required' }, { status: 400 });
  }

  const { email, password, tenantSlug } = parsed.data;
  const result = await login(email, password, tenantSlug);
  if (!result) {
    return NextResponse.json({ error: 'Incorrect email or password.' }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true, tenantId: result.tenantId });
  response.cookies.set(SESSION_COOKIE, result.token, cookieOptions(request, result.expiresAt));
  return response;
}
