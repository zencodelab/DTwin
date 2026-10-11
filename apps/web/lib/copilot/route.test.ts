import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { GraphDeps } from './deps.ts';
import type { CopilotGraph } from './graph.ts';
import { CopilotTurn, parseEvent, type CopilotEvent } from './protocol.ts';
import { lockThread, threadRunning } from './session.ts';
import { TENANT_ID, fakeDeps, plannerMsg, type FakeDeps, type Script } from './testing/fakes.ts';
import { fastPathScript } from './testing/scripts.ts';

/**
 * The copilot's route handlers, run (route stage; spec §9.1). Until now the
 * gate order, the 409 mapping and the stream were checked by typecheck and
 * by reading them; vitest now resolves `@/`, so the handlers themselves run
 * here — on the fakes, with the session and the tenant mocked, and nothing
 * reaching a database, a model or a service.
 *
 * What is proved: every gate answers in its order and BEFORE any byte (a
 * refused NDJSON request is a JSON error, never a 200 stream); the stream's
 * headers and pings; the lock held for the RUN, not the response, and
 * released when the run settles even after the reader has gone; errors after
 * the stream opened in fixed words, logged by name and status only; Stop
 * without the lock; and GET in both forms.
 */

interface Viewer {
  tenantId: string; userId: string; sessionId: string; displayName: string; email: string;
  role: 'owner' | 'admin' | 'operator' | 'viewer';
}

const h = vi.hoisted(() => ({
  viewer: null as null | { tenantId: string; userId: string; sessionId: string; displayName: string; email: string; role: string },
  demoTenant: null as null | { tenantId: string },
  /** The deps the route's next graph is built with (the route's own real ones are discarded). */
  nextDeps: null as null | (() => GraphDeps),
  graphs: [] as unknown[],
  logs: [] as Array<{ level: string; event: string; fields: Record<string, unknown> }>,
}));

vi.mock('@/lib/tenant', () => ({
  currentViewer: async () => h.viewer,
  currentTenant: async () => (h.viewer ? { tenantId: h.viewer.tenantId, userId: h.viewer.userId } : h.demoTenant),
  unauthorized: () => Response.json({ error: 'unauthenticated' }, { status: 401 }),
}));

vi.mock('@/lib/log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../log.ts')>();
  const push = (level: string) => (event: string, fields: Record<string, unknown> = {}) => { h.logs.push({ level, event, fields }); };
  return { ...actual, log: { info: push('info'), warn: push('warn'), error: push('error') } };
});

// Nothing the route would reach for real: no pool, no ingest, no worker, no model.
vi.mock('@/lib/copilot/backend', () => ({
  realReader: () => ({}), realProbe: () => ({}), realIssuer: () => ({}),
}));
vi.mock('@/lib/copilot/sim-runner', () => ({ realScenarioRunner: () => null }));
vi.mock('@/lib/copilot/graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./graph.ts')>();
  return {
    ...actual,
    realModelCaller: () => async () => { throw new Error('route.test: no real model'); },
    buildCopilotGraph: (deps: GraphDeps) => {
      const graph = actual.buildCopilotGraph(h.nextDeps ? h.nextDeps() : deps);
      h.graphs.push(graph);
      return graph;
    },
  };
});

const { GET, POST } = await import('../../app/api/copilot/route.ts');
const { GET: GRAPH_GET } = await import('../../app/api/copilot/graph/route.ts');
const { resolveModels } = await import('./model.ts');

const URL_BASE = 'http://localhost/api/copilot';
const TURN_FAILED = 'the copilot could not complete this turn';
const SECRET = 'sk-ant-api03-SECRETSECRET request_id=req_011CabcDEF';

function signIn(role: Viewer['role'] = 'operator'): Viewer {
  const v: Viewer = {
    tenantId: TENANT_ID, userId: randomUUID(), sessionId: randomUUID(), displayName: 'Test Operator',
    email: 'operator@example.invalid', role,
  };
  h.viewer = v;
  h.demoTenant = null;
  return v;
}

