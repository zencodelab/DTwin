import type Anthropic from '@anthropic-ai/sdk';
import type { EvidenceRecord } from '../evidence.ts';
import { ANALYSE_TOOL_SET } from './analyse.ts';
import {
  ServiceError, isRefused, kb, localIso, sealEvidence, serviceDown, utf8Bytes,
  type EvidenceDraft, type EvidenceTool, type Refused, type SimRunRecord, type SpecialistRole, type ToolContext,
  type ToolEnv, type ToolName, type ToolTask,
} from './common.ts';
import { CONTROL_TOOL_SET, proposePlan, proposePlanDefinition, type ProposedPlanWithBasis } from './control.ts';
import { DIAGNOSE_TOOL_SET } from './diagnose.ts';
import { reportFinding, reportFindingDefinition, type ReportFindingInput } from './report.ts';
import { SIMULATE_TOOL_SET } from './simulate.ts';

/**
 * The copilot's tools by owner, their write classes, and the one dispatcher
 * the specialist `tools` node calls (docs/decisions.md §64).
 *
 * The lists below are asserted verbatim by test. Each names everything that
 * owner can do; a call to anything else is refused at dispatch, before its
 * input is even parsed, so a model cannot reach a tool by naming it.
 */

export const DIAGNOSE_TOOLS = ['zone_conditions', 'zone_history', 'zone_timeline', 'equipment_status', 'list_alerts', 'control_history', 'report_finding'] as const;
export const ANALYSE_TOOLS = ['energy_by_end_use', 'meter_consumption', 'compare_zones', 'report_finding'] as const;
export const SIMULATE_TOOLS = ['simulate_scenarios', 'report_finding'] as const;
export const CONTROL_TOOLS = ['list_zones', 'control_envelope', 'dry_run_setpoint', 'propose_plan', 'report_finding'] as const;

/**
 * Every tool's write class. `read` reads, in a READ ONLY transaction or from
 * ingest's settings; `dry_run` asks the envelope and queues nothing;
 * `scratch` writes simulation rows nothing in the building reads; `propose`
 * hands a plan to plan_check, which is still not the building; `report` ends
 * a task. There is no `building` class: the one write to the building is the
 * graph's `apply` node, which no tool can reach.
 */
export const TOOL_CLASS = {
  zone_conditions: 'read', zone_history: 'read', zone_timeline: 'read', equipment_status: 'read', list_alerts: 'read',
  control_history: 'read', energy_by_end_use: 'read', meter_consumption: 'read', compare_zones: 'read',
  list_zones: 'read', control_envelope: 'read', dry_run_setpoint: 'dry_run', simulate_scenarios: 'scratch',
  propose_plan: 'propose', report_finding: 'report',
} as const;   // no 'building' class exists

export type ToolClass = (typeof TOOL_CLASS)[keyof typeof TOOL_CLASS];

const ROLE_TOOLS: Readonly<Record<SpecialistRole, readonly ToolName[]>> = {
  diagnose: DIAGNOSE_TOOLS,
  analyse: ANALYSE_TOOLS,
  simulate: SIMULATE_TOOLS,
  control: CONTROL_TOOLS,
};

/** Every evidence-producing tool, by name. */
const EVIDENCE_TOOLS: ReadonlyMap<ToolName, EvidenceTool<unknown>> = new Map(
  [...DIAGNOSE_TOOL_SET, ...ANALYSE_TOOL_SET, ...SIMULATE_TOOL_SET, ...CONTROL_TOOL_SET].map((t) => [t.name, t]),
);

const DEFINITIONS: ReadonlyMap<ToolName, Anthropic.Tool> = new Map<ToolName, Anthropic.Tool>([
  ...[...EVIDENCE_TOOLS.values()].map((t) => [t.name, t.definition] as const),
  ['propose_plan', proposePlanDefinition],
  ['report_finding', reportFindingDefinition],
]);

/**
 * What a role is offered. `propose_plan` only in the controller's `propose`
 * mode: a controller asked to CHECK something (say, "can we pre-cool
 * tomorrow?") cannot propose, whatever it concludes (P14).
 */
export function offeredTools(role: SpecialistRole, opts: { mode?: 'propose' | 'check' | undefined } = {}): readonly ToolName[] {
  const tools = ROLE_TOOLS[role];
  return role === 'control' && opts.mode !== 'propose' ? tools.filter((t) => t !== 'propose_plan') : tools;
}

