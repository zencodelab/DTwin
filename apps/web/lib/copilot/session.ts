import { randomUUID } from 'node:crypto';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import type { EvidenceRecord, Finding } from './evidence.ts';
import { copilotControls, RECURSION_LIMIT, type CopilotGraph } from './graph.ts';
import type { Models } from './model.ts';
import { noticeText, type Notice } from './notices.ts';
import { CopilotTurn, PendingPlan, type CopilotEvent } from './protocol.ts';
import { renderAnswer, renderCard } from './render.ts';
import type { CopilotStateType, ReviewedCommand, ReviewedPlan } from './state.ts';
import type { Usage } from './registry.ts';
import { projectChunk } from './stream.ts';
import { verifyText } from './verify.ts';

export { CopilotTurn, type CopilotEvent };

/**
 * Running the copilot graph for one turn, and projecting what the operator
 * may see (docs/decisions.md §64, design §9.1–9.3).
 *
 * ONE RUNNER. JSON and NDJSON answers go through the same `runTurn`: it
 * streams the graph (`updates` + `custom`, subgraphs included), hands each
 * chunk to the pure projector, and ends with the turn read back from the
 * checkpoint. A caller that wants events passes a sink; one that does not
 * gets the same final turn.
 *
 * The rules it keeps:
 *
 * - A DECISION is refused BEFORE the graph runs unless the thread holds a
 *   pending interrupt from `confirm` with exactly the id, plan id and plan
 *   hash the operator was shown, and that plan has not expired (P8). The
 *   resume is then keyed by that interrupt id, never a scalar: a scalar
 *   resume answers EVERY pending interrupt at once (fact 15).
 * - ONE RUN PER THREAD. The lock lives here so the route and the tests share
 *   it; a second Approve while the first runs is a `LockConflict` (409), and
 *   the ledger's consume-once grant catches anything that gets past (P7).
 * - `new Command(` appears in this file and nowhere else in the copilot, and
 *   only to resume (the source scan holds both).
 * - No `signal`. A client that disconnects does not abort the run: it
 *   finishes within its bounds and checkpoints, and `rehydrate` shows it.
 * - The browser never receives a model message. `turnFromState` builds the
 *   turn field by field — verified answer segments, verified wording, code-
 *   built labels, fixed notice text — and the protocol schema is applied to
 *   it before it leaves. A run that fails says so in fixed words, and the
 *   log gets the error's name, never its message.
 */

// ==================================================================== errors

/** A run is already in progress on this thread. The route answers 409 with Retry-After. */
export class LockConflict extends Error {
  readonly retryAfterS: number;
  constructor(retryAfterS: number) {
    super('a request on this thread is still running');
    this.name = 'LockConflict';
    this.retryAfterS = retryAfterS;
  }
}

/** Nothing the decision named is awaiting approval. The route answers 409. */
export class NoPendingPlan extends Error {
  readonly code: 'nothing_pending' | 'plan_expired' = 'nothing_pending';
  constructor(message = 'nothing awaiting approval') {
    super(message);
    this.name = 'NoPendingPlan';
  }
}

/**
 * The plan the decision named is pending but past its TTL. A NoPendingPlan
 * too — nothing approvable is pending — so a caller that handles only the
 * general case still refuses it.
 */
export class PlanExpired extends NoPendingPlan {
  override readonly code = 'plan_expired' as const;
  constructor() {
    super('plan_expired');
    this.name = 'PlanExpired';
  }
}

/** The run failed after it started. Fixed words; the cause is logged by name only. */
export class TurnFailed extends Error {
  readonly requestId: string | null;
  constructor(requestId: string | null) {
    super(TURN_FAILED);
    this.name = 'TurnFailed';
    this.requestId = requestId;
  }
}

const TURN_FAILED = 'the copilot could not complete this turn' as const;

// ==================================================================== inputs

