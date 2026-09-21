import { z } from 'zod';
import { TenantId, ZoneId } from './ids.ts';
import { TENANT_ROLES, type TenantRole } from './tenancy.ts';

/**
 * Supervisory control: the contracts for the one thing in this system that
 * writes to the building rather than reading it (docs/decisions.md §62).
 */

export const CONTROL_COMMAND_STATES = [
  'pending', 'dispatched', 'applied', 'failed', 'expired', 'cancelled', 'superseded',
] as const;
export const ControlCommandState = z.enum(CONTROL_COMMAND_STATES);
export type ControlCommandState = z.infer<typeof ControlCommandState>;

/**
 * Who may command.
 *
 * `viewer` is excluded, which is the first time this project has had a role
 * that means anything: until now every member of a tenant could do everything
 * a member could do. A read-only role that can move a building's setpoints is
 * not a read-only role.
 */
export const CONTROL_ROLES: readonly TenantRole[] = ['owner', 'admin', 'operator'];

export function mayCommand(role: TenantRole): boolean {
  return CONTROL_ROLES.includes(role);
}

/**
 * Why a command was refused.
 *
 * A closed set, because these are shown to an operator who has to decide what
 * to do next, and "rejected" on its own tells them nothing. Each one names the
 * rule that refused and therefore implies the remedy — wait, pick a smaller
 * number, fix the sensor, call someone about the AHU.
 */
export const CONTROL_REFUSALS = [
  /** The tenant's kill switch is off. Nothing is dispatched while it is. */
  'control_disabled',
  /** The caller's role may not command. */
  'forbidden_role',
  /** Serving equipment is in fault, maintenance or offline. */
  'equipment_unavailable',
  /** The zone's own temperature reading is missing, stale or quality-flagged. */
  'feedback_unusable',
  /** Further from the zone's designed setpoint than the envelope allows. */
  'outside_envelope',
  /** A bigger jump in one move than `max_step_k`. */
  'step_too_large',
  /** The zone is already at this setpoint. */
  'no_change',
  /** Another command for this zone is still pending or dispatched. */
  'command_in_flight',
  /** Commanded again inside `min_interval_s`. Equipment life is spent in cycles. */
  'too_soon',
  /** Longer than `max_duration_s`. An override is supervisory, not permanent. */
  'duration_too_long',
  /** The zone has no thermal profile, so it has no designed setpoint to reason from. */
  'no_baseline',
] as const;
export const ControlRefusal = z.enum(CONTROL_REFUSALS);
export type ControlRefusal = z.infer<typeof ControlRefusal>;

export const SetpointCommandRequest = z.object({
  zoneId: ZoneId,
  setpointTempC: z.number().finite().min(-50).max(60),
  /**
   * Required, and not a nicety: a control action with no recorded reason is
   * indistinguishable from a mistake six months later. Bounded because it is
   * stored and displayed.
   */
  reason: z.string().trim().min(3).max(500),
  /** How long the override should hold. The tenant's default when omitted. */
  durationS: z.number().int().positive().max(86_400).optional(),
  /**
   * Evaluate and report, queue nothing.
   *
   * The whole envelope runs, so a dry run is a real answer rather than an
   * optimistic one — it is how an operator finds out that the AHU is in
   * maintenance before committing to anything.
   */
  dryRun: z.boolean().optional(),
});
export type SetpointCommandRequest = z.infer<typeof SetpointCommandRequest>;

export const ControlCommand = z.object({
  id: z.string().uuid(),
  tenantId: TenantId,
  zoneId: ZoneId,
  zoneName: z.string().nullable(),
  setpointTempC: z.number(),
  previousTempC: z.number().nullable(),
  state: ControlCommandState,
  reason: z.string(),
  requestedBy: z.string().uuid(),
  requestedByName: z.string().nullable(),
  requestedAt: z.coerce.date(),
  expiresAt: z.coerce.date(),
  effectiveUntil: z.coerce.date(),
  appliedAt: z.coerce.date().nullable(),
  settledAt: z.coerce.date().nullable(),
  outcomeDetail: z.string().nullable(),
  attempts: z.number().int(),
});
export type ControlCommand = z.infer<typeof ControlCommand>;

/** What a gateway reports back after trying to apply one. */
export const CommandResultReport = z.object({
  outcome: z.enum(['applied', 'failed']),
  /** Required on a failure, so "it did not work" is never the whole record. */
  detail: z.string().trim().max(500).optional(),
}).refine((r) => r.outcome !== 'failed' || (r.detail?.length ?? 0) > 0, {
  message: 'detail is required when reporting a failure',
  path: ['detail'],
});
export type CommandResultReport = z.infer<typeof CommandResultReport>;

export const ControlSettings = z.object({
  enabled: z.boolean(),
  maxDeviationK: z.number().positive(),
  maxStepK: z.number().positive(),
  minIntervalS: z.number().int().nonnegative(),
  defaultDurationS: z.number().int().positive(),
  maxDurationS: z.number().int().positive(),
  commandTtlS: z.number().int().positive(),
});
export type ControlSettings = z.infer<typeof ControlSettings>;

export const ControlSettingsUpdate = z.object({
  enabled: z.boolean().optional(),
  maxDeviationK: z.number().positive().max(10).optional(),
  maxStepK: z.number().positive().max(10).optional(),
  minIntervalS: z.number().int().nonnegative().max(86_400).optional(),
  defaultDurationS: z.number().int().positive().max(86_400).optional(),
  maxDurationS: z.number().int().positive().max(86_400).optional(),
  commandTtlS: z.number().int().positive().max(3_600).optional(),
});
export type ControlSettingsUpdate = z.infer<typeof ControlSettingsUpdate>;

/** Roles re-exported so a consumer needs one import to check authority. */
export { TENANT_ROLES };