/**
 * The `tools` parameter for a role's model call: byte-identical on every
 * call (the descriptions are built from DEFAULT_LIMITS, never from a
 * request), so it caches, and in the order the lists above give.
 */
export function toolDefinitions(role: SpecialistRole, opts: { mode?: 'propose' | 'check' | undefined } = {}): Anthropic.Tool[] {
  return offeredTools(role, opts).map((name) => DEFINITIONS.get(name)!);
}

/**
 * The specialists the planner may dispatch. `simulate` only when a scenario
 * runner exists (COPILOT_SIM_API_KEY is set, §5.1): an unavailable tool is
 * not offered rather than offered and refused.
 */
export function availableSpecialists(orient: { sim: { available: boolean } }): Array<Exclude<SpecialistRole, 'control'>> {
  return orient.sim.available ? ['diagnose', 'analyse', 'simulate'] : ['diagnose', 'analyse'];
}

// ================================================================== dispatch

export interface ToolCall {
  /** The tool_use block's id. */
  id: string;
  name: string;
  input: unknown;
}

/** One call's answer, as the per-call dispatcher returns it. */
export interface SpecialistToolResult {
  /** The tool_result content. For evidence: JSON of {evidenceId, source, window, caveats, data}. */
  content: string;
  isError?: true;
  evidence?: EvidenceRecord;
  proposal?: ProposedPlanWithBasis;
  report?: ReportFindingInput;
  /** Simulation runs the call started, whether or not it then succeeded. */
  simRuns?: SimRunRecord[];
}

export interface ToolTurnRequest {
  role: SpecialistRole;
  task: ToolTask;
  ctx: ToolContext;
  /** Every tool_use block of one assistant message, in order. */
  calls: readonly ToolCall[];
  /** Calls this task already ran in earlier turns: the per-task bound. */
  callsSoFar?: number;
}

export interface ToolTurnResult {
  /** One per call, in call order: the user message that answers the turn. */
  blocks: Anthropic.ToolResultBlockParam[];
  /** Per call, in call order. */
  results: SpecialistToolResult[];
  /** Records accepted this turn, numbered in call order. */
  evidence: EvidenceRecord[];
  /** The first plan accepted this turn, or null. */
  proposal: ProposedPlanWithBasis | null;
  /** The first finding accepted this turn, or null. */
  report: ReportFindingInput | null;
  simRuns: SimRunRecord[];
  /** Calls that ran (counted toward the per-task bound); capped calls do not count. */
  callsRun: number;
  /** A record was refused because the request's evidence ledger is full. */
  ledgerFull: boolean;
}

type Outcome =
  | { kind: 'error'; content: string; simRuns?: SimRunRecord[] }
  | { kind: 'evidence'; draft: EvidenceDraft }
  | { kind: 'proposal'; content: string; proposal: ProposedPlanWithBasis }
  | { kind: 'report'; content: string; report: ReportFindingInput };

const error = (r: Refused): Outcome =>
  (r.simRuns ? { kind: 'error', content: r.refused, simRuns: r.simRuns } : { kind: 'error', content: r.refused });

/**
 * Run one call to completion — except the evidence id, which is the turn's
 * to assign. Never throws: every failure is an is_error the model can read.
 */
