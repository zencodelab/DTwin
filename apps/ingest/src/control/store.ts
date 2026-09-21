import { withTenant, type Db } from '@dtwin/db';
import type { ControlCommand, ControlSettings } from '@dtwin/types';
import type { ServingEquipment, ZoneFeedback } from './envelope.ts';

/**
 * Persistence for supervisory control.
 *
 * Every statement here is scoped by `withTenant`, so the row-level security
 * policies added in 017 supply the tenant predicate. None of these queries
 * writes `WHERE tenant_id = $1` as well — that would be a second place to
 * forget it (§38).
 */

const COMMAND_COLUMNS = `
  c.id, c.tenant_id AS "tenantId", c.zone_id AS "zoneId",
  z.name AS "zoneName",
  c.setpoint_temp_c AS "setpointTempC", c.previous_temp_c AS "previousTempC",
  c.state, c.reason,
  c.requested_by AS "requestedBy", u.display_name AS "requestedByName",
  c.requested_at AS "requestedAt", c.expires_at AS "expiresAt",
  c.effective_until AS "effectiveUntil",
  c.applied_at AS "appliedAt", c.settled_at AS "settledAt",
  c.outcome_detail AS "outcomeDetail", c.attempts
`;

const FROM_COMMANDS = `
  FROM control_commands c
  LEFT JOIN zones z ON z.id = c.zone_id
  LEFT JOIN users u ON u.id = c.requested_by
`;

/**
 * The tenant's envelope, created on first read.
 *
 * Defaulted rather than required so a tenant that has never configured control
 * still has a well-defined answer — and that answer is `enabled: false`. A
 * missing settings row must never read as "no limits"; it reads as "off".
 */
export async function getSettings(tenantId: string): Promise<ControlSettings> {
  return withTenant({ tenantId }, async (db) => {
    const { rows } = await db.query<ControlSettings>(
      `INSERT INTO control_settings (tenant_id) VALUES ($1)
       ON CONFLICT (tenant_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
       RETURNING enabled,
                 max_deviation_k    AS "maxDeviationK",
                 max_step_k         AS "maxStepK",
                 min_interval_s     AS "minIntervalS",
                 default_duration_s AS "defaultDurationS",
                 max_duration_s     AS "maxDurationS",
                 command_ttl_s      AS "commandTtlS"`,
      [tenantId],
    );
    return rows[0]!;
  });
}

export async function updateSettings(
  tenantId: string, userId: string, patch: Record<string, unknown>,
): Promise<ControlSettings> {
  const columns: Record<string, string> = {
    enabled: 'enabled',
    maxDeviationK: 'max_deviation_k',
    maxStepK: 'max_step_k',
    minIntervalS: 'min_interval_s',
    defaultDurationS: 'default_duration_s',
    maxDurationS: 'max_duration_s',
    commandTtlS: 'command_ttl_s',
  };
  const entries = Object.entries(patch).filter(([k, v]) => columns[k] && v !== undefined);
  if (entries.length === 0) return getSettings(tenantId);

  await getSettings(tenantId); // ensure the row exists
  return withTenant({ tenantId, userId }, async (db) => {
    const sets = entries.map(([k], i) => `${columns[k]} = $${i + 3}`);
    const { rows } = await db.query<ControlSettings>(
      `UPDATE control_settings
          SET ${sets.join(', ')}, updated_at = now(), updated_by = $2
        WHERE tenant_id = $1
        RETURNING enabled,
                  max_deviation_k    AS "maxDeviationK",
                  max_step_k         AS "maxStepK",
                  min_interval_s     AS "minIntervalS",
                  default_duration_s AS "defaultDurationS",
                  max_duration_s     AS "maxDurationS",
                  command_ttl_s      AS "commandTtlS"`,
      [tenantId, userId, ...entries.map(([, v]) => v)],
    );
    return rows[0]!;
  });
}

export interface ZoneControlContext {
  baselineTempC: number | null;
  activeOverrideTempC: number | null;
  equipment: ServingEquipment[];
  feedback: ZoneFeedback | null;
  lastCommandAt: number | null;
  commandInFlight: boolean;
  zoneExists: boolean;
}

