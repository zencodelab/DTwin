import type Anthropic from '@anthropic-ai/sdk';
import type { Capped, DirectoryRow } from '@dtwin/db';
import type { ControlSettings, KeyedLimiter, SimulationStatus } from '@dtwin/types';
import { z } from 'zod';
import type { SpecialistDeps } from '../deps.ts';
import {
  CAVEAT_IDS, EVIDENCE_ID_RE, type CaveatId, type EvidenceId, type EvidenceKind, type EvidenceRecord,
  type EvidenceSource, type SPECIALIST_ROLES,
} from '../evidence.ts';
import type { Limits } from '../limits.ts';
import type { RunRegistry, SimRefusal } from '../registry.ts';
import { toLocalIso } from '../time.ts';

/**
 * What every copilot tool has in common (docs/decisions.md §64, §5.2 of the
 * design): how a timestamp and a window are accepted or refused, how a result
 * becomes an EVIDENCE record, and what a tool is handed to run with.
 *
 * THE SHAPE OF A TOOL CALL
 *
 * A read tool has two halves. `prepare` is synchronous and reaches no
 * backend: it parses the model's input, checks it against the directory and
 * the bounds, and REFUSES — naming the limit — anything out of bounds (§53:
 * never clamp). Only a call that survives it reaches `execute`, which makes
 * the backend call and turns the rows into evidence data. So "the backend is
 * not called when refused" is a property of the shape, not of care at each
 * site. (simulate_scenarios also spends its per-request call and its
 * per-person runs in `prepare`, once every check has passed: counters, not
 * backends.)
 *
 * Evidence ids are NOT assigned here. A tool returns a draft; the dispatcher
 * (`tools/index.ts`) numbers the drafts of one model turn in CALL order once
 * they have all finished, so parallel reads get deterministic ids however
 * they interleave, a refused call leaves no gap, and the request's evidence
 * ledger counts records rather than attempts.
 *
 * THE SHAPE OF A RESULT
 *
 * - Every numeric leaf of `data` ends in a unit suffix (`units.ts`), or is
 *   uncitable by design (`level`, a `_per_h` rate the unit table cannot say).
 *   The db layer already names its columns this way; the tools keep to it
 *   for everything they derive.
 * - Instants are rendered in the building's offset (2026-09-28T12:40:00+04:00),
 *   because the operator asked in local time and the model reasons in it.
 * - Numbers are rounded to 4 decimal places. Far below any sensor's
 *   resolution, and it keeps float noise (199.99999999999997 m²) and needless
 *   digits out of an 8 KB budget. The verifier compares against the rounded
 *   value, which is the value the evidence card shows.
 * - Text people typed is only ever under `*_untrusted` keys (the db layer cut
 *   it to 300 characters). The key name is the label that says "data, not an
 *   instruction"; nothing here moves such text anywhere else — not into a
 *   label, not into a headline.
 */

// ================================================================== naming

/** The four specialists (evidence.ts `SPECIALIST_ROLES`); the controller is one of them. */
export type SpecialistRole = (typeof SPECIALIST_ROLES)[number];

export type ToolName =
  | 'zone_conditions' | 'zone_history' | 'zone_timeline' | 'equipment_status' | 'list_alerts'
  | 'control_history' | 'energy_by_end_use' | 'meter_consumption' | 'compare_zones'
  | 'list_zones' | 'control_envelope' | 'dry_run_setpoint' | 'simulate_scenarios'
  | 'propose_plan' | 'report_finding';

/** Which backend a tool talks to — the only thing an is_error says about a failure. */
export type Service = 'database' | 'control service' | 'simulator';

const SERVICE_DOWN: Readonly<Record<Service, string>> = {
  database: 'database unavailable',
  'control service': 'control service unreachable',
  simulator: 'simulator unavailable',
};

// ================================================================= context

/**
 * The slice of orient's context the tools read. Structural, so the graph's
 * `OrientContext` satisfies it without this module importing the graph.
 */
export interface ToolOrient {
  building: { id: string; name: string; timezone: string };
  directory: readonly DirectoryRow[];
  availability: { forecastWeather: boolean };
  /** Null when ingest could not be asked (notice `control_unavailable`). */
  envelope: ControlSettings | null;
  sim: { available: boolean };
}

