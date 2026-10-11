import { createHash } from 'node:crypto';
import { DEFAULT_LIMITS } from './limits.ts';

/**
 * The approval ledger: the one thing `apply` will act on.
 *
 * The graph's edge list says `apply` is reached only from `confirm`, and a
 * source scan says nothing routes around it. This is the lock behind those
 * two, for the day one of them is wrong: `apply` does not trust graph state at
 * all. It issues exactly the commands `confirm` GRANTED here, after a person's
 * resume named that plan's id and hash — a frozen copy, held outside the
 * checkpoint where no node's update can reach it, and consumed on first read.
 *
 * So a forged route into `apply` (a Command goto, a stray Send) finds no
 * grant and issues nothing; a forged `pendingPlan` in state changes nothing
 * the grant holds; and a second Approve finds the grant already taken.
 *
 * A plan is granted ONCE. Take-once alone is not enough: two approvals of
 * one plan that both got past the route (its lock bypassed, or a second
 * replica) each run `confirm`, and if the second grants after the first
 * `apply` has taken, there is a fresh grant to take and the plan is issued
 * twice. So the ledger remembers every plan id it has granted, for as long
 * as that plan could still be approved (its TTL — `confirm` refuses an
 * expired plan before it asks), and refuses to grant one again.
 *
 * In memory, per compiled graph, like the checkpointer it sits beside: a
 * restart loses pending grants, which is the fail-safe direction — the
 * operator is asked again, nothing is issued twice.
 */

/** Exactly the fields `apply` sends to ingest, plus the name it reports. */
export interface GrantedCommand {
  readonly zoneId: string;
  readonly zoneName: string;
  readonly setpointTempC: number;
  readonly durationS: number | null;
  readonly reason: string;
}

export interface Grant {
  readonly planId: string;
  readonly planHash: string;
  readonly commands: ReadonlyArray<GrantedCommand>;
  /** Epoch ms, by the ledger's clock. */
  readonly grantedAt: number;
}

/** What `confirm` hands over: a reviewed plan, of which only these fields are kept. */
export interface GrantablePlan {
  planId: string;
  planHash: string;
  commands: ReadonlyArray<{
    zoneId: string;
    zoneName: string;
    setpointTempC: number;
    durationS?: number | null | undefined;
    reason: string;
  }>;
}

/**
 * JSON with object keys sorted at every depth, so two structurally equal
 * values always serialise — and hash — the same whatever order their keys
 * were written in.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    if (s === undefined) throw new TypeError(`not JSON: ${typeof value}`);
    return s;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value).sort()
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * A plan's identity: sha256 over what would be SENT — zone, setpoint,
 * duration, reason — and nothing that is only shown. The operator's resume
 * names this hash; `confirm` and the ledger both recompute it, so a plan whose
 * commands changed after the operator saw it cannot be granted.
 */
export function hashCommands(commands: GrantablePlan['commands']): string {
  const sent = commands.map((c) => ({
    zoneId: c.zoneId, setpointTempC: c.setpointTempC, durationS: c.durationS ?? null, reason: c.reason,
  }));
  return createHash('sha256').update(canonicalJson(sent)).digest('hex');
}

const HASH_RE = /^[0-9a-f]{64}$/;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * Copy out only what is issued, checking each field's type on the way: the
 * plan reached `confirm` through a checkpoint, and a Proxy or a getter here
 * would otherwise be copied by reference into the one object `apply` trusts.
 */
function project(plan: GrantablePlan, maxCommands: number): Grant['commands'] | null {
  if (!Array.isArray(plan.commands) || plan.commands.length === 0
    || plan.commands.length > maxCommands) return null;
  const out: GrantedCommand[] = [];
  for (const c of plan.commands) {
    const { zoneId, zoneName, setpointTempC, reason } = c;
    const durationS = c.durationS ?? null;
    if (typeof zoneId !== 'string' || typeof zoneName !== 'string' || typeof reason !== 'string'
      || typeof setpointTempC !== 'number' || !Number.isFinite(setpointTempC)
      || (durationS !== null && (!Number.isInteger(durationS) || durationS <= 0))) {
      return null;
    }
    out.push({ zoneId, zoneName, setpointTempC, durationS, reason });
  }
  return out;
}

