import type { QualityCode, RawTelemetryBatch, Reading } from '@dtwin/types';
import type { Config } from './config.ts';
import { Fanout } from './fanout.ts';
import type { OwnedReading } from './writer.ts';
import { assessQuality } from './quality.ts';
import { SensorRegistry, type RegisteredSensor } from './registry.ts';
import { AlertEngine } from './rules/index.ts';
import { TelemetryWriter } from './writer.ts';

/**
 * The ingest path, in one place: resolve -> quality -> persist + fan out.
 *
 * Synthetic and real readings take exactly this route. If the simulator had its
 * own shortcut into the database, every check run against it would be testing a
 * path production never uses.
 */
export interface IngestResult {
  accepted: number;
  unknownIds: string[];
  flagged: number;
  /**
   * Readings refused because their timestamp was too far ahead of this
   * server's clock. Reported rather than silently dropped, so a gateway with a
   * skewed clock is visible to whoever sent it.
   */
  futureDated: number;
}

export class Pipeline {
  readonly registry: SensorRegistry;
  readonly writer: TelemetryWriter;
  readonly fanout: Fanout;
  readonly alerts: AlertEngine;
  #lastValues = new Map<string, number>();
  #refreshTimer: NodeJS.Timeout | null = null;

  constructor(private readonly config: Config) {
    this.registry = new SensorRegistry({
      pageRows: config.INGEST_REGISTRY_PAGE_ROWS,
      maxSensors: config.INGEST_REGISTRY_MAX_SENSORS,
      unknownMax: config.INGEST_UNKNOWN_MAX,
      unknownRetryMs: config.INGEST_UNKNOWN_RETRY_MS,
    });
    this.writer = new TelemetryWriter(config);
    // The registry owns the topic->tenant map, so it is what decides whether a
    // subscriber may listen to a topic.
    this.fanout = new Fanout(config, (tenantId, topic) =>
      this.registry.maySubscribe(tenantId, topic));
    this.alerts = new AlertEngine(config, this.registry, this.fanout);
  }

  async start(): Promise<void> {
    await this.registry.refresh();
    this.writer.start();
    this.fanout.start();
    // After the registry: the engine expands rule scopes against it at start.
    if (this.config.ALERT_ENABLED) await this.alerts.start();
    this.#refreshTimer ??= setInterval(() => {
      // A failed refresh keeps the previous map; it must not kill the process.
      void this.registry
        .refresh()
        // Rules are expanded against the registry, so a new sensor only picks
        // up its zone's rules once the engine re-expands too.
        .then(() => (this.config.ALERT_ENABLED ? this.alerts.refresh() : undefined))
        .catch((err: unknown) => {
          console.error('[ingest] registry refresh failed:', (err as Error).message);
        });
    }, this.config.INGEST_REGISTRY_REFRESH_MS);
  }

  async stop(): Promise<void> {
    if (this.#refreshTimer) {
      clearInterval(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    this.alerts.stop();
    this.fanout.stop();
    await this.writer.stop();
  }

  /**
   * Device-facing entry point, keyed by the gateway's own identifiers.
   *
   * `tenantId` comes from the API key the device authenticated with, never from
   * the batch. Resolution is scoped to it, so an `externalId` that exists in
   * another tenant is reported as unknown rather than silently accepted — which
   * is both the safe answer and the true one, since that point is genuinely not
   * one this device may write to.
   */
  ingestRaw(tenantId: string, batch: RawTelemetryBatch): IngestResult {
    const now = Date.now();
    const unknown = new Set<string>();
    const readings: OwnedReading[] = [];
    const sensors: RegisteredSensor[] = [];
    let flagged = 0;
    let futureDated = 0;

    for (const raw of batch.readings) {
      const sensor = this.registry.lookup(tenantId, raw.externalId);
      if (!sensor) {
        unknown.add(raw.externalId);
        continue;
      }

      // Refused, not flagged. Every other bad reading is stored with a quality
      // code, because "the sensor reported -273 for six hours" is itself a
      // diagnosis — but a future timestamp is not a fact about the sensor, it
      // is damage to the database. One such row leaves the continuous
      // aggregates' watermark ahead of now when the refresh policy next runs,
      // and from then until a later refresh every reading written by every
      // tenant on that hypertable is invisible in the rollups. A quality flag
      // would not prevent that; only not writing the row does.
      // See docs/decisions.md §46.
      const ts = raw.ts ?? now;
      if (ts > now + this.config.INGEST_MAX_CLOCK_SKEW_MS) {
        futureDated++;
        continue;
      }

      const quality = assessQuality(sensor, raw.value, raw.quality as QualityCode | undefined);
      if (quality !== 0) flagged++;
      readings.push({
        sensorId: sensor.id as Reading['sensorId'],
        ts,
        value: raw.value,
        quality,
        tenantId: sensor.tenantId,
      });
      sensors.push(sensor);
    }

    this.#dispatch(sensors, readings);

    // Refresh out of band: an unrecognised id may be a point provisioned since
    // boot. Rate-limited in the registry so a misconfigured gateway repeating a
    // bad id cannot turn into a query per reading.
    const retry = [...unknown].filter(
      (id) => this.registry.shouldRetryUnknown(tenantId, id, now));
    if (retry.length > 0) {
      // Logged, not swallowed. Its sibling on the interval timer logs; this one
      // discarded the error entirely, so a registry that could not reach the
      // database looked exactly like one with nothing new to load — while every
      // reading from a newly provisioned point was reported as an unknown id.
      void this.registry.refresh().catch((err: unknown) => {
        console.error('[ingest] out-of-band registry refresh failed', err);
      });
    }

    if (futureDated > 0) {
      console.warn(
        `[ingest] refused ${futureDated} reading(s) dated more than ` +
          `${this.config.INGEST_MAX_CLOCK_SKEW_MS}ms ahead of this clock ` +
          `(tenant ${tenantId}) — check the gateway's time`,
      );
    }

    return { accepted: readings.length, unknownIds: [...unknown], flagged, futureDated };
  }

  /** In-process entry point for the simulator; the sensor is already resolved. */
  ingestResolved(items: Array<{ sensor: RegisteredSensor; value: number; ts: number }>): number {
    const readings: OwnedReading[] = [];
    const sensors: RegisteredSensor[] = [];

    for (const { sensor, value, ts } of items) {
      readings.push({
        sensorId: sensor.id as Reading['sensorId'],
        ts,
        value,
        quality: assessQuality(sensor, value),
        tenantId: sensor.tenantId,
      });
      sensors.push(sensor);
    }

    this.#dispatch(sensors, readings);
    return readings.length;
  }

  #dispatch(sensors: RegisteredSensor[], readings: OwnedReading[]): void {
    if (readings.length === 0) return;
    this.writer.enqueue(readings);
    for (let i = 0; i < readings.length; i++) {
      const sensor = sensors[i]!;
      const reading = readings[i]!;
      this.#lastValues.set(sensor.id, reading.value);
      this.fanout.publish(sensor, reading);
      if (this.config.ALERT_ENABLED) this.alerts.onReading(sensor, reading);
    }
  }

  lastValue(sensorId: string): number | undefined {
    return this.#lastValues.get(sensorId);
  }

  stats() {
    return {
      sensors: this.registry.size,
      writer: this.writer.stats,
      fanout: this.fanout.stats,
      alerts: this.config.ALERT_ENABLED ? this.alerts.stats : { enabled: false as const },
    };
  }
}
