import { Quality, type AlertCondition, type QualityCode } from '@dtwin/types';
import type { RegisteredSensor } from '../registry.ts';

/**
 * Condition predicates — pure functions over a sensor's tracked state.
 *
 * Kept free of database and socket access so each condition can be reasoned
 * about (and tested) on its own. The engine owns scheduling, debounce and
 * persistence; this module only answers "is this breaching right now?".
 */

export interface SensorState {
  lastValue: number;
  lastTs: number;
  /** When the value last actually moved — the basis for flatline detection. */
  lastChangedAt: number;
  lastQuality: QualityCode;
  /** Only populated for sensors targeted by a rate_of_change rule. */
  history?: Array<{ ts: number; value: number }>;
}

export interface EvalContext {
  now: number;
  /** Zone setpoint, live where a setpoint point exists, else from the profile. */
  setpoint: number | undefined;
  /** When the engine started; the baseline for no_data before a first reading. */
  startedAt: number;
}

export interface RuleSpec {
  condition: AlertCondition;
  threshold: number | null;
  windowS: number | null;
}

/**
 * Value-based conditions ignore readings the quality gate already flagged.
 *
 * A thermistor reporting -273 must raise a sensor fault, not "zone overheating".
 * Letting bad data drive thermal alarms produces exactly the noise that trains
 * facility managers to ignore the alarm list. `out_of_range` is the exception —
 * it is the condition whose entire purpose is that flag.
 */
export function isEvaluable(rule: RuleSpec, state: SensorState | undefined): boolean {
  if (!state) return rule.condition === 'no_data';
  if (rule.condition === 'out_of_range') return true;
  return state.lastQuality === Quality.Good;
}

export function evaluate(
  rule: RuleSpec,
  sensor: RegisteredSensor,
  state: SensorState | undefined,
  ctx: EvalContext,
): { breaching: boolean; value: number | null } {
  switch (rule.condition) {
    case 'no_data': {
      // Before the first reading, measure from engine start — otherwise every
      // sensor alarms at boot simply because nothing has arrived yet.
      const since = state?.lastTs ?? ctx.startedAt;
      const windowMs = (rule.windowS ?? 0) * 1000;
      return { breaching: ctx.now - since > windowMs, value: null };
    }

    case 'flatline': {
      if (!state) return { breaching: false, value: null };
      const windowMs = (rule.windowS ?? 0) * 1000;
      return {
        breaching: ctx.now - state.lastChangedAt > windowMs,
        value: state.lastValue,
      };
    }

    case 'out_of_range':
      if (!state) return { breaching: false, value: null };
      return {
        breaching: state.lastQuality === Quality.OutOfRange,
        value: state.lastValue,
      };

    case 'threshold_above':
      if (!state || rule.threshold === null) return { breaching: false, value: null };
      return { breaching: state.lastValue > rule.threshold, value: state.lastValue };

    case 'threshold_below':
      if (!state || rule.threshold === null) return { breaching: false, value: null };
      return { breaching: state.lastValue < rule.threshold, value: state.lastValue };

    case 'deviation_from_setpoint': {
      if (!state || rule.threshold === null || ctx.setpoint === undefined) {
        return { breaching: false, value: state?.lastValue ?? null };
      }
      const deviation = Math.abs(state.lastValue - ctx.setpoint);
      return { breaching: deviation > rule.threshold, value: state.lastValue };
    }

    case 'rate_of_change': {
      if (!state?.history || rule.threshold === null || rule.windowS === null) {
        return { breaching: false, value: state?.lastValue ?? null };
      }
      const slope = slopePerHour(state.history, ctx.now, rule.windowS);
      if (slope === null) return { breaching: false, value: state.lastValue };
      return { breaching: Math.abs(slope) > rule.threshold, value: slope };
    }
  }
}

/**
 * Least-squares slope in units per hour over the trailing window.
 *
 * Endpoint difference would be far simpler and wrong: with ±0.18 K of sensor
 * noise, two adjacent samples 60 s apart imply over 20 K/h, so a 2 K/h rule
 * would fire constantly on a perfectly steady zone. A regression over the whole
 * window averages the noise out and measures the trend the rule actually means.
 *
 * Returns null until the samples span at least half the window — a slope
 * computed from a sliver of it is not the quantity the threshold describes.
 */
export function slopePerHour(
  history: Array<{ ts: number; value: number }>,
  now: number,
  windowS: number,
): number | null {
  const windowMs = windowS * 1000;
  const samples = history.filter((h) => now - h.ts <= windowMs);
  if (samples.length < 3) return null;

  const span = samples[samples.length - 1]!.ts - samples[0]!.ts;
  if (span < windowMs / 2) return null;

  // Centre the x axis on the mean to keep the normal equations well conditioned
  // with epoch-millisecond timestamps.
  const meanTs = samples.reduce((s, h) => s + h.ts, 0) / samples.length;
  const meanValue = samples.reduce((s, h) => s + h.value, 0) / samples.length;

  let num = 0;
  let den = 0;
  for (const h of samples) {
    const dx = h.ts - meanTs;
    num += dx * (h.value - meanValue);
    den += dx * dx;
  }
  if (den === 0) return null;

  return (num / den) * 3_600_000; // per ms -> per hour
}

/** Sensors quantise, so exact equality would miss a stuck reading that dithers. */
export const FLATLINE_EPSILON = 1e-6;
