import {
  copilotCompareZones, copilotControlHistory, copilotEnergyByEndUse, copilotEquipmentStatus,
  copilotListAlerts, copilotListZones, copilotMeterConsumption, copilotOrient, copilotZoneConditions,
  copilotZoneHistory, copilotZoneTimeline, withTenant, type Db,
} from '@dtwin/db';
import { ControlSettings } from '@dtwin/types';
import { z } from 'zod';
import type {
  CommandSpec, ControlProbe, DryRunResult, IssueResult, Issuer, TwinReader,
} from './deps.ts';
import { readJson } from './http.ts';

/**
 * The real implementations of the copilot's capabilities (deps.ts).
 *
 * The agent never sees a database handle, an API key, or the ingest URL. It
 * sees tools, and the tools reach the building through exactly the path a
 * human operator's click goes through — the same `/control` routes on ingest,
 * the same `x-acting-user`, the same envelope evaluated the same number of
 * times. There is no privileged agent path (docs/decisions.md §63). What the
 * copilot can do is bounded by what these objects offer, and what they offer
 * is bounded by what the signed-in user could do by hand.
 *
 * Reads come from the database under `withTenant(…, { readOnly: true })`, so
 * RLS scopes them and the transaction itself refuses a write (P17). Dry runs
 * and issues go to ingest over HTTP, because the safety envelope lives there
 * and is evaluated against state this service does not hold: a second
 * implementation of the envelope here would be a second envelope, and the two
 * would diverge on the day it mattered.
 */

const DEFAULT_INGEST_BASE = 'http://localhost:8787';

/**
 * How long one probe or issue request may take before it is abandoned. Not in
 * `Limits`: they bound a transport, not a request. Reached, a probe THROWS
 * (the tool reports "control service unreachable"); an issue ANSWERS a
 * `timeout` refusal that says the command may nonetheless have been queued,
 * because a request that was sent and not answered is not known to have
 * failed. Without a bound, a hung ingest holds the thread's lock until
 * undici's five-minute header timeout.
 */
export const PROBE_TIMEOUT_MS = 10_000;
export const ISSUE_TIMEOUT_MS = 15_000;

/** Read per call, not per module: `||` so a blank `INGEST_BASE_URL=` means unset. */
function ingestBase(): string {
  return process.env.INGEST_BASE_URL?.trim() || DEFAULT_INGEST_BASE;
}

/**
 * The web service's key (bootstrap `web-proxy`: `sim:run`, `control:write`)
 * and the person the request is for. Honest limit: this key could issue, so
 * for the probe the boundary is the code below — the route guard, the types,
 * the source scan — not the key's scope (§64).
 */
function controlHeaders(userId: string, withBody: boolean): Record<string, string> {
  const key = process.env.SIM_API_KEY?.trim();
  return {
    ...(withBody ? { 'content-type': 'application/json' } : {}),
    'x-acting-user': userId,
    ...(key ? { authorization: `Bearer ${key}` } : {}),
  };
}

