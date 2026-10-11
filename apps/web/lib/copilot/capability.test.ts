import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

/**
 * P9 ("only `apply` holds the Issuer") as a type fact, a runtime fact and a
 * fetch fact, and P17 ("reads cannot write") as a fact about the transaction
 * every read opens (§7, §10 capability tests 1, 3 and 4).
 *
 * THE SEAM FOR TEST 4 is `pg` itself. `withTenant` checks a client out of the
 * module pool that `@dtwin/db` builds with `new Pool(…)`; mocking `pg` swaps
 * that pool for one that records every statement, so the test drives the
 * REAL path — realReader → withTenant → the copilot query → COMMIT — and
 * production code carries no test-only parameter. (The alternative, an
 * injectable runner on `realReader`, would test that the reader passes
 * `readOnly: true`, not that `BEGIN READ ONLY` is what reaches the database.)
 *
 * Nothing here touches a network or a database: `fetch` is stubbed per test,
 * and `pg` is mocked for the whole file.
 */

const pg = vi.hoisted(() => {
  interface Reply { rows: unknown[]; rowCount: number }
  interface Statement { client: number; text: string; params: unknown[] | undefined }
  const empty = (): Reply => ({ rows: [], rowCount: 0 });
  const state = {
    statements: [] as Statement[],
    clients: 0,
    respond: ((_text: string, _params: unknown[] | undefined): Reply => empty()) as
      (text: string, params: unknown[] | undefined) => Reply,
  };
  class Pool {
    on(): this { return this; }
    async connect() {
      const client = ++state.clients;
      return {
        query: async (text: string, params?: unknown[]) => {
          state.statements.push({ client, text, params });
          return state.respond(text, params);
        },
        release: () => { state.statements.push({ client, text: '<release>', params: undefined }); },
      };
    }
    async end(): Promise<void> {}
  }
  const types = { setTypeParser: () => {}, builtins: { INT8: 20 } };
  return {
    state, Pool, types,
    reset() {
      state.statements.length = 0;
      state.respond = empty;
    },
  };
});

vi.mock('pg', () => ({ Pool: pg.Pool, types: pg.types, default: { Pool: pg.Pool, types: pg.types } }));

import {
  ISSUE_TIMEOUT_MS, ProbeRouteRefused, probeFetch, realIssuer, realProbe, realReader,
} from './backend.ts';
import {
  CONTROL_PROBE_METHODS, ISSUER_METHODS, SCENARIO_RUNNER_METHODS, TWIN_READER_METHODS,
  type CommandSpec, type ControlProbe, type GraphDeps, type Issuer, type ReaderMethod,
  type ScenarioRunner, type SpecialistDeps, type TwinReader,
} from './deps.ts';
import { InertDepsError, inertDeps } from './inert.ts';
import {
  SimRouteRefused, copilotSlotHeld, makeSimFetch, realScenarioRunner, stripNullParams,
} from './sim-runner.ts';
import { memoryLogger } from '../log.ts';
import { buildCopilotGraph, type CopilotGraph } from './graph.ts';
import { decide, sendMessage } from './session.ts';
import { WRITES } from './state.ts';
import {
  BUILDING_ID, TENANT_ID as T, USER_ID as U, Z, composeMsg, fakeDeps, message, plannerMsg, toolUse,
} from './testing/fakes.ts';
import { harness } from './testing/run.ts';
import { compoundScript, fastPathScript, NOW_LOCAL, report, SINCE_9 } from './testing/scripts.ts';

// ------------------------------------------------------------ fetch stubs

interface SentRequest { url: string; method: string; headers: Record<string, string>; body: unknown }
type Reply = Response | Error | (() => Response);

/** `fetch` answering `replies` in order; any call beyond them fails the test. */
function stubFetch(...replies: Reply[]): { sent: SentRequest[]; fn: typeof fetch } {
  const sent: SentRequest[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    sent.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string> | undefined) },
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const r = replies.shift();
    if (r === undefined) throw new Error(`unexpected fetch ${init.method ?? 'GET'} ${String(url)}`);
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r() : r;
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fn);
  return { sent, fn };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const CMD: CommandSpec = { zoneId: Z.off301, setpointTempC: 22, durationS: 7200, reason: 'pre-cool before the peak' };