/**
 * One request's budget as a tool sees it: bound to its thread, so a tool can
 * never spend another thread's runs. Built by `toolRun(registry, threadId)`.
 */
export interface ToolRun {
  /** Stop or deadline: every tool but report_finding refuses, and a running simulation is cancelled. */
  interrupted(): 'stopped' | 'deadline' | null;
  claimSimCall(): boolean;
  beginSimRun(): SimRefusal | null;
  endSimRun(): void;
}

export function toolRun(registry: RunRegistry, threadId: string): ToolRun {
  return {
    interrupted: () => registry.interrupted(threadId),
    claimSimCall: () => registry.claimSimCall(threadId),
    beginSimRun: () => registry.beginSimRun(threadId),
    endSimRun: () => registry.endSimRun(threadId),
  };
}

/** A `copilot.sim` progress event, for `config.writer` (the panel's sim rows). */
export interface SimEventPayload {
  event: 'copilot.sim';
  taskId: string;
  runId: string;
  role: 'baseline' | 'scenario';
  scenario: string;
  status: SimulationStatus;
  progressPct: number;
}

/** One simulation run this request started, for the graph's `simRuns` channel. */
export interface SimRunRecord {
  runId: string;
  taskId: string;
  role: 'baseline' | 'scenario';
  scenario: string;
  status: SimulationStatus;
}

export interface ToolContext {
  /** A specialist's capabilities: never an issuer (deps.ts). */
  deps: SpecialistDeps;
  orient: ToolOrient;
  identity: { tenantId: string; userId: string };
  requestId: string;
  run: ToolRun;
  limits: Readonly<Limits>;
  /** Milliseconds since the epoch. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /**
   * The next evidence id for this task (`T3.E4`, `K.E1`), or null when the
   * request's ledger is full. Called once per accepted record, in call
   * order, after the record has passed every check — see `evidenceAllocator`.
   */
  allocateEvidenceId: () => EvidenceId | null;
  /** Runs per person per hour (§54). Required for simulate_scenarios; `sharedSimLimiter()` in production. */
  simLimiter?: KeyedLimiter | undefined;
  /** The graph's `config.writer`. Absent under invoke(), where there is nothing to stream to. */
  emit?: ((event: SimEventPayload) => void) | undefined;
  /** Event name and fields, never a sentence (§61). */
  log?: ((event: string, fields: Record<string, string | number | boolean | null>) => void) | undefined;
}

export interface ToolTask {
  /** `T1`…`T8` for a specialist task, `K` for the controller. */
  taskId: string;
  /** Records this task was handed by the planner (copies of earlier evidence). */
  inputEvidenceIds: readonly string[];
  /** Records this task produced in earlier turns. */
  producedEvidenceIds: readonly string[];
  /** The controller's mode; `propose_plan` is offered only in `propose`. */
  mode?: 'propose' | 'check' | undefined;
}

/** What one handler is run with. */
export interface ToolEnv {
  role: SpecialistRole;
  task: ToolTask;
  ctx: ToolContext;
}

/**
 * Hands out `${taskId}.E${n}` in order, each backed by a slot in the
 * request's evidence ledger (`RunRegistry.claimEvidence`). `after` is how many
 * this task numbered in earlier turns (its private `evidenceSeq`), so ids are
 * never reused across turns. Null when the ledger is full — or, defensively,
 * past `E99`, which the id grammar cannot express (a task makes at most 12
 * tool calls, so it is unreachable).
 */
export function evidenceAllocator(opts: {
  taskId: string;
  after: number;
  claim: () => boolean;
}): { next: () => EvidenceId | null; issued: () => number } {
  let n = opts.after;
  let issued = 0;
  return {
    next: () => {
      const id = `${opts.taskId}.E${n + 1}`;
      if (!EVIDENCE_ID_RE.test(id) || !opts.claim()) return null;
      n += 1;
      issued += 1;
      return id;
    },
    issued: () => issued,
  };
}

// ================================================================ refusals

/** A call that is answered with `is_error`, carrying whatever runs it had already started. */
export interface Refused {
  refused: string;
  simRuns?: SimRunRecord[];
}

export const refuse = (message: string, simRuns?: SimRunRecord[]): Refused =>
  simRuns && simRuns.length > 0 ? { refused: message, simRuns } : { refused: message };

