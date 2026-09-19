import { z } from 'zod';
import { SensorId } from './ids.ts';
import { MetricType } from './enums.ts';

/**
 * Quality codes, matching telemetry.quality in 002_timeseries.sql.
 *
 * A bad reading is stored with a quality flag rather than dropped: "the sensor
 * reported -273 for six hours" is itself a diagnosis, and silently discarding
 * it turns a visible fault into an unexplained gap. Aggregates count bad
 * samples separately so a dashboard can show coverage honestly.
 */
export const Quality = {
  Good: 0,
  Uncertain: 1,
  OutOfRange: 2,
  Stale: 3,
  DeviceFault: 4,
} as const;
export type QualityCode = (typeof Quality)[keyof typeof Quality];

export const QualityCodeSchema = z
  .number()
  .int()
  .min(0)
  .max(4) as z.ZodType<QualityCode>;

/**
 * Wire format for a reading: a positional tuple, not an object.
 *
 * `{"sensorId": "...", "timestamp": ..., "value": ..., "quality": 0}` spends
 * most of each frame on repeated key names. At 500 points on a one-second tick
 * the tuple form is roughly a third of the bytes for identical information.
 * Decoded once on arrival via `expandReading`.
 *
 * Position 1 is epoch MILLISECONDS (not seconds, not ISO) — unambiguous,
 * sortable, and what Date and the charting layer both want.
 */
export const ReadingTuple = z.tuple([
  z.string().uuid(),      // sensorId
  z.number().int(),       // ts, epoch ms
  z.number(),             // value
  QualityCodeSchema,      // quality
]);
export type ReadingTuple = z.infer<typeof ReadingTuple>;

export const Reading = z.object({
  sensorId: SensorId,
  ts: z.number().int(),
  value: z.number(),
  quality: QualityCodeSchema,
});
export type Reading = z.infer<typeof Reading>;

export function expandReading(t: ReadingTuple): Reading {
  return { sensorId: t[0] as Reading['sensorId'], ts: t[1], value: t[2], quality: t[3] };
}

export function compactReading(r: Reading): ReadingTuple {
  return [r.sensorId, r.ts, r.value, r.quality];
}

/** A batch of readings, optionally stamped by the gateway that collected them. */
export const TelemetryBatch = z.object({
  readings: z.array(ReadingTuple).min(1).max(10_000),
  /** When the gateway sent the batch; lets us measure end-to-end lag. */
  sentAt: z.number().int().optional(),
  source: z.string().optional(),
});
export type TelemetryBatch = z.infer<typeof TelemetryBatch>;

/**
 * Ingest payload keyed by the DEVICE-side identifier rather than our UUID.
 *
 * A BACnet gateway knows its own object ids and nothing about this database.
 * Forcing it to learn our UUIDs would mean a provisioning round trip before it
 * can report anything; the ingest service resolves external_id -> sensor_id
 * against a cached map instead.
 */
export const RawReading = z.object({
  externalId: z.string().min(1),
  ts: z.number().int().optional(), // absent = stamp on arrival
  value: z.number(),
  quality: QualityCodeSchema.optional(),
});
export type RawReading = z.infer<typeof RawReading>;

export const RawTelemetryBatch = z.object({
  readings: z.array(RawReading).min(1).max(10_000),
  source: z.string().optional(),
});
export type RawTelemetryBatch = z.infer<typeof RawTelemetryBatch>;

/** One bucket from telemetry_5m / _1h / _1d. */
export const AggregateBucket = z.object({
  bucket: z.coerce.date(),
  sensorId: SensorId,
  avgValue: z.number().nullable(),
  minValue: z.number().nullable(),
  maxValue: z.number().nullable(),
  lastValue: z.number().nullable(),
  sampleCount: z.number().int().nonnegative(),
  badQualityCount: z.number().int().nonnegative(),
  /**
   * Reset-aware consumption over the bucket, for cumulative points only.
   * Null for gauges. Derived from counter_agg, never from max - min.
   */
  deltaValue: z.number().nullable().optional(),
});
export type AggregateBucket = z.infer<typeof AggregateBucket>;

export const AGGREGATE_RESOLUTIONS = ['5m', '1h', '1d'] as const;
export const AggregateResolution = z.enum(AGGREGATE_RESOLUTIONS);
export type AggregateResolution = z.infer<typeof AggregateResolution>;

/** The latest reading per sensor, as the 3D overlay and side panels consume it. */
export const LatestReading = z.object({
  sensorId: SensorId,
  metric: MetricType,
  unit: z.string(),
  value: z.number(),
  quality: QualityCodeSchema,
  ts: z.coerce.date(),
  /** True once the reading is older than the sensor's expected interval. */
  isStale: z.boolean(),
});
export type LatestReading = z.infer<typeof LatestReading>;