beforeEach(() => {
  // Never the user's services: every URL below is a name that resolves nowhere.
  // DATABASE_URL too — the pool is mocked, but if that mock ever stopped
  // applying, the client would otherwise default to localhost:5432.
  vi.stubEnv('DATABASE_URL', 'postgres://copilot-test@127.0.0.1:9/never');
  vi.stubEnv('INGEST_BASE_URL', 'http://ingest.test');
  vi.stubEnv('SIM_BASE_URL', 'http://sim.test');
  vi.stubEnv('SIM_API_KEY', 'web-proxy-key');
  vi.stubEnv('COPILOT_SIM_API_KEY', 'copilot-sim-key');
  pg.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ======================================================================= 1

describe('capability: types', () => {
  it('nothing but an Issuer can issue, and no specialist can hold one', () => {
    expectTypeOf<ControlProbe>().not.toHaveProperty('issue');
    expectTypeOf<TwinReader>().not.toHaveProperty('issue');
    expectTypeOf<ScenarioRunner>().not.toHaveProperty('issue');
    expectTypeOf<SpecialistDeps>().not.toHaveProperty('issuer');
    // The positive cases, so the negatives cannot pass by the names being wrong.
    expectTypeOf<Issuer>().toHaveProperty('issue');
    expectTypeOf<GraphDeps>().toHaveProperty('issuer');
    expectTypeOf<SpecialistDeps>().toHaveProperty('reader');
  });

  it('the real objects carry exactly their interface, and nothing that issues', () => {
    const sorted = (xs: readonly string[]) => [...xs].sort();
    expect(sorted(Object.keys(realReader(T, U)))).toEqual(sorted(TWIN_READER_METHODS));
    expect(sorted(Object.keys(realProbe(U)))).toEqual(sorted(CONTROL_PROBE_METHODS));
    expect(sorted(Object.keys(realIssuer(U)))).toEqual(sorted(ISSUER_METHODS));
    const runner = realScenarioRunner(T, { env: { COPILOT_SIM_API_KEY: 'k' } });
    expect(sorted(Object.keys(runner!))).toEqual(sorted(SCENARIO_RUNNER_METHODS));
    for (const capability of [realReader(T, U), realProbe(U), runner!]) {
      expect('issue' in capability).toBe(false);
    }
  });
});

// ============================================================= 3: the probe

describe('capability: probe fetch guard', () => {
  it('a dry run is sent as a dry run, for the acting user, with the web key', async () => {
    const { sent } = stubFetch(json(200, {
      dryRun: true, allowed: true, previousTempC: 23, durationS: 7200,
      expiresAt: '2026-09-28T08:45:00.000Z', effectiveUntil: '2026-09-28T10:40:00.000Z',
    }));
    const verdict = await realProbe(U).dryRun(CMD);
    expect(verdict).toEqual({ allowed: true, previousTempC: 23, durationS: 7200, effectiveUntil: '2026-09-28T10:40:00.000Z' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.url).toBe('http://ingest.test/control/commands');
    expect(sent[0]!.body).toEqual({ ...CMD, dryRun: true });
    expect(sent[0]!.headers).toMatchObject({ 'x-acting-user': U, authorization: 'Bearer web-proxy-key' });
  });

  it('a command object carrying dryRun:false or stray fields still sends only a dry run', async () => {
    const { sent } = stubFetch(json(409, { error: 'too soon', refusal: 'too_soon' }));
    const forged = { ...CMD, dryRun: false, apply: true } as unknown as CommandSpec;
    await realProbe(U).dryRun(forged);
    expect(sent[0]!.body).toEqual({ ...CMD, dryRun: true });
  });

  it('a refusal comes back as a refusal, naming ingest’s rule', async () => {
    stubFetch(json(409, { error: 'VAV-305 (fault)', refusal: 'equipment_unavailable' }));
    expect(await realProbe(U).dryRun({ ...CMD, zoneId: Z.off305 }))
      .toEqual({ allowed: false, refusal: 'equipment_unavailable', message: 'VAV-305 (fault)' });
  });

  it('a reply that is not JSON, or not a verdict, is a refusal — never a throw, never "allowed"', async () => {
    stubFetch(
      new Response('<html>502 Bad Gateway</html>', { status: 502 }),
      json(200, { allowed: 'yes' }),
    );
    const probe = realProbe(U);
    const html = await probe.dryRun(CMD);
    expect(html).toMatchObject({ allowed: false, refusal: 'http_502' });
    expect(html.allowed === false && html.message).toMatch(/not JSON/);
    expect(await probe.dryRun(CMD)).toEqual({
      allowed: false, refusal: 'http_200', message: 'the control service answered without a verdict',
    });
  });

  it('settings are read with a GET and parsed; a bad or failed read throws', async () => {
    const envelope = {
      enabled: true, maxDeviationK: 3, maxStepK: 2, minIntervalS: 900,
      defaultDurationS: 3600, maxDurationS: 43_200, commandTtlS: 300,
    };
    const { sent } = stubFetch(json(200, envelope), json(503, { error: 'down' }), json(200, { enabled: 'maybe' }));
    const probe = realProbe(U);
    expect(await probe.settings()).toEqual(envelope);
    expect(sent[0]).toMatchObject({ method: 'GET', url: 'http://ingest.test/control/settings', body: undefined });
    await expect(probe.settings()).rejects.toThrow('control settings unavailable: 503');
    await expect(probe.settings()).rejects.toThrow(/unreadable/);
  });

  it('refuses, BEFORE fetch, every request that is not settings or a dry run', async () => {
    const { fn } = stubFetch();
    const body = { zoneId: Z.off301, setpointTempC: 21, reason: 'pre-cool' };
    let reads = 0;
    const forged: Array<[string, string, unknown]> = [
      ['POST', '/control/commands', body],                                   // no dryRun: ingest would ISSUE it
      ['POST', '/control/commands', { ...body, dryRun: false }],
      ['POST', '/control/commands', { ...body, dryRun: 'true' }],
      ['POST', '/control/commands', { ...body, dryRun: 1 }],
      ['POST', '/control/commands', [{ ...body, dryRun: true }]],
      ['POST', '/control/commands', undefined],
      // The object says dryRun; the bytes it serialises to do not.
      ['POST', '/control/commands', { ...body, dryRun: true, toJSON: () => body }],
      // Reads false when serialised, true on any later look.
      ['POST', '/control/commands', { ...body, get dryRun() { reads += 1; return reads > 1; } }],
      ['POST', '/control/commands?dryRun=true', { ...body, dryRun: true }],
      ['POST', '/control/commands/cancel', { commandId: 'c1', dryRun: true }],
      ['POST', '/control/settings', { enabled: false, dryRun: true }],
      ['GET', '/control/commands', undefined],
      ['GET', '/control/settings', { dryRun: true }],
      ['PUT', '/control/commands', { ...body, dryRun: true }],
      ['DELETE', '/control/settings', undefined],
      ['POST', '/control/dispatch/claim', { dryRun: true }],
    ];
    for (const [method, path, b] of forged) {
      await expect(probeFetch(U, method, path, b), `${method} ${path}`).rejects.toBeInstanceOf(ProbeRouteRefused);
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it('judges what is sent: a getter that says true when serialised sends a dry run', async () => {
    const { sent } = stubFetch(json(200, {
      allowed: true, previousTempC: 23, durationS: 3600, effectiveUntil: '2026-09-28T09:40:00.000Z',
    }));
    let reads = 0;
    const body = { zoneId: Z.off301, setpointTempC: 21, reason: 'pre-cool', get dryRun() { reads += 1; return reads === 1; } };
    await probeFetch(U, 'POST', '/control/commands', body);
    expect(sent[0]!.body).toMatchObject({ dryRun: true });
  });
});

// ============================================================ 3: the issuer

describe('capability: the issuer is the only non-dry POST', () => {
  it('issues exactly the command, without dryRun, for the acting user', async () => {
    const { sent } = stubFetch(json(202, {
      command: { id: 'cmd-1', state: 'pending', effectiveUntil: '2026-09-28T10:40:00.000Z', zoneId: Z.off301 },
    }));
    const forged = { ...CMD, dryRun: true } as unknown as CommandSpec;
    expect(await realIssuer(U).issue(forged))
      .toEqual({ ok: true, commandId: 'cmd-1', state: 'pending', effectiveUntil: '2026-09-28T10:40:00.000Z' });
    expect(sent[0]).toMatchObject({ method: 'POST', url: 'http://ingest.test/control/commands', body: CMD });
    expect(sent[0]!.body).not.toHaveProperty('dryRun');
    expect(sent[0]!.headers).toMatchObject({ 'x-acting-user': U, authorization: 'Bearer web-proxy-key' });
  });

  it('answers refusals, an unreadable 202 and a timeout; throws only when nothing was sent', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    stubFetch(
      json(409, { error: 'too soon', refusal: 'too_soon' }),
      new Response('queued', { status: 202 }),
      timeout,
      new TypeError('fetch failed'),
    );
    const issuer = realIssuer(U);
    expect(await issuer.issue(CMD)).toEqual({ ok: false, refusal: 'too_soon', message: 'too soon' });
    expect(await issuer.issue(CMD)).toMatchObject({ ok: false, refusal: 'unreadable_reply' });
    const late = await issuer.issue(CMD);
    expect(late).toMatchObject({ ok: false, refusal: 'timeout' });
    expect(late.ok === false && late.message).toContain(`${ISSUE_TIMEOUT_MS / 1000} s`);
    expect(late.ok === false && late.message).toMatch(/may have been queued/);
    await expect(issuer.issue(CMD)).rejects.toThrow('fetch failed');
  });
});

// ============================================================ 3: the runner

const RUN = '0190f5a2-7c3e-7d4b-9a10-3f6c2b1e0a01';
const OTHER_RUN = '0190f5a2-7c3e-7d4b-9a10-3f6c2b1e0a99';

function simRequest(scenarioName = 'copilot: baseline') {
  return {
    buildingId: BUILDING_ID, scenarioName, description: `copilot run; user ${U}; request r1`,
    periodStart: new Date('2026-09-27T05:00:00Z'), periodEnd: new Date('2026-09-28T09:00:00Z'), intervalS: 3600,
    params: {}, zoneIds: [Z.off301, Z.off303],
    weather: { mode: 'synthetic' as const, peakDryBulbC: 46, minDryBulbC: 32, peakGhiW_m2: 950 },
  } as Parameters<ScenarioRunner['start']>[0];
}

/** What GET /runs/{id} returns: the worker writes unset params as null. */
function workerRun(id: string, status: string) {
  return {
    id, buildingId: BUILDING_ID, scenarioName: 'copilot: baseline', description: null,
    periodStart: '2026-09-27T05:00:00Z', periodEnd: '2026-09-28T09:00:00Z', intervalS: 3600,
    params: { setpointDeltaK: 1, lightingScale: null, equipmentScale: null, occupancyScale: null,
      hvacCopScale: null, infiltrationScale: null, gridCarbonKgPerKwh: null },
    status, progressPct: status === 'completed' ? 100 : 50,
    requestedAt: '2026-09-28T08:40:00Z', startedAt: '2026-09-28T08:40:01Z',
    completedAt: status === 'completed' ? '2026-09-28T08:40:09Z' : null, error: null,
  };
}

describe('capability: scenario runner', () => {
  it('exists only with COPILOT_SIM_API_KEY, and never falls back to SIM_API_KEY', () => {
    expect(realScenarioRunner(T, { env: { SIM_API_KEY: 'web-proxy-key' } })).toBeNull();
    expect(realScenarioRunner(T, { env: { SIM_API_KEY: 'web-proxy-key', COPILOT_SIM_API_KEY: '  ' } })).toBeNull();
    expect(realScenarioRunner(T, { env: { COPILOT_SIM_API_KEY: 'copilot-sim-key' } })).not.toBeNull();
    vi.stubEnv('COPILOT_SIM_API_KEY', '');
    expect(realScenarioRunner(T)).toBeNull();
  });

  it('refuses, BEFORE fetch, every worker route that is not on the allow-list', async () => {
    const { fn } = stubFetch();
    const simFetch = makeSimFetch({ baseUrl: 'http://sim.test', apiKey: 'copilot-sim-key', tenantId: T, fetchImpl: fn });
    const forged: Array<[string, string, unknown]> = [
      ['POST', '/weather/generate', { buildingId: BUILDING_ID }],
      ['GET', '/weather/generate', undefined],
      ['POST', '/control/commands', { zoneId: Z.off301, setpointTempC: 21, reason: 'x', dryRun: true }],
      ['POST', '/control/settings', { enabled: true }],
      ['GET', '/simulate', undefined],
      ['POST', '/simulate', undefined],
      ['GET', '/runs/not-a-uuid', undefined],
      ['GET', `/runs/${RUN}/summary`, undefined],
      ['GET', `/runs/${RUN}/../../weather/generate`, undefined],
      ['DELETE', `/runs/${RUN}`, undefined],
      // Run-scoped routes for a run this runner did not start.
      ['GET', `/runs/${RUN}`, undefined],
      ['GET', `/runs/${RUN}/results?limit=10`, undefined],
      ['POST', `/runs/${RUN}/cancel`, undefined],
    ];
    for (const [method, path, body] of forged) {
      await expect(simFetch(method, path, body), `${method} ${path}`).rejects.toBeInstanceOf(SimRouteRefused);
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it('owns only the runs the worker said it started, and bounds the results limit', async () => {
    const { fn, sent } = stubFetch(json(202, { runId: RUN, status: 'queued', zonesWithoutProfile: 0 }));
    const simFetch = makeSimFetch({ baseUrl: 'http://sim.test', apiKey: 'copilot-sim-key', tenantId: T, fetchImpl: fn });
    await simFetch('POST', '/simulate', { any: 'body' });
    for (const path of [`/runs/${RUN}/results?limit=0`, `/runs/${RUN}/results?limit=10001`,
      `/runs/${RUN}/results?limit=5&zoneId=${Z.off301}`, `/runs/${RUN}/results`, `/runs/${OTHER_RUN}`]) {
      await expect(simFetch('GET', path), path).rejects.toBeInstanceOf(SimRouteRefused);
    }
    await expect(simFetch('POST', `/runs/${OTHER_RUN}/cancel`)).rejects.toBeInstanceOf(SimRouteRefused);
    await expect(simFetch('POST', `/runs/${RUN}/cancel`, { reason: 'x' })).rejects.toBeInstanceOf(SimRouteRefused);
    expect(sent).toHaveLength(1);
  });

  it('runs one scenario end to end on the sim-only key, stripping the worker’s null params', async () => {
    const row = {
      zoneId: Z.off301, intervalStart: '2026-09-28T05:00:00Z', hvacLoadKwh: 2.4, lightingKwh: 0.8, plugKwh: 1.2,
      totalKwh: 4.4, co2Kg: 1.848, peakDemandKw: 4.4, indoorTempC: 23.3, solarGainKwh: 0.6, internalGainKwh: 1.5,
      envelopeLossKwh: 0.4, ventilationLossKwh: 0.5, occupancyCount: 16, unmetHours: 0,
    };
    const { fn, sent } = stubFetch(
      json(202, { runId: RUN, status: 'queued', zonesWithoutProfile: 0 }),
      json(200, workerRun(RUN, 'running')),
      json(200, workerRun(RUN, 'completed')),
      json(200, { results: [row, { ...row, zoneId: Z.off303 }] }),
      json(409, { detail: 'run has already finished' }),
    );
    const runner = realScenarioRunner(T, { fetchImpl: fn })!;

    expect(await runner.start(simRequest())).toEqual({ ok: true, runId: RUN });
    expect(sent[0]).toMatchObject({ method: 'POST', url: 'http://sim.test/simulate' });
    expect(sent[0]!.headers).toMatchObject({ authorization: 'Bearer copilot-sim-key', 'x-tenant-id': T });
    expect(sent[0]!.body).toMatchObject({
      buildingId: BUILDING_ID, periodStart: '2026-09-27T05:00:00.000Z', weather: { mode: 'synthetic', peakDryBulbC: 46 },
    });
    expect(copilotSlotHeld()).toBe(true);

    expect(await runner.getRun(RUN)).toEqual({ status: 'running', progressPct: 50, error: null });
    expect(copilotSlotHeld()).toBe(true);
    expect(await runner.getRun(RUN)).toEqual({ status: 'completed', progressPct: 100, error: null });
    expect(copilotSlotHeld()).toBe(false);   // a finished run holds no worker slot, so none of ours

    const rows = await runner.getResults(RUN, 2);
    expect(sent[3]!.url).toBe(`http://sim.test/runs/${RUN}/results?limit=2`);
    expect(rows.map((r) => r.zoneId)).toEqual([Z.off301, Z.off303]);
    expect(rows[0]!.intervalStart).toEqual(new Date('2026-09-28T05:00:00Z'));
    await expect(runner.getResults(RUN, 10_001)).rejects.toBeInstanceOf(RangeError);

    await runner.cancel(RUN);   // 409: already finished, which is fine
    expect(sent[4]).toMatchObject({ method: 'POST', url: `http://sim.test/runs/${RUN}/cancel` });
    await expect(runner.cancel(OTHER_RUN)).rejects.toBeInstanceOf(SimRouteRefused);
    await expect(runner.getRun(OTHER_RUN)).rejects.toBeInstanceOf(SimRouteRefused);
    expect(sent).toHaveLength(5);
    for (const s of sent) expect(s.headers.authorization).toBe('Bearer copilot-sim-key');
  });

  it('a worker 429 is surfaced once, never retried, and frees the slot', async () => {
    const { fn, sent } = stubFetch(json(429, { detail: '2 simulation(s) already running; retry when one finishes' }));
    const runner = realScenarioRunner(T, { fetchImpl: fn })!;
    expect(await runner.start(simRequest())).toEqual({
      ok: false, reason: 'busy', status: 429, message: '2 simulation(s) already running; retry when one finishes',
    });
    expect(sent).toHaveLength(1);
    expect(copilotSlotHeld()).toBe(false);
  });

  it('one copilot run per web process: a second is refused before any request, until the first ends', async () => {
    const { fn, sent } = stubFetch(
      json(202, { runId: RUN, status: 'queued', zonesWithoutProfile: 0 }),
      json(200, { runId: RUN, status: 'cancelled' }),
      json(202, { runId: OTHER_RUN, status: 'queued', zonesWithoutProfile: 0 }),
      json(200, workerRun(OTHER_RUN, 'completed')),
    );
    const mine = realScenarioRunner(T, { fetchImpl: fn })!;
    const someoneElses = realScenarioRunner('00000000-0000-4000-a000-0000000000ff', { fetchImpl: fn })!;

    expect(await mine.start(simRequest())).toMatchObject({ ok: true });
    expect(await someoneElses.start(simRequest())).toEqual({
      ok: false, reason: 'busy', status: 0,
      message: 'another copilot simulation is running in this service; one runs at a time',
    });
    expect(sent).toHaveLength(1);

    await mine.cancel(RUN);
    expect(copilotSlotHeld()).toBe(false);
    expect(await someoneElses.start(simRequest())).toEqual({ ok: true, runId: OTHER_RUN });
    await someoneElses.getRun(OTHER_RUN);
    expect(copilotSlotHeld()).toBe(false);
  });

  it('a slot whose run was never seen to end is freed by its lease, not held for ever', async () => {
    let now = Date.parse('2026-09-28T08:40:00Z');
    const { fn } = stubFetch(
      json(202, { runId: RUN, status: 'queued', zonesWithoutProfile: 0 }),
      new TypeError('fetch failed'),   // the cancel cannot reach the worker
      json(202, { runId: OTHER_RUN, status: 'queued', zonesWithoutProfile: 0 }),
      json(200, workerRun(OTHER_RUN, 'completed')),
    );
    const runner = realScenarioRunner(T, { fetchImpl: fn, clock: () => now })!;
    await runner.start(simRequest());
    await expect(runner.cancel(RUN)).rejects.toThrow('fetch failed');
    expect(await runner.start(simRequest())).toMatchObject({ ok: false, reason: 'busy', status: 0 });
    now += 60_000;
    expect(await runner.start(simRequest())).toEqual({ ok: true, runId: OTHER_RUN });
    await runner.getRun(OTHER_RUN);
  });

  it('strips only null params, leaving everything else to Zod', () => {
    expect(stripNullParams(workerRun(RUN, 'running'))).toMatchObject({ params: { setpointDeltaK: 1 } });
    expect((stripNullParams(workerRun(RUN, 'running')) as { params: object }).params).not.toHaveProperty('lightingScale');
    expect(stripNullParams(null)).toBeNull();
    expect(stripNullParams({ params: null })).toEqual({ params: null });
  });
});

// ======================================================= 4: READ ONLY reads

const FROM = new Date('2026-09-28T05:00:00Z');
const TO = new Date('2026-09-28T08:40:00Z');

const EVERY_READ: ReadonlyArray<readonly [ReaderMethod, (r: TwinReader) => Promise<unknown>]> = [
  ['orient', (r) => r.orient()],
  ['listZones', (r) => r.listZones()],
  ['zoneConditions', (r) => r.zoneConditions({ zoneId: Z.off305, from: FROM, to: TO })],
  ['zoneHistory', (r) => r.zoneHistory({ zoneId: Z.off305, metrics: ['temperature_c'], resolution: '5m', from: FROM, to: TO })],
  ['zoneTimeline', (r) => r.zoneTimeline({ zoneId: Z.off305, from: FROM, to: TO, limit: 50 })],
  ['equipmentStatus', (r) => r.equipmentStatus({ tag: null, zoneId: Z.off305, limit: 40, buildingId: BUILDING_ID })],
  ['listAlerts', (r) => r.listAlerts({ state: 'any', from: FROM, to: TO, zoneId: null, limit: 50, buildingId: BUILDING_ID })],
  ['controlHistory', (r) => r.controlHistory({ zoneId: null, from: FROM, to: TO, limit: 50, buildingId: BUILDING_ID })],
  ['energyByEndUse', (r) => r.energyByEndUse({ from: FROM, to: TO, groupBy: 'local_day', timezone: 'Asia/Dubai', buildingId: BUILDING_ID })],
  ['meterConsumption', (r) => r.meterConsumption({ meterTag: 'MTR-MAIN', from: FROM, to: TO, bucket: 'hour', timezone: 'Asia/Dubai', buildingId: BUILDING_ID })],
  ['compareZones', (r) => r.compareZones({ metric: 'temperature_c', from: FROM, to: TO, floorLevel: 3, orderBy: 'mean', limit: 24, now: TO, buildingId: BUILDING_ID })],
];

describe('capability: reader opens READ ONLY', () => {
  it('covers every reader method', () => {
    expect(EVERY_READ.map(([m]) => m).sort()).toEqual([...TWIN_READER_METHODS].sort());
  });

  it.each(EVERY_READ)('%s is one READ ONLY transaction, scoped to the tenant and the user', async (_method, read) => {
    await read(realReader(T, U));
    const s = pg.state.statements;
    expect(new Set(s.map((x) => x.client)).size).toBe(1);
    expect(s[0]!.text).toBe('BEGIN READ ONLY');
    expect(s[1]!.text).toMatch(/set_config\('app\.tenant_id', \$1, true\)/);
    expect(s[1]!.params).toEqual([T, U]);
    expect(s.at(-2)!.text).toBe('COMMIT');
    expect(s.at(-1)!.text).toBe('<release>');
    expect(s.filter((x) => /^\s*BEGIN\s*$/i.test(x.text))).toEqual([]);
    expect(s.filter((x) => /^\s*(INSERT|UPDATE|DELETE|MERGE|COPY|TRUNCATE)\b/i.test(x.text))).toEqual([]);
  });

  it('the meter sets max_parallel_workers_per_gather inside the transaction, before any rollup', async () => {
    pg.state.respond = (text) => (/equipment_type IN \('electric_meter', 'water_meter'\)/.test(text)
      ? { rows: [{ tag: 'MTR-MAIN', type: 'electric_meter', sensor_id: 's-1', metric: 'energy_kwh' }], rowCount: 1 }
      : { rows: [], rowCount: 0 });
    const rows = await realReader(T, U).meterConsumption({
      meterTag: 'MTR-MAIN', from: FROM, to: TO, bucket: 'hour', timezone: 'Asia/Dubai', buildingId: BUILDING_ID,
    });
    expect(rows).toMatchObject({ unit: 'kwh', meter: { tag: 'MTR-MAIN' } });
    const texts = pg.state.statements.map((x) => x.text);
    const setLocal = texts.indexOf('SET LOCAL max_parallel_workers_per_gather = 0');
    const firstRollup = texts.findIndex((t) => t.includes('telemetry_1h_t'));
    expect(texts[0]).toBe('BEGIN READ ONLY');
    expect(setLocal).toBeGreaterThan(1);
    expect(firstRollup).toBeGreaterThan(setLocal);
    expect(texts.at(-2)).toBe('COMMIT');
  });

  it('a read that fails rolls back and releases its connection', async () => {
    pg.state.respond = (text) => {
      if (text.includes('FROM buildings')) throw new Error('connection reset');
      return { rows: [], rowCount: 0 };
    };
    await expect(realReader(T, U).orient()).rejects.toThrow('connection reset');
    const texts = pg.state.statements.map((x) => x.text);
    expect(texts[0]).toBe('BEGIN READ ONLY');
    expect(texts.slice(-2)).toEqual(['ROLLBACK', '<release>']);
    expect(texts).not.toContain('COMMIT');
  });
});

// ================================================================= inert

describe('inert deps', () => {
  it('refuse every capability and the model, and touch neither network nor database', async () => {
    const { fn } = stubFetch();
    const d = inertDeps();
    for (const m of TWIN_READER_METHODS) {
      await expect((d.reader[m] as () => Promise<unknown>)(), m).rejects.toBeInstanceOf(InertDepsError);
    }
    await expect(d.probe.settings()).rejects.toBeInstanceOf(InertDepsError);
    await expect(d.probe.dryRun(CMD)).rejects.toBeInstanceOf(InertDepsError);
    await expect(d.issuer.issue(CMD)).rejects.toBeInstanceOf(InertDepsError);
    await expect(d.callModel({ model: 'none', max_tokens: 1, messages: [] })).rejects.toBeInstanceOf(InertDepsError);
    expect(d.scenarios).toBeNull();
    expect(fn).not.toHaveBeenCalled();
    expect(pg.state.statements).toEqual([]);
  });
});

// ============================================== 2: specialists and the issuer

describe('capability: specialists never touch issue', () => {
  it('2. the compound run on recording capabilities: nothing outside an interface is read, and the issuer only after approval', async () => {
    // Any fetch fails the run: the fakes are the only way out.
    const { fn } = stubFetch();
    const fake = fakeDeps({ script: compoundScript(), scenarios: 'ok' });
    // The fakes are already strict (they throw on a property outside the
    // interface), but a throw inside a tool becomes an is_error the model
    // reads. So every read is RECORDED here too, and judged afterwards.
    const touched: string[] = [];
    const record = <C extends object>(target: C, label: string): C => new Proxy(target, {
      get(t, prop, receiver) {
        if (typeof prop === 'string') touched.push(`${label}.${prop}`);
        return Reflect.get(t, prop, receiver) as unknown;
      },
    });
    const graph = buildCopilotGraph({
      ...fake.deps,
      reader: record(fake.deps.reader, 'TwinReader'),
      probe: record(fake.deps.probe, 'ControlProbe'),
      scenarios: record(fake.deps.scenarios!, 'ScenarioRunner'),
      issuer: record(fake.deps.issuer, 'Issuer'),
      log: memoryLogger(),
    });

    const turn = await sendMessage(graph, 'cap2', 'Check the Level 3 offices, simulate a 1 K cooler setpoint, then propose it', { mayCommand: true });

    expect(turn.pendingPlan).not.toBeNull();
    const allowed = new Set([
      ...TWIN_READER_METHODS.map((m) => `TwinReader.${m}`),
      ...CONTROL_PROBE_METHODS.map((m) => `ControlProbe.${m}`),
      ...SCENARIO_RUNNER_METHODS.map((m) => `ScenarioRunner.${m}`),
    ]);
    expect(touched.filter((t) => !allowed.has(t))).toEqual([]);
    // Not vacuous: the run read, dry-ran and simulated through these very objects.
    expect(new Set(touched)).toEqual(new Set([
      'TwinReader.orient', 'TwinReader.zoneConditions', 'TwinReader.listZones',
      'ControlProbe.settings', 'ControlProbe.dryRun',
      'ScenarioRunner.start', 'ScenarioRunner.getRun', 'ScenarioRunner.getResults',
    ]));

    const before = touched.length;
    await decide(graph, 'cap2', {
      decision: 'approved', interruptId: turn.pendingPlan!.interruptId,
      planId: turn.pendingPlan!.planId, planHash: turn.pendingPlan!.planHash,
    });
    expect(touched.slice(before)).toEqual(['Issuer.issue', 'Issuer.issue']);
    expect(fake.issuer.issued).toHaveLength(2);
    expect(fn).not.toHaveBeenCalled();
    expect(pg.state.statements).toEqual([]);
  });
});

// ============================================================ 5: the WRITES map

/** Every raw chunk the graph streams, however the session consumes it. */
function tap(graph: CopilotGraph): unknown[] {
  const chunks: unknown[] = [];
  const original = graph.stream.bind(graph);
  vi.spyOn(graph, 'stream').mockImplementation((async (input: never, config: never) => {
    const it = await original(input, config);
    return (async function* () {
      for await (const c of it) {
        chunks.push(c);
        yield c;
      }
    })();
  }) as never);
  return chunks;
}

describe('capability: the WRITES map', () => {
  it('5. every node\'s update keys are within WRITES[node]; only control declares `proposal`; only plan_check sets a plan, only apply outcomes', async () => {
    const chunks: unknown[] = [];
    const words = (t: string) => composeMsg({ paragraphs: [{ segments: [{ kind: 'text', text: t }] }], caveats: [] });

    // A wave (diagnose, analyse, join, compose, verify) and the compound path (simulate), approved (apply).
    const q = harness({
      planner: [
        plannerMsg({
          next: 'dispatch',
          tasks: [
            { specialist: 'diagnose', goal: 'why OFF-305 warm', zoneIds: [Z.off305], from: SINCE_9, to: NOW_LOCAL },
            { specialist: 'analyse', goal: 'rank the floors', from: SINCE_9, to: NOW_LOCAL },
          ],
        }),
        plannerMsg({ next: 'compose' }),
      ],
      'diagnose:T1': [message([toolUse('zone_conditions', { zoneId: Z.off305, from: SINCE_9, to: NOW_LOCAL })]), message([report()])],
      'analyse:T2': [message([toolUse('energy_by_end_use', { from: SINCE_9, to: NOW_LOCAL, groupBy: 'floor' })]), message([report()])],
      compose: [words('OFF-305 is warm.')],
    });
    chunks.push(tap(q.graph));
    await q.send('w1', 'why is OFF-305 warm?');

    const c = harness(compoundScript(), { scenarios: 'ok' });
    chunks.push(tap(c.graph));
    await c.decide('w2', (await c.send('w2', 'check, simulate, propose')).turn, 'approved');

    // The fast path, declined; then superseded; then a context that cannot be read.
    const f = harness({ ...fastPathScript(), planner: [...fastPathScript().planner!, ...fastPathScript().planner!] });
    chunks.push(tap(f.graph));
    await f.decide('w3', (await f.send('w3', 'pre-cool L3')).turn, 'declined');
    await f.send('w4', 'pre-cool L3');
    f.fake.reader.throwOn.add('orient');
    await f.send('w4', 'and again');

    // plan_check refuses: the kill switch goes off between propose_plan's dry run and plan_check's.
    const k = harness({
      planner: fastPathScript().planner!,
      control: [
        message([toolUse('propose_plan', {
          summary: 'Raise OFF-301.', commands: [{ zoneId: Z.off301, setpointTempC: 24, reason: 'pre-cool' }],
        })]),
        () => { k.fake.probe.settings.enabled = false; return message([report()]); },
      ],
    });
    chunks.push(tap(k.graph));
    const refused = await k.send('w5', 'pre-cool OFF-301');
    expect(refused.turn.notices.map((n) => n.code)).toContain('plan_refused');

    const all = (chunks as unknown[][]).flat() as Array<[string[], string, Record<string, unknown>]>;
    const nodesSeen = new Set<string>();
    for (const [ns, mode, payload] of all) {
      if (mode !== 'updates') continue;
      if (ns.length === 0) {
        for (const [node, update] of Object.entries(payload)) {
          if (node === '__interrupt__' || update === null || update === undefined) continue;
          nodesSeen.add(node);
          const allowed: readonly string[] = WRITES[node as keyof typeof WRITES];
          expect(Object.keys(update as object).filter((key) => !allowed.includes(key)), node).toEqual([]);
          const u = update as { pendingPlan?: unknown; outcomes?: unknown[]; proposal?: unknown };
          if (u.pendingPlan !== undefined && u.pendingPlan !== null) expect(node, 'sets a pending plan').toBe('plan_check');
          if (u.outcomes !== undefined && u.outcomes.length > 0) expect(node, 'records outcomes').toBe('apply');
          if (u.proposal !== undefined && u.proposal !== null) expect(node, 'writes a proposal').toBe('control');
        }
      } else if ('finish' in payload) {
        // A specialist's own finish writes only what its output schema declares.
        const role = ns[0]!.split(':', 1)[0]!;
        const outputs = (c.graph as unknown as { builder: { nodes: Record<string, { runnable: { outputChannels: string[] } }> } })
          .builder.nodes[role]!.runnable.outputChannels;
        expect(Object.keys(payload.finish as object).filter((key) => !outputs.includes(key)), `${role}:finish`).toEqual([]);
      }
    }
    expect([...nodesSeen].sort()).toEqual(Object.keys(WRITES).sort());

    // Only the controller's subgraph can hand a proposal to the parent at all.
    const nodes = (c.graph as unknown as { builder: { nodes: Record<string, { runnable: { outputChannels?: string[] } }> } }).builder.nodes;
    for (const role of ['diagnose', 'analyse', 'simulate']) {
      expect(nodes[role]!.runnable.outputChannels).toEqual(['findings', 'evidence', 'simRuns']);
    }
    expect(nodes.control!.runnable.outputChannels).toEqual(['findings', 'evidence', 'controlTask', 'proposal']);
    expect(Object.entries(WRITES).filter(([, keys]) => (keys as readonly string[]).includes('proposal')).map(([n]) => n)).toEqual(['intake', 'control']);
    expect(Object.entries(WRITES).filter(([, keys]) => (keys as readonly string[]).includes('outcomes')).map(([n]) => n)).toEqual(['intake', 'apply']);
  });
});
