import { SimulationRequest, SimulationResult, SimulationRun } from '@dtwin/types';
import { z } from 'zod';
import type { ScenarioRunner, SimResultRow, SimRunState, SimStartResult } from './deps.ts';
import { readJson } from './http.ts';

/**
 * The copilot's scratch capability: what-if runs on the simulation worker
 * (docs/decisions.md §64, write class "scratch").
 *
 * A simulation writes rows — a `simulation_runs` row and its results — but
 * nothing the building reads: the worker has no route to control, and a run
 * changes no setpoint. That is why it may be a tool rather than an
 * interrupt-gated node. What keeps it that way is here:
 *
 * - Its OWN credential, `COPILOT_SIM_API_KEY` (bootstrap `copilot-sim`, scope
 *   `sim:run` only). Without it there is no runner at all — never a fallback
 *   to `SIM_API_KEY`, which also carries `control:write`.
 * - An allow-list of worker routes, checked before `fetch`: start a run, read
 *   it, read its results, cancel it. `/weather/generate` is not on it: it
 *   writes `weather_observations`, which an `observed` run then treats as
 *   measured weather — a scratch write that would become evidence.
 * - Run-scoped routes only for runs THIS runner started, learnt from the
 *   worker's own 202 rather than from any caller, so a model-supplied run id
 *   cannot be read or cancelled.
 * - One copilot run in flight per web process. The worker admits two runs
 *   across every tenant (`SIM_MAX_CONCURRENT_RUNS`); a copilot holding both
 *   would 429 every person's ScenarioPanel.
 *
 * Bounds on the request itself (window, zones, deltas, runs per request and
 * per user) belong to the `simulate_scenarios` tool and the run registry.
 */

const DEFAULT_SIM_BASE = 'http://localhost:8000';

/** The worker's own ceiling on `/runs/{id}/results?limit=` (`le=10_000`). */
export const SIM_RESULTS_MAX_LIMIT = 10_000;

/** One worker request. Reached: the call throws, and the tool reports the simulator unavailable. */
export const SIM_REQUEST_TIMEOUT_MS = 10_000;

/**
 * How long the process slot is held for a run nobody has seen finish. A run's
 * own deadline is 45 s (`simRunDeadlineS`), after which the tool cancels it
 * and the cancel frees the slot; this lease is the backstop when even the
 * cancel could not reach the worker, so a lost run cannot hold the slot for
 * the life of the process.
 */
export const COPILOT_SLOT_LEASE_MS = 60_000;

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const RUN_RE = new RegExp(`^/runs/(${UUID})$`);
const RESULTS_RE = new RegExp(`^/runs/(${UUID})/results\\?limit=([1-9][0-9]{0,4})$`);
const CANCEL_RE = new RegExp(`^/runs/(${UUID})/cancel$`);

/** A worker request the runner refused to send. A bug in the caller, never a worker failure. */
export class SimRouteRefused extends Error {
  constructor(method: string, path: string, why: string) {
    super(`simulation route refused: ${method} ${path} (${why})`);
    this.name = 'SimRouteRefused';
  }
}

export interface SimReply {
  status: number;
  ok: boolean;
  /** The parsed body, or null when it was empty or not JSON. */
  json: unknown;
}

export type SimFetch = (method: string, path: string, body?: unknown) => Promise<SimReply>;

export interface SimFetchConfig {
  baseUrl: string;
  apiKey: string;
  /** From the session, never from a request body: the worker scopes the run to it. */
  tenantId: string;
  fetchImpl?: typeof fetch;
}

/**
 * The runner's only door to the worker. THROWS BEFORE `fetch` unless the
 * request is one of:
 *
 *   POST /simulate                     (with a body)
 *   GET  /runs/{uuid}                  (a run this door started)
 *   GET  /runs/{uuid}/results?limit=n  (1 ≤ n ≤ 10,000; a run this door started)
 *   POST /runs/{uuid}/cancel           (a run this door started)
 *
 * "Started" is learnt only by watching the worker answer 202 with a run id to
 * a `POST /simulate` sent through this same door; there is no method to
 * declare a run as ours.
 */
