import { NextResponse } from 'next/server';
import { withTenant } from '@dtwin/db';
import { getZoneHeatmap } from '@dtwin/db/queries';
import { currentTenant, unauthorized } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * Historical mean per zone for the overlay's initial paint.
 *
 * Live WebSocket values take over once they arrive, but they only cover sensors
 * that have reported since the page opened. Without this the building would
 * render uncoloured for the first seconds and zones with slow-reporting points
 * would stay grey indefinitely.
 */
export async function GET(request: Request) {
  const ctx = await currentTenant();
  if (!ctx) return unauthorized();

  const url = new URL(request.url);
  const buildingId = url.searchParams.get('buildingId');
  const metric = url.searchParams.get('metric') ?? 'temperature_c';
  const hours = Number(url.searchParams.get('hours') ?? 1);

  if (!buildingId) {
    return NextResponse.json({ error: 'buildingId is required' }, { status: 400 });
  }

  const to = new Date();
  const from = new Date(to.getTime() - hours * 3600_000);

  // `buildingId` is still caller-supplied, but it is no longer load-bearing for
  // isolation: the query runs inside this tenant's scope, so naming another
  // tenant's building returns nothing rather than returning their data.
  const zones = await withTenant(ctx, async (db) => {
    // Setpoints ship with the overlay because the temperature scale is diverging
    // about each zone's own target — the colour is meaningless without it, and a
    // second round trip to fetch them would leave the first paint uncoloured.
    const [rows, setpoints] = await Promise.all([
      getZoneHeatmap(db, buildingId, metric, from, to),
      db.query<{ id: string; setpointC: number; deadbandK: number }>(
        `SELECT z.id, tp.setpoint_temp_c AS "setpointC", tp.deadband_k AS "deadbandK"
           FROM zones z
           JOIN floors f ON f.id = z.floor_id
           JOIN thermal_profiles tp ON tp.id = z.thermal_profile_id
          WHERE f.building_id = $1`,
        [buildingId],
      ),
    ]);

    const profileById = new Map(setpoints.rows.map((r) => [r.id, r]));
    return rows.map((z) => ({
      ...z,
      setpointC: profileById.get(z.zoneId)?.setpointC ?? null,
      deadbandK: profileById.get(z.zoneId)?.deadbandK ?? null,
    }));
  });

  return NextResponse.json({ zones });
}
