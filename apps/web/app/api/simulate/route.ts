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
    // `.ok` is checked before `.json()`. Without it a worker 404 or 500 parsed
    // into an object with no `status`, the client saw a run that was not
    // finished, and it polled for the full sixty seconds before reporting "run
    // did not finish in time" — describing a timeout that had not happened.
    const runRes = await fetch(`${SIM_BASE}/runs/${runId}`, { headers });
    if (!runRes.ok) {
      return NextResponse.json(
        { error: `simulation worker returned ${runRes.status} for this run` },
        { status: runRes.status === 404 ? 404 : 502 },
      );
    }
    const run = await runRes.json();
    if (run.status !== 'completed') return NextResponse.json({ run });

    const summaryRes = await fetch(`${SIM_BASE}/runs/${runId}/summary`, { headers });
    if (!summaryRes.ok) {
      return NextResponse.json(
        { error: `summary unavailable (${summaryRes.status})`, run },
        { status: 502 },
      );
    }
    return NextResponse.json(await summaryRes.json());
  } catch (err) {
    return NextResponse.json(
      { error: `simulation worker unreachable: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}