function field(json: unknown, key: string): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const v = (json as Record<string, unknown>)[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * The command as ingest's `SetpointCommandRequest` takes it, field by field.
 * Built rather than spread, so nothing the caller's object happens to carry
 * — a `dryRun: false`, an extra key a later refactor adds — rides along.
 */
function commandBody(c: CommandSpec): Record<string, unknown> {
  return {
    zoneId: c.zoneId,
    setpointTempC: c.setpointTempC,
    reason: c.reason,
    ...(c.durationS !== undefined ? { durationS: c.durationS } : {}),
  };
}

// ==================================================================== reader

/**
 * Every read is one READ ONLY transaction scoped to the tenant and the acting
 * user. `set_config` and `SET LOCAL` still work inside it, so RLS and the
 * meter query's planner setting are unaffected; an INSERT fails with SQLSTATE
 * 25006 whatever the role's grants say (P17, db smoke).
 */
export function realReader(tenantId: string, userId: string): TwinReader {
  const read = <T>(fn: (db: Db) => Promise<T>): Promise<T> =>
    withTenant({ tenantId, userId }, fn, { readOnly: true });

  return {
    orient: () => read((db) => copilotOrient(db)),
    listZones: () => read((db) => copilotListZones(db)),
    zoneConditions: (q) => read((db) => copilotZoneConditions(db, q)),
    zoneHistory: (q) => read((db) => copilotZoneHistory(db, q)),
    zoneTimeline: (q) => read((db) => copilotZoneTimeline(db, q)),
    equipmentStatus: (q) => read((db) => copilotEquipmentStatus(db, q)),
    listAlerts: (q) => read((db) => copilotListAlerts(db, q)),
    controlHistory: (q) => read((db) => copilotControlHistory(db, q)),
    energyByEndUse: (q) => read((db) => copilotEnergyByEndUse(db, q)),
    meterConsumption: (q) => read((db) => copilotMeterConsumption(db, q)),
    compareZones: (q) => read((db) => copilotCompareZones(db, q)),
  };
}

// ===================================================================== probe

/** A request the probe refused to send. A bug in the caller, never a service failure. */
export class ProbeRouteRefused extends Error {
  constructor(method: string, path: string) {
    super(`control probe refused ${method} ${path}: only GET /control/settings and a dry-run POST /control/commands are allowed`);
    this.name = 'ProbeRouteRefused';
  }
}

export interface ProbeReply {
  status: number;
  ok: boolean;
  /** The parsed body, or null when it was empty or not JSON. */
  json: unknown;
}

/**
 * The probe's only door to ingest, and a closed one: it THROWS BEFORE `fetch`
 * unless the request is `GET /control/settings` with no body, or
 * `POST /control/commands` whose body says `dryRun: true`.
 *
 * The body is judged as the bytes that will be sent — serialised, parsed
 * back, and checked — not as the object handed in. A getter that answers
 * `true` once and `false` the next time, or a `toJSON` that drops the flag,
 * would pass a check on the object and still send a real command; ingest
 * treats a missing `dryRun` as "issue it". The path is compared exactly, so
 * a query string or a trailing segment is a different route and refused.
 */
export async function probeFetch(
  userId: string, method: string, path: string, body?: unknown,
): Promise<ProbeReply> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const sent: unknown = payload === undefined ? undefined : JSON.parse(payload);
  const isSettings = method === 'GET' && path === '/control/settings' && payload === undefined;
  const isDryRun = method === 'POST' && path === '/control/commands'
    && typeof sent === 'object' && sent !== null && !Array.isArray(sent)
    && (sent as Record<string, unknown>).dryRun === true;
  if (!isSettings && !isDryRun) throw new ProbeRouteRefused(method, path);

  const res = await fetch(`${ingestBase()}${path}`, {
    method,
    headers: controlHeaders(userId, payload !== undefined),
    ...(payload !== undefined ? { body: payload } : {}),
    cache: 'no-store',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  return { status: res.status, ok: res.ok, json: await readJson(res) };
}

/** Ingest's dry-run answer when the envelope allows (apps/ingest/src/server.ts). */
const DryRunAllowed = z.object({
  allowed: z.literal(true),
  previousTempC: z.number(),
  durationS: z.number(),
  effectiveUntil: z.string(),
});

/**
 * The dry-run capability for one acting user. Parse at the boundary: the
 * envelope is Zod-parsed as `ControlSettings`, an allowed verdict as
 * `DryRunAllowed`; anything else is a refusal naming the status, never a
 * cast that lets a malformed reply through as "allowed".
 */
export function realProbe(userId: string): ControlProbe {
  return {
    async settings() {
      const reply = await probeFetch(userId, 'GET', '/control/settings');
      if (!reply.ok) throw new Error(`control settings unavailable: ${reply.status}`);
      const parsed = ControlSettings.safeParse(reply.json);
      if (!parsed.success) throw new Error('control settings unreadable: the reply is not a control envelope');
      return parsed.data;
    },

    async dryRun(command) {
      const reply = await probeFetch(userId, 'POST', '/control/commands', { ...commandBody(command), dryRun: true });
      if (reply.ok) {
        const allowed = DryRunAllowed.safeParse(reply.json);
        if (allowed.success) {
          const { previousTempC, durationS, effectiveUntil } = allowed.data;
          return { allowed: true, previousTempC, durationS, effectiveUntil } satisfies DryRunResult;
        }
      }
      return {
        allowed: false,
        refusal: field(reply.json, 'refusal') ?? `http_${reply.status}`,
        message: field(reply.json, 'error')
          ?? (reply.json === null ? 'the control service returned a reply that is not JSON'
            : reply.ok ? 'the control service answered without a verdict' : 'refused'),
      } satisfies DryRunResult;
    },
  };
}

// ==================================================================== issuer

/** Ingest's 202 on a queued command. Only the three fields the outcome reports. */
const Queued = z.object({
  command: z.object({ id: z.string(), state: z.string(), effectiveUntil: z.string() }),
});

/**
 * The ONLY non-dry POST to `/control/commands` in the copilot. `buildCopilotGraph`
 * hands the object this returns to `makeApply` and to nothing else (§5.5).
 *
 * A transport failure before a reply THROWS (apply records "control service
 * unreachable"). A timeout ANSWERS, because the request may have arrived: the
 * refusal says to look at the control history before trying again, rather
 * than inviting a second command on top of the first.
 */
export function realIssuer(userId: string): Issuer {
  return {
    async issue(command) {
      let res: Response;
      try {
        res = await fetch(`${ingestBase()}/control/commands`, {
          method: 'POST',
          headers: controlHeaders(userId, true),
          body: JSON.stringify(commandBody(command)),
          signal: AbortSignal.timeout(ISSUE_TIMEOUT_MS),
        });
      } catch (err) {
        if ((err as { name?: unknown } | null)?.name === 'TimeoutError') {
          return {
            ok: false,
            refusal: 'timeout',
            message: `no reply from the control service within ${ISSUE_TIMEOUT_MS / 1000} s; the command may ` +
              'have been queued — check the control history before issuing it again',
          } satisfies IssueResult;
        }
        throw err;
      }
      const json = await readJson(res);
      const queued = Queued.safeParse(json);
      if (res.ok && queued.success) {
        const { id, state, effectiveUntil } = queued.data.command;
        return { ok: true, commandId: id, state, effectiveUntil } satisfies IssueResult;
      }
      if (res.ok) {
        return {
          ok: false,
          refusal: 'unreadable_reply',
          message: `the control service accepted the command (${res.status}) but its reply could not be read; ` +
            'check the control history before issuing it again',
        } satisfies IssueResult;
      }
      return {
        ok: false,
        refusal: field(json, 'refusal') ?? `http_${res.status}`,
        message: field(json, 'error') ?? 'refused',
      } satisfies IssueResult;
    },
  };
}
