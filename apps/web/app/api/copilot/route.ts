import { NextResponse } from 'next/server';
import { mayCommand } from '@dtwin/types';
import { z } from 'zod';
import { currentTenant, currentViewer, unauthorized } from '@/lib/tenant';
import { realBackend } from '@/lib/copilot/backend';
import {
  buildCopilotGraph, decide, hasModelCredential, realModelCaller, sendMessage,
  type CopilotGraph,
} from '@/lib/copilot/graph';

export const dynamic = 'force-dynamic';

const MODEL = process.env.COPILOT_MODEL ?? 'claude-opus-5';

/**
 * The copilot, one graph per signed-in user.
 *
 * Per user rather than per process because the backend the graph holds is
 * bound to an acting user — every dry run and every issue carries that
 * person's `x-acting-user`, and ingest looks their role up in the database.
 * The copilot therefore has exactly the authority of whoever is typing, and
 * not one setpoint more (docs/decisions.md §63).
 *
 * The checkpointer is in memory. A suspended plan survives across HTTP
 * requests — approval arrives on a later call than the proposal — but not
 * across a restart of this process, and not across replicas. That is the
 * honest limit of this version; a Postgres checkpointer is the next step.
 */
const graphs = new Map<string, CopilotGraph>();
const MAX_GRAPHS = 200;

function graphFor(tenantId: string, userId: string): CopilotGraph {
  const key = `${tenantId}:${userId}`;
  let graph = graphs.get(key);
  if (!graph) {
    if (graphs.size >= MAX_GRAPHS) {
      // Oldest first. A map iterates in insertion order.
      const oldest = graphs.keys().next().value;
      if (oldest !== undefined) graphs.delete(oldest);
    }
    graph = buildCopilotGraph({
      backend: realBackend(tenantId, userId),
      callModel: realModelCaller(),
      model: MODEL,
    });
    graphs.set(key, graph);
  }
  return graph;
}

const Request = z.union([
  z.object({ threadId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), message: z.string().trim().min(1).max(2_000) }),
  z.object({ threadId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), decision: z.enum(['approved', 'declined']) }),
]);

/**
 * A real person, not merely a tenant: a plan is approved BY someone, and the
 * commands it issues are recorded against them. The demo session has a tenant
 * and nobody to record, and is told so; a request with no session at all gets
 * the plain 401 every route gives.
 */
async function requireViewer() {
  const viewer = await currentViewer();
  if (viewer) return { viewer };
  const tenant = await currentTenant();
  if (!tenant) return { response: unauthorized() };
  return {
    response: NextResponse.json({
      error: 'Sign in to use the copilot — the commands it proposes are recorded against a person, '
        + 'and the demo session is not one.',
    }, { status: 403 }),
  };
}

export async function POST(request: globalThis.Request) {
  const gate = await requireViewer();
  if (!gate.viewer) return gate.response;
  const { viewer } = gate;
  if (!mayCommand(viewer.role)) {
    return NextResponse.json(
      { error: `role '${viewer.role}' may not issue control commands, so it may not ask the copilot to` },
      { status: 403 });
  }
  if (!hasModelCredential()) {
    // Said plainly, like a missing email transport. A copilot that looked
    // wired and was not would be worse than one that says it is not.
    return NextResponse.json({
      error: 'The copilot has no model credential. Set ANTHROPIC_API_KEY for the web service and restart it.',
    }, { status: 503 });
  }

  let parsed;
  try {
    parsed = Request.safeParse(await request.json());
  } catch {
    return NextResponse.json({ error: 'malformed request body' }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: 'threadId and either message or decision are required' }, { status: 400 });
  }

  const graph = graphFor(viewer.tenantId, viewer.userId);
  // Threads are namespaced by the person, so one user cannot resume — and
  // approve — another's suspended plan by guessing a thread id.
  const threadId = `${viewer.userId}:${parsed.data.threadId}`;

  try {
    const turn = 'message' in parsed.data
      ? await sendMessage(graph, threadId, parsed.data.message)
      : await decide(graph, threadId, parsed.data.decision);
    return NextResponse.json(turn);
  } catch (err) {
    // The model's error message can name the API key's prefix or a request
    // id; neither belongs to the browser. Log server-side, say little.
    console.error('[copilot] turn failed', err);
    return NextResponse.json({ error: 'the copilot could not complete this turn' }, { status: 502 });
  }
}

export async function GET() {
  const gate = await requireViewer();
  if (!gate.viewer) return gate.response;
  const { viewer } = gate;
  return NextResponse.json({
    available: hasModelCredential() && mayCommand(viewer.role),
    model: MODEL,
    reason: !hasModelCredential()
      ? 'no model credential (ANTHROPIC_API_KEY)'
      : !mayCommand(viewer.role) ? `role '${viewer.role}' may not command` : null,
  });
}
