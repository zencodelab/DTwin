import type Anthropic from '@anthropic-ai/sdk';
import type { ControlSettings, SimulationRequest, SimulationStatus } from '@dtwin/types';
import type { z } from 'zod';
import type { AnswerDoc } from '../evidence.ts';
import type { PlannerDecision } from '../planner.ts';
import type { Limits } from '../limits.ts';
import { ROLES, type ModelCaller, type Role } from '../registry.ts';
import {
  CONTROL_PROBE_METHODS, ISSUER_METHODS, SCENARIO_RUNNER_METHODS, TWIN_READER_METHODS,
  type CommandSpec, type ControlProbe, type DryRunResult, type GraphDeps, type IssueResult, type Issuer,
  type ReaderMethod, type ScenarioRunner, type SimResultRow, type SimRunState, type SimStartResult,
  type TwinReader,
} from '../deps.ts';
import * as fx from './fixtures.ts';

export * from './fixtures.ts';

/**
 * Fakes for every copilot capability, a scripted model, and `fakeDeps()` to
 * bundle them (§6). No network, no database, no real clock: every test that
 * runs the graph runs it against these.
 *
 * Every fake capability is wrapped in a Proxy that THROWS on any property its
 * interface does not declare. A specialist that reached for `reader.issue`,
 * or a tool that poked at `scenarios.fetch`, fails the test on the spot
 * rather than quietly reading `undefined` (capability test 2). The spies and
 * switches a test needs live on the object `fakeX()` returns, beside the
 * capability — never on it.
 *
 * Excluded from the source scan (§10): nothing here is production code.
 */

// ==================================================================== clock

export interface FakeClock {
  now(): number;
  iso(): string;
  advance(ms: number): void;
  set(t: number | string): void;
}

/** Starts at 2026-09-28T08:40:00Z — 12:40 in Asia/Dubai, "since 9" is 3 h 40 min. */
export function fakeClock(start: number | string = fx.FAKE_NOW_ISO): FakeClock {
  let t = typeof start === 'number' ? start : Date.parse(start);
  return {
    now: () => t,
    iso: () => new Date(t).toISOString(),
    advance: (ms) => { t += ms; },
    set: (v) => { t = typeof v === 'number' ? v : Date.parse(v); },
  };
}

// ========================================================== strict wrapping

/**
 * `target` behind a Proxy that answers only the interface's own methods.
 * Symbols pass (inspection), and the two string keys JavaScript itself reads
 * off any value — `then` (by `await`) and `toJSON` (by JSON.stringify) —
 * answer "absent", so the fake stays a plain, non-thenable value. Any other
 * property throws, naming it.
 */
export function strictCapability<T extends object>(target: T, methods: readonly string[], label: string): T {
  const allowed = new Set<string>(methods);
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === 'symbol' || allowed.has(prop)) return Reflect.get(t, prop, receiver) as unknown;
      if (prop === 'then' || prop === 'toJSON') return undefined;
      throw new Error(`${label}.${prop} is not part of the ${label} interface`);
    },
    set(_t, prop) {
      throw new Error(`${label} is not writable (tried to set ${String(prop)})`);
    },
  });
}

// =================================================================== reader

/** The one argument a reader method takes, or undefined for `orient` and `listZones`. */
export type ReaderQuery<M extends ReaderMethod> = Parameters<TwinReader[M]> extends [infer Q] ? Q : undefined;

export interface ReaderSpy {
  /** Every call's query, per method, in call order. */
  calls: { [M in ReaderMethod]: Array<ReaderQuery<M>> };
  inFlight: number;
  peakInFlight: number;
  total(): number;
}

export interface FakeReader {
  /** The capability to hand the graph: strict, spied, cloned on the way out. */
  reader: TwinReader;
  spy: ReaderSpy;
  /** Methods that throw (the tool reports "database unavailable"). */
  throwOn: Set<ReaderMethod>;
  /** Real-timer delays per method, for overlap and ordering tests. */
  delayMs: Map<ReaderMethod, number>;
}

/**
 * A reader over the fixtures, with `overrides` replacing any method. Windows
 * are applied as the real queries apply them, except `meterConsumption`,
 * whose fixtures are fixed series (see `meterFixture`).
 */
