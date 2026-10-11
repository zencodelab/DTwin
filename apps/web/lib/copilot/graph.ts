import { END, START, StateGraph, type LangGraphRunnableConfig } from '@langchain/langgraph';
import { log as defaultLog, type Logger } from '../log.ts';
import { makeApply } from './apply.ts';
import { BoundedMemorySaver } from './checkpoints.ts';
import { makeCompose, makeVerify } from './compose.ts';
import { makeConfirm } from './confirm.ts';
import type { GraphDeps } from './deps.ts';
import { PLANNER_TARGETS, afterPlanner, join } from './fanout.ts';
import { ApprovalLedger } from './ledger.ts';
import { afterOrient, declined, makeFinish, makeIntake } from './lifecycle.ts';
import { DEFAULT_LIMITS, resolveLimits, type Limits } from './limits.ts';
import type { Models } from './model.ts';
import { makeOrient } from './orient.ts';
import { makePlanCheck } from './plan-check.ts';
import { makePlanner } from './planner.ts';
import type { CopilotNode } from './protocol.ts';
import { RunRegistry, type Usage } from './registry.ts';
import { makeSpecialist, type SpecialistFactoryDeps } from './specialist.ts';
import { CopilotState, type CopilotStateType } from './state.ts';
import {
  ANALYSE_TOOLS, CONTROL_TOOLS, DIAGNOSE_TOOLS, SIMULATE_TOOLS, makeSimLimiter, sharedSimLimiter,
} from './tools/index.ts';

export { DEFAULT_MODEL, hasModelCredential, realModelCaller, resolveModels, type Models } from './model.ts';
export { SYSTEM_PROMPTS } from './prompts.ts';

/**
 * The copilot as a graph: a planner that fans specialists out in bounded
 * waves (they read, and `simulate` also writes scratch simulation runs;
 * none can write to the building), a composer whose every figure is
 * verified, and — for a
 * setpoint change — one door to the building (docs/decisions.md §63, §64).
 *
 * The diagram is GENERATED from this graph (`npm run copilot:graph`), never
 * drawn by hand; README and ADR 64 embed it, and a test compares them.
 *
 * ONE DOOR. The only way to the building is
 *
 *   control → plan_check → confirm (interrupt) → apply
 *
 * and each link is asserted on the compiled graph, flat and xray:
 * `apply`'s only in-edge is `confirm`, `confirm`'s is `plan_check`,
 * `plan_check`'s is `control`, and nothing a specialist, the join, compose or
 * verify can reach leads to any of them. Behind the edge list sit three more
 * locks, for the day it is wrong: a source scan for the constructs that route
 * around drawn edges (Command goto, Send outside `fanout.ts`, an error
 * handler, Command.PARENT); `confirm` calling `interrupt()` as its first
 * statement, so it pauses however it is entered; and `apply` issuing only the
 * frozen plan `confirm` granted into a consume-once ledger held OUTSIDE graph
 * state, after a person's resume named that plan's id and hash.
 *
 * ONE ISSUER. `deps.issuer` is handed to `makeApply` and to nothing else.
 * Every other node gets a narrower capability — a reader, the dry-run probe,
 * the scenario runner — and the types say so.
 *
 * The ledger and the run registry are created here, per compiled graph (one
 * per signed-in user), and keyed by thread. They are closures, not state:
 * state is checkpointed and written by reducers at the end of a superstep,
 * and neither a grant nor a budget can be allowed to be either.
 */

/** Waves per request; past it the planner makes no call (design §8). */
export const MAX_WAVES = DEFAULT_LIMITS.maxWaves;

/**
 * Supersteps per graph level. The worst case — three waves, three drafts,
 * the controller, plan_check and confirm — is about 25 at the top level and
 * about 15 inside a specialist; a test runs it (design §8).
 */
export const RECURSION_LIMIT = DEFAULT_LIMITS.recursionLimit;

/**
 * What each node IS, for the panel's diagram and the docs. A property of the
 * node, kept beside the graph rather than in node metadata, because metadata
 * would change the generated Mermaid.
 */
