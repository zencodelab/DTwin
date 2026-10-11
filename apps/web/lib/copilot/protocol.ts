import { SimulationStatus } from '@dtwin/types';
import { z } from 'zod';
import {
  BASES, EVIDENCE_KINDS, EVIDENCE_SOURCES, EvidenceId, FINDING_REASONS, FINDING_STATUSES, SPECIALIST_ROLES,
} from './evidence.ts';
import { NoticeCode } from './notices.ts';

/**
 * What crosses the wire between the copilot route and the panel
 * (docs/decisions.md §64, design §9.2–9.3): the streamed events, and the
 * `CopilotTurn` every run ends with.
 *
 * ONE SCHEMA, BOTH ENDS. The server builds each event and then parses it
 * through these schemas before it is written (stream.ts), so a field that is
 * not declared here never leaves the server; the client parses every line
 * through the same schemas before it renders anything (`parseEvent`), so a
 * line that does not match is dropped rather than cast. An unknown `t` is
 * dropped too — an older panel talking to a newer route skips what it does
 * not know instead of breaking.
 *
 * What is NOT here is the point: no model message, no tool body, no thinking
 * block, no error message, no graph state. Every string below is either
 * built by code (labels, notices, caveat lines), a verified segment, or text
 * that passed the verifier's wording rules (the interpretation, a clarifying
 * question, a plan's summary and reasons).
 *
 * Client-safe: this module imports zod and the two pure domain modules, never
 * LangGraph or the server's capabilities.
 */

// ==================================================================== nodes

/**
 * The top-level nodes, in the graph's insertion order. `graph.ts` types
 * NODE_ROLES against this list, so a node added to the graph and not here
 * (or the reverse) is a compile error, and a `step` event can only ever
 * name a node that exists.
 */
export const COPILOT_NODES = [
  'intake', 'orient', 'planner', 'diagnose', 'analyse', 'simulate', 'join', 'compose', 'verify',
  'control', 'plan_check', 'confirm', 'apply', 'declined', 'finish',
] as const;
export type CopilotNode = (typeof COPILOT_NODES)[number];

// ================================================================= pieces

/** A specialist task (`T1`…`T8`) or the controller's (`K`). */
const TaskId = z.string().regex(/^(T[1-8]|K)$/);
/** A tool name as the tools module spells them; the projector maps anything else to `unknown`. */
const ToolName = z.string().regex(/^[a-z_]{1,40}$/);
const Instant = z.string().max(40);
const Window = z.object({ from: Instant, to: Instant }).nullable();
const Coverage = z.object({
  good_count: z.number().int().nonnegative(),
  expected_count: z.number().int().nonnegative(),
}).nullable();
const Truncated = z.object({
  total_count: z.number().int().nonnegative(),
  limit_count: z.number().int().nonnegative(),
}).nullable();
const Label = z.string().max(300);
const PlanHash = z.string().regex(/^[0-9a-f]{64}$/);
/** A scenario name as simulate_scenarios accepts it, or the baseline. */
const ScenarioName = z.string().regex(/^[a-z0-9-]{1,40}$/);

/** A task before its finding (`pending` is the controller's, `running`/`done` a specialist's), then the finding's status. */
export const TASK_STATUSES = ['pending', 'running', 'done', ...FINDING_STATUSES] as const;

// ================================================================== events

export const AcceptedEvent = z.object({ t: z.literal('accepted'), requestId: z.string().max(100).nullable() }).strict();

/** A top-level node finished (its `updates` chunk). Inner specialist steps are not shown. */
export const StepEvent = z.object({ t: z.literal('step'), node: z.enum(COPILOT_NODES) }).strict();

/** A task was dispatched (`running`, with its goal) or ended (its finding's status). */
export const TaskEvent = z.object({
  t: z.literal('task'),
  taskId: TaskId,
  specialist: z.enum(SPECIALIST_ROLES),
  /** The planner's goal, only if it passed the wording rules; null otherwise, and on a task's end. */
  goal: z.string().max(600).nullable(),
  status: z.enum(TASK_STATUSES),
}).strict();

