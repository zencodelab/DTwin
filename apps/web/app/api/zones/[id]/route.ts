import { NextResponse } from 'next/server';
import { withTenant } from '@dtwin/db';
import { getLatestReadingsForZone } from '@dtwin/db/queries';
import { parseUuid } from '@/lib/params';
import { currentTenant, unauthorized } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/** Everything the detail panel shows for one zone, in a single round trip. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await currentTenant();
  if (!ctx) return unauthorized();

  const zone = parseUuid((await params).id, 'zone id');
  if (!zone.ok) return zone.response;
  const id = zone.value;

  const payload = await withTenant(ctx, async (db) => {
    const [readings, equipment, maintenance, profile] = await Promise.all([
      getLatestReadingsForZone(db, id),
      db.query(
        `SELECT DISTINCT e.id, e.tag, e.equipment_type AS "equipmentType", e.status,
                e.manufacturer, e.model, e.rated_power_kw AS "ratedPowerKw"
           FROM equipment e
           JOIN equipment_zone_service es ON es.equipment_id = e.id
          WHERE es.zone_id = $1
          ORDER BY e.tag`,
        [id],
      ),
      // Maintenance for every asset serving this zone, newest first — an AHU's
      // service history is part of diagnosing the zone it conditions.
      db.query(
        `SELECT m.id, m.performed_at AS "performedAt", m.log_type AS "logType",
                m.technician, m.notes, m.downtime_minutes AS "downtimeMinutes",
                m.next_due_at AS "nextDueAt", e.tag AS "equipmentTag"
           FROM maintenance_logs m
           JOIN equipment e ON e.id = m.equipment_id
           JOIN equipment_zone_service es ON es.equipment_id = e.id
          WHERE es.zone_id = $1
          ORDER BY m.performed_at DESC
          LIMIT 10`,
        [id],
      ),
      db.query(
        `SELECT tp.name, tp.setpoint_temp_c AS "setpointC", tp.deadband_k AS "deadbandK",
                tp.hvac_cop AS "hvacCop", tp.ventilation_l_s_person AS "ventilationLSPerson",
                tp.window_to_wall_ratio AS "windowToWallRatio"
           FROM zones z JOIN thermal_profiles tp ON tp.id = z.thermal_profile_id
          WHERE z.id = $1`,
        [id],
      ),
    ]);

    return {
      readings,
      equipment: equipment.rows,
      maintenance: maintenance.rows,
      profile: profile.rows[0] ?? null,
    };
  });

  return NextResponse.json(payload);
}
