import { withTenant } from '@dtwin/db';
import type { ControlRefusal, ControlSettings } from '@dtwin/types';

/**
 * Everything the copilot is allowed to touch, as one narrow interface.
 *
 * The agent never sees a database handle, an API key, or the ingest URL. It
 * sees four verbs, and the real implementation of each goes through exactly
 * the path a human operator's click goes through — the same `/control`
 * routes on ingest, the same `x-acting-user`, the same envelope evaluated the
 * same number of times. There is no privileged agent path (docs/decisions.md
 * §63). What the model can do is bounded by what this interface offers, and
 * what this interface offers is bounded by what the signed-in user could do
 * by hand.
 *
 * Narrow on purpose so that the graph's tests can supply a fake with no
 * network and no database, and so that the list of verbs is short enough to
 * read in one glance when asking "what could go wrong".
 */

export interface ZoneSummary {
  id: string;
  name: string;
  floorName: string;
  zoneType: string;
  areaM2: number | null;
  /** Latest GOOD temperature in the last hour, or null. §55's rule. */
  temperatureC: number | null;
  designedSetpointC: number | null;
  deadbandK: number | null;
  activeOverrideC: number | null;
  overrideUntil: string | null;
  equipment: Array<{ tag: string; status: string }>;
}

export interface CommandSpec {
  zoneId: string;
  setpointTempC: number;
  durationS?: number | undefined;
  reason: string;
}

export type DryRunResult =
  | { allowed: true; previousTempC: number; durationS: number; effectiveUntil: string }
  | { allowed: false; refusal: ControlRefusal | 'unknown_zone' | string; message: string };

export type IssueResult =
  | { ok: true; commandId: string; state: string; effectiveUntil: string }
  | { ok: false; refusal: string; message: string };

export interface CopilotBackend {
  listZones(): Promise<ZoneSummary[]>;
  settings(): Promise<ControlSettings>;
  dryRun(command: CommandSpec): Promise<DryRunResult>;
  issue(command: CommandSpec): Promise<IssueResult>;
}

const INGEST_BASE = process.env.INGEST_BASE_URL ?? 'http://localhost:8787';

/**
 * The real backend, bound to one tenant and one acting user.
 *
 * Reads come from the database under `withTenant`, so RLS scopes them. Writes
 * — the dry run and the issue — go to ingest over HTTP, because the safety
 * envelope lives there and is evaluated against state this service does not
 * hold. A second implementation of the envelope here would be a second
 * envelope, and the two would diverge on the day it mattered.
 */
export function realBackend(tenantId: string, userId: string): CopilotBackend {
  const headers = (): Record<string, string> => {
    const key = process.env.SIM_API_KEY;
    return {
      'content-type': 'application/json',
      'x-acting-user': userId,
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    };
  };

  return {
    async listZones() {
      return withTenant({ tenantId }, async (db) => {
        const { rows } = await db.query<ZoneSummary & { equipment: ZoneSummary['equipment'] | null }>(
          `SELECT z.id, z.name, f.name AS "floorName", z.zone_type AS "zoneType",
                  z.area_m2 AS "areaM2",
                  p.setpoint_temp_c AS "designedSetpointC", p.deadband_k AS "deadbandK",
                  -- Latest GOOD reading only, and only if it is recent: the same
                  -- rule the live map paints by. A value the map would grey out
                  -- is not a value to plan a setpoint change from.
                  (SELECT t.value FROM telemetry_t t
                     JOIN sensors s ON s.id = t.sensor_id
                    WHERE s.zone_id = z.id AND s.metric = 'temperature_c' AND t.quality = 0
                      AND t.time > now() - INTERVAL '1 hour'
                    ORDER BY t.time DESC LIMIT 1) AS "temperatureC",
                  o.setpoint_temp_c AS "activeOverrideC",
                  o.effective_until AS "overrideUntil",
                  (SELECT json_agg(json_build_object('tag', e.tag, 'status', e.status) ORDER BY e.tag)
                     FROM equipment_zone_service s JOIN equipment e ON e.id = s.equipment_id
                    WHERE s.zone_id = z.id) AS equipment
             FROM zones z
             JOIN floors f ON f.id = z.floor_id
             LEFT JOIN thermal_profiles p ON p.id = z.thermal_profile_id
             LEFT JOIN LATERAL (
               SELECT c.setpoint_temp_c, c.effective_until
                 FROM control_commands c
                WHERE c.zone_id = z.id AND c.state = 'applied' AND c.effective_until > now()
                ORDER BY c.effective_until DESC LIMIT 1
             ) o ON true
            ORDER BY f.name, z.name`,
        );
        return rows.map((r) => ({
          ...r,
          equipment: r.equipment ?? [],
          overrideUntil: r.overrideUntil ? new Date(r.overrideUntil).toISOString() : null,
        }));
      });
    },

    async settings() {
      const res = await fetch(`${INGEST_BASE}/control/settings`, { headers: headers(), cache: 'no-store' });
      if (!res.ok) throw new Error(`control settings unavailable: ${res.status}`);
      return (await res.json()) as ControlSettings;
    },

    async dryRun(command) {
      const res = await fetch(`${INGEST_BASE}/control/commands`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ ...command, dryRun: true }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (res.ok && body.allowed === true) {
        return {
          allowed: true,
          previousTempC: body.previousTempC as number,
          durationS: body.durationS as number,
          effectiveUntil: String(body.effectiveUntil),
        };
      }
      return {
        allowed: false,
        refusal: String(body.refusal ?? `http_${res.status}`),
        message: String(body.error ?? 'refused'),
      };
    },

    async issue(command) {
      const res = await fetch(`${INGEST_BASE}/control/commands`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(command),
      });
      const body = (await res.json()) as Record<string, unknown>;
      const cmd = body.command as Record<string, unknown> | undefined;
      if (res.ok && cmd) {
        return {
          ok: true,
          commandId: String(cmd.id),
          state: String(cmd.state),
          effectiveUntil: String(cmd.effectiveUntil),
        };
      }
      return {
        ok: false,
        refusal: String(body.refusal ?? `http_${res.status}`),
        message: String(body.error ?? 'refused'),
      };
    },
  };
}
