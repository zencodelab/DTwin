import { NextResponse } from 'next/server';
import { signWsTicket } from '@dtwin/db';
import { currentTenant, unauthorized } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * Mint a short-lived ticket for the ingest WebSocket.
 *
 * The browser cannot present the session cookie to ingest — it is a different
 * origin and a different service — and it must not hold anything longer-lived
 * than the connection it is about to open. So the web service, which is the
 * only thing that authenticates a person, signs a ticket naming the tenant, and
 * ingest verifies the signature without a database round trip on every connect.
 *
 * 60 seconds is deliberately shorter than any session: the ticket is spent
 * immediately on the socket's first frame, so its whole life is one handshake.
 * A leaked ticket is a minute of read access to one tenant's topics, not a
 * session.
 */
export async function GET() {
  const ctx = await currentTenant();
  if (!ctx) return unauthorized();

  const ticket = signWsTicket({
    tenantId: ctx.tenantId,
    // A device key has no user; a browser session always does. The demo
    // fallback has none either, and ingest only reads `tenantId` for topic
    // authorisation, so the empty string is honest rather than invented.
    userId: ctx.userId ?? '',
  });

  // Never cached: it is a credential, and a minute-old one is nearly expired.
  return NextResponse.json({ ticket }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
