import { withTenant, type Db } from '@dtwin/db';
import type { AlertSeverity, AlertWithContext } from '@dtwin/types';

/**
 * Alert persistence.
 *
 * Every read returns the alert already joined to its spatial context, so a
 * dashboard can render "AHU-03, Level 2, MEE-204" without a second round trip.
 * Alerts are rare enough that the join costs nothing worth optimising.
 *
 * Every function here takes a tenantId and opens its own scoped transaction.
 * None of the statements carry a tenant predicate — the policies add it — so an
 * alert id from another tenant simply does not match, and the caller gets null
 * rather than a leak or an error that confirms the id exists.
 */
const SELECT_WITH_CONTEXT = `
  SELECT a.id, a.rule_id AS "ruleId",
         a.sensor_id AS "sensorId", a.equipment_id AS "equipmentId", a.zone_id AS "zoneId",
         a.severity, a.state, a.message,
         a.trigger_value AS "triggerValue", a.threshold,
         a.opened_at AS "openedAt",
         a.acknowledged_at AS "acknowledgedAt", a.acknowledged_by AS "acknowledgedBy",
         a.resolved_at AS "resolvedAt", a.context,
         r.name AS "ruleName",
         z.name AS "zoneName", f.name AS "floorName",
         e.tag  AS "equipmentTag", s.name AS "sensorName"
    FROM alerts a
    JOIN alert_rules r ON r.id = a.rule_id
    LEFT JOIN sensors   s ON s.id = a.sensor_id
    LEFT JOIN equipment e ON e.id = COALESCE(a.equipment_id, s.equipment_id)
    LEFT JOIN zones     z ON z.id = COALESCE(a.zone_id, s.zone_id, e.zone_id)
    LEFT JOIN floors    f ON f.id = COALESCE(z.floor_id, e.floor_id)
`;

export interface OpenAlertInput {
  tenantId: string;
  ruleId: string;
  sensorId: string;
  equipmentId: string | null;
  zoneId: string | null;
  severity: AlertSeverity;
  message: string;
  triggerValue: number | null;
  threshold: number | null;
  context: Record<string, unknown>;
}

/**
 * Open an alert, or return null if one is already live for this target.
 *
 * The conflict target matches the partial unique index in 003_alerting.sql. It
 * is not belt-and-braces: the engine's own state says whether an alert is open,
 * but that state is per-process, and a second ingest replica would otherwise
 * duplicate every alert. The database is the only place that fact can be
 * settled.
 */
export async function openAlert(input: OpenAlertInput): Promise<AlertWithContext | null> {
  return withTenant({ tenantId: input.tenantId }, async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO alerts (tenant_id, rule_id, sensor_id, equipment_id, zone_id,
                           severity, state, message, trigger_value, threshold, context)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9, $10)
       ON CONFLICT (rule_id, COALESCE(sensor_id, equipment_id, zone_id))
         WHERE state <> 'resolved'
         DO NOTHING
       RETURNING id`,
      [
        input.tenantId, input.ruleId, input.sensorId, input.equipmentId, input.zoneId,
        input.severity, input.message, input.triggerValue, input.threshold,
        JSON.stringify(input.context),
      ],
    );
    const id = rows[0]?.id;
    return id ? await selectById(db, id) : null;
  });
}

export async function resolveAlert(
  tenantId: string,
  alertId: string,
): Promise<AlertWithContext | null> {
  return withTenant({ tenantId }, async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `UPDATE alerts SET state = 'resolved', resolved_at = now()
        WHERE id = $1 AND state <> 'resolved'
        RETURNING id`,
      [alertId],
    );
    return rows[0] ? await selectById(db, rows[0].id) : null;
  });
}

/**
 * Acknowledge an alert as a specific user.
 *
 * `by` is a user id taken from the authenticated session, not a caller-supplied
 * string. The old signature accepted whatever the request body said, which made
 * the acknowledgement trail worth exactly nothing — it was a P0 in the CTO
 * assessment. The column is now a foreign key to `users`, so an id that is not
 * a real user fails rather than being recorded.
 */
export async function acknowledgeAlert(
  tenantId: string,
  alertId: string,
  byUserId: string,
): Promise<AlertWithContext | null> {
  return withTenant({ tenantId, userId: byUserId }, async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `UPDATE alerts SET state = 'acknowledged', acknowledged_at = now(), acknowledged_by = $2
        WHERE id = $1 AND state = 'open'
        RETURNING id`,
      [alertId, byUserId],
    );
    return rows[0] ? await selectById(db, rows[0].id) : null;
  });
}

/** Within an already-scoped transaction. */
async function selectById(db: Db, alertId: string): Promise<AlertWithContext | null> {
  const { rows } = await db.query<AlertWithContext>(
    `${SELECT_WITH_CONTEXT} WHERE a.id = $1`, [alertId]);
  return rows[0] ?? null;
}

export async function byId(
  tenantId: string,
  alertId: string,
): Promise<AlertWithContext | null> {
  return withTenant({ tenantId }, (db) => selectById(db, alertId));
}

export async function listAlerts(
  tenantId: string,
  state?: 'live' | 'resolved',
): Promise<AlertWithContext[]> {
  const where =
    state === 'live' ? `WHERE a.state <> 'resolved'`
    : state === 'resolved' ? `WHERE a.state = 'resolved'`
    : '';
  return withTenant({ tenantId }, async (db) => {
    const { rows } = await db.query<AlertWithContext>(
      `${SELECT_WITH_CONTEXT} ${where} ORDER BY a.opened_at DESC LIMIT 200`);
    return rows;
  });
}

/**
 * Alerts still live in the database, keyed as the engine keys its state.
 *
 * Loaded at boot so a restart adopts them instead of leaving them open forever:
 * without this the engine would neither re-open (the unique index forbids it)
 * nor ever resolve them, and the alert list would accumulate permanent ghosts
 * across every deploy.
 */
export async function loadLiveAlerts(tenantId: string): Promise<Map<string, string>> {
  return withTenant({ tenantId }, async (db) => {
    const { rows } = await db.query<{ id: string; ruleId: string; sensorId: string }>(
      `SELECT id, rule_id AS "ruleId", sensor_id AS "sensorId"
         FROM alerts WHERE state <> 'resolved' AND sensor_id IS NOT NULL`);
    return new Map(rows.map((r) => [`${r.ruleId}:${r.sensorId}`, r.id]));
  });
}
