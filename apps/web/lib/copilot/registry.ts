import type Anthropic from '@anthropic-ai/sdk';
import { resolveLimits, type Limits } from './limits.ts';

/**
 * The run registry: one request's budget, deadline and stop flag, held
 * outside graph state.
 *
 * v1 kept its turn ceiling in graph state, summed across the THREAD, so a
 * long conversation eventually refused every new question — §63 said "per
 * request" and the code said otherwise. Here the budget belongs to a request:
 * `begin` opens a fresh one for every new message and `end` closes it.
 *
 * Outside state because state is written by reducers at the END of a
 * superstep, and parallel specialists in one superstep would each see the
 * same stale count and each spend it. The registry is a plain Map read and
 * written synchronously, and JavaScript runs one callback at a time, so
 * "check, then increment" in `call` is atomic across `Promise.all` with no
 * lock: nothing can interleave between the check and the increment because
 * there is no `await` between them.
 *
 * Every refusal is a BudgetError the caller turns into a finding status —
 * `budget`, `deadline` or `stopped` — never an exception out of a node.
 */

export const ROLES = ['planner', 'compose', 'diagnose', 'analyse', 'simulate', 'control'] as const;
export type Role = (typeof ROLES)[number];

/**
 * What bounds one model call: aborted by Stop or at the request's deadline,
 * and never allowed longer than what is left of that deadline. The SDK's
 * `messages.create` takes both as request options.
 */
export interface ModelCallOptions {
  signal: AbortSignal;
  timeout: number;
}

/** The one seam every model call goes through; a function shaped like `messages.create`. */
export type ModelCaller = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  options?: ModelCallOptions,
) => Promise<Anthropic.Message>;

export type BudgetReason = 'stopped' | 'deadline' | 'budget';

const BUDGET_MESSAGES: Readonly<Record<BudgetReason, string>> = {
  stopped: 'the request was stopped',
  deadline: 'the request passed its deadline',
  budget: 'the request used its model-call budget',
};

export class BudgetError extends Error {
  readonly reason: BudgetReason;
  constructor(reason: BudgetReason) {
    super(BUDGET_MESSAGES[reason]);
    this.name = 'BudgetError';
    this.reason = reason;
  }
}

/**
 * What one request used. Calls are counted when they are made; tokens are
 * added from each reply's `usage` when it comes back, so a call that failed
 * at the API counts as a call and adds no tokens. `inputTokens` is the
 * uncached input only — the API reports cache reads and cache writes apart
 * from it, and each is billed at its own rate, so all three are kept.
 */