export function makeSimFetch(cfg: SimFetchConfig): SimFetch {
  const doFetch = cfg.fetchImpl ?? fetch;
  const started = new Set<string>();

  return async (method, path, body) => {
    const own = (id: string) => started.has(id.toLowerCase());
    let simulate = false;
    if (method === 'POST' && path === '/simulate') {
      if (body === undefined) throw new SimRouteRefused(method, path, 'a run needs a request body');
      simulate = true;
    } else if (method === 'GET' && (RUN_RE.test(path) || RESULTS_RE.test(path))) {
      const m = RUN_RE.exec(path) ?? RESULTS_RE.exec(path)!;
      if (!own(m[1]!)) throw new SimRouteRefused(method, path, 'not a run this runner started');
      if (m[2] !== undefined && Number(m[2]) > SIM_RESULTS_MAX_LIMIT) {
        throw new SimRouteRefused(method, path, `limit is at most ${SIM_RESULTS_MAX_LIMIT}`);
      }
    } else if (method === 'POST' && CANCEL_RE.test(path)) {
      if (!own(CANCEL_RE.exec(path)![1]!)) throw new SimRouteRefused(method, path, 'not a run this runner started');
      if (body !== undefined) throw new SimRouteRefused(method, path, 'a cancel carries no body');
    } else {
      throw new SimRouteRefused(method, path, 'not on the allow-list');
    }

    const res = await doFetch(`${cfg.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        'x-tenant-id': cfg.tenantId,
        authorization: `Bearer ${cfg.apiKey}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(SIM_REQUEST_TIMEOUT_MS),
    });
    const json = await readJson(res);
    if (simulate && res.status === 202) {
      const id = Started.safeParse(json);
      if (id.success) started.add(id.data.runId.toLowerCase());
    }
    return { status: res.status, ok: res.ok, json };
  };
}

/** The worker's 202 to `POST /simulate`. */
const Started = z.object({ runId: z.string().uuid() });

const ResultRow = SimulationResult.omit({ runId: true });
const Results = z.object({ results: z.array(ResultRow) });

/**
 * The worker writes unset params as `null` (Pydantic), and the shared
 * `SimulationParams` declares them `.optional()`, which rejects null — so a
 * run read over HTTP fails to parse until they are removed. Only the WebSocket
 * path stripped them until now (docs/decisions.md §36: optional and nullable
 * are different, and Pydantic writes both as null).
 */
export function stripNullParams(run: unknown): unknown {
  if (typeof run !== 'object' || run === null) return run;
  const params = (run as { params?: unknown }).params;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return run;
  return {
    ...run,
    params: Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null)),
  };
}

/** The worker's error text (FastAPI `detail`, a string or a list of issues), bounded. */
function detailOf(json: unknown, fallback: string): string {
  const detail = typeof json === 'object' && json !== null ? (json as { detail?: unknown }).detail : undefined;
  let text = fallback;
  if (typeof detail === 'string' && detail !== '') text = detail;
  else if (Array.isArray(detail)) {
    text = detail.map((d) => (typeof d === 'object' && d !== null ? String((d as { msg?: unknown }).msg ?? '') : ''))
      .filter(Boolean).join('; ') || fallback;
  }
  return text.slice(0, 300);
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

// ---------------------------------------------------------- the process slot

/**
 * One copilot run in flight per web process, across every tenant and user.
 * Module state on purpose: a runner is built per user graph, and a limit held
 * by each runner would be a limit per user.
 */
let slot: { runId: string | null; since: number } | null = null;

function takeSlot(now: number): boolean {
  if (slot !== null && now - slot.since < COPILOT_SLOT_LEASE_MS) return false;
  slot = { runId: null, since: now };
  return true;
}

function freeSlotFor(runId: string | null): void {
  if (slot !== null && slot.runId === (runId === null ? null : runId.toLowerCase())) slot = null;
}

/** Whether a copilot run holds the process slot. For tests and health output. */
export function copilotSlotHeld(now: number = Date.now()): boolean {
  return slot !== null && now - slot.since < COPILOT_SLOT_LEASE_MS;
}

// ------------------------------------------------------------------- runner

export interface ScenarioRunnerOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  clock?: () => number;
}