export function fakeReader(overrides: Partial<TwinReader> = {}, opts: { clock?: () => number } = {}): FakeReader {
  const now = opts.clock ?? (() => Date.parse(fx.FAKE_NOW_ISO));
  const impl: TwinReader = { ...fixtureReader(now), ...overrides };
  const calls = Object.fromEntries(TWIN_READER_METHODS.map((m) => [m, []])) as unknown as ReaderSpy['calls'];
  const spy: ReaderSpy = {
    calls,
    inFlight: 0,
    peakInFlight: 0,
    total: () => TWIN_READER_METHODS.reduce((s, m) => s + calls[m].length, 0),
  };
  const throwOn = new Set<ReaderMethod>();
  const delayMs = new Map<ReaderMethod, number>();

  const wrapped: Record<string, (q?: unknown) => Promise<unknown>> = {};
  for (const m of TWIN_READER_METHODS) {
    const run = impl[m] as (q?: unknown) => Promise<unknown>;
    wrapped[m] = async (q?: unknown) => {
      (calls[m] as unknown[]).push(q);
      spy.inFlight += 1;
      spy.peakInFlight = Math.max(spy.peakInFlight, spy.inFlight);
      try {
        const d = delayMs.get(m);
        if (d) await new Promise((resolve) => setTimeout(resolve, d));
        if (throwOn.has(m)) throw new Error(`fake reader: ${m} failed (throwOn)`);
        // Cloned, so a tool that trims a result cannot edit the next call's fixture.
        return structuredClone(await run(q));
      } finally {
        spy.inFlight -= 1;
      }
    };
  }
  return {
    reader: strictCapability(wrapped as unknown as TwinReader, TWIN_READER_METHODS, 'TwinReader'),
    spy, throwOn, delayMs,
  };
}

function fixtureReader(now: () => number): TwinReader {
  const nameOf = (id: string | null) => (id === null ? null : fx.zoneById(id)?.name ?? '');
  return {
    orient: async () => fx.orientFixture(now()),
    listZones: async () => fx.listZonesFixture(),
    zoneConditions: async (q) => {
      const z = fx.zoneById(q.zoneId);
      return z ? fx.zoneConditionsFixture(z, q.from.getTime(), q.to.getTime(), now()) : null;
    },
    zoneHistory: async (q) => {
      const z = fx.zoneById(q.zoneId);
      return z
        ? fx.zoneHistoryFixture(z, q.metrics, q.resolution, q.from.getTime(), q.to.getTime(), now())
        : { resolution: q.resolution, series: {} };
    },
    zoneTimeline: async (q) => {
      const z = fx.zoneById(q.zoneId);
      if (z) return fx.zoneTimelineFixture(z, q.from.getTime(), q.to.getTime(), q.limit, now());
      return { ...fx.cappedOf([], q.limit), rulesInScope: fx.cappedOf([], 50) };
    },
    equipmentStatus: async (q) => {
      if (q.tag !== null && q.zoneId !== null) throw new RangeError('equipment status takes a tag or a zone, not both');
      let list: readonly fx.SeedEquipment[] = fx.EQUIPMENT;
      if (q.tag !== null) list = list.filter((e) => e.tag === q.tag);
      if (q.zoneId !== null) {
        const z = fx.zoneById(q.zoneId);
        list = z ? fx.servingChain(z) : [];
      }
      return fx.cappedOf(list.map((e) => fx.equipmentRow(e, now())), q.limit);
    },
    listAlerts: async (q) => {
      const zone = nameOf(q.zoneId);
      const rows = fx.ALERTS
        .filter((a) => Date.parse(a.opened_at) < q.to.getTime()
          && (a.resolved_at === null || Date.parse(a.resolved_at) >= q.from.getTime()))
        .filter((a) => q.state === 'any' || (q.state === 'live') === (a.resolved_at === null))
        .filter((a) => zone === null || a.zone === zone)
        .sort((a, b) => Date.parse(b.opened_at) - Date.parse(a.opened_at))
        .map((a) => fx.alertRow(a, now()));
      return fx.cappedOf(rows, q.limit);
    },
    controlHistory: async (q) => {
      const zone = nameOf(q.zoneId);
      const rows = fx.COMMANDS
        .filter((c) => Date.parse(c.requested_at) < q.to.getTime() && Date.parse(c.effective_until) >= q.from.getTime())
        .filter((c) => zone === null || c.zone === zone)
        .sort((a, b) => Date.parse(b.requested_at) - Date.parse(a.requested_at))
        .map((c) => fx.commandRow(c, now()));
      return fx.cappedOf(rows, q.limit);
    },
    energyByEndUse: async (q) => {
      if (q.groupBy === 'local_day') assertTimezone(q.timezone);
      return fx.energyFixture(q.groupBy, q.from.getTime(), q.to.getTime());
    },
    meterConsumption: async (q) => {
      if (q.bucket === 'local_day') assertTimezone(q.timezone);
      return fx.meterFixture(q.meterTag, q.bucket);
    },
    compareZones: async (q) => fx.compareZonesFixture({
      metric: q.metric, fromMs: q.from.getTime(), toMs: q.to.getTime(),
      floorLevel: q.floorLevel, orderBy: q.orderBy, limit: q.limit, nowMs: q.now.getTime(),
    }),
  };
}