export const NODE_ROLES = {
  intake: 'pure',
  orient: 'read',
  planner: 'llm',
  diagnose: 'specialist',
  analyse: 'specialist',
  simulate: 'specialist-scratch',
  join: 'join',
  compose: 'llm',
  verify: 'pure',
  control: 'specialist-control',
  plan_check: 'dry-run',
  confirm: 'interrupt',
  apply: 'writes-building',
  declined: 'pure',
  finish: 'pure',
} as const satisfies Record<CopilotNode, string>;
export type NodeRole = (typeof NODE_ROLES)[keyof typeof NODE_ROLES];

// ================================================================== routers

/**
 * After verify, in order: another draft while one is allowed; then the
 * controller if this request gave it a task and may control; else finish.
 */
export function afterVerify(s: CopilotStateType, maxDrafts: number = DEFAULT_LIMITS.maxDrafts): 'compose' | 'control' | 'finish' {
  if (s.violations.length > 0 && s.answer !== null && s.drafts < maxDrafts) return 'compose';
  if (s.controlTask?.status === 'pending' && s.scope?.allowControl === true && s.request?.mayCommand === true) {
    return 'control';
  }
  return 'finish';
}

/** A plan goes to plan_check; a controller that proposed nothing is answered in words. */
export function afterControl(s: CopilotStateType): 'plan_check' | 'compose' {
  return s.proposal !== null ? 'plan_check' : 'compose';
}

export function afterPlanCheck(s: CopilotStateType): 'confirm' | 'finish' {
  return s.pendingPlan !== null ? 'confirm' : 'finish';
}

export function afterConfirm(s: CopilotStateType): 'apply' | 'declined' {
  return s.decision === 'approved' ? 'apply' : 'declined';
}

// ==================================================================== build

const realSleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export function buildCopilotGraph(deps: GraphDeps) {
  const { reader, probe, issuer, scenarios, callModel, models, identity } = deps;
  const limits = resolveLimits(deps.limits);
  const clock = deps.clock ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const log = deps.log ?? defaultLog;

  const registry = new RunRegistry({ limits: deps.limits ?? {}, clock });
  const ledger = new ApprovalLedger({
    clock, grantTtlS: limits.grantTtlS, planTtlS: limits.planTtlS, maxPlanCommands: limits.maxPlanCommands,
  });
  // Runs per person per hour. The shared limiter runs on real time and spans
  // every graph in the process; a graph given its own clock (tests) gets its
  // own limiter on that clock, so a fake hour is an hour.
  const simLimiter = deps.clock === undefined
    ? sharedSimLimiter()
    : makeSimLimiter({ runsPerHour: limits.simRunsPerUserPerHour, now: clock });

  const common: Omit<SpecialistFactoryDeps, 'capabilities'> = {
    registry, callModel, models, limits, identity, clock, sleep, simLimiter, log,
  };

  const graph = new StateGraph(CopilotState)
    .addNode('intake', makeIntake({ registry, ledger, clock, identity, log }))
    .addNode('orient', makeOrient({ reader, probe, simAvailable: scenarios !== null, clock, log }))
    .addNode('planner', makePlanner({ registry, callModel, models, limits, log }))
    .addNode('diagnose', makeSpecialist('diagnose', DIAGNOSE_TOOLS, { ...common, capabilities: { reader } }))
    .addNode('analyse', makeSpecialist('analyse', ANALYSE_TOOLS, { ...common, capabilities: { reader } }))
    .addNode('simulate', makeSpecialist('simulate', SIMULATE_TOOLS, { ...common, capabilities: { reader, scenarios } }))
    .addNode('join', (s: CopilotStateType, _config: LangGraphRunnableConfig) => join(s), { defer: true })
    .addNode('compose', makeCompose({ registry, callModel, models, limits, log }))
    .addNode('verify', makeVerify({ limits, log }))
    .addNode('control', makeSpecialist('control', CONTROL_TOOLS, { ...common, capabilities: { reader, probe } }))
    .addNode('plan_check', makePlanCheck({ probe, limits, clock, log, interrupted: (t) => registry.interrupted(t) }))
    .addNode('confirm', makeConfirm(ledger, clock))
    .addNode('apply', makeApply(issuer, ledger, log, (t) => registry.stopRequested(t)))
    .addNode('declined', declined)
    .addNode('finish', makeFinish({ registry }))
    .addEdge(START, 'intake')
    .addEdge('intake', 'orient')
    .addConditionalEdges('orient', afterOrient, ['planner', 'finish'])
    .addConditionalEdges('planner', afterPlanner, [...PLANNER_TARGETS])
    .addEdge('diagnose', 'join')
    .addEdge('analyse', 'join')
    .addEdge('simulate', 'join')
    .addEdge('join', 'planner')
    .addEdge('compose', 'verify')
    .addConditionalEdges('verify', (s: CopilotStateType) => afterVerify(s, limits.maxDrafts), ['compose', 'control', 'finish'])
    .addConditionalEdges('control', afterControl, ['plan_check', 'compose'])
    .addConditionalEdges('plan_check', afterPlanCheck, ['confirm', 'finish'])
    .addConditionalEdges('confirm', afterConfirm, ['apply', 'declined'])
    .addEdge('apply', 'finish')
    .addEdge('declined', 'finish')
    .addEdge('finish', END);

  // Each thread keeps its latest checkpoint only, and a graph at most
  // maxThreadsPerGraph threads; a thread with an open request is never let go.
  const checkpointer = new BoundedMemorySaver({
    maxThreads: limits.maxThreadsPerGraph,
    busy: (threadId) => registry.requestId(threadId) !== null,
  });
  const compiled = graph.compile({ checkpointer });
  CONTROLS.set(compiled, {
    stop: (threadId) => registry.stop(threadId),
    clearStop: (threadId) => registry.clearStop(threadId),
    running: (threadId) => registry.requestId(threadId) !== null,
    anyOpen: () => registry.anyOpen(),
    hasGrant: (threadId) => ledger.has(threadId),
    usage: (threadId) => {
      const requestId = registry.requestId(threadId);
      const usage = registry.usage(threadId);
      return requestId === null || usage === null ? null : { requestId, usage };
    },
    abandon: (threadId) => {
      registry.end(threadId);
      ledger.revoke(threadId);
    },
    limits,
    models,
    clock,
    log,
  });
  return compiled;
}

