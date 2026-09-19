import { Quality, type QualityCode } from '@dtwin/types';
import type { RegisteredSensor } from './registry.ts';

/**
 * Assign a quality code to an incoming value.
 *
 * Bad readings are stored with a flag rather than dropped. "The sensor reported
 * -273 for six hours" is itself a diagnosis; discarding it turns a visible
 * fault into an unexplained gap, and the aggregates already count bad samples
 * separately so coverage can be shown honestly.
 */
export function assessQuality(
  sensor: RegisteredSensor,
  value: number,
  declared?: QualityCode,
): QualityCode {
  // A device that reports its own fault knows more than we do.
  if (declared !== undefined && declared !== Quality.Good) return declared;

  if (!Number.isFinite(value)) return Quality.DeviceFault;

  if (sensor.minPlausible !== null && value < sensor.minPlausible) return Quality.OutOfRange;
  if (sensor.maxPlausible !== null && value > sensor.maxPlausible) return Quality.OutOfRange;

  return Quality.Good;
}

/**
 * A cumulative counter going backwards is a meter reset or a replacement, not
 * bad data — `counter_agg` in the hourly aggregate is built to handle exactly
 * that. Flagging it would misreport a normal event as a fault, so this exists
 * to be called and deliberately return Good.
 */
export function isCounterReset(
  sensor: RegisteredSensor,
  value: number,
  previous: number | undefined,
): boolean {
  return sensor.isCumulative && previous !== undefined && value < previous;
}