/** As the db layer: an unknown zone is a RangeError before any query, not "database unavailable". */
function assertTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new RangeError(`unknown time zone ${JSON.stringify(tz)}`);
  }
}

// ==================================================================== probe

export interface FakeProbe {
  probe: ControlProbe;
  /** Every dry run asked for, in order. */
  dryRuns: CommandSpec[];
  /** Methods that throw as if ingest were down. */
  throwOn: Set<'settings' | 'dryRun'>;
  /** The envelope `settings()` answers; edit it to change the answer. */
  settings: ControlSettings;
  settingsCalls(): number;
}

/**
 * v1's refusal rules: OFF-305 is refused `equipment_unavailable` (VAV-305 is
 * in fault in the fixture register) and SER-105 `feedback_unusable` (its
 * sensor is stale), a zone not in the directory `unknown_zone`, and
 * everything when the kill switch is off. The rest are allowed, from the
 * zone's designed setpoint, for the requested or default duration.
 */
export function fakeProbe(opts: { settingsThrows?: boolean; clock?: () => number } = {}): FakeProbe {
  const now = opts.clock ?? (() => Date.parse(fx.FAKE_NOW_ISO));
  const dryRuns: CommandSpec[] = [];
  const throwOn = new Set<'settings' | 'dryRun'>(opts.settingsThrows ? ['settings'] : []);
  let settingsCalls = 0;
  const fake: FakeProbe = {
    probe: undefined as unknown as ControlProbe,
    dryRuns,
    throwOn,
    settings: { ...fx.CONTROL_SETTINGS },
    settingsCalls: () => settingsCalls,
  };
  const probe: ControlProbe = {
    async settings() {
      settingsCalls += 1;
      if (throwOn.has('settings')) throw new Error('control settings unavailable: 503');
      return { ...fake.settings };
    },
    async dryRun(command) {
      dryRuns.push({ ...command });
      if (throwOn.has('dryRun')) throw new Error('fetch failed: control service unreachable');
      const z = fx.zoneById(command.zoneId);
      if (!z) return { allowed: false, refusal: 'unknown_zone', message: 'unknown zone' } satisfies DryRunResult;
      if (!fake.settings.enabled) {
        return { allowed: false, refusal: 'control_disabled', message: 'supervisory control is switched off' } satisfies DryRunResult;
      }
      if (z.name === 'OFF-305') {
        return { allowed: false, refusal: 'equipment_unavailable', message: 'VAV-305 (fault)' } satisfies DryRunResult;
      }
      if (z.name === 'SER-105') {
        return { allowed: false, refusal: 'feedback_unusable', message: 'no good temperature reading in the last hour' } satisfies DryRunResult;
      }
      const durationS = command.durationS ?? fake.settings.defaultDurationS;
      return {
        allowed: true, previousTempC: z.designed_setpoint_c, durationS,
        effectiveUntil: new Date(now() + durationS * 1000).toISOString(),
      } satisfies DryRunResult;
    },
  };
  fake.probe = strictCapability(probe, CONTROL_PROBE_METHODS, 'ControlProbe');
  return fake;
}

// =================================================================== issuer

