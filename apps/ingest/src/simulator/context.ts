import { withTenant } from '@dtwin/db';
import type { DayType, EquipmentType, ZoneType } from '@dtwin/types';

/**
 * Building context the simulator needs to produce plausible values.
 *
 * Loaded once from the seeded model rather than invented, so the synthetic feed
 * respects what the twin actually says: a server room holds 21 C because its
 * thermal profile says so, and a chiller flagged `maintenance` draws no power.
 * Values that contradict the model would make every downstream check
 * meaningless.
 *
 * Loaded per tenant. The simulator holds one context per tenant rather than one
 * globally, because `timezone` and every profile value below belong to a
 * specific building — averaging them across tenants would produce a feed that
 * matches nobody's model, which is exactly the failure this whole module exists
 * to avoid.
 */
export interface ZoneContext {
  id: string;
  zoneType: ZoneType;
  designOccupancy: number;
  areaM2: number;
  setpointC: number;
  lightingDensityW_m2: number;
  equipmentDensityW_m2: number;
  scheduleId: string | null;
}

export interface EquipmentContext {
  id: string;
  equipmentType: EquipmentType;
  ratedPowerKw: number | null;
  ratedAirflowCmh: number | null;
  isRunning: boolean;
}

export interface SimContext {
  timezone: string;
  /**
   * Supervisory overrides in force, zone id -> setpoint.
   *
   * Separate from `ZoneContext.setpointC`, which is the zone's DESIGNED
   * setpoint and never changes. An override is a temporary layer over it, and
   * keeping them apart is what makes expiry free: the map is rebuilt from the
   * database each poll, and an override that has lapsed simply is not in the
   * new one (§62).
   */
  overrides: Map<string, number>;
  zones: Map<string, ZoneContext>;
  equipment: Map<string, EquipmentContext>;
  /** scheduleId -> dayType -> 24 hourly fractions */
  schedules: Map<string, Map<DayType, number[]>>;
}

export async function loadSimContext(tenantId: string): Promise<SimContext> {
  return withTenant({ tenantId }, async (pool) => {
  const [building, zones, equipment, days] = await Promise.all([
    pool.query<{ timezone: string }>(`SELECT timezone FROM buildings ORDER BY name LIMIT 1`),
    pool.query<ZoneContext>(`
      SELECT z.id, z.zone_type AS "zoneType",
             COALESCE(z.design_occupancy, 0) AS "designOccupancy",
             COALESCE(z.area_m2, 100) AS "areaM2",
             COALESCE(tp.setpoint_temp_c, 23) AS "setpointC",
             COALESCE(tp.lighting_power_density_w_m2, 8) AS "lightingDensityW_m2",
             COALESCE(tp.equipment_power_density_w_m2, 10) AS "equipmentDensityW_m2",
             z.occupancy_schedule_id AS "scheduleId"
        FROM zones z
        LEFT JOIN thermal_profiles tp ON tp.id = z.thermal_profile_id`),
    pool.query<EquipmentContext>(`
      SELECT id, equipment_type AS "equipmentType",
             rated_power_kw AS "ratedPowerKw",
             rated_airflow_cmh AS "ratedAirflowCmh",
             status IN ('operational', 'degraded') AS "isRunning"
        FROM equipment`),
    pool.query<{ scheduleId: string; dayType: DayType; hourlyFractions: number[] }>(`
      SELECT schedule_id AS "scheduleId", day_type AS "dayType",
             hourly_fractions AS "hourlyFractions"
        FROM occupancy_schedule_days`),
  ]);

  const schedules = new Map<string, Map<DayType, number[]>>();
  for (const d of days.rows) {
    let byDay = schedules.get(d.scheduleId);
    if (!byDay) {
      byDay = new Map();
      schedules.set(d.scheduleId, byDay);
    }
    byDay.set(d.dayType, d.hourlyFractions);
  }

  return {
    timezone: building.rows[0]?.timezone ?? 'UTC',
    // Empty until the first command poll fills it. Loading overrides here too
    // would put the same query in two places with two lifetimes.
    overrides: new Map<string, number>(),
    zones: new Map(zones.rows.map((z) => [z.id, z])),
    equipment: new Map(equipment.rows.map((e) => [e.id, e])),
    schedules,
  };
  });
}

/** Local hour (fractional) and day type in the building's timezone. */
export function localTime(now: Date, timezone: string): { hour: number; dayType: DayType } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false,
  }).formatToParts(now);

  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  // Intl renders midnight as hour 24 in some locales; fold it back to 0.
  const hour = Number(get('hour')) % 24 + Number(get('minute')) / 60;
  const weekday = get('weekday');

  const dayType: DayType =
    weekday === 'Sat' ? 'saturday' : weekday === 'Sun' ? 'sunday' : 'weekday';

  return { hour, dayType };
}

export function occupancyFraction(
  ctx: SimContext,
  zone: ZoneContext | undefined,
  hour: number,
  dayType: DayType,
): number {
  if (!zone?.scheduleId) return 0;
  const fractions = ctx.schedules.get(zone.scheduleId)?.get(dayType);
  return fractions?.[Math.floor(hour) % 24] ?? 0;
}

/**
 * Outdoor dry bulb for a Gulf summer day: minimum around 06:00, peak around
 * 15:00. Drives the cooling load, so indoor drift tracks it.
 */
export function outdoorTempC(hour: number): number {
  return 34 + 8 * Math.sin(((hour - 9) / 24) * 2 * Math.PI);
}
