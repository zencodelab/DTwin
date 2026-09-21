import {
  Quality, isReadingStale, mayCommand,
  type ControlRefusal, type ControlSettings, type QualityCode, type TenantRole,
} from '@dtwin/types';

/**
 * The safety envelope: may this command be issued, right now, to this zone?
 *
 * A pure function of a request and a snapshot of the world, so it can be
 * exhaustively tested without a database, a gateway or a building — which is
 * the point, because this is the one piece of the system whose failure is
 * measured in equipment rather than in pixels. Everything it needs is passed
 * in; it reads nothing and writes nothing.
 *
 * **It runs twice, deliberately.** Once when a person asks — so they are told
 * no while they are still there to be told — and again when a gateway claims
 * the command, because the world moves in between. A command validated four
 * minutes ago against a healthy AHU must not be dispatched to one that has
 * since faulted, and a sensor that was fresh at request time may be dead by
 * dispatch. The second evaluation is not belt and braces; it is the one that
 * matters, and the first is the courtesy.
 *
 * The order of the checks is deliberate, because the FIRST failure is what an
 * operator is shown and it should name the real problem:
 *
 *   1. authority   — may this person command at all?
 *   2. capability  — is control switched on, and does the zone have a baseline?
 *   3. interlocks  — is it safe to command this zone at all right now?
 *   4. value       — is this particular number allowed?
 *   5. rate        — is it allowed *yet*?
 *
 * Interlocks precede the value check so that a dead sensor is reported as a
 * dead sensor, rather than the operator being told their number is fine and
 * discovering the interlock only on the next attempt.
 */

export interface ServingEquipment {
  tag: string;
  status: 'operational' | 'degraded' | 'fault' | 'offline' | 'maintenance';
}

export interface ZoneFeedback {
  /** Latest zone temperature, as measured. */
  value: number;
  /** Device timestamp, epoch ms. */
  ts: number;
  /** When it reached us, epoch ms. */
  receivedAt: number;
  quality: QualityCode;
  sampleIntervalS: number;
}

export interface EnvelopeContext {
  settings: ControlSettings;
  role: TenantRole;
  /** The zone's designed setpoint, from its thermal profile. Null = no profile. */
  baselineTempC: number | null;
  /** Whatever is overriding it now, if anything. */
  activeOverrideTempC: number | null;
  equipment: ServingEquipment[];
  feedback: ZoneFeedback | null;
  /** When this zone was last commanded, epoch ms. Null if never. */
  lastCommandAt: number | null;
  /** A pending or dispatched command already exists for this zone. */
  commandInFlight: boolean;
  now: number;
}

export interface EnvelopeRequest {
  setpointTempC: number;
  durationS?: number | undefined;
}

export type EnvelopeVerdict =
  | {
    ok: true;
    /** What the zone is being moved from — recorded on the command for audit. */
    previousTempC: number;
    /** Resolved from the request or the tenant default, and capped. */
    durationS: number;
    expiresAt: Date;
    effectiveUntil: Date;
  }
  | { ok: false; refusal: ControlRefusal; message: string };

/**
 * Equipment states in which the zone must not be commanded.
 *
 * `degraded` is deliberately NOT here. Degraded equipment is running and
 * still doing its job less well; refusing to command it would take supervisory
 * control away exactly when the building most needs help. `maintenance` is
 * here because somebody is working on it, and a setpoint moving under a
 * technician's hands is how people get hurt.
 */
const BLOCKING_STATUSES = new Set(['fault', 'offline', 'maintenance']);

/** Setpoints closer than this are the same setpoint. */
const SETPOINT_EPSILON_K = 0.05;