export class ApprovalLedger {
  readonly #grants = new Map<string, Grant>();
  /** Plan id → when it was granted. A plan in here is never granted again. */
  readonly #granted = new Map<string, number>();
  readonly #clock: () => number;
  readonly #ttlMs: number;
  readonly #planTtlMs: number;
  readonly #maxCommands: number;

  constructor(opts: { clock?: () => number; grantTtlS?: number; planTtlS?: number; maxPlanCommands?: number } = {}) {
    this.#clock = opts.clock ?? Date.now;
    this.#ttlMs = (opts.grantTtlS ?? DEFAULT_LIMITS.grantTtlS) * 1000;
    this.#planTtlMs = (opts.planTtlS ?? DEFAULT_LIMITS.planTtlS) * 1000;
    this.#maxCommands = opts.maxPlanCommands ?? DEFAULT_LIMITS.maxPlanCommands;
  }

  /**
   * Record an approval. Only `confirm` calls this, and only after the resume
   * matched the plan's id and hash. Returns false — and holds NOTHING for the
   * thread, not even an earlier grant — if the plan is malformed or its
   * commands do not hash to its planHash.
   *
   * Returns false for a plan that was granted before, too, and then leaves
   * the thread's grant exactly as it was: that grant is the first approval
   * of this very plan, and a second approval must neither issue it again nor
   * cancel the first.
   */
  grant(threadId: string, plan: GrantablePlan): boolean {
    this.#sweep();
    let planId: unknown;
    let planHash: unknown;
    let commands: Grant['commands'] | null;
    try {
      ({ planId, planHash } = plan);
      commands = project(plan, this.#maxCommands);
    } catch {
      // A getter or Proxy that throws is a plan nobody should act on.
      this.#grants.delete(threadId);
      return false;
    }
    if (typeof planId !== 'string' || planId.length === 0
      || typeof planHash !== 'string' || !HASH_RE.test(planHash)
      || commands === null || hashCommands(commands) !== planHash) {
      this.#grants.delete(threadId);
      return false;
    }
    if (this.#granted.has(planId)) return false;
    const grant: Grant = {
      planId,
      planHash,
      // Already plain primitives after project(); the clone makes "no shared
      // reference with anything in state" true by construction, not by review.
      commands: structuredClone(commands),
      grantedAt: this.#clock(),
    };
    this.#grants.set(threadId, deepFreeze(grant));
    this.#granted.set(planId, grant.grantedAt);
    return true;
  }

  /**
   * Consume the grant: delete-on-read, so a second Approve — or a second
   * route into `apply` — finds nothing. A grant older than the TTL is
   * refused (and still consumed); so is one stamped in the future, which only
   * a clock step could produce, and which cannot be aged honestly.
   */
  take(threadId: string): Grant | null {
    const grant = this.#grants.get(threadId);
    if (!grant) return null;
    this.#grants.delete(threadId);
    const age = this.#clock() - grant.grantedAt;
    return age >= 0 && age < this.#ttlMs ? grant : null;
  }

  /** Set a grant aside unissued: a new message superseded the plan. */
  revoke(threadId: string): void {
    this.#grants.delete(threadId);
  }

  /** Whether a grant is held, without consuming or exposing it. */
  has(threadId: string): boolean {
    return this.#grants.has(threadId);
  }

  /**
   * Grants past their TTL can never be taken, and a plan granted more than a
   * plan TTL ago has expired and cannot reach `grant` again; dropping both
   * bounds the maps by the approval rate.
   */
  #sweep(): void {
    const now = this.#clock();
    for (const [threadId, g] of this.#grants) {
      if (now - g.grantedAt >= this.#ttlMs) this.#grants.delete(threadId);
    }
    for (const [planId, at] of this.#granted) {
      if (now - at >= this.#planTtlMs) this.#granted.delete(planId);
    }
  }
}