/**
 * The scratch capability for one tenant, or null when `COPILOT_SIM_API_KEY`
 * is unset or blank — then orient reports `sim.available = false` and the
 * planner is never offered `simulate`. `||`-style blank handling, as for
 * `COPILOT_MODEL`: `KEY=` in an env file is an empty string, not a key.
 */
export function realScenarioRunner(tenantId: string, opts: ScenarioRunnerOptions = {}): ScenarioRunner | null {
  const env = opts.env ?? process.env;
  const apiKey = env.COPILOT_SIM_API_KEY?.trim();
  if (!apiKey) return null;
  const clock = opts.clock ?? Date.now;
  const simFetch = makeSimFetch({
    baseUrl: env.SIM_BASE_URL?.trim() || DEFAULT_SIM_BASE,
    apiKey,
    tenantId,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  return {
    async start(req) {
      // Parse at the boundary, outgoing: the tool built this from the model's
      // input, and the worker must receive the shared contract, not whatever
      // object arrived. A malformed request is the caller's bug and throws.
      const body = SimulationRequest.parse(req);
      if (!takeSlot(clock())) {
        return {
          ok: false, reason: 'busy', status: 0,
          message: 'another copilot simulation is running in this service; one runs at a time',
        } satisfies SimStartResult;
      }
      let reply: SimReply;
      try {
        reply = await simFetch('POST', '/simulate', body);
      } catch {
        freeSlotFor(null);
        return { ok: false, reason: 'unavailable', status: 0, message: 'simulator unavailable' } satisfies SimStartResult;
      }
      const started = Started.safeParse(reply.json);
      if (reply.status === 202 && started.success) {
        if (slot !== null && slot.runId === null) slot.runId = started.data.runId.toLowerCase();
        return { ok: true, runId: started.data.runId } satisfies SimStartResult;
      }
      freeSlotFor(null);
      if (reply.status === 429) {
        return { ok: false, reason: 'busy', status: 429, message: detailOf(reply.json, 'simulator busy') } satisfies SimStartResult;
      }
      if (reply.status >= 500 || reply.status === 202) {
        return {
          ok: false, reason: 'unavailable', status: reply.status,
          message: detailOf(reply.json, `simulator answered ${reply.status}`),
        } satisfies SimStartResult;
      }
      return {
        ok: false, reason: 'refused', status: reply.status,
        message: detailOf(reply.json, `simulator refused the run (${reply.status})`),
      } satisfies SimStartResult;
    },

    async getRun(runId) {
      const reply = await simFetch('GET', `/runs/${runId}`);
      if (!reply.ok) throw new Error(`simulation worker answered ${reply.status} for the run`);
      const run = SimulationRun.safeParse(stripNullParams(reply.json));
      if (!run.success || run.data.id.toLowerCase() !== runId.toLowerCase()) {
        throw new Error('simulation run unreadable: the reply is not this run');
      }
      // Finished runs hold no worker slot, so they hold ours no longer either.
      if (TERMINAL.has(run.data.status)) freeSlotFor(runId);
      return { status: run.data.status, progressPct: run.data.progressPct, error: run.data.error } satisfies SimRunState;
    },

    async getResults(runId, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > SIM_RESULTS_MAX_LIMIT) {
        throw new RangeError(`results limit must be an integer 1–${SIM_RESULTS_MAX_LIMIT}, got ${limit}`);
      }
      const reply = await simFetch('GET', `/runs/${runId}/results?limit=${limit}`);
      if (!reply.ok) throw new Error(`simulation worker answered ${reply.status} for the results`);
      const parsed = Results.safeParse(reply.json);
      if (!parsed.success) throw new Error('simulation results unreadable: the reply is not a result list');
      return parsed.data.results satisfies SimResultRow[];
    },

    async cancel(runId) {
      const reply = await simFetch('POST', `/runs/${runId}/cancel`);
      // 409: it had already finished; 404: the worker no longer knows it.
      // Either way it holds no worker slot. A transport failure throws and
      // leaves ours to its lease, because the run may still be running.
      if (reply.ok || reply.status === 404 || reply.status === 409) {
        freeSlotFor(runId);
        return;
      }
      throw new Error(`simulation cancel answered ${reply.status}`);
    },
  };
}
