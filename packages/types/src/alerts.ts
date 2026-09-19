import { z } from 'zod';
import {
  AlertId, AlertRuleId, BuildingId, FloorId, ZoneId, EquipmentId, SensorId,
} from './ids.ts';
import { AlertCondition, AlertSeverity, AlertState, MetricType } from './enums.ts';

/**
 * An alert rule is scoped at exactly one level. A rule written against a zone or
 * building fans out to every matching sensor when it is evaluated, so adding a
 * point to a zone inherits that zone's rules without writing a new rule.
 */
export const AlertRuleScope = z.object({
  buildingId: BuildingId.nullable(),
  floorId: FloorId.nullable(),
  zoneId: ZoneId.nullable(),
  equipmentId: EquipmentId.nullable(),
  sensorId: SensorId.nullable(),
});
export type AlertRuleScope = z.infer<typeof AlertRuleScope>;

export const AlertRule = z
  .object({
    id: AlertRuleId,
    name: z.string().min(1),
    description: z.string().nullable(),
    metric: MetricType.nullable(),
    condition: AlertCondition,
    threshold: z.number().nullable(),
    windowS: z.number().int().positive().nullable(),
    /** Debounce — breaching evaluations required before the alert opens. */
    consecutiveBreaches: z.number().int().min(1),
    /** Minimum gap before the same rule+target may re-open after resolving. */
    cooldownS: z.number().int().nonnegative(),
    severity: AlertSeverity,
    enabled: z.boolean(),
    notify: z.record(z.unknown()).default({}),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .merge(AlertRuleScope)
  // Mirrors the CHECK constraints in 003_alerting.sql. Duplicated deliberately:
  // the database is the last line of defence, but a rule editor should reject a
  // bad rule before it reaches the database.
  .refine(
    (r) =>
      [r.buildingId, r.floorId, r.zoneId, r.equipmentId, r.sensorId]
        .filter((v) => v !== null).length === 1,
    { message: 'exactly one scope target must be set' },
  )
  .refine(
    (r) =>
      ['flatline', 'no_data', 'out_of_range'].includes(r.condition) ||
      r.threshold !== null,
    { message: 'this condition requires a threshold' },
  )
  .refine(
    (r) =>
      !['rate_of_change', 'flatline', 'no_data'].includes(r.condition) ||
      r.windowS !== null,
    { message: 'this condition requires a window' },
  )
  .refine((r) => r.sensorId !== null || r.metric !== null, {
    message: 'a rule broader than one sensor must name a metric',
  });
export type AlertRule = z.infer<typeof AlertRule>;

export const Alert = z.object({
  id: AlertId,
  ruleId: AlertRuleId,
  /** The concrete point/asset that breached — narrower than the rule's scope. */
  sensorId: SensorId.nullable(),
  equipmentId: EquipmentId.nullable(),
  zoneId: ZoneId.nullable(),
  severity: AlertSeverity,
  state: AlertState,
  message: z.string(),
  triggerValue: z.number().nullable(),
  /** Snapshot of the rule's threshold at trigger time; the rule may be edited. */
  threshold: z.number().nullable(),
  openedAt: z.coerce.date(),
  acknowledgedAt: z.coerce.date().nullable(),
  acknowledgedBy: z.string().nullable(),
  resolvedAt: z.coerce.date().nullable(),
  context: z.record(z.unknown()).default({}),
});
export type Alert = z.infer<typeof Alert>;

/** An alert joined to enough spatial context to render without another fetch. */
export const AlertWithContext = Alert.extend({
  ruleName: z.string(),
  zoneName: z.string().nullable(),
  floorName: z.string().nullable(),
  equipmentTag: z.string().nullable(),
  sensorName: z.string().nullable(),
});
export type AlertWithContext = z.infer<typeof AlertWithContext>;

export const AcknowledgeAlertRequest = z.object({
  acknowledgedBy: z.string().min(1),
  note: z.string().optional(),
});
export type AcknowledgeAlertRequest = z.infer<typeof AcknowledgeAlertRequest>;
