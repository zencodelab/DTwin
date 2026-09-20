import { NextResponse } from 'next/server';
import { parseUuid } from '@/lib/params';
import { currentTenant, unauthorized } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * The worker will not act for a tenant on the word of a header alone; it wants
 * a key with the `sim:run` scope beside it. The key says this service may name
 * a tenant, the header says which one — one key serves every tenant, so the
 * two cannot be the same credential.
 *
 * Absent, the worker answers 401 and this route reports it, rather than the
 * request failing somewhere less legible. `npm run bootstrap` prints the value.
 */
function workerAuth(): Record<string, string> {
  const key = process.env.SIM_API_KEY;
  return key ? { authorization: `Bearer ${key}` } : {};
}

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
        ...workerAuth(),
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

  // Validated as a uuid because it is interpolated into the worker's URL path:
  // `?runId=../weather/generate` should be a 400 here, not a request somewhere
  // else on the worker.
  const run = parseUuid(new URL(request.url).searchParams.get('runId'), 'runId');
  if (!run.ok) return run.response;
  const runId = run.value;

  const headers = { 'x-tenant-id': ctx.tenantId, ...workerAuth() };

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
