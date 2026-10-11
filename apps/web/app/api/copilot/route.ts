import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { mayCommand } from '@dtwin/types';
import { z } from 'zod';
import { currentTenant, currentViewer, unauthorized } from '@/lib/tenant';
import { log } from '@/lib/log';
import { realIssuer, realProbe, realReader } from '@/lib/copilot/backend';
import {
  buildCopilotGraph, copilotControls, hasModelCredential, realModelCaller, resolveModels, type CopilotGraph,
} from '@/lib/copilot/graph';
import { GraphCache, GraphsBusy } from '@/lib/copilot/graph-cache';
import { readBoundedText } from '@/lib/copilot/http';
import { DEFAULT_LIMITS } from '@/lib/copilot/limits';
import type { CopilotEvent, CopilotTurn } from '@/lib/copilot/protocol';
import {
  DecisionRequest, LockConflict, NoPendingPlan, PlanExpired, TurnFailed, graphBusy, lockThread, pendingDecision,
  rehydrate, runTurn, stop, turnFromState, type ThreadLock, type TurnInput,
} from '@/lib/copilot/session';
import { realScenarioRunner } from '@/lib/copilot/sim-runner';

export const dynamic = 'force-dynamic';

const MODELS = resolveModels();

/**
 * The copilot, one graph per signed-in user (docs/decisions.md §63, §64).
 *
 * EVERY GATE BEFORE ANY BYTE, in this order: session (401), demo session
 * (403), `mayCommand` (403, for the whole copilot), model credential (503),
 * body size (413, read to `maxRequestBodyBytes` and no further), body (400);
 * then Stop answers 202 without the lock and without building a graph; then
 * the person's graph (503 + Retry-After when one would have to be evicted and
 * every graph is busy); then the thread's lock (409 + Retry-After) and, for a
 * decision, the pending-plan check (409 "nothing awaiting approval" /
 * "plan_expired"). A refused request is always a plain JSON error with its
 * status — never a 200 stream that then says no — whatever its Accept header
 * asked for.
 *
 * Then ONE runner, `runTurn` in session.ts, answers in either form:
 *
 * - `Accept: application/x-ndjson`: a stream of protocol events, one JSON
 *   line each, with a ping every `pingIntervalS` so a proxy does not close
 *   an idle connection mid-run. A reader that goes away does NOT stop the
 *   run: it finishes within its bounds and checkpoints, and `GET ?threadId`
 *   shows how it ended. The thread's lock is therefore released when the RUN
 *   settles, not when the Response is handed back — a second request while
 *   the first still runs is a 409, however the first one's client is doing.
 * - otherwise: the finished `CopilotTurn` as JSON.
 *
 * A run that fails after the stream opened ends in the fixed-words `error`
 * event; the log gets the error's name and HTTP status, never its message
 * (an SDK error can carry a key prefix or a request id).
 *
 * Per user rather than per process because the capabilities the graph holds
 * are bound to an acting user — every dry run and every issue carries that
 * person's `x-acting-user`, and ingest looks their role up in the database.
 * The copilot therefore has exactly the authority of whoever is typing, and
 * not one setpoint more. The issuer is handed to the graph's `apply` node and
 * nothing else.
 *
 * The checkpointer and the approval ledger are in memory. A suspended plan
 * survives across HTTP requests but not a restart of this process, nor
 * another replica: the fail-safe direction — the operator is asked again,
 * nothing is issued twice.
 */
// Least recently used goes first, and never a graph with a run or a plan
// open: when all are busy a new person gets a 503, not someone else's plan.
const graphs = new GraphCache<CopilotGraph>({ max: DEFAULT_LIMITS.maxGraphs, busy: graphBusy });

const graphKey = (tenantId: string, userId: string) => `${tenantId}:${userId}`;

/** Throws `GraphsBusy` when a graph must be evicted to build this one and every graph is busy. */
function graphFor(tenantId: string, userId: string): CopilotGraph {
  return graphs.getOrBuild(graphKey(tenantId, userId), () => buildCopilotGraph({
    reader: realReader(tenantId, userId),
    probe: realProbe(userId),
    issuer: realIssuer(userId),
    // Built once per user graph: the runner remembers which runs it
    // started, and only those may be read or cancelled.
    scenarios: realScenarioRunner(tenantId),
    callModel: realModelCaller(),
    models: MODELS,
    identity: { tenantId, userId },
  }));
}

const ThreadId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Body = z.union([
  z.object({ threadId: ThreadId, message: z.string().trim().min(1).max(DEFAULT_LIMITS.maxRequestTextChars) }).strict(),
  DecisionRequest.extend({ threadId: ThreadId }).strict(),
  z.object({ threadId: ThreadId, stop: z.literal(true) }).strict(),
]);

const TURN_FAILED = 'the copilot could not complete this turn' as const;

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

