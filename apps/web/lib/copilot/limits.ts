/**
 * Every bound on the copilot, in one table (docs/decisions.md §64, bounds).
 *
 * §53's rule applies to each of these: a bound says what it does when it is
 * reached, and the answer differs. Model calls, the deadline and stop END the
 * request with what was found; tool windows and list sizes REFUSE the call and
 * name the limit, never clamp it; the evidence ledger REFUSES further records;
 * drafts fall back to evidence cards; plans and grants EXPIRE. The comment on
 * each field names which, so the number is never read without its behaviour.
 *
 * Flat rather than nested so that `Partial<Limits>` is a useful override in
 * tests ("six model calls") without restating the rest. Units are in the
 * names, as everywhere else: `S`, `Ms`, `H`, `Bytes`, `Chars`, `K`.
 */
export interface Limits {
  // ---- planning
  /** Planner waves per request. Reached: no model call; compose if findings, else finish; notice `wave_limit`. */
  maxWaves: number;
  /** Tasks one planner call may dispatch. Reached: validation error, one repair, then fallback. */
  maxTasksPerWave: number;
  /** Tasks per request across waves. Reached: validation error, as above. */
  maxTasksPerRequest: number;
  /**
   * Simulate tasks per request. Reached: validation error, as above. One,
   * because a request makes one simulate_scenarios call (`simCallsPerRequest`):
   * a second simulate task could only be refused "runs once per request" after
   * spending its model calls on finding that out.
   */
  maxSimulateTasksPerRequest: number;
  /** Specialist tasks running at once (run config). Reached: extra Sends wait for a slot. */
  maxConcurrency: number;
  /** Repair calls per planner execution. Reached: the fallback path. */
  maxPlannerRepairs: number;

  // ---- the request's budget
  /** Model calls per request, atomic across parallel specialists. Reached: BudgetError('budget'). */
  maxModelCalls: number;
  /**
   * Wall-clock per request. Reached: BudgetError('deadline') at the next call
   * or tool, and a model call IN FLIGHT is aborted (registry.ts `call`); the
   * in-flight sim is cancelled.
   */
  deadlineS: number;
  /**
   * max_tokens on EVERY model call; adaptive thinking counts toward it.
   * Reached (stop_reason max_tokens): a specialist or the controller ends
   * `partial`; the planner's cut-off JSON gets its one repair, then the
   * fallback; compose's is unparseable, so the evidence cards and
   * `compose_unavailable`.
   */
  maxTokens: number;

  // ---- specialists
  /** Model turns per specialist task. Reached: `partial` / `turn_limit` (the last turn is nudged). */
  maxSpecialistTurns: number;
  /** Tool calls per model turn. Reached: the extra calls get is_error naming the limit. */
  maxToolCallsPerTurn: number;
  /** Tool calls per task. Reached: is_error naming the limit. */
  maxToolCallsPerTask: number;

  // ---- evidence
  /** Serialised size of one record's data. Reached: is_error "narrow the window"; never truncated. */
  maxEvidenceBytes: number;
  /** Records per request (registry counter). Reached: is_error "evidence ledger full", then finish. */
  maxEvidencePerRequest: number;
  /** Evidence handed to compose. Reached: uncited data dropped first, and the drop stated. */
  maxComposeEvidenceBytes: number;

  // ---- the answer
  /** Compose drafts per request. Reached: evidence cards and notice `verify_failed`. */
  maxDrafts: number;
  /**
   * Reached (any of the three): violation `too_long`, so compose retries.
   * Compose is ASKED for less (`ANSWER_AIM`, prompts.ts); these are what the
   * verifier refuses.
   */
  maxAnswerParagraphs: number;
  maxAnswerSegments: number;
  maxAnswerTextChars: number;

