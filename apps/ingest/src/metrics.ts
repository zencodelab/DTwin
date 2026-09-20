/**
 * Prometheus text exposition of the counters `/healthz` already reports.
 *
 * This is a formatter, not instrumentation. Every number here was already being
 * counted — shed load has been surfaced since §12 — but only as JSON on a health
 * endpoint, which answers "is it well right now?" and cannot answer "when did
 * it start dropping frames?". A scraper needs the same numbers in a shape it
 * can store, and a rate is only computable from a counter that is scraped.
 *
 * Pure: a snapshot in, a string out. It knows nothing about the pipeline, so
 * the shape of the output is testable without starting one.
 *
 * Process-level only, like `/healthz`, and for the same reason: it is served
 * without a key, so it must not carry anything that belongs to a tenant. There
 * are deliberately NO per-tenant labels. They would be the first thing anyone
 * asked for, and they would turn an open endpoint into a list of who the
 * customers are and how busy each one is — besides making the series count a
 * function of the customer count.
 */
export type MetricKind = 'counter' | 'gauge';

export interface Sample {
  labels?: Record<string, string>;
  value: number;
}

export interface Metric {
  name: string;
  help: string;
  kind: MetricKind;
  samples: Sample[];
}

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

export function renderMetrics(metrics: Metric[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const metric of metrics) {
    if (!NAME.test(metric.name)) throw new Error(`invalid metric name: ${metric.name}`);
    // A name declared twice is rejected by the scraper for the WHOLE payload,
    // so one careless addition would blank every dashboard built on this.
    if (seen.has(metric.name)) throw new Error(`duplicate metric: ${metric.name}`);
    seen.add(metric.name);
    // The convention is load-bearing: `rate()` is only meaningful on a counter,
    // and the suffix is how a person reading a query knows which they have.
    if (metric.kind === 'counter' && !metric.name.endsWith('_total')) {
      throw new Error(`counter must end in _total: ${metric.name}`);
    }

    lines.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`);
    lines.push(`# TYPE ${metric.name} ${metric.kind}`);
    for (const sample of metric.samples) {
      const labels = Object.entries(sample.labels ?? {});
      for (const [key] of labels) {
        if (!LABEL.test(key)) throw new Error(`invalid label name: ${key}`);
      }
      const rendered = labels.length === 0
        ? ''
        : `{${labels.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}`;
      lines.push(`${metric.name}${rendered} ${formatValue(sample.value)}`);
    }
  }
  // The format requires a trailing newline; some scrapers reject its absence.
  return `${lines.join('\n')}\n`;
}

// --------------------------------------------------------------- the snapshot

interface LimiterStats { keys: number; refused: number; overflowed: number }

export interface IngestSnapshot {
  ready: boolean;
  uptimeS: number;
  sensors: number;
  writer: {
    written: number; dropped: number; flushes: number; failedFlushes: number;
    buffered: number; lastFlushMs: number | null;
  };
  fanout: {
    framesSent: number; readingsSent: number; framesSkipped: number;
    backloggedClosed: number; subscribesDenied: number;
    subscribers: number; authenticated: number; topics: number;
  };
  alerts: {
    rules: number; live: number; opened: number; resolved: number; suppressedByCooldown: number;
    notify: { delivered: number; failed: number; blocked: number; skipped: number };
  } | null;
  limits: Record<string, LimiterStats>;
}

const one = (value: number): Sample[] => [{ value }];

