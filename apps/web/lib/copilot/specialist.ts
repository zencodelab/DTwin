import type Anthropic from '@anthropic-ai/sdk';
import type { KeyedLimiter } from '@dtwin/types';
import {
  Annotation, END, START, StateGraph, type LangGraphRunnableConfig,
} from '@langchain/langgraph';
import type { Logger } from '../log.ts';
import { CHECK_MODE_CAVEAT } from './caveats.ts';
import type { SpecialistDeps } from './deps.ts';
import type { EvidenceRecord, Finding } from './evidence.ts';
import type { Limits } from './limits.ts';
import { errorName, systemBlocks, transcriptCache, type Models } from './model.ts';
import { DATA_PREAMBLE, LAST_TURN_NUDGE, SYSTEM_PROMPTS } from './prompts.ts';
import { BudgetError, type ModelCaller, type RunRegistry } from './registry.ts';
import {
  contextChannel, controlTaskChannel, evidenceChannel, findingsChannel, proposalChannel, requestChannel,
  scopeChannel, simRunsChannel, threadIdOf, type SpecialistTask,
} from './state.ts';
import { orderCaveats } from './tools/common.ts';
import {
  describeToolCall, evidenceAllocator, offeredTools, runSpecialistTools, toolDefinitions, toolRun,
  type ProposedPlanWithBasis, type ReportFindingInput, type SpecialistRole, type ToolCall, type ToolContext,
  type ToolName, type ToolTurnResult,
} from './tools/index.ts';

/**
 * The specialist subgraph: one factory, one shape, four roles
 * (docs/decisions.md §64, design §3.2).
 *
 *   __start__ → agent ⇄ tools → finish → __end__
 *
 * Each specialist is a COMPILED subgraph added as a node, so it has a private
 * transcript (`messages` never reaches the parent: a specialist's tool results
 * are its working, not the conversation), and `getGraphAsync({xray: true})`
 * draws its inner nodes — so "no specialist node has an edge to the gate" is
 * a property of the drawn graph, asserted by test, not a claim.
 *
 * diagnose, analyse and simulate are reached by Send: their input is the task
 * payload and nothing else. `control` is reached by a plain edge and reads
 * the parent's request, context, scope, controlTask and evidence. Its OUTPUT
 * schema is the only one in the copilot that declares `proposal`.
 *
 * NOTHING THROWS OUT OF A SPECIALIST (P18). A model error, a refusal, a cut-off
 * reply, the budget, the deadline and Stop each become a FINDING with a status
 * and a reason; a tool failure is an is_error the model reads. One sibling
 * failing therefore never aborts or re-runs another (fact 20 is what happens
 * when a node throws in a fan-out).
 *
 * A specialist holds only what its role needs (§6): diagnose and analyse a
 * reader, simulate a reader and the scenario runner, control a reader and the
 * dry-run probe. None holds an issuer; the type of `SpecialistDeps` has none.
 */

// ================================================================== channels

const replaceChannel = <T>(initial: () => T) => Annotation<T>({ reducer: (_, inc) => inc, default: initial });
const sumChannel = () => Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 });

export interface SpecialistFailure {
  status: Finding['status'];
  reason: Finding['reason'];
}

