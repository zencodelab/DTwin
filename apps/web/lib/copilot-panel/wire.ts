import { CopilotTurn, parseEvent, type CopilotEvent } from '../copilot/protocol.ts';

/**
 * The panel's side of the copilot's wire (docs/decisions.md §64, design
 * §9.1–9.2): reading an NDJSON answer line by line, reading a JSON turn, and
 * turning a refusal into words. Pure apart from reading the stream it is
 * handed — no React, no fetch.
 *
 * Every line goes through the protocol's own `parseEvent`, the same schemas
 * the server parsed it through before writing it. A line that is not JSON,
 * names an event this build does not know, or does not match its schema is
 * dropped, not cast: a newer route talking to an older panel skips what the
 * panel cannot draw.
 */

export const NDJSON = 'application/x-ndjson';

/**
 * A line longer than this is not an event this protocol writes (a whole turn
 * with sixty evidence cards is tens of kilobytes). It is dropped rather than
 * buffered without bound, and so is the rest of it up to its newline.
 */
export const MAX_LINE_CHARS = 4 * 1024 * 1024;

/**
 * Splits text that arrives in arbitrary pieces into whole lines. A chunk can
 * end mid-line — and, before decoding, mid-character — so the tail is carried
 * to the next push. `\r\n` is tolerated; blank lines are skipped.
 */
export class LineSplitter {
  private carry = '';
  private discarding = false;

  constructor(private readonly maxChars = MAX_LINE_CHARS) {}

  push(text: string): string[] {
    const parts = (this.carry + text).split('\n');
    this.carry = parts.pop()!;
    const lines: string[] = [];
    for (const part of parts) {
      if (this.discarding) { this.discarding = false; continue; } // the tail of an oversized line
      const line = part.endsWith('\r') ? part.slice(0, -1) : part;
      if (line.trim() !== '' && line.length <= this.maxChars) lines.push(line);
    }
    if (this.carry.length > this.maxChars) { this.carry = ''; this.discarding = true; }
    return lines;
  }

  /** The last line, if the stream ended without a newline after it. */
  end(): string[] {
    const last = this.discarding ? '' : this.carry.replace(/\r$/, '');
    this.carry = '';
    this.discarding = false;
    return last.trim() === '' ? [] : [last];
  }
}

/** How a stream ended: with the run's turn, with the run's error, or with neither (the connection went). */
export type StreamEnd = 'turn' | 'error' | 'lost';

/**
 * Read an NDJSON body to its end, handing each chunk's events over as one
 * batch (the caller coalesces batches per animation frame). No `for await`:
 * the web tsconfig has no DOM.AsyncIterable, so this is the reader loop.
 *
 * Never throws for a dropped connection — that is `lost`, and the run it was
 * following carries on server-side (the route does not abort on disconnect),
 * so the caller rehydrates rather than reporting a failure.
 */
export async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvents: (events: CopilotEvent[]) => void,
): Promise<StreamEnd> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const lines = new LineSplitter();
  let end: StreamEnd = 'lost';
  const hand = (texts: string[]) => {
    const events: CopilotEvent[] = [];
    for (const text of texts) {
      const e = parseEvent(text);
      if (!e) continue;
      events.push(e);
      if (e.t === 'turn') end = 'turn';
      else if (e.t === 'error' && end !== 'turn') end = 'error';
    }
    if (events.length > 0) onEvents(events);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hand(lines.push(decoder.decode(value, { stream: true })));
    }
    hand(lines.push(decoder.decode()));
    hand(lines.end());
  } catch {
    // A reset connection. Whatever arrived whole has been handed over.
    hand(lines.end());
  } finally {
    reader.releaseLock();
  }
  return end;
}

/**
 * A turn from a JSON body (`GET ?threadId`, or the JSON answer to a POST).
 * Unknown top-level fields are stripped before the strict parse — a server a
 * release behind this page carried v1's `messages`/`notice` beside the turn,
 * and one a release ahead may add a field this panel does not read — but
 * everything the turn does declare is checked as strictly as a streamed turn
 * is. Null if it is not a turn.
 */
export function parseTurn(body: unknown): CopilotTurn | null {
  const parsed = CopilotTurn.strip().safeParse(body);
  return parsed.success ? parsed.data : null;
}

/** The route's refusals that are codes rather than sentences, in words. */
const CODES: Readonly<Record<string, string>> = {
  plan_expired: 'That plan expired before your decision reached it, so nothing was issued. Ask again for a fresh plan.',
  'nothing awaiting approval': 'Nothing on this conversation is awaiting approval any more, so nothing was issued.',
};

/**
 * What to show for a response that is not a turn. The route's `error` is
 * already written for a person (or is one of the codes above); a body
 * without one gets the status, not a guess at the cause.
 */
export function errorText(status: number, body: unknown): string {
  const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  if (typeof error === 'string' && error.trim() !== '') return CODES[error] ?? error;
  return `The copilot answered ${status}.`;
}