export type CopilotGraph = ReturnType<typeof buildCopilotGraph>;

/**
 * The few things a caller may do to a graph's request from outside it:
 * press Stop, ask whether a request is open and what it has used, ask
 * whether a grant is held (never read it), close a request that failed —
 * plus the settings the session runs the graph with (its limits, models,
 * clock and logger), so a run needs nothing but the graph. Held in a WeakMap
 * so the registry and the ledger stay closures: nothing here can spend a
 * budget, grant a plan or take one (abandon only revokes).
 */
export interface CopilotControls {
  stop(threadId: string): boolean;
  /** A decision answers a Stop pressed while its plan waited (registry `clearStop`). */
  clearStop(threadId: string): void;
  running(threadId: string): boolean;
  /** Whether any thread of this graph has a request open (the route never evicts such a graph). */
  anyOpen(): boolean;
  hasGrant(threadId: string): boolean;
  /**
   * What the thread's open request has used so far, and which request that
   * is — for a turn read while the request is still open (paused at
   * `confirm`, or mid-run), whose `usage` channel `finish` has not written.
   */
  usage(threadId: string): { requestId: string; usage: Usage } | null;
  /**
   * Close a request that failed without reaching `finish`: end its registry
   * entry (so `running` stops saying true, and a late straggler is refused
   * like any call after `end`) and revoke any grant (fail closed — the next
   * approval must come through `confirm` again).
   */
  abandon(threadId: string): void;
  limits: Readonly<Limits>;
  models: Models;
  clock: () => number;
  log: Logger;
}

const CONTROLS = new WeakMap<object, CopilotControls>();

export function copilotControls(graph: CopilotGraph): CopilotControls {
  const c = CONTROLS.get(graph);
  if (!c) throw new Error('not a copilot graph built by buildCopilotGraph');
  return c;
}
