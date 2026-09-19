import { withTenant } from '@dtwin/db';
import { insertReadings } from '@dtwin/db/queries';
import type { Reading } from '@dtwin/types';
import type { Config } from './config.ts';

/** A reading plus the tenant it belongs to, as resolved from its sensor. */
export interface OwnedReading extends Reading {
  tenantId: string;
}

export interface WriterStats {
  buffered: number;
  written: number;
  dropped: number;
  flushes: number;
  failedFlushes: number;
  lastError: string | null;
  lastFlushMs: number | null;
}

/**
 * Buffers readings and writes them in batches.
 *
 * Writing per reading would be one round trip per sample — at 190 points that
 * is hundreds of tiny transactions a second for data that is perfectly happy
 * arriving a second late. The buffer flushes on whichever limit trips first,
 * row count or interval.
 *
 * ONE BUFFER, PARTITIONED BY TENANT ON FLUSH. The buffer is shared because the
 * memory cap that protects this process from a database outage has to be a
 * property of the process, not of each tenant — twenty tenants with their own
 * 100k-row caps is a two-million-row cap wearing a disguise. The flush then
 * groups by tenant and issues one scoped statement per group, because
 * `withTenant` admits exactly one tenant per transaction.
 *
 * Shedding stays global and oldest-first for the same reason. A per-tenant
 * policy would be fairer in principle and would mean one noisy tenant's backlog
 * is paid for by every tenant's memory; that trade is worth revisiting if
 * tenants ever differ enough in volume for it to matter.
 */
export class TelemetryWriter {
  #buffer: OwnedReading[] = [];
  #flushing = false;
  #timer: NodeJS.Timeout | null = null;
  #stats: Omit<WriterStats, 'buffered'> = {
    written: 0, dropped: 0, flushes: 0, failedFlushes: 0,
    lastError: null, lastFlushMs: null,
  };
  /** Sensors touched since the last flush, per tenant, for a batched last_seen_at. */
  #touched = new Map<string, Set<string>>();

  constructor(private readonly config: Config) {}

  start(): void {
    this.#timer ??= setInterval(() => {
      void this.flush();
    }, this.config.INGEST_FLUSH_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.flush();
  }

  get stats(): WriterStats {
    return { ...this.#stats, buffered: this.#buffer.length };
  }

  enqueue(readings: OwnedReading[]): void {
    this.#buffer.push(...readings);
    for (const r of readings) {
      let set = this.#touched.get(r.tenantId);
      if (!set) {
        set = new Set();
        this.#touched.set(r.tenantId, set);
      }
      set.add(r.sensorId);
    }

    // Bound the buffer. If the database is unreachable this is the only thing
    // between a transient outage and an OOM kill that takes the live stream
    // down too. Oldest-first: newer telemetry is the more useful to keep.
    const overflow = this.#buffer.length - this.config.INGEST_BUFFER_MAX_ROWS;
    if (overflow > 0) {
      this.#buffer.splice(0, overflow);
      this.#stats.dropped += overflow;
    }

    if (this.#buffer.length >= this.config.INGEST_FLUSH_MAX_ROWS) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.#flushing || this.#buffer.length === 0) return;
    this.#flushing = true;

    // Swap rather than clear-after-await: readings arriving during the write
    // belong to the next batch, and clearing afterwards would discard them.
    const batch = this.#buffer;
    const touched = this.#touched;
    this.#buffer = [];
    this.#touched = new Map();

    const started = Date.now();
    try {
      const rows = dedupe(batch);

      // One transaction per tenant. A single statement covering all of them is
      // not available: the tenant is a transaction-local setting, and the
      // insert derives each row's tenant from the RLS-scoped `sensors` join.
      let written = 0;
      for (const [tenantId, group] of groupByTenant(rows)) {
        written += await withTenant({ tenantId }, (db) => insertReadings(db, group));
      }
      await this.#markSeen(touched);

      this.#stats.written += written;
      this.#stats.flushes++;
      this.#stats.lastError = null;
      this.#stats.lastFlushMs = Date.now() - started;
    } catch (err) {
      this.#stats.failedFlushes++;
      this.#stats.lastError = (err as Error).message;

      // Put the batch back so the next tick retries it. The buffer cap in
      // enqueue() bounds how long that can go on, so a prolonged outage sheds
      // load instead of retrying forever against a growing backlog.
      this.#buffer = batch.concat(this.#buffer);
      for (const [tenantId, ids] of touched) {
        let set = this.#touched.get(tenantId);
        if (!set) {
          set = new Set();
          this.#touched.set(tenantId, set);
        }
        for (const id of ids) set.add(id);
      }
      const overflow = this.#buffer.length - this.config.INGEST_BUFFER_MAX_ROWS;
      if (overflow > 0) {
        this.#buffer.splice(0, overflow);
        this.#stats.dropped += overflow;
      }
    } finally {
      this.#flushing = false;
    }
  }

  /**
   * One statement for every sensor in the batch. Updating last_seen_at per
   * reading would double the write load to maintain a column nothing reads at
   * that resolution.
   */
  async #markSeen(touched: Map<string, Set<string>>): Promise<void> {
    for (const [tenantId, sensorIds] of touched) {
      if (sensorIds.size === 0) continue;
      await withTenant({ tenantId }, (db) =>
        db.query(
          `UPDATE sensors SET last_seen_at = now() WHERE id = ANY($1::uuid[])`,
          [[...sensorIds]],
        ));
    }
  }
}

/**
 * Partition a batch by tenant, preserving order within each group.
 *
 * Order matters: `dedupe` has already collapsed same-key readings to the last
 * one, and the insert relies on that rather than on ON CONFLICT's first-write-
 * wins. Reordering here would reintroduce the behaviour dedupe exists to avoid.
 */
function groupByTenant(readings: OwnedReading[]): Map<string, OwnedReading[]> {
  const out = new Map<string, OwnedReading[]>();
  for (const r of readings) {
    const list = out.get(r.tenantId);
    if (list) list.push(r);
    else out.set(r.tenantId, [r]);
  }
  return out;
}

/**
 * Collapse duplicate (sensor_id, time) pairs, last write wins.
 *
 * The database would resolve these itself via ON CONFLICT DO NOTHING, but that
 * resolves to FIRST write wins — the opposite of what a gateway re-sending a
 * corrected value means. Deciding it here makes the behaviour explicit and
 * shrinks the statement.
 */
function dedupe(readings: OwnedReading[]): OwnedReading[] {
  if (readings.length < 2) return readings;
  const seen = new Map<string, OwnedReading>();
  for (const r of readings) seen.set(`${r.sensorId}:${r.ts}`, r);
  return [...seen.values()];
}