  // ---- tool windows. Reached: is_error naming the limit; the backend is not called.
  zoneConditionsMaxWindowH: number;
  zoneTimelineMaxWindowH: number;
  zoneHistoryMaxWindowH: number;
  /** zone_history uses 5-minute buckets up to this span, hourly beyond, so a series is ≤ 48 points. */
  zoneHistory5mMaxSpanH: number;
  energyByEndUseMaxWindowH: number;
  compareZonesMaxWindowH: number;
  /** compare_zones orderBy minutes_above_band reads 5-minute data, so its window is shorter. */
  compareZonesBandMaxWindowH: number;
  listAlertsMaxWindowH: number;
  controlHistoryMaxWindowH: number;
  /** list_alerts and control_history with no window: the last this-many hours. */
  listDefaultWindowH: number;
  meterHourMaxWindowH: number;
  meterLocalDayMaxWindowH: number;
  /** A `to` further than this past now is refused: "to must not be in the future". */
  futureToleranceS: number;

  // ---- capped lists. Reached: {items, total_count, limit_count, truncated}.
  //
  // Each is the most rows of that list the 8 KB evidence bound holds WITH
  // REALISTIC ROWS (the dev database's own, sizes.test.ts), with room to
  // spare — not a round number the bound then refuses. §8 had 50 for the
  // first three: fifty alerts are about 20 KB, so the largest limit the
  // model was offered was the one limit certain to be refused. A page of
  // unusually long rows can still be too large; that is refused with a
  // computed limit that fits, never truncated.
  zoneTimelineMaxItems: number;
  listAlertsMaxItems: number;
  controlHistoryMaxItems: number;
  compareZonesMaxItems: number;
  equipmentStatusMaxItems: number;

  // ---- simulation (scratch). Each reached: is_error naming the limit.
  /** simulate_scenarios calls per request. */
  simCallsPerRequest: number;
  /** Runs per request: a baseline and at most two scenarios. */
  simRunsPerRequest: number;
  /** Runs in flight per request: runs are sequential. */
  simInFlightPerRequest: number;
  /** Copilot runs in flight per web process (a module slot; the worker admits two in all). */
  simRunsPerProcess: number;
  /** Runs per tenant+user per hour; refused with retry_after_s. */
  simRunsPerUserPerHour: number;
  /** zones × (hours + warm-up hours), checked before any POST. */
  simMaxZoneH: number;
  /** One run's deadline; reached: cancel, then is_error. */
  simRunDeadlineS: number;
  simPollIntervalMs: number;
  simMaxWindowH: number;
  /** Prepended to every run and dropped from its results. */
  simWarmupH: number;
  simMaxScenarios: number;
  simMaxZones: number;
  /** |setpointDeltaK|, further capped by the envelope's maxDeviationK. */
  simMaxDeltaK: number;

  // ---- plans
  /** Commands per plan (v1). Reached: propose_plan is_error. */
  maxPlanCommands: number;
  /** From plan_check's fresh dry run. Reached: 409 plan_expired, or `expired` in confirm. */
  planTtlS: number;
  /** From confirm's grant to apply's take. Reached: take() returns null → apply_refused. */
  grantTtlS: number;

  // ---- the run and the route
  /** Supersteps per graph level. Unreachable by design; a test proves the worst case fits. */
  recursionLimit: number;
  /** Retry-After on the per-thread 409. */
  lockRetryAfterS: number;
  /** NDJSON keep-alive. */
  pingIntervalS: number;

  // ---- conversation
  /** Dialogue entries kept per thread. Reached: oldest dropped. */
  dialogueKept: number;
  /** Dialogue entries the planner and compose see. */
  dialogueTail: number;
  /** Request text. Reached: 400. */
  maxRequestTextChars: number;
  /** A request's body, read before it is parsed. Reached: 413, the rest unread. */
  maxRequestBodyBytes: number;
  /**
   * Compiled graphs held (one per user). Reached: the least recently used
   * graph with no thread locked and no request open is evicted; when every
   * graph is busy, a new person gets 503 + Retry-After (graph-cache.ts).
   */
  maxGraphs: number;
  /**
   * Threads one graph's checkpointer holds, each only its latest checkpoint
   * (checkpoints.ts). Reached: the least recently used thread with no open
   * request is forgotten, and its next message starts a fresh conversation.
   */
  maxThreadsPerGraph: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxWaves: 3,
  maxTasksPerWave: 4,
  maxTasksPerRequest: 8,
  maxSimulateTasksPerRequest: 1,
  maxConcurrency: 3,
  maxPlannerRepairs: 1,

