import { NextResponse } from 'next/server';
import { LoginRequest } from '@dtwin/types';
import { login } from '@dtwin/db/queries';
import { SESSION_COOKIE, cookieOptions } from '@/lib/tenant';
import { addressOf, loginLimits, withVerificationSlot } from '@/lib/login-limits';

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
 *
 * Attempts are rationed (`lib/login-limits.ts`). The 429 is as uninformative as
 * the 401: it is keyed on what was typed, not on whether it matched anyone.
 */
function tooMany(retryAfterS: number, status: 429 | 503 = 429) {
  const seconds = Number.isFinite(retryAfterS) ? Math.max(1, retryAfterS) : 60;
  return NextResponse.json(
    { error: 'Too many sign-in attempts. Try again shortly.', retryAfterS: seconds },
    { status, headers: { 'retry-after': String(seconds) } },
  );
}

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
  const emailKey = email.trim().toLowerCase();
  const address = addressOf(request);

  // Checked before the hash is computed, since the hash is what is rationed.
  const byEmail = loginLimits.perEmail.exhausted(emailKey);
  if (!byEmail.ok) return tooMany(byEmail.retryAfterS);
  if (address) {
    const byAddress = loginLimits.perAddress.exhausted(address);
    if (!byAddress.ok) return tooMany(byAddress.retryAfterS);
  }

  const attempt = await withVerificationSlot(() => login(email, password, tenantSlug));
  // 503, not 429: this caller did nothing wrong, the service is simply at the
  // number of verifications it will run at once.
  if (!attempt.ran) return tooMany(1, 503);

  const result = attempt.value;
  if (!result) {
    loginLimits.perEmail.take(emailKey);
    if (address) loginLimits.perAddress.take(address);
    return NextResponse.json({ error: 'Incorrect email or password.' }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true, tenantId: result.tenantId });
  response.cookies.set(SESSION_COOKIE, result.token, cookieOptions(request, result.expiresAt));
  return response;
}