/** A tool call, labelled by the server from the directory — never the model's text. */
export const ActivityEvent = z.object({
  t: z.literal('activity'),
  taskId: TaskId,
  tool: ToolName,
  label: z.string().max(200),
}).strict();

/** An evidence record's metadata. Its `data` stays on the server; the final turn carries the card. */
export const EvidenceEvent = z.object({
  t: z.literal('evidence'),
  id: EvidenceId,
  taskId: TaskId,
  tool: ToolName,
  source: z.enum(EVIDENCE_SOURCES),
  kind: z.enum(EVIDENCE_KINDS),
  label: Label,
  window: Window,
  coverage: Coverage,
  flaggedExcluded_count: z.number().int().nonnegative().nullable(),
  truncated: Truncated,
}).strict();

export const SimEvent = z.object({
  t: z.literal('sim'),
  taskId: TaskId,
  runId: z.string().uuid(),
  role: z.enum(['baseline', 'scenario']),
  scenario: ScenarioName,
  status: SimulationStatus,
  progressPct: z.number().min(0).max(100),
}).strict();

/**
 * A plan is waiting for the operator. Only what a decision must name — the
 * interrupt, the plan's id and hash — and when it expires. The plan itself
 * arrives in the turn.
 */
export const PlanEvent = z.object({
  t: z.literal('plan'),
  interruptId: z.string().min(1).max(200),
  planId: z.string().uuid(),
  planHash: PlanHash,
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

export const PingEvent = z.object({ t: z.literal('ping') }).strict();

/** A run failed after the stream opened. Fixed words: never the error's message. */
export const ErrorEvent = z.object({
  t: z.literal('error'),
  error: z.literal('the copilot could not complete this turn'),
  requestId: z.string().max(100).nullable(),
}).strict();

// =================================================================== turn

const RenderedSegment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }).strict(),
  z.object({
    kind: z.literal('num'),
    text: z.string().max(40),
    basis: z.enum(BASES),
    evidenceIds: z.array(EvidenceId),
    simulated: z.boolean(),
  }).strict(),
  z.object({ kind: z.literal('cite'), evidenceIds: z.array(EvidenceId) }).strict(),
]);

const RenderedAnswer = z.object({
  paragraphs: z.array(z.array(RenderedSegment)),
  caveatLines: z.array(z.string()),
}).strict();

const EvidenceCard = z.object({
  id: EvidenceId,
  label: Label,
  source: z.enum(EVIDENCE_SOURCES),
  kind: z.enum(EVIDENCE_KINDS),
  window: Window,
  coverage: Coverage,
  flaggedExcluded_count: z.number().int().nonnegative().nullable(),
  truncated: Truncated,
  headline: z.array(z.object({ label: z.string().max(80), text: z.string().max(120) }).strict()),
  /** The record's caveats in the catalogue's fixed words (render.ts `renderCard`). */
  caveatLines: z.array(z.string()).default([]),
}).strict();

const Verdict = z.union([
  z.object({
    allowed: z.literal(true),
    previousTempC: z.number().nullable(),
    durationS: z.number(),
    effectiveUntil: z.string(),
  }).strict(),
  z.object({ allowed: z.literal(false), refusal: z.string(), message: z.string() }).strict(),
]);

const ReviewedCommand = z.object({
  zoneId: z.string().uuid(),
  zoneName: z.string(),
  setpointTempC: z.number(),
  durationS: z.number().int().positive().optional(),
  reason: z.string(),
  verdict: Verdict,
}).strict();