export function evaluate(request: EnvelopeRequest, ctx: EnvelopeContext): EnvelopeVerdict {
  const refuse = (refusal: ControlRefusal, message: string): EnvelopeVerdict =>
    ({ ok: false, refusal, message });

  // --- 1. authority ---------------------------------------------------------
  if (!mayCommand(ctx.role)) {
    return refuse('forbidden_role', `role '${ctx.role}' may not issue control commands`);
  }

  // --- 2. capability --------------------------------------------------------
  if (!ctx.settings.enabled) {
    return refuse('control_disabled',
      'supervisory control is switched off for this tenant');
  }
  if (ctx.baselineTempC === null) {
    // Without a designed setpoint there is nothing to measure an envelope
    // against, and a bare number with no baseline is exactly what this design
    // refuses to accept.
    return refuse('no_baseline', 'this zone has no thermal profile, so it has no designed setpoint');
  }

  // --- 3. interlocks --------------------------------------------------------
  const blocked = ctx.equipment.filter((e) => BLOCKING_STATUSES.has(e.status));
  if (blocked.length > 0) {
    const named = blocked.map((e) => `${e.tag} (${e.status})`).join(', ');
    return refuse('equipment_unavailable', `serving equipment is unavailable: ${named}`);
  }

  // The rule §55 established for DRAWING a zone, applied to ACTING on one. A
  // control loop closed over a dead sensor is how a building gets frozen: the
  // last value it reported is held forever, the twin believes the zone is
  // fine, and nothing contradicts it. If we would not paint this zone, we will
  // not command it.
  if (ctx.feedback === null) {
    return refuse('feedback_unusable', 'this zone has no temperature reading to control against');
  }
  if (ctx.feedback.quality !== Quality.Good) {
    return refuse('feedback_unusable',
      `the zone's temperature reading is quality-flagged (code ${ctx.feedback.quality})`);
  }
  if (isReadingStale(
    ctx.feedback.ts, ctx.feedback.receivedAt, ctx.feedback.sampleIntervalS, ctx.now,
  )) {
    const ageS = Math.round((ctx.now - Math.min(ctx.feedback.ts, ctx.feedback.receivedAt)) / 1000);
    return refuse('feedback_unusable',
      `the zone's temperature reading is ${ageS}s old and it reports every ` +
      `${ctx.feedback.sampleIntervalS}s`);
  }

  // --- 4. value -------------------------------------------------------------
  const baseline = ctx.baselineTempC;
  const current = ctx.activeOverrideTempC ?? baseline;
  const target = request.setpointTempC;

  const deviation = Math.abs(target - baseline);
  if (deviation > ctx.settings.maxDeviationK + 1e-9) {
    return refuse('outside_envelope',
      `${target.toFixed(1)} °C is ${deviation.toFixed(1)} K from this zone's designed ` +
      `${baseline.toFixed(1)} °C; the envelope allows ${ctx.settings.maxDeviationK.toFixed(1)} K`);
  }

  const step = Math.abs(target - current);
  if (step > ctx.settings.maxStepK + 1e-9) {
    return refuse('step_too_large',
      `moving ${step.toFixed(1)} K in one command, from ${current.toFixed(1)} °C; ` +
      `the limit is ${ctx.settings.maxStepK.toFixed(1)} K`);
  }
  if (step <= SETPOINT_EPSILON_K) {
    // Refused rather than accepted as a no-op: a command is a dispatch, a
    // write and an equipment cycle, and spending all three to change nothing
    // is how a rate limiter gets exhausted by an optimiser that is not
    // converging.
    return refuse('no_change', `this zone is already at ${current.toFixed(1)} °C`);
  }

  // --- 5. rate --------------------------------------------------------------
  if (ctx.commandInFlight) {
    return refuse('command_in_flight',
      'a command for this zone is already waiting to be applied');
  }
  if (ctx.lastCommandAt !== null) {
    const sinceS = (ctx.now - ctx.lastCommandAt) / 1000;
    if (sinceS < ctx.settings.minIntervalS) {
      const waitS = Math.ceil(ctx.settings.minIntervalS - sinceS);
      return refuse('too_soon',
        `commanded ${Math.floor(sinceS)}s ago; this zone accepts one command every ` +
        `${ctx.settings.minIntervalS}s — ${waitS}s to wait`);
    }
  }

  const durationS = request.durationS ?? ctx.settings.defaultDurationS;
  if (durationS > ctx.settings.maxDurationS) {
    return refuse('duration_too_long',
      `${durationS}s exceeds the ${ctx.settings.maxDurationS}s maximum; an override ` +
      'is supervisory, not permanent — change the profile instead');
  }

  return {
    ok: true,
    previousTempC: current,
    durationS,
    // The intent goes stale long before the effect does: these are different
    // clocks and the schema keeps both (migration 017).
    expiresAt: new Date(ctx.now + ctx.settings.commandTtlS * 1000),
    effectiveUntil: new Date(ctx.now + durationS * 1000),
  };
}