export function isRefused(x: unknown): x is Refused {
  return typeof x === 'object' && x !== null && typeof (x as { refused?: unknown }).refused === 'string';
}

/** A Zod failure as one line the model can act on: `path: message, …`. */
export function zodIssues(error: z.ZodError): string {
  return error.issues.slice(0, 6).map((i) => {
    const path = i.path.join('.');
    return path === '' ? i.message : `${path}: ${i.message}`;
  }).join('; ');
}

/**
 * A backend failure, tagged with the service it came from. Only these are
 * reported as "database unavailable" and the like; anything else thrown in a
 * tool is a bug in the tool and is reported as one, never blamed on a
 * service that answered.
 */
export class ServiceError extends Error {
  readonly service: Service;
  readonly causeName: string;
  constructor(service: Service, cause: unknown) {
    super(SERVICE_DOWN[service]);
    this.name = 'ServiceError';
    this.service = service;
    this.causeName = cause instanceof Error ? cause.name : typeof cause;
  }
}

/**
 * Call a backend. A RangeError is the db layer refusing an argument (a span
 * it would truncate, an unknown time zone) and is passed on as a refusal in
 * its own words — "database unavailable" would be the wrong diagnosis. Any
 * other throw becomes a ServiceError naming the service, and nothing else:
 * an exception's message can carry a connection string or a stack.
 */
export async function callService<T>(service: Service, fn: () => Promise<T>): Promise<T | Refused> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RangeError) return refuse(`refused: ${err.message.slice(0, 200)}`);
    throw new ServiceError(service, err);
  }
}

export function serviceDown(service: Service): string {
  return SERVICE_DOWN[service];
}

// ============================================================== timestamps

/**
 * An instant WITH its offset. "09:00" means something only in a zone, and a
 * model that drops the offset has usually dropped the zone too.
 */
export const Ts = z.string().datetime({
  offset: true,
  message: 'a timestamp with its offset, e.g. 2026-09-28T09:00:00+04:00 (a time without an offset is ambiguous)',
});

export const ZoneIdInput = z.string().uuid('a zone id from the directory');

/** A window that passed every check, in epoch milliseconds. */
export interface Window {
  fromMs: number;
  toMs: number;
}

const hours = (ms: number): string => {
  const h = ms / 3_600_000;
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
};

/** "168 h (7 d)", "48 h (2 d)", "4 h". */
export function hoursAndDays(h: number): string {
  return h % 24 === 0 ? `${h} h (${h / 24} d)` : `${h} h`;
}

/**
 * Accept a window or refuse it, naming the bound (§53). Never clamped: a
 * clamped window answers a different question than the one asked, and says
 * nothing about it.
 *
 * - `to` must be after `from`.
 * - `to` may run at most `futureToleranceS` past now: clocks differ by
 *   seconds, and "until now" is often written as the next minute, but a
 *   window reaching further asks about readings that do not exist yet.
 * - The span must be within the tool's limit.
 */
export function checkWindow(
  tool: string, fromIso: string, toIso: string, maxH: number, env: ToolEnv, advice = '',
): Window | Refused {
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return refuse('from and to must be timestamps with an offset');
  if (toMs <= fromMs) return refuse('to must be after from');
  const now = env.ctx.now();
  if (toMs > now + env.ctx.limits.futureToleranceS * 1000) {
    return refuse(`to must not be in the future (now is ${localIso(now, env)})`);
  }
  if (toMs - fromMs > maxH * 3_600_000) {
    return refuse(`window is ${hours(toMs - fromMs)} h; ${tool} answers at most ${hoursAndDays(maxH)}${advice}`);
  }
  return { fromMs, toMs };
}

/**
 * The window for a list tool whose bounds may be null: the last
 * `listDefaultWindowH` hours ending now, or ending at `to`, or starting at
 * `from` and running to now.
 */
export function listWindow(
  tool: string, from: string | null, to: string | null, maxH: number, env: ToolEnv,
): Window | Refused {
  const { now, limits } = env.ctx;
  const defaultMs = limits.listDefaultWindowH * 3_600_000;
  const toIso = to ?? new Date(now()).toISOString();
  const fromIso = from ?? new Date(Date.parse(toIso) - defaultMs).toISOString();
  if (from !== null && to === null && Date.parse(from) >= now()) return refuse('from must be in the past');
  return checkWindow(tool, fromIso, toIso, maxH, env);
}

