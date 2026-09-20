import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { deleteSession } from '@dtwin/db';
import { SESSION_COOKIE, cookieOptions } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * End the session, server-side first.
 *
 * Clearing the cookie alone would leave a live row in `sessions` that anyone
 * holding the token could keep using, so the row goes first and the cookie
 * second. Deleting an unknown token is a no-op, so a double submit is fine.
 *
 * The clear must carry the same attributes as the set — a cookie is identified
 * by name, domain and path, and a mismatch leaves the original in place.
 */
export async function POST(request: Request) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await deleteSession(token);

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, '', { ...cookieOptions(request), maxAge: 0 });
  return response;
}