/** The plan waiting for a decision, as plan_check reviewed it, plus the interrupt a decision must name. */
export const PendingPlan = z.object({
  interruptId: z.string().min(1).max(200),
  planId: z.string().uuid(),
  planHash: PlanHash,
  checkedAt: z.string(),
  expiresAt: z.string(),
  summary: z.string(),
  commands: z.array(ReviewedCommand).min(1),
  simulation: z.object({
    evidenceId: EvidenceId,
    scenario: ScenarioName,
    zonesMatch: z.boolean(),
    setpointsMatch: z.boolean(),
    timing: z.literal('whole_window_vs_override'),
  }).strict().nullable(),
}).strict();
export type PendingPlan = z.infer<typeof PendingPlan>;

const Outcome = z.object({
  zoneName: z.string(),
  setpointTempC: z.number(),
  result: z.union([
    z.object({ ok: z.literal(true), commandId: z.string(), state: z.string(), effectiveUntil: z.string() }).strict(),
    z.object({ ok: z.literal(false), refusal: z.string(), message: z.string() }).strict(),
  ]),
}).strict();

const DialogueEntry = z.discriminatedUnion('role', [
  z.object({ role: z.literal('operator'), text: z.string() }).strict(),
  z.object({ role: z.literal('copilot'), text: z.string().nullable(), notices: z.array(NoticeCode) }).strict(),
]);

export const CopilotTurn = z.object({
  requestId: z.string().nullable(),
  running: z.boolean(),
  dialogue: z.array(DialogueEntry),
  /** Null unless it verified; the cards stand in for it. */
  answer: RenderedAnswer.nullable(),
  /** The planner's reading of the question, only if it passed the wording rules. */
  interpretation: z.string().nullable(),
  /** A clarifying question or out-of-scope answer, only if it passed the wording rules. */
  message: z.string().nullable(),
  cards: z.array(EvidenceCard),
  tasks: z.array(z.object({
    taskId: TaskId,
    specialist: z.enum(SPECIALIST_ROLES),
    goal: z.string().nullable(),
    status: z.enum(TASK_STATUSES),
    reason: z.enum(FINDING_REASONS).nullable(),
  }).strict()),
  pendingPlan: PendingPlan.nullable(),
  outcomes: z.array(Outcome),
  /** Fixed templates, rendered by code (notices.ts). */
  notices: z.array(z.object({ code: NoticeCode, text: z.string() }).strict()),
  usage: z.object({
    modelCalls: z.number().int().nonnegative(),
    byRole: z.record(z.string(), z.number().int().nonnegative()),
    simRuns: z.number().int().nonnegative(),
    // What the request cost, from each reply's usage. Optional so that a
    // panel built before they existed, or a turn that never had them, still
    // parses; the server always sends all four.
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
  }).strict().nullable(),
  models: z.object({ lead: z.string(), specialist: z.string() }).strict(),
}).strict();
export type CopilotTurn = z.infer<typeof CopilotTurn>;

export const TurnEvent = z.object({ t: z.literal('turn'), turn: CopilotTurn }).strict();

// ================================================================== union

export const CopilotEvent = z.discriminatedUnion('t', [
  AcceptedEvent, StepEvent, TaskEvent, ActivityEvent, EvidenceEvent, SimEvent, PlanEvent, PingEvent, TurnEvent,
  ErrorEvent,
]);
export type CopilotEvent = z.infer<typeof CopilotEvent>;

export const EVENT_TYPES = [
  'accepted', 'step', 'task', 'activity', 'evidence', 'sim', 'plan', 'ping', 'turn', 'error',
] as const satisfies ReadonlyArray<CopilotEvent['t']>;

/**
 * One NDJSON line (or an already-parsed value) as an event, or null. Null
 * for anything that is not JSON, has a `t` this build does not know, or does
 * not match its schema: the panel skips it and reads the next line. Never
 * throws.
 */
export function parseEvent(line: unknown): CopilotEvent | null {
  let value: unknown = line;
  if (typeof line === 'string') {
    try {
      value = JSON.parse(line);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const t = (value as { t?: unknown }).t;
  if (typeof t !== 'string' || !(EVENT_TYPES as readonly string[]).includes(t)) return null;
  const parsed = CopilotEvent.safeParse(value);
  return parsed.success ? parsed.data : null;
}