/** True when an instant falls on a whole hour (the hourly rollup's and the simulator's grid). */
export function onWholeHour(iso: string): boolean {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms % 3_600_000 === 0;
}

export function localIso(ms: number, env: ToolEnv): string {
  return toLocalIso(ms, env.ctx.orient.building.timezone);
}

/** Buckets of `widthS` STARTING in [from, to) — the db layer's `bucketStartsIn`, restated so tools need no `pg`. */
export function bucketsIn(fromMs: number, toMs: number, widthS: number): number {
  const w = widthS * 1000;
  return Math.max(0, Math.ceil(toMs / w) - Math.ceil(fromMs / w));
}

/**
 * A window as an evidence label reads it: "09:00–12:40 (Asia/Dubai)" when it
 * is all today, with the date when it is not.
 */
export function windowLabel(w: Window, env: ToolEnv): string {
  const tz = env.ctx.orient.building.timezone;
  const f = toLocalIso(w.fromMs, tz);
  const t = toLocalIso(w.toMs, tz);
  const today = toLocalIso(env.ctx.now(), tz).slice(0, 10);
  const hm = (s: string) => s.slice(11, 16);
  if (f.slice(0, 10) === t.slice(0, 10)) {
    return f.slice(0, 10) === today ? `${hm(f)}–${hm(t)} (${tz})` : `${f.slice(0, 10)} ${hm(f)}–${hm(t)} (${tz})`;
  }
  return `${f.slice(0, 10)} ${hm(f)} – ${t.slice(0, 10)} ${hm(t)} (${tz})`;
}

export function windowOf(w: Window, env: ToolEnv): { from: string; to: string } {
  return { from: localIso(w.fromMs, env), to: localIso(w.toMs, env) };
}

// ================================================================ directory

export function zoneIn(env: ToolEnv, zoneId: string): DirectoryRow | undefined {
  return env.ctx.orient.directory.find((z) => z.id === zoneId);
}

/** The refusal for a zone id the directory does not hold. The id is echoed, never trusted as text. */
export function unknownZone(zoneId: string): Refused {
  return refuse(`unknown zone ${JSON.stringify(zoneId.slice(0, 40))}: use an id from the directory`);
}

// ================================================================== shaping

/** Exactly what `Date.prototype.toISOString` writes, which is every instant the db layer returns. */
const UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const DECIMALS = 4;
const SCALE = 10 ** DECIMALS;

/** A number as evidence holds it: 4 decimal places, and never −0. */
export function round4(v: number): number {
  const r = Math.round(v * SCALE) / SCALE;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Rows as evidence data: instants in the building's offset, numbers to four
 * places, `undefined` dropped. Text under an `*_untrusted` key is left
 * exactly as it came, even when it happens to look like a timestamp.
 *
 * A `*_truncated: false` is dropped too: the flag is there to say text WAS
 * cut (§5.2, "`*_truncated: true` when cut"), and repeating "not cut" on
 * every row of a list spent 8 KB evidence bytes on nothing.
 */
export function shapeData(value: unknown, env: ToolEnv, key = ''): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? round4(value) : null;
  if (typeof value === 'string') {
    return !key.endsWith('_untrusted') && UTC_ISO_RE.test(value) ? localIso(Date.parse(value), env) : value;
  }
  if (Array.isArray(value)) return value.map((v) => shapeData(v, env, key));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || (v === false && k.endsWith('_truncated'))) continue;
      out[k] = shapeData(v, env, k);
    }
    return out;
  }
  return value;
}

/** The db layer's `{items, total, limit, truncated}` as the model reads it (§5.2). */
export function cappedData<T>(c: Capped<T>, env: ToolEnv, row: (item: T) => unknown = (x) => x): {
  items: unknown[]; total_count: number; limit_count: number; truncated: boolean;
} {
  return {
    items: c.items.map((i) => shapeData(row(i), env)),
    total_count: c.total,
    limit_count: c.limit,
    truncated: c.truncated,
  };
}

export function truncatedMeta<T>(c: Capped<T>): { total_count: number; limit_count: number } | null {
  return c.truncated ? { total_count: c.total, limit_count: c.limit } : null;
}