/**
 * Everything the envelope needs about one zone, in a single round trip.
 *
 * One query rather than five because this runs on the request path and again
 * on every dispatch claim, and five round trips against a ten-connection pool
 * shared with the telemetry writer is a cost paid per command.
 *
 * `latest_reading` deliberately reads RAW telemetry rather than a rollup: the
 * question is "how old is the newest reading", and a five-minute aggregate
 * cannot answer it more precisely than five minutes — which is the resolution
 * the staleness rule is trying to measure.
 */
export async function loadZoneContext(
  tenantId: string, zoneId: string,
): Promise<ZoneControlContext> {
  return withTenant({ tenantId }, async (db) => {
    const { rows } = await db.query<{
      zoneExists: boolean;
      baselineTempC: number | null;
      activeOverrideTempC: number | null;
      equipment: ServingEquipment[] | null;
      feedbackValue: number | null;
      feedbackTs: Date | null;
      feedbackQuality: number | null;
      feedbackIntervalS: number | null;
      lastCommandAt: Date | null;
      commandInFlight: boolean;
    }>(
      `WITH zone AS (
         SELECT z.id, p.setpoint_temp_c
           FROM zones z
           LEFT JOIN thermal_profiles p ON p.id = z.thermal_profile_id
          WHERE z.id = $1
       ),
       serving AS (
         SELECT coalesce(json_agg(json_build_object('tag', e.tag, 'status', e.status)), '[]')
                  AS equipment
           FROM equipment_zone_service s
           JOIN equipment e ON e.id = s.equipment_id
          WHERE s.zone_id = $1
       ),
       point AS (
         SELECT s.id, s.sample_interval_s
           FROM sensors s
          WHERE s.zone_id = $1 AND s.metric = 'temperature_c' AND s.is_active
          ORDER BY s.id
          LIMIT 1
       ),
       latest_reading AS (
         SELECT t.value, t.time, t.quality
           FROM telemetry_t t
           JOIN point ON point.id = t.sensor_id
          WHERE t.time > now() - INTERVAL '1 day'
          ORDER BY t.time DESC
          LIMIT 1
       ),
       override AS (
         SELECT c.setpoint_temp_c
           FROM control_commands c
          WHERE c.zone_id = $1 AND c.state = 'applied' AND c.effective_until > now()
          ORDER BY c.effective_until DESC
          LIMIT 1
       ),
       recent AS (
         SELECT max(c.requested_at) AS at,
                bool_or(c.state IN ('pending', 'dispatched')) AS in_flight
           FROM control_commands c
          WHERE c.zone_id = $1
       )
       SELECT (SELECT count(*) FROM zone) > 0            AS "zoneExists",
              (SELECT setpoint_temp_c FROM zone)         AS "baselineTempC",
              (SELECT setpoint_temp_c FROM override)     AS "activeOverrideTempC",
              (SELECT equipment FROM serving)            AS equipment,
              (SELECT value FROM latest_reading)         AS "feedbackValue",
              (SELECT time FROM latest_reading)          AS "feedbackTs",
              (SELECT quality FROM latest_reading)       AS "feedbackQuality",
              (SELECT sample_interval_s FROM point)      AS "feedbackIntervalS",
              (SELECT at FROM recent)                    AS "lastCommandAt",
              coalesce((SELECT in_flight FROM recent), false) AS "commandInFlight"`,
      [zoneId],
    );

    const row = rows[0]!;
    const ts = row.feedbackTs ? row.feedbackTs.getTime() : null;
    return {
      zoneExists: row.zoneExists,
      baselineTempC: row.baselineTempC,
      activeOverrideTempC: row.activeOverrideTempC,
      equipment: row.equipment ?? [],
      // `receivedAt` is the database's own view of when the row landed, which
      // for a stored reading is its timestamp. The distinction that matters in
      // the browser — device clock versus arrival — has already been settled
      // by the time a row exists here.
      feedback: row.feedbackValue !== null && ts !== null && row.feedbackIntervalS !== null
        ? {
          value: row.feedbackValue,
          ts,
          receivedAt: ts,
          quality: (row.feedbackQuality ?? 0) as ZoneFeedback['quality'],
          sampleIntervalS: row.feedbackIntervalS,
        }
        : null,
      lastCommandAt: row.lastCommandAt ? row.lastCommandAt.getTime() : null,
      commandInFlight: row.commandInFlight,
    };
  });
}