export const DecisionRequest = z.object({
  decision: z.enum(['approved', 'declined']),
  interruptId: z.string().min(1).max(200),
  planId: z.string().uuid(),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type DecisionRequest = z.infer<typeof DecisionRequest>;

export type TurnInput =
  | { kind: 'message'; text: string; mayCommand: boolean; requestId?: string }
  | ({ kind: 'decision' } & DecisionRequest);

/** Where events go. A sink that throws (a closed socket) is dropped, never fatal. */
export type EventSink = (event: CopilotEvent) => void;

// ===================================================================== locks

const LOCKS = new WeakMap<CopilotGraph, Set<string>>();

export interface ThreadLock {
  readonly threadId: string;
  /** Idempotent. */
  release(): void;
}

/**
 * Take the thread, or throw `LockConflict` — synchronously, so two requests
 * arriving together cannot both pass. Held across the whole run, including
 * a streamed one; release it when the run has ended, not when the response
 * has been handed to the client.
 */
export function lockThread(graph: CopilotGraph, threadId: string): ThreadLock {
  let held = LOCKS.get(graph);
  if (!held) LOCKS.set(graph, (held = new Set()));
  if (held.has(threadId)) throw new LockConflict(copilotControls(graph).limits.lockRetryAfterS);
  held.add(threadId);
  let released = false;
  const set = held;
  return {
    threadId,
    release: () => {
      if (released) return;
      released = true;
      set.delete(threadId);
    },
  };
}

export function threadRunning(graph: CopilotGraph, threadId: string): boolean {
  return LOCKS.get(graph)?.has(threadId) ?? false;
}

/**
 * Whether a graph is doing anything a person is waiting on: a thread locked
 * by a run, or a request open (running, or a plan waiting at `confirm`). The
 * route never evicts such a graph (graph-cache.ts).
 */
export function graphBusy(graph: CopilotGraph): boolean {
  return (LOCKS.get(graph)?.size ?? 0) > 0 || copilotControls(graph).anyOpen();
}

export async function withThreadLock<T>(graph: CopilotGraph, threadId: string, fn: () => Promise<T>): Promise<T> {
  const lock = lockThread(graph, threadId);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

// =================================================================== config

function stateConfig(threadId: string) {
  return { configurable: { thread_id: threadId } };
}

/** The run's config. No `signal`: a disconnect must not abort a run mid-node (§8). */
function runConfig(graph: CopilotGraph, threadId: string) {
  return {
    ...stateConfig(threadId),
    recursionLimit: RECURSION_LIMIT,
    maxConcurrency: copilotControls(graph).limits.maxConcurrency,
    streamMode: ['updates', 'custom'] as ('updates' | 'custom')[],
    subgraphs: true as const,
  };
}

// ================================================================ decisions

/**
 * The plan a decision may act on, or a throw — before any part of the graph
 * runs. The thread must hold exactly one pending interrupt, raised by
 * `confirm`, whose plan is the one in state; the decision must name that
 * interrupt, that plan and that hash; and the plan must not have expired.
 * An unknown thread, a finished thread, a superseded plan and a wrong hash
 * are all the same answer: nothing awaiting approval.
 */
export async function pendingDecision(
  graph: CopilotGraph, threadId: string, d: DecisionRequest,
): Promise<{ plan: PendingPlan; requestId: string | null }> {
  const snapshot = await graph.getState(stateConfig(threadId));
  const plan = pendingPlanOf(snapshot);
  if (plan === null || plan.interruptId !== d.interruptId || plan.planId !== d.planId || plan.planHash !== d.planHash) {
    throw new NoPendingPlan();
  }
  if (Date.parse(plan.expiresAt) <= copilotControls(graph).clock()) throw new PlanExpired();
  const values = (snapshot.values ?? {}) as Partial<CopilotStateType>;
  return { plan, requestId: values.request?.requestId ?? null };
}

// ===================================================================== runs

/**
 * Run one turn: a new message, or a decision on the pending plan. Events go
 * to `onEvent` as they happen; the final turn is returned (and sent as the
 * last event). Takes no lock itself — the caller holds the thread
 * (`withThreadLock`, or the route across a stream).
 *
 * Throws `NoPendingPlan` / `PlanExpired` before the graph runs, and
 * `TurnFailed` if the run fails after it started (after sending an `error`
 * event in fixed words).
 */
export async function runTurn(
  graph: CopilotGraph, threadId: string, input: TurnInput, onEvent?: EventSink,
): Promise<CopilotTurn> {
  const controls = copilotControls(graph);
  let sink = onEvent;
  const emit = (e: CopilotEvent) => {
    if (!sink) return;
    try {
      sink(e);
    } catch {
      // The reader went away. The run carries on and checkpoints; the next
      // GET ?threadId shows how it ended.
      sink = undefined;
    }
  };

  let graphInput: Parameters<CopilotGraph['stream']>[0];
  let requestId: string | null;
  if (input.kind === 'message') {
    requestId = input.requestId ?? randomUUID();
    graphInput = {
      inbox: {
        requestId,
        text: input.text,
        receivedAt: new Date(controls.clock()).toISOString(),
        mayCommand: input.mayCommand,
      },
    };
  } else {
    const d: DecisionRequest = {
      decision: input.decision, interruptId: input.interruptId, planId: input.planId, planHash: input.planHash,
    };
    ({ requestId } = await pendingDecision(graph, threadId, d));
    // The decision is the operator's latest word: a Stop pressed while the
    // plan waited must not keep an approved plan from being issued. A Stop
    // pressed from here on is honoured by `apply`, between commands.
    controls.clearStop(threadId);
    // Keyed by the interrupt's id: it answers that interrupt and no other.
    graphInput = new Command({ resume: { [d.interruptId]: { decision: d.decision, planId: d.planId, planHash: d.planHash } } });
  }

  // A run that fails never reaches `finish`, which is what closes its
  // request in the registry — so close it here, or `running` would go on
  // saying true for a request that is over (gate open issue) and a straggler
  // could still spend its budget.
  const failed = (err: unknown): TurnFailed => {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : null;
    controls.log.error('copilot.turn_failed', { name: err instanceof Error ? err.name : typeof err, status });
    controls.abandon(threadId);
    emit({ t: 'error', error: TURN_FAILED, requestId });
    return new TurnFailed(requestId);
  };

  emit({ t: 'accepted', requestId });
  let turn: CopilotTurn;
  try {
    const stream = await graph.stream(graphInput, runConfig(graph, threadId));
    for await (const chunk of stream) {
      for (const e of projectChunk(chunk)) emit(e);
    }
    // Reading the finished run back is part of the run: once `accepted` has
    // been sent, every way this can fail ends in the fixed-words `error`
    // event, never in a stream that simply stops.
    turn = turnFromState(await graph.getState(stateConfig(threadId)), {
      models: controls.models, running: false, live: controls.usage(threadId),
    });
  } catch (err) {
    throw failed(err);
  }

  const checked = CopilotTurn.safeParse(turn);
  if (!checked.success) {
    // A turn that does not match the protocol is a server bug; it is not
    // sent half-checked. Paths only: the values may be anything.
    controls.log.error('copilot.turn_invalid', {
      paths: checked.error.issues.slice(0, 5).map((i) => i.path.join('.')).join(','),
    });
    controls.abandon(threadId);
    emit({ t: 'error', error: TURN_FAILED, requestId });
    throw new TurnFailed(requestId);
  }
  emit({ t: 'turn', turn: checked.data });
  return checked.data;
}

/** A new message, under the thread's lock. */
export async function sendMessage(
  graph: CopilotGraph, threadId: string, text: string,
  opts: { mayCommand: boolean; requestId?: string; onEvent?: EventSink },
): Promise<CopilotTurn> {
  return withThreadLock(graph, threadId, () => runTurn(graph, threadId, {
    kind: 'message', text, mayCommand: opts.mayCommand, ...(opts.requestId ? { requestId: opts.requestId } : {}),
  }, opts.onEvent));
}

/**
 * The operator's decision on the pending plan, under the thread's lock — the
 * lock first, then the pending check (the route's gate order).
 */
export async function decide(
  graph: CopilotGraph, threadId: string, d: DecisionRequest, opts: { onEvent?: EventSink } = {},
): Promise<CopilotTurn> {
  return withThreadLock(graph, threadId, () => runTurn(graph, threadId, { kind: 'decision', ...d }, opts.onEvent));
}

/** The operator's Stop: cooperative, never takes the lock. False when nothing was running. */
export function stop(graph: CopilotGraph, threadId: string): boolean {
  return copilotControls(graph).stop(threadId);
}

/** The thread as it stands — for a panel that reloaded, or a client that disconnected mid-run. */
export async function rehydrate(graph: CopilotGraph, threadId: string): Promise<CopilotTurn> {
  const controls = copilotControls(graph);
  return turnFromState(await graph.getState(stateConfig(threadId)), {
    models: controls.models, running: threadRunning(graph, threadId), live: controls.usage(threadId),
  });
}

// =============================================================== projection

interface SnapshotLike {
  values: unknown;
  tasks?: ReadonlyArray<{ name?: string; interrupts?: ReadonlyArray<{ id?: string; value?: unknown }> }>;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function reviewedCommand(c: ReviewedCommand): PendingPlan['commands'][number] {
  const v = c.verdict;
  return {
    zoneId: c.zoneId,
    zoneName: c.zoneName,
    setpointTempC: c.setpointTempC,
    ...(c.durationS !== undefined ? { durationS: c.durationS } : {}),
    reason: c.reason,
    verdict: v.allowed
      ? { allowed: true, previousTempC: v.previousTempC, durationS: v.durationS, effectiveUntil: v.effectiveUntil }
      : { allowed: false, refusal: v.refusal, message: v.message },
  };
}

/**
 * The plan awaiting a decision: exactly one interrupt, raised by `confirm`,
 * agreeing with `pendingPlan` in state. Anything else — no interrupt, two,
 * one from elsewhere, or a disagreement — is no plan, which is the fail-safe
 * reading: the operator is asked again, nothing is approved.
 */
function pendingPlanOf(snapshot: SnapshotLike): PendingPlan | null {
  const interrupts = (snapshot.tasks ?? []).flatMap((t) => (t.interrupts ?? []).map((i) => ({ task: t.name, ...i })));
  if (interrupts.length !== 1) return null;
  const [i] = interrupts;
  const held = ((snapshot.values ?? {}) as Partial<CopilotStateType>).pendingPlan ?? null;
  const v = i!.value as ReviewedPlan | null | undefined;
  if (i!.task !== 'confirm' || typeof i!.id !== 'string' || !v || !held
    || v.planId !== held.planId || v.planHash !== held.planHash || v.expiresAt !== held.expiresAt) return null;
  const parsed = PendingPlan.safeParse({
    interruptId: i!.id,
    planId: v.planId,
    planHash: v.planHash,
    checkedAt: v.checkedAt,
    expiresAt: v.expiresAt,
    summary: v.summary,
    commands: Array.isArray(v.commands) ? v.commands.map(reviewedCommand) : [],
    simulation: v.simulation === null ? null : {
      evidenceId: v.simulation.evidenceId,
      scenario: v.simulation.scenario,
      zonesMatch: v.simulation.zonesMatch,
      setpointsMatch: v.simulation.setpointsMatch,
      timing: v.simulation.timing,
    },
  });
  return parsed.success ? parsed.data : null;
}

/**
 * What one turn shows (§9.3). Everything the model wrote is either verified
 * or dropped here: the answer only if it verifies (else the cards stand in),
 * the interpretation, a clarifying question and each task's goal only if
 * they pass the wording rules. Notices are fixed text. No transcript, tool
 * body or state object is copied through: every field is built.
 *
 * `usage` is what `finish` recorded. A request still open — paused at
 * `confirm` with a plan on screen, the costliest kind — has not reached
 * `finish`, so `live` (the registry's running count) stands in, but only
 * when it is the same request the snapshot shows.
 */
export function turnFromState(
  snapshot: SnapshotLike,
  opts: { models: Models; running?: boolean; live?: { requestId: string; usage: Usage } | null },
): CopilotTurn {
  const s = (snapshot.values ?? {}) as Partial<CopilotStateType>;
  const evidence: Record<string, EvidenceRecord> = s.evidence ?? {};
  const context = s.context ?? null;
  const findings: Record<string, Finding> = s.findings ?? {};

  const clean = (text: string | null | undefined): string | null =>
    typeof text === 'string' && text.trim() !== '' && verifyText(text, context).length === 0 ? text : null;

  const tasks: CopilotTurn['tasks'] = Object.values(s.tasks ?? {}).map((t) => ({
    taskId: t.taskId, specialist: t.specialist, goal: clean(t.goal),
    status: findings[t.taskId]?.status ?? t.status, reason: findings[t.taskId]?.reason ?? null,
  }));
  if (s.controlTask) {
    tasks.push({
      taskId: 'K', specialist: 'control', goal: clean(s.controlTask.brief),
      status: findings.K?.status ?? s.controlTask.status, reason: findings.K?.reason ?? null,
    });
  }

  const seen = new Set<string>();
  const notices = (s.notices ?? []).filter((n: Notice) => {
    const key = `${n.code}:${JSON.stringify(n.params)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((n) => ({ code: n.code, text: noticeText(n) }));

  return {
    requestId: s.request?.requestId ?? null,
    running: opts.running ?? false,
    dialogue: (s.dialogue ?? []).map((e) => (e.role === 'operator'
      ? { role: 'operator' as const, text: e.text }
      : { role: 'copilot' as const, text: e.text, notices: [...e.notices] })),
    // Both: the graph's verdict on this draft (which includes the rules that
    // need the request's findings), and the renderer's own re-check.
    answer: (s.violations ?? []).length === 0 ? renderAnswer(s.answer ?? null, evidence, context) : null,
    interpretation: clean(s.plannerRoute?.interpretation),
    message: clean(s.plannerRoute?.message),
    cards: Object.values(evidence).map((r) => {
      const card = renderCard(r);
      return { ...card, label: clip(card.label, 300) };
    }),
    tasks,
    pendingPlan: pendingPlanOf(snapshot),
    outcomes: (s.outcomes ?? []).map((o) => ({
      zoneName: o.zoneName,
      setpointTempC: o.setpointTempC,
      result: o.result.ok
        ? { ok: true as const, commandId: o.result.commandId, state: o.result.state, effectiveUntil: o.result.effectiveUntil }
        : { ok: false as const, refusal: o.result.refusal, message: o.result.message },
    })),
    notices,
    usage: usageOf(s.usage ?? (opts.live && opts.live.requestId === s.request?.requestId ? opts.live.usage : null)),
    models: { lead: opts.models.lead, specialist: opts.models.specialist },
  };
}

/** A request's usage as the turn carries it: counts and tokens, field by field. */
function usageOf(u: Usage | null): CopilotTurn['usage'] {
  if (u === null) return null;
  return {
    modelCalls: u.modelCalls,
    byRole: { ...u.byRole },
    simRuns: u.simRuns,
    // `?? 0`: a checkpoint written before tokens were counted has none.
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheReadTokens: u.cacheReadTokens ?? 0,
    cacheWriteTokens: u.cacheWriteTokens ?? 0,
  };
}
