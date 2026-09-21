import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Structured logging, and a request id that survives an await.
 *
 * What was here before was `console.error('[alerts] failed to open', name, err)`.
 * A person can read that. Nothing else can: the interesting values are
 * interpolated into prose, so there is no field to filter on, no way to count
 * how often a thing happened without a regex over free text, and — the one
 * that matters at three in the morning — no way to select the lines belonging
 * to the request that went wrong out of every other request interleaved with
 * it.
 *
 * Two ideas fix that, and they are separate:
 *
 * 1. **An event name, and fields.** `event` is a stable identifier that never
 *    contains a value (`alert.open_failed`), and everything variable is a
 *    named field. Aggregation keys on the event; the prose is for the human
 *    reading one line. Change the wording freely, never the event.
 *
 * 2. **A request id carried out of band.** `AsyncLocalStorage` keeps it
 *    attached to the logical request across every `await` and callback, so it
 *    does not have to be threaded through the signature of every function that
 *    might log. Code deep in the pipeline logs it without knowing it exists.
 *
 * Log injection is handled at the two places it can happen. The id is
 * sanitised at the boundary (a caller supplies it), and JSON output escapes
 * newlines by construction — a field containing `\n{"level":"info"` cannot
 * forge a second record. Text output exists for a human watching a dev server
 * and is not what a machine reads.
 *
 * **Never log a secret.** No API keys, no session tokens, no ticket payloads,
 * no passwords. An api key's ID is fine and is what the audit trail wants; the
 * key itself must not reach a log file, where it outlives every rotation.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface RequestContext {
  requestId: string;
  /** Filled once the request authenticates; absent before that, and on 401s. */
  tenantId?: string;
  route?: string;
}

const store = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with a request context every log call inside it will pick up. */
export function withRequest<T>(ctx: RequestContext, fn: () => T): T {
  return store.run(ctx, fn);
}

export function currentRequest(): RequestContext | undefined {
  return store.getStore();
}

/**
 * Attach the tenant once it is known.
 *
 * Mutates the active context rather than nesting another one: authentication
 * happens inside the handler, and re-entering `withRequest` there would mean
 * every route body indenting into a callback for the sake of one field.
 */
export function bindRequestTenant(tenantId: string): void {
  const ctx = store.getStore();
  if (ctx) ctx.tenantId = tenantId;
}

/**
 * A caller-supplied id, made safe, or a fresh one.
 *
 * Accepting a client's id is what makes a trace span services — the dashboard,
 * the worker and this service can all report the same request. Accepting it
 * *unchecked* would let a caller choose what appears in our logs, so it is
 * bounded and restricted to characters that cannot break a log line or a
 * terminal. Anything else is replaced rather than rejected: the id is
 * diagnostic, and failing a telemetry POST over a malformed header would be a
 * poor trade.
 */
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function requestIdFrom(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && SAFE_ID.test(value) ? value : randomUUID();
}

let threshold = LEVELS.info;
let format: 'json' | 'text' = 'json';

export function configureLogging(options: { level?: LogLevel; format?: 'json' | 'text' }): void {
  if (options.level) threshold = LEVELS[options.level];
  if (options.format) format = options.format;
}

/** An Error as fields. The stack belongs in a log and never in a response. */
function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { errorName: err.name, error: err.message, stack: err.stack };
  }
  return { error: String(err) };
}

function emit(level: LogLevel, event: string, fields: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;

  const ctx = store.getStore();
  const record = {
    ts: new Date().toISOString(),
    level,
    service: 'ingest',
    event,
    ...(ctx ? { requestId: ctx.requestId, tenantId: ctx.tenantId, route: ctx.route } : {}),
    ...fields,
  };

  const line = format === 'json'
    ? JSON.stringify(record)
    : `${record.ts} ${level.toUpperCase().padEnd(5)} ${event}${
      ctx ? ` [${ctx.requestId.slice(0, 8)}]` : ''
    }${fieldsToText(fields)}`;

  // stdout for everything below `warn`, stderr above: a container runtime
  // separates the two, and an operator grepping stderr wants problems only.
  if (LEVELS[level] >= LEVELS.warn) console.error(line);
  else console.log(line);
}

function fieldsToText(fields: Record<string, unknown>): string {
  const parts = Object.entries(fields)
    .filter(([key]) => key !== 'stack')
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

export const log = {
  debug: (event: string, fields: Record<string, unknown> = {}) => emit('debug', event, fields),
  info: (event: string, fields: Record<string, unknown> = {}) => emit('info', event, fields),
  warn: (event: string, fields: Record<string, unknown> = {}) => emit('warn', event, fields),
  error: (event: string, err?: unknown, fields: Record<string, unknown> = {}) =>
    emit('error', event, { ...(err === undefined ? {} : errorFields(err)), ...fields }),
};
