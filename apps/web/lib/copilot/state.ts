import { Annotation } from '@langchain/langgraph';
import type { DirectoryRow } from '@dtwin/db';
import type { ControlSettings } from '@dtwin/types';
import type { DryRunResult, IssueResult } from './deps.ts';
import type { AnswerDoc, EvidenceRecord, Finding, Violation } from './evidence.ts';
import { DEFAULT_LIMITS } from './limits.ts';
import type { Notice, NoticeCode } from './notices.ts';
import type { Usage } from './registry.ts';
import type { ProposedCommand, ProposedPlanWithBasis, SimRunRecord } from './tools/index.ts';
import type { Weekday } from './time.ts';

/**
 * The copilot's graph state: every channel, its reducer, and who may write
 * it (docs/decisions.md §64, design §4).
 *
 * Two kinds of channel live here. CONVERSATION channels (`dialogue`) outlive a
 * request. REQUEST channels hold one question's working — its tasks, findings,
 * evidence, answer and plan — and `intake` resets every one of them when a new
 * message arrives, so nothing from the last question leaks into the next:
 * not its evidence (a stale figure would verify), not its scope (last
 * request's "may control" is not this one's), and not its plan (a new
 * message sets a pending plan aside; nothing is issued).
 *
 * The domain types — evidence, findings, answers, violations, notices — live
 * in `evidence.ts` and `notices.ts`, not here, so that the verifier and the
 * renderer stay pure functions testable without LangGraph. This module
 * imports them; they never import it.
 *
 * Channel INSTANCES shared with a subgraph are declared once and reused in
 * every `Annotation.Root` that names them: LangGraph maps a key between a
 * parent and a subgraph by name, and requires the same instance on both sides.
 */

// ================================================================== reducers

/** The write-once reset sentinel: the only update that clears `scope`. */
export const RESET = { __reset: true } as const;
export type Reset = typeof RESET;
export const isReset = (u: unknown): u is Reset =>
  typeof u === 'object' && u !== null && (u as Reset).__reset === true;

/**
 * A record merged by key; `null` resets it to {}. Parallel Send workers in one
 * superstep write disjoint keys (task ids, evidence ids), so the merge is
 * order-independent. Evidence ids are never reused within a request, so a
 * merge can never overwrite a record another task produced.
 */
export const mergeRecord = <V>() => Annotation<Record<string, V>, Record<string, V> | null>({
  reducer: (held, inc) => (inc === null ? {} : { ...held, ...inc }),
  default: () => ({}),
});

const replace = <T>(initial: () => T) => Annotation<T>({ reducer: (_, inc) => inc, default: initial });

/**
 * Append, and keep the conversation bounded: the oldest entries fall off.
 * The planner and compose see only the last few anyway (`dialogueTail`).
 */
const appendDialogue = Annotation<DialogueEntry[]>({
  reducer: (held, inc) => held.concat(inc).slice(-DEFAULT_LIMITS.dialogueKept),
  default: () => [],
});

/**
 * Notices append. `null` clears them; `{replace}` clears them and starts the
 * list again in one write — which `intake` needs, because a new request both
 * resets the list and may have to say the previous plan was set aside.
 */
export type NoticesUpdate = Notice[] | null | { replace: Notice[] };
const noticesChannel = Annotation<Notice[], NoticesUpdate>({
  reducer: (held, inc) => {
    if (inc === null) return [];
    if (Array.isArray(inc)) return held.concat(inc);
    return [...inc.replace];
  },
  default: () => [],
});

// ================================================================== types

/** What a new message carries in. Written by the caller, consumed by intake. */
export interface InboxMessage {
  requestId: string;
  text: string;
  receivedAt: string;
  /** Whether the person asking may command setpoints (`mayCommand(role)`), fixed by the route. */
  mayCommand: boolean;
}

/**
 * The request as the graph sees it. `nowIso` is in the building's offset
 * (2026-09-28T12:40:00+04:00), because "since 9" means nine o'clock in the
 * building. Intake stamps it in UTC — it does no I/O and cannot know the
 * building yet — and orient re-stamps the SAME instant in the building's zone
 * once it has read it.
 */
export interface RequestStamp {
  requestId: string;
  /** 1 for the first message on a thread, then 2, 3, … */
  seq: number;
  text: string;
  nowIso: string;
  timezone: string;
  localDate: string;
  weekday: Weekday;
  userId: string;
  mayCommand: boolean;
}

export interface Outcome {
  zoneName: string;
  setpointTempC: number;
  result: IssueResult;
}