function setup(script: Script, opts: { role?: Viewer['role']; limits?: FakeDeps['deps']['limits'] } = {}) {
  const fake = fakeDeps({ script, ...(opts.limits ? { limits: opts.limits } : {}) });
  h.nextDeps = () => fake.deps;
  const viewer = signIn(opts.role);
  const key = (threadId: string) => `${viewer.userId}:${threadId}`;
  return { fake, viewer, key, graph: (): CopilotGraph => h.graphs.at(-1) as CopilotGraph };
}

const post = (body: unknown, accept?: string) => POST(new Request(URL_BASE, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(accept ? { accept } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}));
const NDJSON = 'application/x-ndjson';

async function events(res: Response): Promise<CopilotEvent[]> {
  const lines = (await res.text()).split('\n').filter((l) => l !== '');
  const parsed = lines.map((l) => parseEvent(l));
  expect(parsed.every((e) => e !== null), lines.join('\n')).toBe(true);
  return parsed as CopilotEvent[];
}

/** The script with a first planner reply for `build()`: a clarifying question, nothing run. */
function withBuildTurn(script: Script): Script {
  return { ...script, planner: [plannerMsg({ next: 'finish', intent: 'clarify', message: 'Which zone?' }), ...script.planner!] };
}

/** One message on a thread of its own, so the route builds the person's graph. */
async function build(): Promise<void> {
  expect((await post({ threadId: 'build', message: 'hello' })).status).toBe(200);
}

/** A script whose first planner call waits until released: the run is held open. */
function heldFastPath() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const script = fastPathScript();
  const decision = script.planner![0] as Anthropic.Message;
  script.planner = [async () => { await gate; return structuredClone(decision); }];
  return { script, release };
}