/** A 409 the panel can act on: wait and retry, or ask again for a fresh plan. */
function conflict(error: string, headers: Record<string, string> = {}) {
  return NextResponse.json({ error }, { status: 409, headers });
}

/**
 * A person, who may command: the first three gates, in the order every
 * copilot request keeps them. The role gate holds for the WHOLE copilot,
 * reads of a thread included — a person who cannot command has no thread.
 */
async function requireOperator() {
  const gate = await requireViewer();
  if (!gate.viewer) return gate;
  const { viewer } = gate;
  if (!mayCommand(viewer.role)) {
    return {
      response: NextResponse.json(
        { error: `role '${viewer.role}' may not issue control commands, so it may not ask the copilot to` },
        { status: 403 }),
    };
  }
  return { viewer };
}

// Threads are namespaced by the person, so one user cannot resume — and
// approve — another's suspended plan by guessing a thread id.
const threadKey = (userId: string, threadId: string) => `${userId}:${threadId}`;

/** Does the client read NDJSON? Any listed media type, parameters ignored. */
function wantsNdjson(request: globalThis.Request): boolean {
  return (request.headers.get('accept') ?? '').split(',')
    .some((part) => part.split(';', 1)[0]!.trim().toLowerCase() === 'application/x-ndjson');
}

/** Name and HTTP status only — never the message (see the header). */
function failureFields(err: unknown): { name: string; status: number | null } {
  const status = (err as { status?: unknown } | null)?.status;
  return { name: err instanceof Error ? err.name : typeof err, status: typeof status === 'number' ? status : null };
}

const NDJSON_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  // no-transform: a compressing proxy would buffer the lines it compresses.
  'cache-control': 'no-cache, no-transform',
  // nginx buffers proxied responses by default; this turns it off per response.
  'x-accel-buffering': 'no',
};

/**
 * The NDJSON answer. Called only after every gate has passed and the lock is
 * held; from here on nothing is refused by status code — the stream is open.
 *
 * The run is started inside `start` and NOT awaited there, so the Response
 * can go out at once. It owns the lock: `finally` releases it when the run
 * settles, whatever became of the reader. A reader that cancels only stops
 * the writes (the sink throws, and `runTurn` drops it); pings stop with it.
 */
function streamTurn(
  graph: CopilotGraph, threadId: string, input: TurnInput, requestId: string | null, lock: ThreadLock,
): Response {
  const encoder = new TextEncoder();
  const pingMs = copilotControls(graph).limits.pingIntervalS * 1000;
  let reading = true;
  let ping: ReturnType<typeof setInterval> | undefined;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: CopilotEvent) => {
        if (!reading) throw new Error('the reader has gone');
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      ping = setInterval(() => {
        try {
          send({ t: 'ping' });
        } catch {
          reading = false;
        }
      }, pingMs);

      void runTurn(graph, threadId, input, send)
        .catch((err: unknown) => {
          // runTurn has already said so, and logged it, for a run that failed
          // after it started. Anything else — a decision that went stale
          // between the gate and the run — is said and logged here, once.
          if (err instanceof TurnFailed) return;
          log.error('copilot.turn_failed', failureFields(err));
          try {
            send({ t: 'error', error: TURN_FAILED, requestId });
          } catch {
            // The reader has gone; GET ?threadId shows the thread as it is.
          }
        })
        .finally(() => {
          clearInterval(ping);
          lock.release();
          if (reading) {
            reading = false;
            try {
              controller.close();
            } catch {
              // Already closed by a cancel racing this.
            }
          }
        });
    },
    cancel() {
      // The client went away. The run is NOT aborted (no signal is ever
      // passed to it); it finishes, checkpoints, and releases the lock.
      reading = false;
      clearInterval(ping);
    },
  });

  return new Response(body, { status: 200, headers: NDJSON_HEADERS });
}

