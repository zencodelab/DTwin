import { NextResponse } from 'next/server';
import { withTenant } from '@dtwin/db';
import { currentTenant, unauthorized } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * Alerts shown at once.
 *
 * Not exported: a Next.js route module may only export the handlers and a
 * fixed set of config names, and anything else fails the build. The number is
 * reported in the RESPONSE instead, which is where a consumer needs it.
 */
const ALERT_LIST_LIMIT = 100;

/**
 * Alerts currently live, with spatial context joined.
 *
 * Read straight from the database rather than proxied through the ingest
 * service: the dashboard should still show the standing alert list when ingest
 * is restarting, since the alerts are a fact about the building, not about that
 * process.
 *
 * The query carries no tenant predicate of its own — the RLS policy on `alerts`
 * supplies it from the scope `withTenant` sets. Writing `WHERE tenant_id = $1`
 * here as well would be a second place to forget it.
 */
export async function GET() {
  const ctx = await currentTenant();
  if (!ctx) return unauthorized();

  const page = await withTenant(ctx, async (db) => {
    const { rows } = await db.query<{ totalCount: string }>(
      // count(*) OVER () is applied after WHERE and before LIMIT, so the total
      // costs no second round trip and cannot disagree with the page it
      // describes.
      `SELECT count(*) OVER () AS "totalCount",
              a.id, a.severity, a.state, a.message,
              a.trigger_value AS "triggerValue", a.threshold,
              a.opened_at AS "openedAt", a.acknowledged_by AS "acknowledgedBy",
              a.zone_id AS "zoneId", a.sensor_id AS "sensorId",
              r.name AS "ruleName", z.name AS "zoneName", f.name AS "floorName",
              e.tag AS "equipmentTag", s.name AS "sensorName"
         FROM alerts a
         JOIN alert_rules r ON r.id = a.rule_id
         LEFT JOIN sensors   s ON s.id = a.sensor_id
         LEFT JOIN equipment e ON e.id = COALESCE(a.equipment_id, s.equipment_id)
         LEFT JOIN zones     z ON z.id = COALESCE(a.zone_id, s.zone_id, e.zone_id)
         LEFT JOIN floors    f ON f.id = COALESCE(z.floor_id, e.floor_id)
        WHERE a.state <> 'resolved'
        ORDER BY
          CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
          a.opened_at DESC
        LIMIT $1`,
      [ALERT_LIST_LIMIT],
    );
    const total = rows.length > 0 ? Number(rows[0]!.totalCount) : 0;
    const alerts = rows.map(({ totalCount: _totalCount, ...alert }) => alert);
    return { alerts, total, limit: ALERT_LIST_LIMIT, truncated: total > alerts.length };
  });

  return NextResponse.json(page);
}
