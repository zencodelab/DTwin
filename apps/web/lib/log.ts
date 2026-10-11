/**
 * Structured logging for the web service: an event name and fields, one JSON
 * line per record, never a sentence (docs/decisions.md §61).
 *
 * A minimal port of ingest's logger (`apps/ingest/src/log.ts`), without the
 * request-scoped context it carries: the web service has no request id to
 * propagate yet. The two rules that matter are the same:
 *
 * - `event` is a stable identifier that never contains a value
 *   (`copilot.apply_refused`). Everything variable is a named field.
 * - Fields are scalars. An object or an Error is not accepted here, because
 *   the way a secret reaches a log file is almost always "log the whole
 *   thing": an SDK error's message can carry a key prefix or a request id,
 *   and a model message can carry anything. Log a name and a count instead.
 *
 * JSON output escapes newlines by construction, so a field containing
 * `\n{"level":"info"` cannot forge a second record.
 */

export type LogFields = Record<string, string | number | boolean | null>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

type Level = 'info' | 'warn' | 'error';

function emit(level: Level, event: string, fields: LogFields): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, service: 'web', event, ...fields });
  // stdout below `warn`, stderr from it: a container runtime separates the
  // two, and an operator grepping stderr wants problems only.
  if (level === 'info') console.log(line);
  else console.error(line);
}

export const log: Logger = {
  info: (event, fields = {}) => emit('info', event, fields),
  warn: (event, fields = {}) => emit('warn', event, fields),
  error: (event, fields = {}) => emit('error', event, fields),
};

/** A logger that records instead of printing, for tests. */
export function memoryLogger(): Logger & { records: Array<{ level: Level; event: string; fields: LogFields }> } {
  const records: Array<{ level: Level; event: string; fields: LogFields }> = [];
  const push = (level: Level) => (event: string, fields: LogFields = {}) => { records.push({ level, event, fields }); };
  return { records, info: push('info'), warn: push('warn'), error: push('error') };
}