export interface Usage {
  modelCalls: number;
  byRole: Record<Role, number>;
  simRuns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Why a simulation run was not admitted for this request. */
export type SimRefusal = 'stopped' | 'deadline' | 'no_request' | 'in_flight' | 'run_limit';

interface Entry {
  requestId: string;
  startedAt: number;
  deadlineAt: number;
  callsUsed: number;
  byRole: Record<Role, number>;
  stopRequested: boolean;
  evidenceCount: number;
  simCalls: number;
  simRuns: number;
  simInFlight: number;
  tokens: Pick<Usage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>;
  /** The model calls this request has in flight, each abortable by Stop. */
  calls: Set<AbortController>;
}

/** The API's ceiling on cache breakpoints in one request; automatic caching takes one of them. */
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * What is wrong with a request's shape, or null. The rules every copilot
 * call keeps, held at the one seam they all pass through rather than
 * restated at each call site:
 *
 * - `max_tokens` is the configured ceiling on every call. Adaptive thinking
 *   is on by default and counts toward it, so a smaller figure truncates
 *   answers in a way that looks like a model failure.
 * - No `thinking` parameter: the default (adaptive) is what was measured.
 * - No forced `tool_choice` (`any` or a named tool): the API rejects it on
 *   the current models, and a model forced to call a tool cannot say it has
 *   nothing to report.
 * - No `fallbacks`: a refusal is an answer (§63), never a cue to ask a
 *   different model the same thing.
 * - Prompt caching (model.ts) is allowed — the top-level `cache_control`
 *   that turns on automatic caching as well as markers on blocks — within
 *   the API's own rules, which it enforces with a 400 at request time: at
 *   most MAX_CACHE_BREAKPOINTS in all, the automatic one counted, and every
 *   one the default five-minute `{type: 'ephemeral'}`, because the API
 *   refuses a longer TTL placed after a shorter one.
 */
export function requestShapeError(
  params: Anthropic.MessageCreateParamsNonStreaming, maxTokens: number,
): string | null {
  const p = params as unknown as Record<string, unknown>;
  if (params.max_tokens !== maxTokens) return `max_tokens must be ${maxTokens}, got ${String(params.max_tokens)}`;
  if (p.thinking !== undefined) return 'no thinking parameter';
  if (p.fallbacks !== undefined) return 'no fallbacks';
  const choice = p.tool_choice as { type?: string } | undefined;
  if (choice !== undefined && choice.type !== 'auto' && choice.type !== 'none') {
    return `no forced tool_choice (${String(choice.type)})`;
  }
  const markers = cacheMarkers(params);
  if (markers.length > MAX_CACHE_BREAKPOINTS) {
    return `at most ${MAX_CACHE_BREAKPOINTS} cache breakpoints, the automatic one included; got ${markers.length}`;
  }
  const odd = markers.find((m) => !isFiveMinuteEphemeral(m));
  if (odd !== undefined) return `cache_control is {type: 'ephemeral'} with the default TTL, got ${JSON.stringify(odd)}`;
  return null;
}

/**
 * Every `cache_control` a request carries, where the API reads one: at the
 * top (automatic caching), on a tool, on a system block, on a content block,
 * and on a block inside a tool result. Not a walk of every key: a tool's
 * input is the model's JSON, and a key in it named `cache_control` is data.
 */
export function cacheMarkers(params: Anthropic.MessageCreateParamsNonStreaming): unknown[] {
  const found: unknown[] = [];
  const add = (holder: unknown) => {
    const v = (holder as { cache_control?: unknown } | null)?.cache_control;
    if (v !== undefined && v !== null) found.push(v);
  };
  add(params);
  for (const tool of params.tools ?? []) add(tool);
  if (Array.isArray(params.system)) params.system.forEach(add);
  for (const m of params.messages) {
    if (typeof m.content === 'string') continue;
    for (const block of m.content) {
      add(block);
      if (block.type === 'tool_result' && Array.isArray(block.content)) block.content.forEach(add);
    }
  }
  return found;
}

function isFiveMinuteEphemeral(marker: unknown): boolean {
  if (typeof marker !== 'object' || marker === null) return false;
  const { type, ttl, ...rest } = marker as { type?: unknown; ttl?: unknown };
  return type === 'ephemeral' && (ttl === undefined || ttl === '5m') && Object.keys(rest).length === 0;
}

/**
 * One reply's token counts, added in. Read defensively: the fields are
 * nullable in the SDK's types (cache counts are absent when caching is not
 * in play), and a count that is not a finite non-negative number adds
 * nothing rather than turning the total into NaN.
 */
function addTokens(into: Entry['tokens'], usage: Anthropic.Usage | null | undefined): void {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  into.inputTokens += n(usage?.input_tokens);
  into.outputTokens += n(usage?.output_tokens);
  into.cacheReadTokens += n(usage?.cache_read_input_tokens);
  into.cacheWriteTokens += n(usage?.cache_creation_input_tokens);
}

const zeroByRole = (): Record<Role, number> =>
  Object.fromEntries(ROLES.map((r) => [r, 0])) as Record<Role, number>;

export class RunRegistry {
  readonly #entries = new Map<string, Entry>();
  readonly #limits: Readonly<Limits>;
  readonly #clock: () => number;

  constructor(opts: { limits?: Partial<Limits>; clock?: () => number } = {}) {
    this.#limits = resolveLimits(opts.limits);
    this.#clock = opts.clock ?? Date.now;
  }

