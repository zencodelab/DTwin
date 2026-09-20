import { z } from 'zod';

/**
 * Environment is parsed once, at boot, through a schema — the same rule the
 * rest of the system applies to telemetry. A service that starts with a
 * malformed flush interval and only misbehaves under load is worse than one
 * that refuses to start.
 */
const Env = z.object({
  INGEST_PORT: z.coerce.number().int().positive().default(8787),

  /** Buffered writes flush on whichever limit trips first. */
  INGEST_FLUSH_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  INGEST_FLUSH_MAX_ROWS: z.coerce.number().int().positive().default(5000),
  /**
   * Hard cap on the write buffer. If the database is unreachable the buffer
   * would otherwise grow without bound until the process is OOM-killed, taking
   * the live stream down with it. Past this, the oldest readings are dropped
   * and counted — losing old samples beats losing the service.
   */
  INGEST_BUFFER_MAX_ROWS: z.coerce.number().int().positive().default(100_000),

  /** Outbound frames are coalesced over this window, per topic. */
  INGEST_FANOUT_INTERVAL_MS: z.coerce.number().int().positive().default(250),
  /**
   * If a client's socket has more than this queued, skip its next frame rather
   * than queueing another. A slow consumer must not become the server's memory
   * problem, and stale telemetry has no value once newer data exists.
   */
  INGEST_CLIENT_BUFFER_MAX_BYTES: z.coerce.number().int().positive().default(1_000_000),

  /** Registry refresh, so newly provisioned points appear without a restart. */
  INGEST_REGISTRY_REFRESH_MS: z.coerce.number().int().positive().default(60_000),
  /** How long a missing external id is remembered before it is looked up again. */
  INGEST_UNKNOWN_RETRY_MS: z.coerce.number().int().positive().default(30_000),

  /** Largest accepted request body. A batch endpoint needs a stated ceiling. */
  INGEST_MAX_BODY_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024),
  /**
   * How long a socket may stay open before presenting a ticket. Long enough for
   * a browser to fetch one, short enough that an unauthenticated connection is
   * not a free file descriptor.
   */
  INGEST_AUTH_GRACE_MS: z.coerce.number().int().positive().default(10_000),

  /**
   * How far ahead of this server's clock a reading's timestamp may be.
   *
   * Not a plausibility nicety. A row dated ahead of now leaves the continuous
   * aggregates' materialisation watermark ahead of now when the refresh policy
   * next runs, and real-time aggregation only covers buckets at or after it —
   * so every subsequent reading is in the hypertable and invisible in the
   * rollups, for EVERY tenant sharing them, until a later refresh heals it.
   * One gateway with a skewed clock can blank the dashboard's history for
   * everyone. See docs/decisions.md §46.
   *
   * A tolerance rather than zero, because a device clock that is a few seconds
   * fast is normal and rejecting it would be its own outage.
   */
  INGEST_MAX_CLOCK_SKEW_MS: z.coerce.number().int().positive().default(60_000),

  ALERT_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /**
   * How often windowed conditions (flatline, no_data, rate_of_change) are
   * re-checked. These are statements about elapsed time, so nothing arrives to
   * trigger them — `no_data` is by definition the absence of an event.
   */
  ALERT_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  /** Reload rules so edits take effect without a restart. */
  ALERT_REFRESH_MS: z.coerce.number().int().positive().default(60_000),

  /**
   * Notification delivery is off by default. Sending is outward-facing, and a
   * development database seeded with someone's real webhook must not start
   * calling it just because the service booted.
   */
  ALERT_NOTIFY_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  ALERT_NOTIFY_RETRY_MS: z.coerce.number().int().positive().default(60_000),
  ALERT_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  /**
   * How long a claimed notification stays claimed before another worker may
   * take it. Long enough to cover a slow webhook plus its timeout, short
   * enough that a worker which died mid-delivery does not hold its rows for
   * minutes. See docs/decisions.md §51.
   */
  ALERT_NOTIFY_LEASE_MS: z.coerce.number().int().positive().default(60_000),
  /** Rows one worker takes per sweep. Bounds the blast radius of a slow batch. */
  ALERT_NOTIFY_BATCH: z.coerce.number().int().positive().default(50),

  /**
   * SMTP transport for the email channel, as a URL:
   * `smtp://user:pass@host:587` or `smtps://…` for implicit TLS.
   *
   * Absent, email destinations continue to record `failed` with "no email
   * transport configured" — which is the honest answer to "was anyone told?",
   * and better than a channel that looks wired and is not.
   */
  ALERT_SMTP_URL: z.string().url().optional(),
  /** Envelope sender. Required once ALERT_SMTP_URL is set; most relays reject a missing From. */
  ALERT_EMAIL_FROM: z.string().optional(),
  ALERT_EMAIL_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  ALERT_WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  /**
   * Webhook destinations that resolve to private or loopback addresses are
   * blocked, so an operator-supplied URL cannot turn this service into a proxy
   * onto the internal network. Enable only to test against a local receiver.
   */
  ALERT_WEBHOOK_ALLOW_PRIVATE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),

  /**
   * Signing key for WebSocket tickets, shared with the web service.
   *
   * Required, with no development default. A fallback secret that works locally
   * is a fallback secret that reaches production, and this one is all that
   * stands between a stranger and a tenant's live telemetry stream.
   */
  AUTH_SECRET: z.string().min(32,
    'AUTH_SECRET must be at least 32 characters and identical in the web service'),

  /**
   * `INGEST_INTERNAL_TOKEN` is GONE. The simulation worker now authenticates to
   * /internal/sim-event with a `service` API key, like any other caller.
   *
   * A single shared secret could say "this request is from something inside our
   * network" and nothing more. Once events carry a tenant, that is not enough:
   * the endpoint fans a payload out to a tenant's subscribers, so it has to know
   * WHICH tenant is asking, and a bearer token scoped to one tenant answers that
   * where a global secret cannot.
   */

  SIM_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  SIM_TICK_MS: z.coerce.number().int().positive().default(1000),
  /**
   * Sensors are sampled at their own `sample_interval_s` divided by this. A
   * 60-second point at speedup 10 reports every 6 seconds. Timestamps stay real
   * wall-clock time — only the sampling rate is accelerated, so the time axis
   * on every chart remains honest.
   */
  SIM_SPEEDUP: z.coerce.number().positive().default(10),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(): Config {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`invalid ingest configuration:\n${detail}`);
  }
  return parsed.data;
}