async function execute(role: SpecialistRole, call: ToolCall, env: ToolEnv): Promise<Outcome> {
  const name = call.name as ToolName;
  if (!offeredTools(role, { mode: env.task.mode }).includes(name)) {
    return { kind: 'error', content: role === 'control' && name === 'propose_plan'
      ? 'propose_plan is not offered in check mode: report what you found instead'
      : `${call.name.slice(0, 64)} is not offered to ${role}` };
  }
  // A finding may still be recorded after Stop — it is what was learnt, and
  // nothing reaches the building through it. Everything else refuses.
  if (name !== 'report_finding') {
    const why = env.ctx.run.interrupted();
    if (why !== null) {
      return { kind: 'error', content: why === 'stopped' ? 'the request was stopped: report what you have'
        : 'the request passed its deadline: report what you have' };
    }
  }

  if (name === 'report_finding') {
    const r = await reportFinding(call.input, env);
    return isRefused(r) ? error(r) : { kind: 'report', content: r.content, report: r.report };
  }
  if (name === 'propose_plan') {
    const r = await proposePlan(call.input, env);
    return isRefused(r) ? error(r) : { kind: 'proposal', content: r.content, proposal: r.proposal };
  }

  const tool = EVIDENCE_TOOLS.get(name)!;
  let prepared: unknown;
  let draft: EvidenceDraft | Refused;
  try {
    prepared = tool.prepare(call.input, env);
    if (isRefused(prepared)) return error(prepared);
    draft = await tool.execute(prepared, env);
  } catch (err) {
    // A backend that failed is named; anything else is this code's bug and
    // is reported as one, not blamed on a service that answered.
    if (err instanceof ServiceError) return { kind: 'error', content: err.message };
    env.ctx.log?.('copilot.tool_failed', { tool: name, name: err instanceof Error ? err.name : typeof err });
    return { kind: 'error', content: `${name} failed inside the copilot (not a ${tool.service} fault)` };
  }
  if (isRefused(draft)) return error(draft);

  const bytes = utf8Bytes(JSON.stringify(draft.data));
  const max = env.ctx.limits.maxEvidenceBytes;
  if (bytes > max) {
    const hint = tool.tooLarge ? tool.tooLarge(prepared, bytes, env) : 'narrow the window';
    const r: Refused = { refused: `result too large (${kb(bytes)} > ${kb(max)}); ${hint}` };
    if (draft.simRuns) r.simRuns = draft.simRuns;
    return error(r);
  }
  return { kind: 'evidence', draft };
}

/**
 * One model turn's tool calls: the dispatcher the specialist `tools` node
 * calls, once per assistant message.
 *
 * - At most `maxToolCallsPerTurn` calls run, and at most
 *   `maxToolCallsPerTask` over the task; every call past either bound gets an
 *   is_error naming it, so the transcript stays one tool_result per tool_use.
 *   `report_finding` does not spend the task's budget: the refusal past it
 *   says "call report_finding now", and a task told that must be able to.
 * - The calls run CONCURRENTLY, and never throw.
 * - Then, in CALL order, each accepted draft is given the next evidence id
 *   (`ctx.allocateEvidenceId`) — so ids follow the order the model asked in,
 *   however the reads interleaved, and a refused call leaves no gap. When
 *   the request's ledger is full the record is refused instead ("evidence
 *   ledger full").
 * - All results come back as ONE list of tool_result blocks, the next user
 *   message: splitting them would teach the model to stop calling in parallel.
 */
export async function runSpecialistTools(req: ToolTurnRequest): Promise<ToolTurnResult> {
  const { role, task, ctx, calls } = req;
  const env: ToolEnv = { role, task, ctx };
  const { maxToolCallsPerTurn: perTurn, maxToolCallsPerTask: perTask, maxEvidencePerRequest } = ctx.limits;
  let budget = Math.max(0, perTask - (req.callsSoFar ?? 0));

  const pending = calls.map((call, i): Promise<Outcome> | Outcome => {
    if (i >= perTurn) return { kind: 'error', content: `at most ${perTurn} tool calls per turn: call again next turn` };
    if (call.name !== 'report_finding') {
      if (budget <= 0) return { kind: 'error', content: `at most ${perTask} tool calls per task: call report_finding now` };
      budget -= 1;
    }
    // `execute` answers every failure it knows of; this catches the one it
    // does not, so a turn always gets one tool_result per tool_use (P18).
    return execute(role, call, env).catch((err: unknown): Outcome => {
      ctx.log?.('copilot.tool_failed', { tool: call.name.slice(0, 64), name: err instanceof Error ? err.name : typeof err });
      return { kind: 'error', content: `${call.name.slice(0, 64)} failed inside the copilot` };
    });
  });
  const callsRun = pending.filter((p) => p instanceof Promise).length;
  const outcomes = await Promise.all(pending);

  const out: ToolTurnResult = {
    blocks: [], results: [], evidence: [], proposal: null, report: null, simRuns: [], callsRun, ledgerFull: false,
  };
  outcomes.forEach((o, i) => {
    let result: SpecialistToolResult;
    switch (o.kind) {
      case 'error':
        result = { content: o.content, isError: true, ...(o.simRuns ? { simRuns: o.simRuns } : {}) };
        break;
      case 'evidence': {
        const id = ctx.allocateEvidenceId();
        if (id === null) {
          out.ledgerFull = true;
          result = { content: `evidence ledger full (${maxEvidencePerRequest}): report what you have`, isError: true };
        } else {
          const sealed = sealEvidence(o.draft, id, task.taskId, localIso(ctx.now(), env));
          result = { content: sealed.content, evidence: sealed.evidence };
          out.evidence.push(sealed.evidence);
        }
        if (o.draft.simRuns) result.simRuns = o.draft.simRuns;
        break;
      }
      case 'proposal':
        if (out.proposal === null) {
          out.proposal = o.proposal;
          result = { content: o.content, proposal: o.proposal };
        } else {
          result = { content: 'only one plan per turn; the first was kept', isError: true };
        }
        break;
      case 'report':
        if (out.report === null) {
          out.report = o.report;
          result = { content: o.content, report: o.report };
        } else {
          result = { content: 'a finding was already recorded this turn; the first was kept', isError: true };
        }
        break;
    }
    if (result.simRuns) out.simRuns.push(...result.simRuns);
    out.results.push(result);
    out.blocks.push({
      type: 'tool_result',
      tool_use_id: calls[i]!.id,
      content: result.content,
      ...(result.isError ? { is_error: true } : {}),
    });
  });
  return out;
}