export function ingestMetrics(s: IngestSnapshot): Metric[] {
  const p = 'dtwin_ingest_';
  const metrics: Metric[] = [
    { name: `${p}ready`, kind: 'gauge', samples: one(s.ready ? 1 : 0),
      help: '1 when the write path is draining, 0 when degraded. Same judgement as /readyz.' },
    { name: `${p}uptime_seconds`, kind: 'gauge', samples: one(s.uptimeS),
      help: 'Seconds since this process started. A reset here explains a reset in every counter below.' },
    { name: `${p}registry_sensors`, kind: 'gauge', samples: one(s.sensors),
      help: 'Active sensors in the in-memory registry, across all tenants.' },

    { name: `${p}readings_written_total`, kind: 'counter', samples: one(s.writer.written),
      help: 'Readings durably written to the hypertable.' },
    { name: `${p}readings_dropped_total`, kind: 'counter', samples: one(s.writer.dropped),
      help: 'Readings shed from the write buffer on overflow, oldest first. Non-zero means data was lost.' },
    { name: `${p}writer_flushes_total`, kind: 'counter', samples: one(s.writer.flushes),
      help: 'Write-buffer flushes attempted.' },
    { name: `${p}writer_failed_flushes_total`, kind: 'counter', samples: one(s.writer.failedFlushes),
      help: 'Flushes that failed and were returned to the buffer.' },
    { name: `${p}writer_buffered_readings`, kind: 'gauge', samples: one(s.writer.buffered),
      help: 'Readings accepted but not yet written. Sustained growth precedes dropped readings.' },
    { name: `${p}writer_last_flush_milliseconds`, kind: 'gauge', samples: one(s.writer.lastFlushMs ?? NaN),
      help: 'Duration of the most recent flush. NaN before the first.' },

    { name: `${p}ws_frames_sent_total`, kind: 'counter', samples: one(s.fanout.framesSent),
      help: 'WebSocket frames delivered to subscribers.' },
    { name: `${p}ws_readings_sent_total`, kind: 'counter', samples: one(s.fanout.readingsSent),
      help: 'Readings delivered, counted once per receiving subscriber.' },
    { name: `${p}ws_frames_skipped_total`, kind: 'counter', samples: one(s.fanout.framesSkipped),
      help: 'Supersedable frames (telemetry, sim progress) skipped for a backlogged client.' },
    { name: `${p}ws_backlogged_closed_total`, kind: 'counter', samples: one(s.fanout.backloggedClosed),
      help: 'Sockets closed because they were too backlogged to take an alert frame, which is never skipped.' },
    { name: `${p}ws_subscribes_denied_total`, kind: 'counter', samples: one(s.fanout.subscribesDenied),
      help: "Topic subscriptions refused: another tenant's topic, or one this service does not know." },
    { name: `${p}ws_connections`, kind: 'gauge',
      help: 'Open WebSocket connections, by whether they have completed the auth handshake.',
      samples: [
        { labels: { state: 'authenticated' }, value: s.fanout.authenticated },
        { labels: { state: 'unauthenticated' }, value: s.fanout.subscribers - s.fanout.authenticated },
      ] },
    { name: `${p}ws_topics`, kind: 'gauge', samples: one(s.fanout.topics),
      help: 'Topics with at least one subscriber.' },

    { name: `${p}rate_limit_refused_total`, kind: 'counter',
      help: 'Requests, readings batches, frames or authentication attempts refused by each rate limiter.',
      samples: Object.entries(s.limits).map(([limiter, l]) => ({ labels: { limiter }, value: l.refused })) },
    { name: `${p}rate_limit_overflowed_total`, kind: 'counter',
      help: 'Times a limiter was full of mid-burst keys and a newcomer shared the overflow bucket. Non-zero suggests key rotation.',
      samples: Object.entries(s.limits).map(([limiter, l]) => ({ labels: { limiter }, value: l.overflowed })) },
    { name: `${p}rate_limit_keys`, kind: 'gauge',
      help: 'Keys each rate limiter is tracking.',
      samples: Object.entries(s.limits).map(([limiter, l]) => ({ labels: { limiter }, value: l.keys })) },
  ];

  if (s.alerts) {
    metrics.push(
      { name: `${p}alert_rules`, kind: 'gauge', samples: one(s.alerts.rules),
        help: 'Enabled alert rules loaded, across all tenants.' },
      { name: `${p}alerts_live`, kind: 'gauge', samples: one(s.alerts.live),
        help: 'Alerts currently open or acknowledged.' },
      { name: `${p}alerts_opened_total`, kind: 'counter', samples: one(s.alerts.opened),
        help: 'Alerts opened by this process.' },
      { name: `${p}alerts_resolved_total`, kind: 'counter', samples: one(s.alerts.resolved),
        help: 'Alerts resolved by this process.' },
      { name: `${p}alerts_suppressed_total`, kind: 'counter', samples: one(s.alerts.suppressedByCooldown),
        help: 'Alerts not opened because their rule was cooling down.' },
      { name: `${p}notifications_total`, kind: 'counter',
        help: 'Notification attempts by outcome. `blocked` is a destination refused by the SSRF check.',
        samples: (['delivered', 'failed', 'blocked', 'skipped'] as const)
          .map((outcome) => ({ labels: { outcome }, value: s.alerts!.notify[outcome] })) },
    );
  }
  return metrics;
}