export type DialogueEntry =
  | { role: 'operator'; requestId: string; text: string }
  | {
    role: 'copilot';
    requestId: string;
    /** The verified answer as plain text, or the verified clarifying question, or null. */
    text: string | null;
    notices: NoticeCode[];
    outcomes: Outcome[];
  };

export interface Availability {
  perFloorEnergyMeter: boolean;
  perZoneEnergyMeter: boolean;
  /**
   * The meters meter_consumption can read, by tag, from the register. The
   * prompts are byte-constant and name no building's equipment; this is how a
   * model learns what exists here.
   */
  meters: ReadonlyArray<{ tag: string; type: 'electric_meter' | 'water_meter'; unit: 'kwh' | 'm3' }>;
  /** Constant: no equipment type in the schema represents plug load. */
  plugLoadMetered: false;
  /** Constant: no forecast source exists; the word "forecast" is refused by the verifier. */
  forecastWeather: false;
  /** Weather rows that are neither synthetic nor a forecast. */
  observedWeather: boolean;
  telemetryFrom: string | null;
  telemetryTo: string | null;
}

/**
 * What orient learnt, once per request (§5.1). The planner and every
 * specialist receive the directory and availability; the tools read the
 * rest. It satisfies `ToolOrient` and `VerifyContext` structurally.
 */
export interface OrientContext {
  building: { id: string; name: string; timezone: string; grossFloorAreaM2: number | null };
  directory: DirectoryRow[];
  availability: Availability;
  /** Null when ingest could not be asked (notice `control_unavailable`). */
  envelope: ControlSettings | null;
  sim: { available: boolean; reason: string | null };
}

/**
 * The authority a request was given, fixed by the FIRST planner decision —
 * before any tool data exists — and never widened after (P14). `fallback`
 * marks v1 behaviour when the planner could not plan.
 */
export interface Scope {
  allowControl: boolean;
  allowSimulation: boolean;
  source: 'planner' | 'fallback';
}

export interface PlannerRoute {
  next: 'dispatch' | 'compose' | 'control' | 'finish';
  /** The tasks this decision dispatched (empty unless `dispatch`). */
  taskIds: string[];
  /** The planner's reading of the question; shown only if it passes verifyText. */
  interpretation: string | null;
  /** A clarifying question or an out-of-scope answer; shown only if it passes verifyText. */
  message: string | null;
}

export const SPECIALIST_NODES = ['diagnose', 'analyse', 'simulate'] as const;
export type SpecialistNode = (typeof SPECIALIST_NODES)[number];

export interface TaskSpec {
  taskId: string;
  specialist: SpecialistNode;
  goal: string;
  zoneIds: string[];
  from: string | null;
  to: string | null;
  inputEvidenceIds: string[];
  wave: number;
  status: 'running' | 'done';
}

export interface ControlTask {
  mode: 'propose' | 'check';
  brief: string;
  inputEvidenceIds: string[];
  status: 'pending' | 'done';
}

/**
 * Everything a Send-dispatched specialist starts from — and all it sees: a
 * Send worker receives its payload, not the graph state. `inputs` are COPIES
 * of earlier evidence the planner handed on (≤ 6).
 */
export interface SpecialistTask {
  taskId: string;
  specialist: SpecialistNode;
  goal: string;
  zoneIds: string[];
  from: string | null;
  to: string | null;
  inputs: EvidenceRecord[];
  request: RequestStamp;
  building: { id: string; name: string; timezone: string };
  directory: DirectoryRow[];
  availability: Availability;
  envelope: ControlSettings | null;
  simAvailable: boolean;
}

/**
 * How a plan relates to the simulation it names (§5.5). The card's
 * "simulated" badge needs BOTH matches; `timing` names the difference that
 * always remains — a simulation shifts the whole window, an override starts
 * on approval and expires.
 */
export interface SimulationMatch {
  evidenceId: string;
  scenario: string;
  zonesMatch: boolean;
  setpointsMatch: boolean;
  timing: 'whole_window_vs_override';
}

export type ReviewedCommand = ProposedCommand & { zoneName: string; verdict: DryRunResult };

/** A plan after plan_check: freshly dry-run, identified, hashed and timed. */
export interface ReviewedPlan {
  planId: string;
  /** sha256 over what would be SENT (ledger.ts `hashCommands`). */
  planHash: string;
  checkedAt: string;
  expiresAt: string;
  summary: string;
  commands: ReviewedCommand[];
  simulation: SimulationMatch | null;
}

