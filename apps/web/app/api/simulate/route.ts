import { NextResponse } from 'next/server';
import { currentTenant, unauthorized } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

const SIM_BASE = process.env.SIM_BASE_URL ?? 'http://localhost:8000';

/**
 * Proxy to the Python worker.
 *
 * The browser never talks to the simulation service directly: it is an internal
 * service with no CORS story and no business being reachable from a public
 * origin. This route is where auth attaches — it is the only place that holds
 * the user's session, so it is the only place that can tell the worker which
 * tenant it is computing for. The header is set from the session, never copied
 * out of the request body.
 */
export async function POST(request: Request) {
  const ctx = await currentTenant();
  if (!ctx) return unauthorized();

  const body = await request.json();
  try {
    const response = await fetch(`${SIM_BASE}/simulate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': ctx.tenantId,
      },
      body: JSON.stringify(body),
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (err) {
    return NextResponse.json(
      { error: `simulation worker unreachable at ${SIM_BASE}: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}

export async function GET(request: Request) {
  const ctx = await currentTenant();
  if (!ctx) return unauthorized();

  const runId = new URL(request.url).searchParams.get('runId');
  if (!runId) return NextResponse.json({ error: 'runId is required' }, { status: 400 });

  const headers = { 'x-tenant-id': ctx.tenantId };

  try {
    const run = await (await fetch(`${SIM_BASE}/runs/${runId}`, { headers })).json();
    if (run.status !== 'completed') return NextResponse.json({ run });

    const summary = await (
      await fetch(`${SIM_BASE}/runs/${runId}/summary`, { headers })
    ).json();
    return NextResponse.json(summary);
  } catch (err) {
    return NextResponse.json(
      { error: `simulation worker unreachable: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}