/**
 * One call on its own — `runSpecialistTools` with a single call. For tests
 * and for callers with exactly one call; the tools node calls the batch form
 * so that a turn's ids follow call order.
 */
export async function runSpecialistTool(req: {
  role: SpecialistRole; name: string; input: unknown; task: ToolTask; ctx: ToolContext; callsSoFar?: number;
}): Promise<SpecialistToolResult> {
  const turn = await runSpecialistTools({
    role: req.role, task: req.task, ctx: req.ctx, calls: [{ id: 'call', name: req.name, input: req.input }],
    ...(req.callsSoFar !== undefined ? { callsSoFar: req.callsSoFar } : {}),
  });
  return turn.results[0]!;
}

/** The service a tool would blame when it cannot be reached — for logs and for tests. */
export function toolService(name: ToolName): string | null {
  const t = EVIDENCE_TOOLS.get(name);
  return t ? serviceDown(t.service) : null;
}

// ================================================================= activity

/**
 * What a call is doing, for the panel's activity line (`copilot.activity`).
 * Built from the directory and fixed words — zone names come from the
 * directory by id, never from text the model wrote, and nothing the model
 * typed is echoed.
 */
export function describeToolCall(name: string, input: unknown, orient: { directory: ReadonlyArray<{ id: string; name: string }> }): string {
  const i = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const zone = (id: unknown) => (typeof id === 'string' ? orient.directory.find((z) => z.id === id)?.name : undefined);
  const on = (id: unknown) => { const n = zone(id); return n ? ` for ${n}` : ''; };
  switch (name) {
    case 'zone_conditions': return `reading conditions${on(i.zoneId)}`;
    case 'zone_history': return `reading history${on(i.zoneId)}`;
    case 'zone_timeline': return `reading the timeline${on(i.zoneId)}`;
    case 'equipment_status': return `reading equipment${on(i.zoneId)}`;
    case 'list_alerts': return `listing alerts${on(i.zoneId)}`;
    case 'control_history': return `listing setpoint commands${on(i.zoneId)}`;
    case 'energy_by_end_use': return 'reading measured energy';
    case 'meter_consumption': return 'reading a meter';
    case 'compare_zones': return 'ranking zones';
    case 'simulate_scenarios': return 'simulating scenarios';
    case 'list_zones': return 'reading every zone';
    case 'control_envelope': return 'reading the control envelope';
    case 'dry_run_setpoint': return `dry-running a setpoint${on(i.zoneId)}`;
    case 'propose_plan': {
      const n = Array.isArray(i.commands) ? i.commands.length : 0;
      return `proposing ${n} command${n === 1 ? '' : 's'}`;
    }
    case 'report_finding': return 'reporting a finding';
    default: return 'an unknown tool';
  }
}

export {
  evidenceAllocator, toolRun, type SimEventPayload, type SimRunRecord, type SpecialistRole, type ToolContext,
  type ToolName, type ToolOrient, type ToolRun, type ToolTask,
} from './common.ts';
export {
  MAX_PLAN_COMMANDS, PlanBasis, ProposedCommand, ProposedPlan, ProposedPlanWithBasis,
} from './control.ts';
export { ReportFindingInput } from './report.ts';
export { makeSimLimiter, sharedSimLimiter } from './simulate.ts';