export interface FakeIssuer {
  issuer: Issuer;
  /** Every command issued, in order. The number every safety test counts. */
  issued: CommandSpec[];
}

export function fakeIssuer(opts: { clock?: () => number } = {}): FakeIssuer {
  const now = opts.clock ?? (() => Date.parse(fx.FAKE_NOW_ISO));
  const issued: CommandSpec[] = [];
  const issuer: Issuer = {
    async issue(command) {
      issued.push({ ...command });
      return {
        ok: true, commandId: `cmd-${issued.length}`, state: 'pending',
        effectiveUntil: new Date(now() + (command.durationS ?? fx.CONTROL_SETTINGS.defaultDurationS) * 1000).toISOString(),
      } satisfies IssueResult;
    },
  };
  return { issuer: strictCapability(issuer, ISSUER_METHODS, 'Issuer'), issued };
}

// =============================================================== simulation

/**
 * - `ok`: every run completes on its first `getRun`.
 * - `busy429`: `start` answers the worker's admission refusal.
 * - `hang`: runs stay `running` for ever (the tool's deadline must cancel).
 * - `short`: results come back one row short (the tool must refuse them).
 */
export type FakeScenarioMode = 'ok' | 'busy429' | 'hang' | 'short';

export interface FakeScenarios {
  scenarios: ScenarioRunner;
  mode: FakeScenarioMode;
  /** Every request body `start` received, in order. */
  requests: SimulationRequest[];
  /** Run ids `start` issued, in order. */
  started: string[];
  cancelled: string[];
  getRunCalls: number;
  resultCalls: Array<{ runId: string; limit: number }>;
  inFlight: number;
  peakInFlight: number;
}

export function fakeScenarios(mode: FakeScenarioMode = 'ok'): FakeScenarios {
  const runs = new Map<string, { req: SimulationRequest; status: SimulationStatus }>();
  const fake: FakeScenarios = {
    scenarios: undefined as unknown as ScenarioRunner,
    mode, requests: [], started: [], cancelled: [], getRunCalls: 0, resultCalls: [], inFlight: 0, peakInFlight: 0,
  };
  const live = (s: SimulationStatus) => s === 'queued' || s === 'running';
  const runOf = (runId: string) => {
    const run = runs.get(runId);
    if (!run) throw new Error(`fake scenarios: no run ${runId}`);
    return run;
  };

  const runner: ScenarioRunner = {
    async start(req) {
      fake.requests.push(structuredClone(req));
      if (mode === 'busy429') {
        return {
          ok: false, reason: 'busy', status: 429,
          message: '2 simulation(s) already running; retry when one finishes',
        } satisfies SimStartResult;
      }
      const runId = `00000000-0000-4000-9000-${String(runs.size + 1).padStart(12, '0')}`;
      runs.set(runId, { req: structuredClone(req), status: 'queued' });
      fake.started.push(runId);
      fake.inFlight += 1;
      fake.peakInFlight = Math.max(fake.peakInFlight, fake.inFlight);
      return { ok: true, runId } satisfies SimStartResult;
    },
    async getRun(runId) {
      fake.getRunCalls += 1;
      const run = runOf(runId);
      if (live(run.status)) {
        if (mode === 'hang') {
          run.status = 'running';
        } else {
          run.status = 'completed';
          fake.inFlight -= 1;
        }
      }
      return {
        status: run.status, progressPct: run.status === 'completed' ? 100 : 40, error: null,
      } satisfies SimRunState;
    },
    async getResults(runId, limit) {
      fake.resultCalls.push({ runId, limit });
      const run = runOf(runId);
      if (run.status !== 'completed') return [];
      const rows = fakeSimRows(run.req);
      return (mode === 'short' ? rows.slice(0, -1) : rows).slice(0, limit);
    },
    async cancel(runId) {
      const run = runOf(runId);
      fake.cancelled.push(runId);
      if (live(run.status)) {
        run.status = 'cancelled';
        fake.inFlight -= 1;
      }
    },
  };
  fake.scenarios = strictCapability(runner, SCENARIO_RUNNER_METHODS, 'ScenarioRunner');
  return fake;
}