/** One schema for every role; the input and output schemas decide what crosses the boundary. */
function specialistState() {
  return Annotation.Root({
    // What the task starts from: the Send payload, or the parent's state for control.
    task: replaceChannel<SpecialistTask | null>(() => null),
    request: requestChannel,
    context: contextChannel,
    scope: scopeChannel,
    controlTask: controlTaskChannel,
    // Shared with the parent.
    findings: findingsChannel,
    evidence: evidenceChannel,
    simRuns: simRunsChannel,
    proposal: proposalChannel,
    // Private: never visible in the parent, empty on every invocation (e10).
    messages: Annotation<Anthropic.MessageParam[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
    turns: sumChannel(),
    toolCalls: sumChannel(),
    evidenceSeq: sumChannel(),
    report: replaceChannel<ReportFindingInput | null>(() => null),
    failure: replaceChannel<SpecialistFailure | null>(() => null),
    /** A plan propose_plan accepted, held until finish decides whether to emit it. */
    draftPlan: replaceChannel<ProposedPlanWithBasis | null>(() => null),
  });
}

type SpecState = ReturnType<typeof specialistState>['State'];
type SpecUpdate = ReturnType<typeof specialistState>['Update'];

// ===================================================================== view

/** The task as one shape, whichever way the specialist was entered. */
interface TaskView {
  taskId: string;
  goal: string;
  mode: 'propose' | 'check' | undefined;
  zoneIds: string[];
  from: string | null;
  to: string | null;
  inputs: EvidenceRecord[];
  inputEvidenceIds: string[];
  request: SpecialistTask['request'];
  building: SpecialistTask['building'];
  directory: SpecialistTask['directory'];
  availability: SpecialistTask['availability'];
  envelope: SpecialistTask['envelope'];
  simAvailable: boolean;
}

function viewOf(role: SpecialistRole, s: SpecState): TaskView | null {
  if (role !== 'control') {
    const t = s.task;
    if (t === null) return null;
    return {
      taskId: t.taskId, goal: t.goal, mode: undefined, zoneIds: t.zoneIds, from: t.from, to: t.to,
      inputs: t.inputs, inputEvidenceIds: t.inputs.map((e) => e.id), request: t.request, building: t.building,
      directory: t.directory, availability: t.availability, envelope: t.envelope, simAvailable: t.simAvailable,
    };
  }
  const { controlTask: ct, context, request } = s;
  if (ct === null || context === null || request === null) return null;
  // The request's simulation (at most one record: one simulate call per
  // request) comes FIRST, whether or not the planner named it. A plan can
  // cite as its basis only evidence its task was handed, and in a compound
  // request the planner writes the controlTask on its FIRST decision, before
  // the simulation exists — so its ids cannot name it. The first real
  // compound run proposed a plan with no "simulated as" badge for exactly that
  // reason (ADR 64, "One real run").
  const simulated = Object.values(s.evidence).filter((e) => e.kind === 'simulated').map((e) => e.id);
  const inputs = [...new Set([...simulated, ...ct.inputEvidenceIds])]
    .filter((id) => Object.hasOwn(s.evidence, id)).slice(0, 6).map((id) => s.evidence[id]!);
  return {
    taskId: 'K', goal: ct.brief, mode: ct.mode, zoneIds: [], from: null, to: null,
    inputs, inputEvidenceIds: inputs.map((e) => e.id), request,
    building: { id: context.building.id, name: context.building.name, timezone: context.building.timezone },
    directory: context.directory, availability: context.availability, envelope: context.envelope,
    simAvailable: context.sim.available,
  };
}

/**
 * The first user message: one text block, the data preamble and the task as
 * JSON (§3.2).
 *
 * It carries the operator's QUESTION as well as the goal or brief. The goal
 * is the planner's paraphrase, and a paraphrase loses figures: the first real
 * runs (ADR 64, "One real run") turned "raise … by 1 K" into "one step",
 * which the controller read as the envelope's 2 K step and proposed, and
 * dropped "peaks at 46 °C", so the what-if ran on a 42 °C day of its own
 * choosing. The goal still says what THIS task is; the question says what the
 * operator stated. It is the operator's text, the one thing in the message
 * the DATA_RULE does not make data.
 */
function firstMessage(role: SpecialistRole, v: TaskView): Anthropic.MessageParam {
  const request = { nowIso: v.request.nowIso, timezone: v.request.timezone, localDate: v.request.localDate, weekday: v.request.weekday };
  const question = v.request.text;
  const body = role === 'control'
    ? { taskId: v.taskId, question, brief: v.goal, mode: v.mode, inputs: v.inputs, request, directory: v.directory, envelope: v.envelope }
    : {
      taskId: v.taskId, question, goal: v.goal, window: { from: v.from, to: v.to }, zoneIds: v.zoneIds, request,
      directory: v.directory, availability: v.availability, inputs: v.inputs,
      ...(role === 'simulate' ? { envelope: v.envelope } : {}),
    };
  return { role: 'user', content: [{ type: 'text', text: `${DATA_PREAMBLE}\n${JSON.stringify(body)}` }] };
}

const toolUsesOf = (m: Anthropic.MessageParam | undefined): Anthropic.ToolUseBlockParam[] =>
  m?.role === 'assistant' && Array.isArray(m.content)
    ? m.content.filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use')
    : [];

/** Code-written summaries for a task that ended without a report. The planner and compose read them; nobody else. */
const UNREPORTED: Readonly<Record<string, string>> = {
  turn_limit: 'Stopped at the turn limit before reporting a finding.',
  tool_limit: 'Stopped at the tool-call limit before reporting a finding.',
  budget: 'Stopped: the request used its model-call budget before this task reported.',
  deadline: 'Stopped: the request reached its deadline before this task reported.',
  stopped: 'Stopped at the operator\'s request before this task reported.',
  no_report: 'Ended without reporting a finding.',
  model_error: 'The model call failed; this task could not continue.',
  evidence_full: 'Stopped: the request\'s evidence ledger is full.',
  refused: 'The model declined this task; nothing was acted on.',
};

// ================================================================== factory

export interface SpecialistFactoryDeps {
  /** The role's capabilities — never an issuer. */
  capabilities: SpecialistDeps;
  registry: RunRegistry;
  callModel: ModelCaller;
  models: Models;
  limits: Readonly<Limits>;
  identity: { tenantId: string; userId: string };
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  simLimiter: KeyedLimiter;
  log: Logger;
}

/**
 * Build one specialist. `tools` is the role's tool list (tools/index.ts),
 * restated at the call site so the graph's wiring names what each node can
 * do; it must be exactly the role's list.
 */
export function makeSpecialist(role: 'control', tools: readonly ToolName[], deps: SpecialistFactoryDeps): ReturnType<typeof compileControl>;
export function makeSpecialist(role: 'diagnose' | 'analyse' | 'simulate', tools: readonly ToolName[], deps: SpecialistFactoryDeps): ReturnType<typeof compileWorker>;
export function makeSpecialist(role: SpecialistRole, tools: readonly ToolName[], deps: SpecialistFactoryDeps) {
  const full = offeredTools(role, { mode: 'propose' });
  if (tools.length !== full.length || tools.some((t, i) => t !== full[i])) {
    throw new Error(`makeSpecialist(${role}): the tool list must be exactly ${full.join(', ')}`);
  }
  const { registry, callModel, models, limits, log } = deps;

  const agent = async (s: SpecState, config: LangGraphRunnableConfig): Promise<SpecUpdate> => {
    const threadId = threadIdOf(config);
    const v = viewOf(role, s);
    if (v === null) return { failure: { status: 'failed', reason: 'model_error' } };
    const opening = s.messages.length === 0 ? [firstMessage(role, v)] : [];
    if (s.turns >= limits.maxSpecialistTurns) {
      return { messages: opening, failure: { status: 'partial', reason: 'turn_limit' } };
    }

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: role === 'control' ? models.lead : models.specialist,
      max_tokens: limits.maxTokens,
      system: systemBlocks(SYSTEM_PROMPTS[role]),
      tools: toolDefinitions(role, { mode: v.mode }),
      messages: [...s.messages, ...opening],
      // Automatic caching (model.ts): each turn re-sends the transcript plus
      // one reply and its results, and reads the rest from the entry the
      // previous turn wrote. A request parameter: the stored transcript is
      // never marked.
      cache_control: transcriptCache(),
      // The controller's request is v1's but for caching: no output_config.
      ...(role === 'control' ? {} : { output_config: { effort: 'medium' as const } }),
    };

    let reply: Anthropic.Message;
    try {
      reply = await registry.call(threadId, role, callModel, params);
    } catch (err) {
      if (err instanceof BudgetError) {
        if (err.reason === 'budget') log.warn('copilot.budget_exhausted', { role, taskId: v.taskId });
        return { messages: opening, failure: { status: 'partial', reason: err.reason } };
      }
      log.warn('copilot.specialist_failed', { role, taskId: v.taskId, error: errorName(err) });
      return { messages: opening, failure: { status: 'failed', reason: 'model_error' } };
    }

    // The stop reason is read BEFORE the content. A refusal's content may be
    // cut off mid tool call, and a half-formed call is worse than none.
    if (reply.stop_reason === 'refusal') {
      return { messages: opening, turns: 1, failure: { status: 'refused', reason: null } };
    }
    if (reply.stop_reason === 'max_tokens' || reply.stop_reason === 'model_context_window_exceeded') {
      return { messages: opening, turns: 1, failure: { status: 'partial', reason: 'no_report' } };
    }
    return {
      messages: [...opening, { role: 'assistant', content: reply.content as Anthropic.ContentBlockParam[] }],
      turns: 1,
    };
  };

  const toolsNode = async (s: SpecState, config: LangGraphRunnableConfig): Promise<SpecUpdate> => {
    const threadId = threadIdOf(config);
    const v = viewOf(role, s)!;
    const calls: ToolCall[] = toolUsesOf(s.messages[s.messages.length - 1])
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    for (const c of calls) {
      config.writer?.({
        event: 'copilot.activity', taskId: v.taskId, tool: c.name.slice(0, 64),
        label: describeToolCall(c.name, c.input, { directory: v.directory }),
      });
    }

    const own = Object.keys(s.evidence).filter((id) => id.startsWith(`${v.taskId}.`));
    const allocator = evidenceAllocator({ taskId: v.taskId, after: s.evidenceSeq, claim: () => registry.claimEvidence(threadId) });
    const ctx: ToolContext = {
      deps: deps.capabilities,
      orient: {
        building: v.building, directory: v.directory,
        availability: { forecastWeather: v.availability.forecastWeather },
        envelope: v.envelope, sim: { available: v.simAvailable },
      },
      identity: deps.identity,
      requestId: registry.requestId(threadId) ?? v.request.requestId,
      run: toolRun(registry, threadId),
      limits,
      now: deps.clock,
      sleep: deps.sleep,
      allocateEvidenceId: allocator.next,
      simLimiter: deps.simLimiter,
      emit: config.writer ? (e) => config.writer!(e) : undefined,
      log: (event, fields) => log.warn(event, fields),
    };

    let turn: ToolTurnResult;
    try {
      turn = await runSpecialistTools({
        role, ctx, calls, callsSoFar: s.toolCalls,
        task: { taskId: v.taskId, inputEvidenceIds: v.inputEvidenceIds, producedEvidenceIds: own, mode: v.mode },
      });
    } catch (err) {
      // runSpecialistTools answers every failure itself; this keeps the
      // transcript valid (one tool_result per tool_use) if that ever breaks.
      log.error('copilot.tool_failed', { role, taskId: v.taskId, error: errorName(err) });
      turn = {
        blocks: calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: 'the tool failed inside the copilot', is_error: true })),
        results: [], evidence: [], proposal: null, report: null, simRuns: [], callsRun: calls.length, ledgerFull: false,
      };
    }

    for (const e of turn.evidence) {
      config.writer?.({
        event: 'copilot.evidence', id: e.id, taskId: e.taskId, tool: e.tool, source: e.source, kind: e.kind,
        label: e.label, window: e.window, coverage: e.coverage, flaggedExcluded_count: e.flaggedExcluded_count,
        truncated: e.truncated,
      });
    }

    const content: Anthropic.ContentBlockParam[] = [...turn.blocks];
    if (s.turns === limits.maxSpecialistTurns - 1 && turn.report === null) {
      content.push({ type: 'text', text: LAST_TURN_NUDGE });
    }
    const update: SpecUpdate = {
      messages: [{ role: 'user', content }],
      toolCalls: turn.callsRun,
      evidenceSeq: allocator.issued(),
    };
    if (turn.evidence.length > 0) update.evidence = Object.fromEntries(turn.evidence.map((e) => [e.id, e]));
    if (turn.simRuns.length > 0) update.simRuns = Object.fromEntries(turn.simRuns.map((r) => [r.runId, r]));
    if (turn.report !== null) update.report = turn.report;
    if (role === 'control' && turn.proposal !== null) update.draftPlan = turn.proposal;
    if (turn.report === null && (turn.ledgerFull || registry.evidenceFull(threadId))) {
      update.failure = { status: 'partial', reason: 'evidence_full' };
    }
    return update;
  };

  const finish = (s: SpecState, config: LangGraphRunnableConfig): SpecUpdate => {
    const v = viewOf(role, s);
    if (v === null) return {};
    const own = Object.keys(s.evidence).filter((id) => id.startsWith(`${v.taskId}.`));
    let finding: Finding;
    if (s.report !== null) {
      finding = {
        taskId: v.taskId, specialist: role, status: s.report.status, reason: null,
        summary: s.report.summary, claims: s.report.claims, openQuestions: s.report.openQuestions,
        caveats: s.report.caveats, evidenceIds: own,
      };
    } else {
      const f = s.failure ?? { status: 'partial', reason: 'no_report' };
      finding = {
        taskId: v.taskId, specialist: role, status: f.status, reason: f.reason,
        summary: UNREPORTED[f.reason ?? f.status] ?? UNREPORTED.no_report!,
        claims: [], openQuestions: [],
        caveats: orderCaveats(own.flatMap((id) => s.evidence[id]?.caveats ?? [])),
        evidenceIds: own,
      };
    }
    // A check never proposes, so its finding says why, in fixed words.
    if (role === 'control' && v.mode === 'check') {
      finding = { ...finding, caveats: orderCaveats([...finding.caveats, CHECK_MODE_CAVEAT]) };
    }
    config.writer?.({ event: 'copilot.task', taskId: v.taskId, specialist: role, status: finding.status });

    const update: SpecUpdate = { findings: { [v.taskId]: finding } };
    if (role === 'control') {
      update.controlTask = s.controlTask === null ? null : { ...s.controlTask, status: 'done' };
      // A plan survives a task that ran out of turns or budget after
      // proposing it (plan_check re-checks everything). It does not survive a
      // refusal, the operator's Stop or the deadline: those act on nothing.
      const reason = s.failure?.reason ?? null;
      const withdrawn = s.report === null && (s.failure?.status === 'refused' || reason === 'stopped' || reason === 'deadline');
      update.proposal = v.mode === 'propose' && !withdrawn ? s.draftPlan : null;
    }
    return update;
  };

  const afterAgent = (s: SpecState): 'tools' | 'finish' =>
    s.failure === null && toolUsesOf(s.messages[s.messages.length - 1]).length > 0 ? 'tools' : 'finish';
  const afterTools = (s: SpecState): 'agent' | 'finish' =>
    s.report !== null || s.failure !== null ? 'finish' : 'agent';

  const nodes = { agent, tools: toolsNode, finish, afterAgent, afterTools };
  return role === 'control' ? compileControl(nodes) : compileWorker(nodes);
}