beforeEach(() => {
  h.viewer = null;
  h.demoTenant = null;
  h.nextDeps = null;
  h.graphs.length = 0;
  h.logs.length = 0;
  vi.stubEnv('ANTHROPIC_API_KEY', 'route-test-credential');
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('POST: the gates, in order, before any byte', () => {
  const bad = { threadId: 'x', message: '' };   // fails Zod

  it('each gate answers even when every later one would also refuse — and as JSON, whatever Accept asked for', async () => {
    const expectJson = async (res: Response, status: number, error: RegExp) => {
      expect(res.status).toBe(status);
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
      expect(((await res.json()) as { error: string }).error).toMatch(error);
    };
    vi.stubEnv('ANTHROPIC_API_KEY', '');   // the credential gate would refuse too

    // 1. No session at all: 401.
    await expectJson(await post(bad, NDJSON), 401, /^unauthenticated$/);
    // 2. The demo session: a tenant, nobody to record a command against.
    h.demoTenant = { tenantId: TENANT_ID };
    await expectJson(await post(bad, NDJSON), 403, /recorded against a person/);
    // 3. A person who may not command: the whole copilot is closed.
    signIn('viewer');
    await expectJson(await post(bad, NDJSON), 403, /role 'viewer' may not issue control commands/);
    // 4. An operator, with no model credential: said plainly.
    signIn('operator');
    await expectJson(await post(bad, NDJSON), 503, /no model credential/);
    // 5. The credential in place: the body is judged.
    vi.stubEnv('ANTHROPIC_API_KEY', 'route-test-credential');
    await expectJson(await post(bad, NDJSON), 400, /threadId and one of/);
    await expectJson(await post('{not json', NDJSON), 400, /malformed request body/);
    await expectJson(await post({ threadId: 'x', message: 'hi', extra: true }, NDJSON), 400, /threadId and one of/);
    expect(h.graphs).toHaveLength(0);   // nothing was built for a refused request
  });

  it('5a. a body over maxRequestBodyBytes is a 413 before it is parsed, declared or chunked (review)', async () => {
    signIn('operator');
    const { DEFAULT_LIMITS } = await import('./limits.ts');
    const big = JSON.stringify({ threadId: 'x', message: 'x'.repeat(DEFAULT_LIMITS.maxRequestBodyBytes) });
    const declared = await post(big, NDJSON);
    expect(declared.status).toBe(413);
    expect(declared.headers.get('content-type')).toMatch(/^application\/json/);
    // No content-length: counted as it is read, and abandoned past the bound.
    let pulled = 0;
    const chunked = new ReadableStream<Uint8Array>({
      pull(c) { pulled += 1; c.enqueue(new TextEncoder().encode('x'.repeat(4096))); },
    });
    const res = await POST(new Request(URL_BASE, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: chunked, duplex: 'half',
    } as RequestInit));
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(Math.ceil(DEFAULT_LIMITS.maxRequestBodyBytes / 4096) + 2);
    expect(h.graphs).toHaveLength(0);
  });

  it('6. the thread\'s lock: 409 with Retry-After 2, logged, and no model called', async () => {
    const { fake, key, graph } = setup(withBuildTurn(fastPathScript()));
    // Stop builds no graph: with none there is nothing to stop.
    expect(await (await post({ threadId: 't', stop: true })).json()).toEqual({ stopping: false });
    expect(h.graphs).toHaveLength(0);
    await build();
    const called = fake.model.count();
    const lock = lockThread(graph(), key('t'));

    for (const accept of [undefined, NDJSON]) {
      const res = await post({ threadId: 't', message: 'pre-cool L3' }, accept);
      expect(res.status).toBe(409);
      expect(res.headers.get('retry-after')).toBe('2');
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
      expect(await res.json()).toEqual({ error: 'a request on this thread is still running' });
    }
    // Zod still comes first, even on a busy thread.
    expect((await post({ threadId: 't', message: '' })).status).toBe(400);
    expect(h.logs.filter((l) => l.event === 'copilot.lock_conflict')).toEqual([
      { level: 'warn', event: 'copilot.lock_conflict', fields: {} },
      { level: 'warn', event: 'copilot.lock_conflict', fields: {} },
    ]);
    expect(fake.model.count()).toBe(called);
    lock.release();
  });

  it('7. a decision must name the pending interrupt, plan and hash, in date — else 409, before the graph runs', async () => {
    const { fake, key, graph } = setup(fastPathScript());
    const proposed = await post({ threadId: 'd', message: 'pre-cool L3' });
    expect(proposed.status).toBe(200);
    const plan = ((await proposed.json()) as CopilotTurn).pendingPlan!;
    expect(plan).not.toBeNull();
    const streamSpy = vi.spyOn(graph(), 'stream');
    const decision = (over: Record<string, unknown> = {}) => ({
      threadId: 'd', decision: 'approved', interruptId: plan.interruptId, planId: plan.planId, planHash: plan.planHash, ...over,
    });

    for (const [over, accept] of [
      [{ planHash: 'f'.repeat(64) }, NDJSON],
      [{ planId: randomUUID() }, undefined],
      [{ interruptId: 'not-the-interrupt' }, NDJSON],
      [{ threadId: 'never-used' }, undefined],
    ] as const) {
      const res = await post(decision(over), accept);
      expect(res.status, JSON.stringify(over)).toBe(409);
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
      expect(await res.json()).toEqual({ error: 'nothing awaiting approval' });
    }
    // Past its TTL: plan_expired. The lock was taken and given back each time.
    fake.clock.advance(601_000);
    const expired = await post(decision(), NDJSON);
    expect(expired.status).toBe(409);
    expect(await expired.json()).toEqual({ error: 'plan_expired' });
    expect(threadRunning(graph(), key('d'))).toBe(false);
    expect(streamSpy).not.toHaveBeenCalled();
    expect(fake.issuer.issued).toHaveLength(0);
  });

  it('8. Stop answers 202 without the lock — even while a run holds it — and the run ends stopped', async () => {
    const held = heldFastPath();
    const { fake, key, graph } = setup(held.script);
    const running = await post({ threadId: 's', message: 'pre-cool L3' }, NDJSON);
    expect(running.status).toBe(200);
    expect(threadRunning(graph(), key('s'))).toBe(true);
    await vi.waitFor(() => expect(fake.model.count('planner')).toBe(1));   // the run is in its planner call

    const stopped = await post({ threadId: 's', stop: true });
    expect(stopped.status).toBe(202);
    expect(await stopped.json()).toEqual({ stopping: true });
    expect(threadRunning(graph(), key('s'))).toBe(true);   // Stop took nothing

    held.release();
    const last = (await events(running)).at(-1)!;
    expect(last.t).toBe('turn');
    const turn = (last as { turn: CopilotTurn }).turn;
    expect(turn.notices.map((n) => n.code)).toContain('stopped');
    expect(turn.pendingPlan).toBeNull();
    // Nothing to stop on an idle thread.
    expect(await (await post({ threadId: 's', stop: true })).json()).toEqual({ stopping: false });
  });
});

describe('POST: the NDJSON answer', () => {
  it('streams protocol lines with the stream headers and pings, holding the lock until the RUN settles', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const held = heldFastPath();
    const { key, graph } = setup(held.script);

    const res = await post({ threadId: 'n', message: 'pre-cool L3' }, `${NDJSON}, application/json;q=0.5`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    // The Response is out; the run is not over, and the lock says so.
    expect(threadRunning(graph(), key('n'))).toBe(true);
    const busy = await post({ threadId: 'n', message: 'again' }, NDJSON);
    expect(busy.status).toBe(409);
    const rehydrated = await GET(new Request(`${URL_BASE}?threadId=n`));
    expect(((await rehydrated.json()) as CopilotTurn).running).toBe(true);

    vi.advanceTimersByTime(30_000);   // two ping intervals while the model thinks
    held.release();
    const all = await events(res);

    expect(threadRunning(graph(), key('n'))).toBe(false);   // released when the run settled
    expect(all[0]).toEqual({ t: 'accepted', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(all.filter((e) => e.t === 'ping')).toHaveLength(2);
    expect(all.map((e) => e.t)).toEqual(expect.arrayContaining(['step', 'plan', 'turn']));
    const last = all.at(-1) as { t: 'turn'; turn: CopilotTurn };
    expect(last.t).toBe('turn');
    expect(last.turn.pendingPlan).not.toBeNull();
    expect(last.turn.requestId).toBe((all[0] as { requestId: string }).requestId);
    // The stream carries the protocol, not the v1 panel's legacy fields.
    expect(last.turn).not.toHaveProperty('messages');
  });

  it('a reader that goes away does not abort the run: the lock is released when it settles, and GET rehydrates it', async () => {
    const held = heldFastPath();
    const { fake, key, graph } = setup(held.script);
    const res = await post({ threadId: 'gone', message: 'pre-cool L3' }, NDJSON);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(parseEvent(first.split('\n')[0])).toMatchObject({ t: 'accepted' });
    // Mid-run — its request open, its planner call out — the client leaves.
    await vi.waitFor(() => expect(fake.model.count('planner')).toBe(1));
    await reader.cancel();

    // Cancelled, but the run holds the thread until it has finished.
    expect(threadRunning(graph(), key('gone'))).toBe(true);
    held.release();
    await vi.waitFor(() => expect(threadRunning(graph(), key('gone'))).toBe(false));

    expect(fake.model.count('control')).toBe(1);   // it ran on to the controller
    const turn = (await (await GET(new Request(`${URL_BASE}?threadId=gone`))).json()) as CopilotTurn;
    expect(turn.running).toBe(false);
    expect(turn.pendingPlan).not.toBeNull();
    expect(turn.notices.map((n) => n.code)).not.toContain('stopped');   // a disconnect is not a Stop
    expect(h.logs.some((l) => l.event === 'copilot.turn_failed')).toBe(false);
  });

  it('a run that fails after the stream opened ends in fixed words, logged once by name and status — never the message', async () => {
    const { key, graph } = setup(withBuildTurn(fastPathScript()));
    await build();   // build the graph so its stream can be broken
    vi.spyOn(graph(), 'stream').mockImplementation((async () => {
      async function* broken() {
        yield [[], 'updates', { intake: {} }];
        throw Object.assign(new Error(SECRET), { name: 'InternalServerError', status: 529 });
      }
      return broken();
    }) as never);

    const res = await post({ threadId: 'f', message: 'pre-cool L3' }, NDJSON);
    expect(res.status).toBe(200);   // the stream was open; the failure is in it
    const text = await res.text();
    expect(text).not.toContain('sk-ant');
    const all = text.split('\n').filter(Boolean).map((l) => parseEvent(l));
    const accepted = all[0] as { t: 'accepted'; requestId: string };
    expect(all).toEqual([
      accepted,
      { t: 'step', node: 'intake' },
      { t: 'error', error: TURN_FAILED, requestId: accepted.requestId },
    ]);
    expect(h.logs.filter((l) => l.event === 'copilot.turn_failed')).toEqual([
      { level: 'error', event: 'copilot.turn_failed', fields: { name: 'InternalServerError', status: 529 } },
    ]);
    expect(JSON.stringify(h.logs)).not.toContain('sk-ant');
    expect(threadRunning(graph(), key('f'))).toBe(false);

    // The JSON answer to the same failure: 502, the same fixed words.
    h.logs.length = 0;
    const json = await post({ threadId: 'f', message: 'pre-cool L3' });
    expect(json.status).toBe(502);
    const body = await json.text();
    expect(JSON.parse(body)).toEqual({ error: TURN_FAILED });
    expect(body).not.toContain('sk-ant');
    expect(h.logs.filter((l) => l.event === 'copilot.turn_failed')).toHaveLength(1);
    expect(threadRunning(graph(), key('f'))).toBe(false);
  });

  it('a decision that expires between the gate and the run is said in the stream and logged by the route, once', async () => {
    const { fake, key, graph } = setup(fastPathScript());
    const plan = ((await (await post({ threadId: 'x', message: 'pre-cool L3' })).json()) as CopilotTurn).pendingPlan!;
    // The route's own check reads the state first and passes; the plan
    // expires as the run's re-check (defence in depth) reads it again.
    const real = graph().getState.bind(graph());
    let reads = 0;
    vi.spyOn(graph(), 'getState').mockImplementation((async (config: never) => {
      const s = await real(config);
      if ((reads += 1) === 2) fake.clock.advance(601_000);
      return s;
    }) as never);

    const res = await post({
      threadId: 'x', decision: 'approved', interruptId: plan.interruptId, planId: plan.planId, planHash: plan.planHash,
    }, NDJSON);
    expect(res.status).toBe(200);
    expect(await events(res)).toEqual([{ t: 'error', error: TURN_FAILED, requestId: expect.any(String) }]);
    expect(h.logs.filter((l) => l.event === 'copilot.turn_failed')).toEqual([
      { level: 'error', event: 'copilot.turn_failed', fields: { name: 'PlanExpired', status: null } },
    ]);
    expect(fake.issuer.issued).toHaveLength(0);
    expect(threadRunning(graph(), key('x'))).toBe(false);
  });
});

describe('POST: the JSON answer', () => {
  it('is the same runTurn: a plan, then an approval that issues it — the turn and nothing beside it', async () => {
    const { fake, key, graph } = setup(fastPathScript());
    const res = await post({ threadId: 'j', message: 'pre-cool L3' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const body: unknown = await res.json();
    // The strict schema refuses any key it does not name: the v1 panel's
    // `messages` and `notice` are gone, and nothing else rides along.
    const parsed = CopilotTurn.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(body).not.toHaveProperty('messages');
    expect(body).not.toHaveProperty('notice');
    const turn = parsed.data!;
    expect(turn.pendingPlan).not.toBeNull();
    expect(turn.dialogue[0]).toEqual({ role: 'operator', text: 'pre-cool L3' });
    expect(threadRunning(graph(), key('j'))).toBe(false);

    const approved = await post({
      threadId: 'j', decision: 'approved',
      interruptId: turn.pendingPlan!.interruptId, planId: turn.pendingPlan!.planId, planHash: turn.pendingPlan!.planHash,
    });
    expect(approved.status).toBe(200);
    const done = CopilotTurn.parse(await approved.json());
    expect(done.outcomes).toHaveLength(2);
    expect(fake.issuer.issued).toHaveLength(2);

    // GET ?threadId answers the same shape: the thread as it stands.
    const read: unknown = await (await GET(new Request(`${URL_BASE}?threadId=j`))).json();
    expect(CopilotTurn.safeParse(read).success).toBe(true);
    expect(read).toEqual(done);
  });
});

describe('GET', () => {
  it('without a thread: availability, both models, simulation and the reason — for a signed-in person only', async () => {
    expect((await GET(new Request(URL_BASE))).status).toBe(401);
    h.demoTenant = { tenantId: TENANT_ID };
    expect((await GET(new Request(URL_BASE))).status).toBe(403);

    signIn('operator');
    const models = resolveModels();
    // `models` only: the v1 panel's single `model` field is gone.
    expect(await (await GET(new Request(URL_BASE))).json()).toEqual({
      available: true, models,
      simulation: { available: false, reason: 'COPILOT_SIM_API_KEY is not set' }, reason: null,
    });
    signIn('viewer');
    expect(await (await GET(new Request(URL_BASE))).json()).toMatchObject({ available: false, reason: "role 'viewer' may not command" });
    signIn('operator');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(await (await GET(new Request(URL_BASE))).json()).toMatchObject({ available: false, reason: 'no model credential (ANTHROPIC_API_KEY)' });
  });

  it('with a thread: the operator\'s own thread, empty when there is none, 400 on a bad id', async () => {
    signIn('operator');
    const empty = CopilotTurn.parse(await (await GET(new Request(`${URL_BASE}?threadId=nothing-here`))).json());
    expect(empty).toMatchObject({ requestId: null, running: false, dialogue: [], pendingPlan: null });
    expect(h.graphs).toHaveLength(0);   // no graph is built to read nothing
    expect((await GET(new Request(`${URL_BASE}?threadId=${encodeURIComponent('../x')}`))).status).toBe(400);
    signIn('viewer');
    expect((await GET(new Request(`${URL_BASE}?threadId=t`))).status).toBe(403);
  });
});

describe('GET /api/copilot/graph', () => {
  it('serves the compiled graph with its roles; xray expands the specialists', async () => {
    expect((await GRAPH_GET(new Request(`${URL_BASE}/graph`))).status).toBe(401);
    h.demoTenant = { tenantId: TENANT_ID };
    const flat = (await (await GRAPH_GET(new Request(`${URL_BASE}/graph`))).json()) as {
      nodes: string[]; edges: Array<{ source: string; target: string; conditional: boolean }>; mermaid: string; roles: Record<string, string>;
    };
    expect(flat.mermaid).toContain('confirm -.-> apply');
    expect(flat.mermaid).toContain('planner');
    expect(flat.edges.filter((e) => e.target === 'apply').map((e) => e.source)).toEqual(['confirm']);
    expect(flat.roles).toMatchObject({ apply: 'writes-building', confirm: 'interrupt', planner: 'llm' });
    expect(Object.keys(flat.roles).sort()).toEqual(flat.nodes.filter((n) => !n.startsWith('__')).sort());

    const xray = (await (await GRAPH_GET(new Request(`${URL_BASE}/graph?xray=1`))).json()) as typeof flat;
    expect(xray.edges.some((e) => e.source === 'control:finish' && e.target === 'plan_check')).toBe(true);
    expect(xray.roles).toEqual(flat.roles);
  });
});