  maxModelCalls: 40,
  // 300, not the design's 180: measured on the default model in the first
  // real runs (ADR 64, "One real run", which gives the per-call latencies —
  // they are not restated here, where they went stale). A compound question
  // is serial by nature — planner, a wave, planner, compose, controller,
  // plan_check — and the compound run reached 180 s with its plan dry-run
  // and ready, and plan_check, which honours the deadline, dropped it; its
  // re-run took 206 s. The model-call budget, not the clock, is what bounds
  // cost.
  deadlineS: 300,
  maxTokens: 16_000,

  maxSpecialistTurns: 6,
  maxToolCallsPerTurn: 6,
  maxToolCallsPerTask: 12,

  maxEvidenceBytes: 8 * 1024,
  maxEvidencePerRequest: 60,
  maxComposeEvidenceBytes: 64 * 1024,

  maxDrafts: 3,
  maxAnswerParagraphs: 6,
  // 48 and 1,600, not the design's 40 and 1,200: measured in the first real
  // runs (ADR 64, "One real run"). Four of the five captured first drafts
  // were over — 1,232, 1,276, 1,335 and 1,551 characters, and 41 segments —
  // and two of them for length alone; each redraft cost 20–40 s. Asking for
  // about 900 characters and 30 segments narrowed the overrun and did not end
  // it. The prompt still asks for 900 and 30, so the bound is the slack
  // around a target, not a new target; a draft the verifier refuses on
  // length alone is a whole redraft for no gain in honesty.
  maxAnswerSegments: 48,
  maxAnswerTextChars: 1_600,

  zoneConditionsMaxWindowH: 7 * 24,
  zoneTimelineMaxWindowH: 7 * 24,
  zoneHistoryMaxWindowH: 48,
  zoneHistory5mMaxSpanH: 4,
  energyByEndUseMaxWindowH: 31 * 24,
  compareZonesMaxWindowH: 31 * 24,
  compareZonesBandMaxWindowH: 7 * 24,
  listAlertsMaxWindowH: 31 * 24,
  controlHistoryMaxWindowH: 31 * 24,
  listDefaultWindowH: 7 * 24,
  meterHourMaxWindowH: 7 * 24,
  meterLocalDayMaxWindowH: 92 * 24,
  futureToleranceS: 300,

  zoneTimelineMaxItems: 25,     // ≈ 7.0 KB, with the zone's six rules in scope
  listAlertsMaxItems: 15,       // ≈ 6.3 KB
  controlHistoryMaxItems: 12,   // ≈ 5.8 KB: two people-written texts per row
  compareZonesMaxItems: 24,
  equipmentStatusMaxItems: 40,

  simCallsPerRequest: 1,
  simRunsPerRequest: 3,
  simInFlightPerRequest: 1,
  simRunsPerProcess: 1,
  simRunsPerUserPerHour: 12,
  simMaxZoneH: 10_000,
  simRunDeadlineS: 45,
  simPollIntervalMs: 500,
  simMaxWindowH: 72,
  simWarmupH: 24,
  simMaxScenarios: 2,
  simMaxZones: 24,
  simMaxDeltaK: 3,

  maxPlanCommands: 12,
  planTtlS: 600,
  grantTtlS: 120,

  recursionLimit: 40,
  lockRetryAfterS: 2,
  pingIntervalS: 15,

  dialogueKept: 40,
  dialogueTail: 6,
  maxRequestTextChars: 2_000,
  // 2,000 characters are at most 8,000 bytes of UTF-8; the rest is the
  // thread id, a decision's ids and hash, and JSON.
  maxRequestBodyBytes: 16 * 1024,
  maxGraphs: 200,
  maxThreadsPerGraph: 16,
});

/**
 * Defaults with overrides applied, checked. An override that is not a
 * positive integer is a mistake in the caller — a zero budget or a NaN
 * deadline would silently disable a bound — so it throws at graph build
 * time rather than misbehaving at request time.
 */
export function resolveLimits(overrides: Partial<Limits> = {}): Readonly<Limits> {
  const merged: Limits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(overrides) as Array<[keyof Limits, unknown]>) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new RangeError(`unknown limit ${key}`);
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new RangeError(`limit ${key} must be a positive integer, got ${String(value)}`);
    }
    merged[key] = value;
  }
  return Object.freeze(merged);
}