export interface NewCommand {
  tenantId: string;
  zoneId: string;
  setpointTempC: number;
  previousTempC: number;
  reason: string;
  requestedBy: string;
  expiresAt: Date;
  effectiveUntil: Date;
}

/**
 * Queue a command.
 *
 * The unique index on one live command per zone is the real guard against a
 * race: two operators evaluating simultaneously both see `commandInFlight`
 * false, and the second INSERT is what fails. That is deliberate — the check
 * is for a good message, the index is for correctness.
 */
export async function insertCommand(input: NewCommand): Promise<ControlCommand | null> {
  return withTenant({ tenantId: input.tenantId, userId: input.requestedBy }, async (db) => {
    try {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO control_commands
           (tenant_id, zone_id, setpoint_temp_c, previous_temp_c, reason,
            requested_by, expires_at, effective_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          input.tenantId, input.zoneId, input.setpointTempC, input.previousTempC,
          input.reason, input.requestedBy, input.expiresAt, input.effectiveUntil,
        ],
      );
      return await byId(db, rows[0]!.id);
    } catch (err) {
      // 23505 = unique_violation: another command for this zone won the race.
      if ((err as { code?: string }).code === '23505') return null;
      throw err;
    }
  });
}

async function byId(db: Db, id: string): Promise<ControlCommand | null> {
  const { rows } = await db.query<ControlCommand>(
    `SELECT ${COMMAND_COLUMNS} ${FROM_COMMANDS} WHERE c.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function getCommand(tenantId: string, id: string): Promise<ControlCommand | null> {
  return withTenant({ tenantId }, (db) => byId(db, id));
}

/**
 * Retire commands nobody collected in time.
 *
 * Run before every claim rather than on a timer, so an expired command can
 * never be handed out even if no sweep has happened: the gateway's own poll is
 * what retires them. A command whose intent has gone stale must not be applied
 * when the network heals — the operator meant then, not now.
 */
export async function expireStale(tenantId: string): Promise<number> {
  return withTenant({ tenantId }, async (db) => {
    const { rowCount } = await db.query(
      `UPDATE control_commands
          SET state = 'expired', settled_at = now(),
              outcome_detail = 'not collected before expires_at'
        WHERE state = 'pending' AND expires_at <= now()`,
    );
    return rowCount ?? 0;
  });
}

/**
 * Claim commands for one gateway.
 *
 * `FOR UPDATE SKIP LOCKED` under a lease, exactly as the notification outbox
 * claims rows (§51) and for the same reason: two gateway replicas polling the
 * same tenant must not both apply the same command. The lease is the command's
 * own TTL, so a gateway that dies holding a command releases it no later than
 * the moment the command would have expired anyway.
 */
export async function claimCommands(
  tenantId: string, gateway: string, limit: number,
): Promise<ControlCommand[]> {
  return withTenant({ tenantId }, async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `UPDATE control_commands
          SET state = 'dispatched', claimed_at = now(), claimed_by = $1,
              attempts = attempts + 1
        WHERE id IN (
          SELECT c.id FROM control_commands c
           WHERE c.state = 'pending'
             AND c.expires_at > now()
           ORDER BY c.requested_at
           FOR UPDATE SKIP LOCKED
           LIMIT $2
        )
        RETURNING id`,
      [gateway, limit],
    );
    const out: ControlCommand[] = [];
    for (const { id } of rows) {
      const command = await byId(db, id);
      if (command) out.push(command);
    }
    return out;
  });
}

/** Hand a claimed command back, so another poll can pick it up. */
export async function releaseCommand(
  tenantId: string, id: string, detail: string,
): Promise<void> {
  await withTenant({ tenantId }, async (db) => {
    await db.query(
      `UPDATE control_commands
          SET state = 'pending', claimed_at = NULL, claimed_by = NULL,
              outcome_detail = $2
        WHERE id = $1 AND state = 'dispatched'`,
      [id, detail],
    );
  });
}

/**
 * Record what the gateway did.
 *
 * Applying supersedes whatever override was active on the zone, so the
 * "currently active override" query cannot find two. Done in one transaction
 * with the state change, because a moment in which both are `applied` and
 * unexpired is a moment in which the zone has two setpoints.
 */
export async function settleCommand(
  tenantId: string, id: string, outcome: 'applied' | 'failed', detail?: string,
): Promise<ControlCommand | null> {
  return withTenant({ tenantId }, async (db) => {
    const { rows } = await db.query<{ zoneId: string }>(
      `UPDATE control_commands
          SET state = $2::control_command_state,
              settled_at = now(),
              applied_at = CASE WHEN $2 = 'applied' THEN now() ELSE NULL END,
              outcome_detail = $3
        WHERE id = $1 AND state = 'dispatched'
        RETURNING zone_id AS "zoneId"`,
      [id, outcome, detail ?? null],
    );
    if (rows.length === 0) return null;

    if (outcome === 'applied') {
      await db.query(
        `UPDATE control_commands
            SET state = 'superseded', settled_at = now(),
                outcome_detail = 'replaced by a later override'
          WHERE zone_id = $1 AND id <> $2
            AND state = 'applied' AND effective_until > now()`,
        [rows[0]!.zoneId, id],
      );
    }
    return byId(db, id);
  });
}

export async function cancelCommand(
  tenantId: string, id: string, userId: string,
): Promise<ControlCommand | null> {
  return withTenant({ tenantId, userId }, async (db) => {
    const { rowCount } = await db.query(
      `UPDATE control_commands
          SET state = 'cancelled', settled_at = now(),
              outcome_detail = 'cancelled before it was applied'
        WHERE id = $1 AND state IN ('pending', 'dispatched')`,
      [id],
    );
    return (rowCount ?? 0) > 0 ? byId(db, id) : null;
  });
}

export interface ActiveOverride {
  zoneId: string;
  setpointTempC: number;
  effectiveUntil: Date;
}

/**
 * Overrides in force right now, for every zone of a tenant.
 *
 * Read on the simulator's tick and by the dashboard. `effective_until > now()`
 * is the whole of the expiry mechanism: nothing reverts an override, it simply
 * stops being returned by this query, and the zone is back to its profile.
 */
export async function activeOverrides(tenantId: string): Promise<ActiveOverride[]> {
  return withTenant({ tenantId }, async (db) => {
    const { rows } = await db.query<ActiveOverride>(
      `SELECT DISTINCT ON (zone_id)
              zone_id AS "zoneId", setpoint_temp_c AS "setpointTempC",
              effective_until AS "effectiveUntil"
         FROM control_commands
        WHERE state = 'applied' AND effective_until > now()
        ORDER BY zone_id, effective_until DESC`,
    );
    return rows;
  });
}

export async function listCommands(
  tenantId: string, limit: number,
): Promise<{ commands: ControlCommand[]; total: number; limit: number; truncated: boolean }> {
  return withTenant({ tenantId }, async (db) => {
    const { rows } = await db.query<ControlCommand & { totalCount: string }>(
      `SELECT count(*) OVER () AS "totalCount", ${COMMAND_COLUMNS} ${FROM_COMMANDS}
        ORDER BY c.requested_at DESC LIMIT $1`,
      [limit],
    );
    const total = rows.length > 0 ? Number(rows[0]!.totalCount) : 0;
    const commands = rows.map(({ totalCount: _t, ...c }) => c as ControlCommand);
    return { commands, total, limit, truncated: total > commands.length };
  });
}