export type Decision = 'approved' | 'declined' | 'stale' | 'expired';

// ============================================================ shared channels

/** Shared with every specialist subgraph (output). */
export const findingsChannel = mergeRecord<Finding>();
/** Shared with every specialist subgraph (output; control also reads it). */
export const evidenceChannel = mergeRecord<EvidenceRecord>();
/** Shared with the simulate subgraph (output). */
export const simRunsChannel = mergeRecord<SimRunRecord>();
/** Shared with the control subgraph (input and output). */
export const controlTaskChannel = replace<ControlTask | null>(() => null);
/** Shared with the control subgraph (output ONLY: the one schema that declares it). */
export const proposalChannel = replace<ProposedPlanWithBasis | null>(() => null);
/** Shared with the control subgraph (input). */
export const requestChannel = replace<RequestStamp | null>(() => null);
/** Shared with the control subgraph (input). */
export const contextChannel = replace<OrientContext | null>(() => null);
/** Write-once per request: `RESET` clears it, otherwise the first write wins. Shared with control (input). */
export const scopeChannel = Annotation<Scope | null, Scope | Reset>({
  reducer: (held, inc) => (isReset(inc) ? null : held ?? inc),
  default: () => null,
});

// ============================================================== the state

export const CopilotState = Annotation.Root({
  inbox: replace<InboxMessage | null>(() => null),
  request: requestChannel,
  dialogue: appendDialogue,
  context: contextChannel,
  scope: scopeChannel,
  plannerRoute: replace<PlannerRoute | null>(() => null),
  waves: replace<number>(() => 0),
  taskSeq: replace<number>(() => 0),
  tasks: mergeRecord<TaskSpec>(),
  findings: findingsChannel,
  evidence: evidenceChannel,
  simRuns: simRunsChannel,
  controlTask: controlTaskChannel,
  proposal: proposalChannel,
  answer: replace<AnswerDoc | null>(() => null),
  violations: replace<Violation[]>(() => []),
  drafts: replace<number>(() => 0),
  notices: noticesChannel,
  pendingPlan: replace<ReviewedPlan | null>(() => null),
  decision: replace<Decision | null>(() => null),
  outcomes: replace<Outcome[]>(() => []),
  usage: replace<Usage | null>(() => null),
});

export type CopilotStateType = typeof CopilotState.State;
export type CopilotUpdate = typeof CopilotState.Update;

/**
 * Which node may write which channel (P15). The WRITES-map test runs every
 * node against fixtures and asserts its update's keys are a subset of its
 * row. `proposal` appears only under intake (reset) and control; `pendingPlan`
 * is SET only by plan_check (intake, apply and declined only clear it);
 * `outcomes` only by apply.
 *
 * `request` is written by orient as well as intake: intake cannot know the
 * building's time zone, so orient re-stamps the same instant in it.
 */
export const WRITES = {
  intake: [
    'inbox', 'request', 'dialogue', 'context', 'scope', 'plannerRoute', 'waves', 'taskSeq', 'tasks',
    'findings', 'evidence', 'simRuns', 'controlTask', 'proposal', 'answer', 'violations', 'drafts',
    'notices', 'pendingPlan', 'decision', 'outcomes', 'usage',
  ],
  orient: ['request', 'context', 'evidence', 'notices'],
  planner: ['scope', 'plannerRoute', 'waves', 'taskSeq', 'tasks', 'controlTask', 'notices'],
  diagnose: ['findings', 'evidence', 'simRuns'],
  analyse: ['findings', 'evidence', 'simRuns'],
  simulate: ['findings', 'evidence', 'simRuns'],
  join: ['tasks'],
  compose: ['answer', 'drafts', 'notices'],
  verify: ['violations', 'notices'],
  control: ['findings', 'evidence', 'controlTask', 'proposal'],
  plan_check: ['pendingPlan', 'controlTask', 'notices'],
  confirm: ['decision'],
  apply: ['outcomes', 'pendingPlan', 'decision', 'notices'],
  declined: ['pendingPlan', 'decision', 'notices'],
  finish: ['dialogue', 'usage'],
} as const satisfies Record<string, ReadonlyArray<keyof CopilotStateType>>;

/** The thread a node is running for. Visible inside Send workers and subgraph nodes alike. */
export function threadIdOf(config: { configurable?: Record<string, unknown> } | undefined): string {
  const id = config?.configurable?.thread_id;
  return typeof id === 'string' ? id : '';
}
