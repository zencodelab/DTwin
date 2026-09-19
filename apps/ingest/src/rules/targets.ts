import { withTenant, type Db } from '@dtwin/db';
import { activeTenants } from '../tenants.ts';
import type { AlertCondition, AlertSeverity, MetricType } from '@dtwin/types';
import type { RegisteredSensor, SensorRegistry } from '../registry.ts';

export interface AlertRuleRow {
  id: string;
  tenantId: string;
  name: string;
  buildingId: string | null;
  floorId: string | null;
  zoneId: string | null;
  equipmentId: string | null;
  sensorId: string | null;
  metric: MetricType | null;
  condition: AlertCondition;
  threshold: number | null;
  windowS: number | null;
  consecutiveBreaches: number;
  cooldownS: number;
  severity: AlertSeverity;
  /** Channel configuration; shape parsed by the notifier, not here. */
  notify: unknown;
}

/**
 * Every enabled rule, across every tenant.
 *
 * One scoped query per tenant rather than one query over all of them: the
 * engine spans tenants, its database statements do not. Each row carries its
 * `tenantId` so the engine can scope the alert it eventually opens without
 * looking anything up again.
 */
export async function loadRules(): Promise<AlertRuleRow[]> {
  const out: AlertRuleRow[] = [];
  for (const tenant of await activeTenants()) {
    out.push(...await withTenant({ tenantId: tenant.id }, (db) => loadTenantRules(db)));
  }
  return out;
}

async function loadTenantRules(db: Db): Promise<AlertRuleRow[]> {
  const { rows } = await db.query<AlertRuleRow>(`
    SELECT id, tenant_id AS "tenantId", name,
           building_id  AS "buildingId",
           floor_id     AS "floorId",
           zone_id      AS "zoneId",
           equipment_id AS "equipmentId",
           sensor_id    AS "sensorId",
           metric, condition, threshold,
           window_s              AS "windowS",
           consecutive_breaches  AS "consecutiveBreaches",
           cooldown_s            AS "cooldownS",
           severity, notify
      FROM alert_rules
     WHERE enabled
     ORDER BY id`);
  return rows;
}

/**
 * Zone setpoints from each zone's thermal profile — the fallback when no live
 * setpoint point exists. Keyed by zone id, which is a UUID and therefore
 * already unique across tenants, so one flat map is safe here.
 */
export async function loadZoneSetpoints(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const tenant of await activeTenants()) {
    const { rows } = await withTenant({ tenantId: tenant.id }, (db) =>
      db.query<{ id: string; setpoint: number }>(`
        SELECT z.id, tp.setpoint_temp_c AS setpoint
          FROM zones z
          JOIN thermal_profiles tp ON tp.id = z.thermal_profile_id`));
    for (const r of rows) out.set(r.id, r.setpoint);
  }
  return out;
}

/**
 * Expand each rule to the concrete sensors it watches.
 *
 * Resolved in memory against the registry, which already carries every sensor's
 * zone, floor and building. The equivalent SQL is a five-way outer join with a
 * disjunction over five nullable scope columns — correct but awkward to read and
 * to keep correct. At 7 rules x 190 sensors this is a few thousand comparisons
 * recomputed on refresh, so the clarity is free.
 *
 * Expanding at evaluation time is what makes scope inheritance work: a sensor
 * added to a zone picks up that zone's rules on the next refresh, with no new
 * rule rows.
 */
export function expandRule(
  rule: AlertRuleRow,
  registry: SensorRegistry,
): RegisteredSensor[] {
  return registry.all().filter((s) => {
    if (rule.metric !== null && s.metric !== rule.metric) return false;

    // Rules and sensors are both loaded per tenant, but the registry is shared,
    // so a rule must never expand onto a sensor it does not own. Scope columns
    // are UUIDs and would not match across tenants anyway — this is the
    // belt-and-braces that keeps that an accident rather than a vulnerability.
    if (s.tenantId !== rule.tenantId) return false;

    if (rule.sensorId !== null) return s.id === rule.sensorId;
    if (rule.equipmentId !== null) return s.equipmentId === rule.equipmentId;
    if (rule.zoneId !== null) return s.zoneId === rule.zoneId;
    if (rule.floorId !== null) return s.floorId === rule.floorId;
    if (rule.buildingId !== null) return s.buildingId === rule.buildingId;
    return false;
  });
}

export interface RuleTarget {
  rule: AlertRuleRow;
  sensor: RegisteredSensor;
  /** Stable identity for debounce state and the one-open-alert-per-target index. */
  key: string;
}

export function expandAll(rules: AlertRuleRow[], registry: SensorRegistry): RuleTarget[] {
  const out: RuleTarget[] = [];
  for (const rule of rules) {
    for (const sensor of expandRule(rule, registry)) {
      out.push({ rule, sensor, key: `${rule.id}:${sensor.id}` });
    }
  }
  return out;
}