/**
 * Deterministic worker output for a request: one row per (interval, zone),
 * ordered as the worker orders them, unknown zones dropped as the worker
 * drops them. Occupied 08:00–18:00 building time at 80% of design occupancy.
 * A setpoint shift of Δ K moves every indoor temperature by Δ K and scales
 * HVAC energy by (1 − 0.05·Δ): the `+1` scenario is 1 K warmer and 5% cheaper
 * on HVAC. `unmetHours` is 0 — each run meets its OWN shifted band, which is
 * exactly why the tool judges comfort against the designed band instead.
 */
export function fakeSimRows(req: SimulationRequest): SimResultRow[] {
  const deltaK = req.params.setpointDeltaK ?? 0;
  const stepMs = req.intervalS * 1000;
  const h = req.intervalS / 3600;
  const zones = (req.zoneIds ?? fx.ZONES.map((z) => z.id))
    .map((id) => fx.zoneById(id))
    .filter((z): z is fx.SeedZone => z !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
  const rows: SimResultRow[] = [];
  for (let t = req.periodStart.getTime(); t < req.periodEnd.getTime(); t += stepMs) {
    const localHour = (new Date(t).getUTCHours() + 4) % 24;   // Asia/Dubai, no DST
    const occupied = localHour >= 8 && localHour < 18;
    for (const z of zones) {
      const hvac = Math.max(0, (occupied ? 2.4 : 1.1) * (z.area_m2 / 200) * (1 - 0.05 * deltaK) * h);
      const lighting = (occupied ? 0.8 : 0.1) * h;
      const plug = (occupied ? 1.2 : 0.3) * h;
      const total = hvac + lighting + plug;
      rows.push({
        zoneId: z.id as SimResultRow['zoneId'],
        intervalStart: new Date(t),
        hvacLoadKwh: hvac,
        lightingKwh: lighting,
        plugKwh: plug,
        totalKwh: total,
        co2Kg: total * 0.42,
        peakDemandKw: total / h,
        indoorTempC: z.designed_setpoint_c + 0.3 + deltaK,
        solarGainKwh: occupied ? 0.6 * h : 0,
        internalGainKwh: (occupied ? 1.5 : 0.2) * h,
        envelopeLossKwh: 0.4 * h,
        ventilationLossKwh: (occupied ? 0.5 : 0.1) * h,
        occupancyCount: occupied ? 0.8 * z.design_occupancy_count : 0,
        unmetHours: 0,
      });
    }
  }
  return rows;
}

// ==================================================================== model

export type ScriptStep =
  | Anthropic.Message
  | Error
  | ((params: Anthropic.MessageCreateParamsNonStreaming) => Anthropic.Message | Promise<Anthropic.Message>);

/** Replies per key: `planner`, `compose`, `control`, or `<role>:<taskId>` for a specialist (`diagnose:T1`). */
export type Script = Record<string, ScriptStep[]>;

export interface ScriptedModel {
  call: ModelCaller;
  /** The params of every call, per key, as they were when sent. */
  calls: Record<string, Anthropic.MessageCreateParamsNonStreaming[]>;
  /** The key of every call, in call order. */
  order: string[];
  count(key?: string): number;
  remaining(key: string): number;
}

const SPECIALIST_ROLES: ReadonlySet<Role> = new Set<Role>(['diagnose', 'analyse', 'simulate']);

/**
 * A model that answers from a script. Each call is routed by the constant
 * first line of `system[0].text` (`ROLE=planner` …) and, for the three
 * specialists, by the `taskId` in the JSON of the first user message — so
 * parallel tasks each get their own queue and their interleaving cannot
 * reorder a test's script. A step that is an `Error` is thrown (an API
 * error); a function is called with the params. Running out THROWS
 * "script exhausted for <key>", which the graph must turn into a finding,
 * never an exception.
 */
export function scriptedModel(script: Script = {}): ScriptedModel {
  const queues = new Map(Object.entries(script).map(([k, steps]) => [k, [...steps]]));
  const calls: ScriptedModel['calls'] = {};
  const order: string[] = [];

  const call: ModelCaller = async (params) => {
    const key = scriptKey(params);
    (calls[key] ??= []).push(snapshot(params));
    order.push(key);
    const step = queues.get(key)?.shift();
    if (step === undefined) throw new Error(`script exhausted for ${key}`);
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(params);
    return structuredClone(step);
  };

  return {
    call,
    calls,
    order,
    count: (key) => (key === undefined ? order.length : order.filter((k) => k === key).length),
    remaining: (key) => queues.get(key)?.length ?? 0,
  };
}

/** The script key a request routes to. Exported so a test can assert on routing itself. */
export function scriptKey(params: Anthropic.MessageCreateParamsNonStreaming): string {
  const role = roleOf(params);
  return SPECIALIST_ROLES.has(role) ? `${role}:${taskIdOf(params)}` : role;
}

function roleOf(params: Anthropic.MessageCreateParamsNonStreaming): Role {
  const sys = params.system;
  const first = typeof sys === 'string' ? sys : sys?.[0]?.text;
  const line = (first ?? '').split('\n', 1)[0]!.trim();
  const m = /^ROLE=([a-z]+)$/.exec(line);
  if (!m || !(ROLES as readonly string[]).includes(m[1]!)) {
    throw new Error(`scripted model: system[0] must start with a ROLE= line, got ${JSON.stringify(line.slice(0, 40))}`);
  }
  return m[1] as Role;
}

function taskIdOf(params: Anthropic.MessageCreateParamsNonStreaming): string {
  const content = params.messages.find((m) => m.role === 'user')?.content;
  const text = typeof content === 'string'
    ? content
    : content?.find((b): b is Anthropic.TextBlockParam => b.type === 'text')?.text;
  const start = text?.indexOf('{') ?? -1;
  let taskId: unknown;
  try {
    taskId = start < 0 ? undefined : (JSON.parse(text!.slice(start)) as { taskId?: unknown }).taskId;
  } catch {
    taskId = undefined;
  }
  if (typeof taskId !== 'string') {
    throw new Error('scripted model: a specialist call needs {"taskId": …} JSON in its first user message');
  }
  return taskId;
}

/** The params as they were at call time; the graph may append to a transcript later. */
function snapshot(params: Anthropic.MessageCreateParamsNonStreaming): Anthropic.MessageCreateParamsNonStreaming {
  try {
    return structuredClone(params);
  } catch {
    return params;
  }
}

// ================================================================= messages

let blockSeq = 0;

export function toolUse(name: string, input: unknown, id = `toolu_fake_${++blockSeq}`): Anthropic.ToolUseBlock {
  // Cast through unknown: the SDK's block types carry fields (caller) a fake need not fill.
  return { type: 'tool_use', id, name, input } as unknown as Anthropic.ToolUseBlock;
}

export function text(t: string): Anthropic.TextBlock {
  return { type: 'text', text: t, citations: null };
}

/**
 * An assistant message. The stop reason defaults as the API's does:
 * `tool_use` when the content calls a tool, `end_turn` otherwise.
 */
export function message(content: Anthropic.ContentBlock[], stop?: Anthropic.StopReason): Anthropic.Message {
  return {
    id: `msg_fake_${++blockSeq}`, type: 'message', role: 'assistant', model: 'fake', content,
    stop_reason: stop ?? (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'),
    stop_sequence: null, stop_details: null,
    usage: {
      input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      server_tool_use: null, service_tier: null, cache_creation: null, inference_geo: null,
      iterations: null, speed: null,
    },
  } as unknown as Anthropic.Message;
}

export type PlannerIntent = 'diagnose' | 'analyse' | 'whatif' | 'control' | 'compound' | 'clarify' | 'out_of_scope';

/** A planner decision with every field optional; `plannerMsg` fills the rest (§4 `PlannerDecision`). */
export interface PlannerDecisionInput {
  intent?: PlannerIntent;
  interpretation?: string;
  allowControl?: boolean;
  allowSimulation?: boolean;
  next?: 'dispatch' | 'compose' | 'control' | 'finish';
  tasks?: Array<{
    specialist: 'diagnose' | 'analyse' | 'simulate';
    goal: string;
    zoneIds?: string[];
    from?: string | null;
    to?: string | null;
    inputEvidenceIds?: string[];
  }>;
  controlTask?: { mode: 'propose' | 'check'; brief: string; inputEvidenceIds?: string[] } | null;
  message?: string | null;
}

/**
 * The planner's structured output, as the text block `output_config.format`
 * produces. Defaults: `next` is `dispatch` with tasks, `control` with a
 * controlTask, else `compose`; `intent` follows `next`; nothing is allowed.
 */
export function plannerMsg(d: PlannerDecisionInput = {}): Anthropic.Message {
  const tasks = (d.tasks ?? []).map((t) => ({
    specialist: t.specialist, goal: t.goal, zoneIds: t.zoneIds ?? [],
    from: t.from ?? null, to: t.to ?? null, inputEvidenceIds: t.inputEvidenceIds ?? [],
  }));
  const controlTask = d.controlTask
    ? { mode: d.controlTask.mode, brief: d.controlTask.brief, inputEvidenceIds: d.controlTask.inputEvidenceIds ?? [] }
    : null;
  const next = d.next ?? (tasks.length > 0 ? 'dispatch' : controlTask ? 'control' : 'compose');
  const intent = d.intent ?? (next === 'control' ? 'control' : next === 'finish' ? 'clarify' : 'diagnose');
  // Typed against planner.ts's own schema, so the fake cannot drift from the decision it stands in for.
  const decision: z.input<typeof PlannerDecision> = {
    intent,
    interpretation: d.interpretation ?? '',
    allowControl: d.allowControl ?? false,
    allowSimulation: d.allowSimulation ?? false,
    next,
    tasks,
    controlTask,
    message: d.message ?? null,
  };
  return message([text(JSON.stringify(decision))]);
}

/** Compose's structured output: the AnswerDoc as one JSON text block. */
export function composeMsg(doc: AnswerDoc): Anthropic.Message {
  return message([text(JSON.stringify(doc))]);
}

// ===================================================================== deps

export interface FakeDepsOptions {
  script?: Script;
  /** Reader methods to replace; the rest answer from the fixtures. */
  reader?: Partial<TwinReader>;
  /** A scenario runner in this mode, or null (the default) for "COPILOT_SIM_API_KEY unset". */
  scenarios?: FakeScenarioMode | null;
  settingsThrows?: boolean;
  limits?: Partial<Limits>;
  /** Start of the fake clock; 2026-09-28T08:40:00Z by default. */
  now?: number | string;
  /** Called on every `sleep`, after the clock has advanced — e.g. to stop a run mid-poll. */
  onSleep?: (ms: number) => void | Promise<void>;
  models?: { lead: string; specialist: string };
  identity?: { tenantId: string; userId: string };
}

export interface FakeDeps {
  deps: GraphDeps;
  reader: FakeReader;
  probe: FakeProbe;
  issuer: FakeIssuer;
  scenarios: FakeScenarios | null;
  model: ScriptedModel;
  clock: FakeClock;
  /** Every `sleep(ms)` the graph asked for. */
  sleeps: number[];
}

/**
 * Everything `buildCopilotGraph` needs, fake, sharing one clock. `sleep`
 * resolves at once and ADVANCES that clock, so a 45 s poll deadline passes
 * in 90 turns of the event loop rather than 45 s of test time. Models default
 * to `claude-opus-5` for both roles, as production does with nothing set.
 */
export function fakeDeps(opts: FakeDepsOptions = {}): FakeDeps {
  const clock = fakeClock(opts.now);
  const now = () => clock.now();
  const reader = fakeReader(opts.reader, { clock: now });
  const probe = fakeProbe({ settingsThrows: opts.settingsThrows ?? false, clock: now });
  const issuer = fakeIssuer({ clock: now });
  const scenarios = opts.scenarios == null ? null : fakeScenarios(opts.scenarios);
  const model = scriptedModel(opts.script);
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    clock.advance(ms);
    await opts.onSleep?.(ms);
  };
  return {
    deps: {
      reader: reader.reader,
      probe: probe.probe,
      issuer: issuer.issuer,
      scenarios: scenarios?.scenarios ?? null,
      callModel: model.call,
      models: opts.models ?? { lead: 'claude-opus-5', specialist: 'claude-opus-5' },
      identity: opts.identity ?? { tenantId: fx.TENANT_ID, userId: fx.USER_ID },
      clock: now,
      sleep,
      ...(opts.limits ? { limits: opts.limits } : {}),
    },
    reader, probe, issuer, scenarios, model, clock, sleeps,
  };
}