export async function POST(request: globalThis.Request) {
  const gate = await requireOperator();
  if (!gate.viewer) return gate.response;
  const { viewer } = gate;
  if (!hasModelCredential()) {
    // Said plainly, like a missing email transport. A copilot that looked
    // wired and was not would be worse than one that says it is not.
    return NextResponse.json({
      error: 'The copilot has no model credential. Set ANTHROPIC_API_KEY for the web service and restart it.',
    }, { status: 503 });
  }

  // Read to a bound before anything is parsed: the 2,000-character limit on
  // a question is a Zod bound, and would otherwise judge a body only after
  // all of it had been buffered.
  const text = await readBoundedText(request, DEFAULT_LIMITS.maxRequestBodyBytes);
  if (text === null) {
    return NextResponse.json({ error: `request body over ${DEFAULT_LIMITS.maxRequestBodyBytes} bytes` }, { status: 413 });
  }
  let parsed;
  try {
    parsed = Body.safeParse(JSON.parse(text));
  } catch {
    return NextResponse.json({ error: 'malformed request body' }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({
      error: 'threadId and one of: message; decision with interruptId, planId and planHash; or stop',
    }, { status: 400 });
  }

  const threadId = threadKey(viewer.userId, parsed.data.threadId);
  const body = parsed.data;

  // Stop never waits for the lock the run it stops holds, and never builds
  // a graph: with none there is nothing to stop.
  if ('stop' in body) {
    const held = graphs.get(graphKey(viewer.tenantId, viewer.userId));
    return NextResponse.json({ stopping: held ? stop(held, threadId) : false }, { status: 202 });
  }

  let graph: CopilotGraph;
  try {
    graph = graphFor(viewer.tenantId, viewer.userId);
  } catch (err) {
    if (!(err instanceof GraphsBusy)) throw err;
    log.warn('copilot.graphs_busy', { graphs: graphs.size });
    return NextResponse.json({ error: err.message }, { status: 503, headers: { 'retry-after': String(err.retryAfterS) } });
  }

  let lock: ThreadLock;
  try {
    lock = lockThread(graph, threadId);
  } catch (err) {
    if (!(err instanceof LockConflict)) throw err;
    log.warn('copilot.lock_conflict', {});
    return conflict(err.message, { 'retry-after': String(err.retryAfterS) });
  }

  // From here the lock is held: every path below either hands it to the run
  // or releases it itself.
  let input: TurnInput;
  let requestId: string | null;
  try {
    if ('message' in body) {
      requestId = randomUUID();
      input = { kind: 'message', text: body.message, mayCommand: mayCommand(viewer.role), requestId };
    } else {
      const d = { decision: body.decision, interruptId: body.interruptId, planId: body.planId, planHash: body.planHash };
      // Refused here, before any byte of an answer: the plan the operator
      // saw must still be the one pending, and still in date.
      ({ requestId } = await pendingDecision(graph, threadId, d));
      input = { kind: 'decision', ...d };
    }
  } catch (err) {
    lock.release();
    if (err instanceof PlanExpired) return conflict('plan_expired');
    if (err instanceof NoPendingPlan) return conflict('nothing awaiting approval');
    throw err;
  }

  if (wantsNdjson(request)) {
    try {
      return streamTurn(graph, threadId, input, requestId, lock);
    } catch (err) {
      lock.release();
      throw err;
    }
  }

  try {
    // The turn and nothing else: the same object the stream's last line
    // carries, already parsed against the protocol by runTurn.
    const turn: CopilotTurn = await runTurn(graph, threadId, input);
    return NextResponse.json(turn);
  } catch (err) {
    if (err instanceof PlanExpired) return conflict('plan_expired');
    if (err instanceof NoPendingPlan) return conflict('nothing awaiting approval');
    if (err instanceof TurnFailed) {
      // runTurn logged the cause by name. The message is fixed words: the
      // model's error can name the API key's prefix or a request id, and
      // neither belongs to the browser.
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    log.error('copilot.turn_failed', failureFields(err));
    return NextResponse.json({ error: TURN_FAILED }, { status: 502 });
  } finally {
    lock.release();
  }
}

/**
 * `GET /api/copilot?threadId=` — the thread as it stands (a reloaded panel,
 * or one that lost its stream), with `running` while a run holds the lock.
 * `GET /api/copilot` — whether the copilot is available to this person, and
 * with which models.
 */
export async function GET(request: globalThis.Request) {
  const threadParam = new URL(request.url).searchParams.get('threadId');
  if (threadParam !== null) {
    const gate = await requireOperator();
    if (!gate.viewer) return gate.response;
    const { viewer } = gate;
    const threadId = ThreadId.safeParse(threadParam);
    if (!threadId.success) return NextResponse.json({ error: 'threadId must be 1–64 of A–Z a–z 0–9 _ -' }, { status: 400 });
    // No graph means no thread: answer empty rather than build one to read nothing.
    const graph = graphs.get(graphKey(viewer.tenantId, viewer.userId));
    const turn = graph
      ? await rehydrate(graph, threadKey(viewer.userId, threadId.data))
      : turnFromState({ values: {} }, { models: MODELS, running: false });
    return NextResponse.json(turn);
  }

  const gate = await requireViewer();
  if (!gate.viewer) return gate.response;
  const { viewer } = gate;
  const simulation = Boolean(process.env.COPILOT_SIM_API_KEY?.trim());
  return NextResponse.json({
    available: hasModelCredential() && mayCommand(viewer.role),
    models: MODELS,
    simulation: { available: simulation, reason: simulation ? null : 'COPILOT_SIM_API_KEY is not set' },
    reason: !hasModelCredential()
      ? 'no model credential (ANTHROPIC_API_KEY)'
      : !mayCommand(viewer.role) ? `role '${viewer.role}' may not command` : null,
  });
}
