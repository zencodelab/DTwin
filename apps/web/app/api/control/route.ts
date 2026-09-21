import { NextResponse } from 'next/server';
import { SetpointCommandRequest } from '@dtwin/types';
import { currentTenant, unauthorized } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * The demo session can look at everything and command nothing.
 *
 * `DTWIN_ALLOW_DEMO_TENANT` produces a tenant with no user behind it, which is
 * fine for reading a building and impossible for writing to one: every command
 * carries `requested_by` as a foreign key to `users`, because a control action
 * nobody is accountable for is not a control action anyone should accept.
 * Signing in is the remedy, and saying so is more use than a bare 401.
 */
function notAttributable() {
  return NextResponse.json({
    error: 'Sign in to issue control commands — a command is recorded against a person, '
      + 'and the demo session is not one.',
  }, { status: 403 });
}

const INGEST_BASE = process.env.INGEST_BASE_URL ?? 'http://localhost:8787';

/**
 * Operator control, proxied to ingest.
 *
 * Read straight from ingest rather than from the database, unlike the alert
 * list: the safety envelope lives there and is evaluated against live state
 * that this service does not hold — equipment status, the freshness of the
 * zone's own sensor, what is already in flight. A second implementation here
 * would be a second envelope, and the two would diverge on the day it
 * mattered (docs/decisions.md §62).
 *
 * Three facts travel separately and cannot all be forged by one party: the API
 * key says this SERVICE may act for the tenant, `x-acting-user` says WHICH
 * user, and ingest looks that user's ROLE up in the database. The browser
 * supplies none of them — the session cookie is what this route turns into an
 * acting user, and a page cannot choose who it is.
 */
function proxyHeaders(userId: string): Record<string, string> {
  const key = process.env.SIM_API_KEY;
  return {
    'content-type': 'application/json',
    'x-acting-user': userId,
    ...(key ? { authorization: `Bearer ${key}` } : {}),
  };
}

/** The tenant's envelope and recent commands, for the operator panel. */
export async function GET() {
  const ctx = await currentTenant();
  if (!ctx) return unauthorized();
  if (!ctx.userId) return notAttributable();

  try {
    const headers = proxyHeaders(ctx.userId);
    const [settingsRes, commandsRes] = await Promise.all([
      fetch(`${INGEST_BASE}/control/settings`, { headers, cache: 'no-store' }),
      fetch(`${INGEST_BASE}/control/commands`, { headers, cache: 'no-store' }),
    ]);
    if (!settingsRes.ok || !commandsRes.ok) {
      return NextResponse.json(
        { error: `ingest refused: ${settingsRes.status}/${commandsRes.status}` },
        { status: 502 },
      );
    }
    return NextResponse.json({
      settings: await settingsRes.json(),
      ...(await commandsRes.json()),
    });
  } catch (err) {
    // A control panel that cannot reach ingest must say so rather than render
    // as "no commands", which reads as a healthy, quiet building.
    return NextResponse.json(
      { error: `control service unreachable: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  const ctx = await currentTenant();
  if (!ctx) return unauthorized();
  if (!ctx.userId) return notAttributable();

  let parsed;
  try {
    parsed = SetpointCommandRequest.safeParse(await request.json());
  } catch {
    return NextResponse.json({ error: 'malformed request body' }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({
      error: 'invalid command',
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    }, { status: 400 });
  }

  try {
    const response = await fetch(`${INGEST_BASE}/control/commands`, {
      method: 'POST',
      headers: proxyHeaders(ctx.userId),
      body: JSON.stringify(parsed.data),
    });
    // The refusal is passed through verbatim, status and all. Every one of
    // them names a rule an operator can act on, and flattening them into a
    // generic 400 here would throw that away.
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (err) {
    return NextResponse.json(
      { error: `control service unreachable: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}
