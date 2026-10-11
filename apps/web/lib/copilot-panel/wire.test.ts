import { describe, expect, it } from 'vitest';
import { CopilotTurn } from '../copilot/protocol.ts';
import { planFixture, turnFixture } from './fixtures.ts';
import { LineSplitter, errorText, parseTurn, readEvents } from './wire.ts';

/**
 * The panel's reading of the wire: NDJSON split correctly whatever the chunk
 * boundaries, unknown or malformed lines dropped rather than cast, a JSON
 * turn read without top-level fields it does not declare, and refusals in
 * words.
 */

const enc = new TextEncoder();

/** A body that delivers exactly these byte chunks, then (optionally) fails. */
function body(chunks: Uint8Array[], failAfter = false): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else if (failAfter) controller.error(new Error('socket hang up'));
      else controller.close();
    },
  });
}

/** Cut bytes at the given offsets. */
function cut(bytes: Uint8Array, at: number[]): Uint8Array[] {
  const points = [0, ...at, bytes.length];
  return points.slice(1).map((end, i) => bytes.slice(points[i]!, end)).filter((c) => c.length > 0);
}

describe('LineSplitter', () => {
  it('rejoins a line split across pushes, tolerates \\r\\n and skips blank lines', () => {
    const s = new LineSplitter();
    expect(s.push('{"t":"pi')).toEqual([]);
    expect(s.push('ng"}\r\n\n{"t":"accepted",')).toEqual(['{"t":"ping"}']);
    expect(s.push('"requestId":null}\n')).toEqual(['{"t":"accepted","requestId":null}']);
    expect(s.end()).toEqual([]);
  });

  it('hands over a last line with no newline at the end', () => {
    const s = new LineSplitter();
    expect(s.push('{"t":"ping"}')).toEqual([]);
    expect(s.end()).toEqual(['{"t":"ping"}']);
  });

  it('drops an oversized line, and its tail, but keeps the next line', () => {
    const s = new LineSplitter(10);
    expect(s.push('x'.repeat(8))).toEqual([]);
    expect(s.push('x'.repeat(8))).toEqual([]); // past the cap: discarded
    expect(s.push('xxx\nshort\n')).toEqual(['short']);
    expect(s.push('y'.repeat(20))).toEqual([]);
    expect(s.end()).toEqual([]);
  });
});

describe('readEvents', () => {
  it('reads every event whatever the chunk boundaries, including mid-character', async () => {
    const turn = turnFixture({ interpretation: 'since nine, in the building’s time' });
    const lines = [
      { t: 'accepted', requestId: 'req-1' },
      { t: 'step', node: 'intake' },
      { t: 'activity', taskId: 'T1', tool: 'zone_conditions', label: 'reading conditions for OFF-305 — °C' },
      { t: 'turn', turn },
    ].map((e) => JSON.stringify(e)).join('\n');
    const bytes = enc.encode(`${lines}\n`);
    // Cut inside the multi-byte '°' and '’' as well as at arbitrary places.
    const degree = bytes.findIndex((b, i) => b === 0xc2 && bytes[i + 1] === 0xb0);
    const chunks = cut(bytes, [3, degree + 1, degree + 5, bytes.length - 7].sort((a, b) => a - b));
    const got: unknown[] = [];
    const batches: number[] = [];
    const end = await readEvents(body(chunks), (events) => { batches.push(events.length); got.push(...events); });
    expect(end).toBe('turn');
    expect(got).toEqual([
      { t: 'accepted', requestId: 'req-1' },
      { t: 'step', node: 'intake' },
      { t: 'activity', taskId: 'T1', tool: 'zone_conditions', label: 'reading conditions for OFF-305 — °C' },
      { t: 'turn', turn },
    ]);
    // One call per chunk that completed a line, never one per empty chunk.
    expect(batches.every((n) => n > 0)).toBe(true);
  });

  it('drops unknown events, bad JSON and off-schema lines, and reads on', async () => {
    const text = [
      '{"t":"thinking","text":"secret"}',
      'not json',
      '{"t":"step","node":"not_a_node"}',
      '{"t":"step","node":"orient","extra":1}',
      '{"t":"error","error":"the copilot could not complete this turn","requestId":"r"}',
    ].join('\n');
    const got: unknown[] = [];
    const end = await readEvents(body([enc.encode(text)]), (events) => got.push(...events));
    expect(got).toEqual([{ t: 'error', error: 'the copilot could not complete this turn', requestId: 'r' }]);
    expect(end).toBe('error');
  });

  it('a stream that ends, or breaks, without a turn or error is lost — and keeps what arrived whole', async () => {
    const got: unknown[] = [];
    const end = await readEvents(body([enc.encode('{"t":"ping"}\n{"t":"step","node":"orient"}\n{"t":"st')], true),
      (events) => got.push(...events));
    expect(end).toBe('lost');
    expect(got).toEqual([{ t: 'ping' }, { t: 'step', node: 'orient' }]);
  });
});

describe('parseTurn', () => {
  it('reads a turn and strips top-level fields it does not declare (v1\'s messages/notice, say)', () => {
    const turn = turnFixture({ pendingPlan: planFixture() });
    const legacy = { ...turn, messages: [{ role: 'user', content: 'x' }], notice: 'old', model: 'm' };
    expect(parseTurn(legacy)).toEqual(turn);
    expect(CopilotTurn.safeParse(legacy).success).toBe(false); // the strict schema would have refused it
  });

  it('stays strict below the top level, and refuses what is not a turn', () => {
    const turn = turnFixture({ pendingPlan: { ...planFixture(), extra: true } as never });
    expect(parseTurn(turn)).toBeNull();
    expect(parseTurn({ error: 'nope' })).toBeNull();
    expect(parseTurn(null)).toBeNull();
  });
});

describe('errorText', () => {
  it('turns the route\'s codes into words, passes its sentences through, and names a bare status', () => {
    expect(errorText(409, { error: 'plan_expired' })).toMatch(/expired.*nothing was issued/);
    expect(errorText(409, { error: 'nothing awaiting approval' })).toMatch(/nothing was issued/);
    expect(errorText(409, { error: 'a request on this thread is still running' })).toBe('a request on this thread is still running');
    expect(errorText(502, null)).toBe('The copilot answered 502.');
    expect(errorText(500, { error: '' })).toBe('The copilot answered 500.');
  });
});