  /**
   * Open a request on a thread with a fresh budget and deadline. Replaces
   * whatever the thread held: the route's per-thread lock guarantees the
   * previous request is over.
   */
  begin(threadId: string, requestId: string): void {
    const now = this.#clock();
    this.#sweep(now);
    this.#entries.set(threadId, {
      requestId,
      startedAt: now,
      deadlineAt: now + this.#limits.deadlineS * 1000,
      callsUsed: 0,
      byRole: zeroByRole(),
      stopRequested: false,
      evidenceCount: 0,
      simCalls: 0,
      simRuns: 0,
      simInFlight: 0,
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      calls: new Set(),
    });
  }

  /**
   * Why a model call on this thread would be refused right now, or null.
   * Stop first, then the deadline, then the budget: an operator's Stop is
   * the most specific thing that can be said. A thread with no open request
   * is `stopped` — nothing is ever called outside begin…end.
   */
  refusal(threadId: string): BudgetReason | null {
    const e = this.#entries.get(threadId);
    if (!e || e.stopRequested) return 'stopped';
    if (this.#clock() >= e.deadlineAt) return 'deadline';
    if (e.callsUsed >= this.#limits.maxModelCalls) return 'budget';
    return null;
  }

  /**
   * Stop or deadline, but not the model-call budget: what TOOLS check before
   * running. A read after the last model call is harmless; a read after the
   * operator pressed Stop is not what they asked for.
   */
  interrupted(threadId: string): Exclude<BudgetReason, 'budget'> | null {
    const e = this.#entries.get(threadId);
    if (!e || e.stopRequested) return 'stopped';
    if (this.#clock() >= e.deadlineAt) return 'deadline';
    return null;
  }

  /**
   * Spend one model call and make it. The check and the increment happen
   * synchronously, before the first await, which is what makes the budget
   * hold across parallel specialists. A call that then fails at the API is
   * still spent: it cost what it cost.
   *
   * Every model call passes through here, so this is also where the request
   * shape is held to the rules (see `requestShapeError`). A malformed request
   * is a programming error: it throws a TypeError before anything is spent.
   *
   * And where its cost is counted: the reply's token usage is added to the
   * entry that made the call — the one captured before the await, so a reply
   * that lands after its request was closed or replaced is charged to the
   * request that spent it, not to the next one.
   *
   * And where the call is BOUNDED. Checking Stop and the deadline before a
   * call is not enough: a call that stalls (an overloaded API, a black-holed
   * connection) ran on the SDK's own defaults — ten minutes an attempt, two
   * retries — and held the thread's lock the whole time, while Stop answered
   * "stopping" and changed nothing (review, ADR 64). So each call carries an
   * AbortSignal that Stop fires and a timer fires at the deadline, and a
   * timeout no longer than the time left; the SDK stops on either, and the
   * call is RACED against the signal so that nothing a caller does with it
   * can outlast it. Aborted, it is a BudgetError like any other refusal, which
   * every node already turns into a status — a node is still never killed
   * mid-way, only the request it is waiting on.
   */
  async call(
    threadId: string,
    role: Role,
    callModel: ModelCaller,
    params: Anthropic.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Message> {
    const shape = requestShapeError(params, this.#limits.maxTokens);
    if (shape !== null) throw new TypeError(`copilot request shape: ${shape}`);
    const reason = this.refusal(threadId);
    if (reason !== null) throw new BudgetError(reason);
    const e = this.#entries.get(threadId)!;
    e.callsUsed += 1;
    e.byRole[role] += 1;

    const controller = new AbortController();
    const remainingMs = Math.max(1, e.deadlineAt - this.#clock());
    const timer = setTimeout(() => controller.abort('deadline'), remainingMs);
    timer.unref?.();
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new BudgetError(controller.signal.reason === 'stopped' ? 'stopped' : 'deadline'));
      }, { once: true });
    });
    aborted.catch(() => {});
    e.calls.add(controller);
    try {
      const pending = callModel(params, { signal: controller.signal, timeout: remainingMs });
      // The caller's own rejection after an abort (the SDK's APIUserAbortError)
      // has nobody left to hear it.
      pending.catch(() => {});
      const reply = await Promise.race([pending, aborted]);
      addTokens(e.tokens, reply.usage);
      return reply;
    } finally {
      clearTimeout(timer);
      e.calls.delete(controller);
    }
  }

  /**
   * Operator's Stop. The next call or tool refuses, and every model call in
   * flight is aborted. False if nothing was running.
   */
  stop(threadId: string): boolean {
    const e = this.#entries.get(threadId);
    if (!e) return false;
    e.stopRequested = true;
    for (const c of e.calls) c.abort('stopped');
    return true;
  }

  /**
   * Whether the operator pressed Stop on the open request — and only that:
   * not the deadline, which a decision made within the plan's TTL has usually
   * outlived. What `apply` checks between the commands it issues.
   */
  stopRequested(threadId: string): boolean {
    return this.#entries.get(threadId)?.stopRequested ?? false;
  }

  /**
   * A decision on a paused plan is a new word from the operator: a Stop
   * pressed while the plan waited is answered by it, not carried into it.
   */
  clearStop(threadId: string): void {
    const e = this.#entries.get(threadId);
    if (e) e.stopRequested = false;
  }

  /** Close the request and hand back what it used. Later calls on the thread are refused. */
  end(threadId: string): Usage | null {
    const usage = this.usage(threadId);
    this.#entries.delete(threadId);
    return usage;
  }

  usage(threadId: string): Usage | null {
    const e = this.#entries.get(threadId);
    if (!e) return null;
    return { modelCalls: e.callsUsed, byRole: { ...e.byRole }, simRuns: e.simRuns, ...e.tokens };
  }

  /** Whether any thread has a request open — running, or paused with a plan on screen. */
  anyOpen(): boolean {
    this.#sweep(this.#clock());
    return this.#entries.size > 0;
  }

  /** The open request's id, for logs and for checking a straggler belongs to it. */
  requestId(threadId: string): string | null {
    return this.#entries.get(threadId)?.requestId ?? null;
  }

  // ---------------------------------------------------------------- evidence

  /**
   * Take one slot in the request's evidence ledger. False when it is full —
   * the tool result is then refused with "evidence ledger full", never stored
   * and silently dropped from compose's input.
   */
  claimEvidence(threadId: string): boolean {
    const e = this.#entries.get(threadId);
    if (!e || e.evidenceCount >= this.#limits.maxEvidencePerRequest) return false;
    e.evidenceCount += 1;
    return true;
  }

  evidenceFull(threadId: string): boolean {
    const e = this.#entries.get(threadId);
    return !e || e.evidenceCount >= this.#limits.maxEvidencePerRequest;
  }

  // ---------------------------------------------------------------- simulation

  /**
   * The one simulate_scenarios call a request may make. A second call is
   * refused however the first went: a retry loop against the worker is the
   * thing the bound exists to prevent.
   */
  claimSimCall(threadId: string): boolean {
    const e = this.#entries.get(threadId);
    if (!e || e.stopRequested || e.simCalls >= this.#limits.simCallsPerRequest) return false;
    e.simCalls += 1;
    return true;
  }

  /**
   * Admit one run: not stopped, not past the deadline, nothing of this
   * request's already in flight (runs are sequential), and under the
   * per-request run count. Every admitted run must be paired with `endSimRun`.
   */
  beginSimRun(threadId: string): SimRefusal | null {
    const e = this.#entries.get(threadId);
    if (!e) return 'no_request';
    const interrupted = this.interrupted(threadId);
    if (interrupted !== null) return interrupted;
    if (e.simInFlight >= this.#limits.simInFlightPerRequest) return 'in_flight';
    if (e.simRuns >= this.#limits.simRunsPerRequest) return 'run_limit';
    e.simRuns += 1;
    e.simInFlight += 1;
    return null;
  }

  endSimRun(threadId: string): void {
    const e = this.#entries.get(threadId);
    if (e && e.simInFlight > 0) e.simInFlight -= 1;
  }

  /**
   * Drop requests that can no longer matter. A request is over within its
   * deadline, and any plan it produced expires PLAN_TTL_S after that, after
   * which the route refuses its decision before the graph runs. An entry
   * older than both is a run that never reached `finish` (a crash, an
   * evicted graph); keeping it would grow the map by one per such thread.
   */
  #sweep(now: number): void {
    const retainMs = (this.#limits.deadlineS + this.#limits.planTtlS) * 1000;
    for (const [threadId, e] of this.#entries) {
      if (now - e.startedAt >= retainMs) this.#entries.delete(threadId);
    }
  }
}