/** good / expected as a percentage to 0.1, or null when nothing was expected. */
export function coveragePct(good: number, expected: number): number | null {
  return expected > 0 ? Math.round((good / expected) * 1000) / 10 : null;
}

/** Under 95% of the expected good buckets: PARTIAL_COVERAGE. */
export function partial(good: number, expected: number): boolean {
  return expected > 0 && good / expected < 0.95;
}

// ================================================================= evidence

/** A record before the dispatcher numbers it. */
export interface EvidenceDraft {
  tool: ToolName;
  kind: EvidenceKind;
  source: EvidenceSource;
  label: string;
  window: { from: string; to: string } | null;
  coverage: { good_count: number; expected_count: number } | null;
  flaggedExcluded_count: number | null;
  truncated: { total_count: number; limit_count: number } | null;
  caveats: CaveatId[];
  headline: Array<{ label: string; path: string }>;
  data: unknown;
  /** The runs a simulation started; carried beside the record, never in it. */
  simRuns?: SimRunRecord[];
}

const MAX_LABEL = 200;
const MAX_HEADLINE_LABEL = 80;
const MAX_HEADLINES = 6;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Caveat codes de-duplicated, in catalogue order. */
export function orderCaveats(ids: Iterable<CaveatId>): CaveatId[] {
  const wanted = new Set(ids);
  return CAVEAT_IDS.filter((id) => wanted.has(id));
}

/**
 * The record and the tool_result content for one accepted draft. The content
 * is the model's view of the record: its id (to cite), where it came from,
 * the window it covers, the caveats it carries (so a specialist knows what
 * its finding must not leave out) and the data.
 */
export function sealEvidence(draft: EvidenceDraft, id: EvidenceId, taskId: string, atIso: string): {
  evidence: EvidenceRecord; content: string;
} {
  const evidence: EvidenceRecord = {
    id,
    taskId,
    tool: draft.tool,
    kind: draft.kind,
    source: draft.source,
    label: clip(draft.label, MAX_LABEL),
    window: draft.window,
    coverage: draft.coverage,
    flaggedExcluded_count: draft.flaggedExcluded_count,
    truncated: draft.truncated,
    caveats: orderCaveats(draft.caveats),
    headline: draft.headline.slice(0, MAX_HEADLINES).map((h) => ({ label: clip(h.label, MAX_HEADLINE_LABEL), path: h.path })),
    data: draft.data,
    at: atIso,
  };
  const content = JSON.stringify({
    evidenceId: id, source: evidence.source, window: evidence.window, caveats: evidence.caveats, data: evidence.data,
  });
  return { evidence, content };
}

export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** "8 KB", "21.7 KB". */
export function kb(bytes: number): string {
  const k = bytes / 1024;
  return Number.isInteger(k) ? `${k} KB` : `${k.toFixed(1)} KB`;
}

/**
 * The narrowing hint for a capped list that came back too large: the largest
 * limit that would have fitted, by proportion, with a margin. Never a
 * truncated page — the model asks again, and the second answer says what it
 * covers.
 */
export function listHint(limit: number, bytes: number, maxBytes: number): string {
  const fits = Math.max(1, Math.floor(limit * (maxBytes / bytes) * 0.9));
  return `call again with limit ${fits} or less, or a narrower window`;
}

// ==================================================================== tools

/**
 * A tool that reads (or, for simulate_scenarios, makes a scratch write) and
 * answers with evidence. `prepare` is synchronous and never touches a
 * backend; `execute` is the only half that does (see the header).
 */
export interface EvidenceTool<P> {
  name: ToolName;
  service: Service;
  definition: Anthropic.Tool;
  prepare(input: unknown, env: ToolEnv): P | Refused;
  execute(prepared: P, env: ToolEnv): Promise<EvidenceDraft | Refused>;
  /** The narrowing hint when the result is over the evidence size bound. Default: narrow the window. */
  tooLarge?(prepared: P, bytes: number, env: ToolEnv): string;
}

/**
 * Erase `P`: a prepared value only ever flows from a tool's own `prepare` to
 * the same tool's `execute`, which is what makes the cast sound.
 */
export function evidenceTool<P>(tool: EvidenceTool<P>): EvidenceTool<unknown> {
  return tool as unknown as EvidenceTool<unknown>;
}