interface SpecialistNodes {
  agent: (s: SpecState, config: LangGraphRunnableConfig) => Promise<SpecUpdate>;
  tools: (s: SpecState, config: LangGraphRunnableConfig) => Promise<SpecUpdate>;
  finish: (s: SpecState, config: LangGraphRunnableConfig) => SpecUpdate;
  afterAgent: (s: SpecState) => 'tools' | 'finish';
  afterTools: (s: SpecState) => 'agent' | 'finish';
}

/**
 * The controller, entered by a plain edge: it reads the parent's request,
 * context, scope, controlTask and evidence, and its output is the only one
 * that declares `proposal`.
 */
function compileControl(n: SpecialistNodes) {
  const Input = Annotation.Root({
    request: requestChannel, context: contextChannel, scope: scopeChannel, controlTask: controlTaskChannel,
    evidence: evidenceChannel,
  });
  const Output = Annotation.Root({
    findings: findingsChannel, evidence: evidenceChannel, controlTask: controlTaskChannel, proposal: proposalChannel,
  });
  return new StateGraph({ stateSchema: specialistState(), input: Input, output: Output })
    .addNode('agent', n.agent)
    .addNode('tools', n.tools)
    .addNode('finish', n.finish)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', n.afterAgent, ['tools', 'finish'])
    .addConditionalEdges('tools', n.afterTools, ['agent', 'finish'])
    .addEdge('finish', END)
    .compile({ checkpointer: false });
}

/** diagnose, analyse, simulate: entered by Send, so the task payload is ALL they receive. */
function compileWorker(n: SpecialistNodes) {
  const State = specialistState();
  const Input = Annotation.Root({ task: State.spec.task });
  const Output = Annotation.Root({ findings: findingsChannel, evidence: evidenceChannel, simRuns: simRunsChannel });
  return new StateGraph({ stateSchema: State, input: Input, output: Output })
    .addNode('agent', n.agent)
    .addNode('tools', n.tools)
    .addNode('finish', n.finish)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', n.afterAgent, ['tools', 'finish'])
    .addConditionalEdges('tools', n.afterTools, ['agent', 'finish'])
    .addEdge('finish', END)
    .compile({ checkpointer: false });
}
