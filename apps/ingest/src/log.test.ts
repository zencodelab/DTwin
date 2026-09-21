import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindRequestTenant, configureLogging, currentRequest, log, requestIdFrom, withRequest,
} from './log.ts';

function captured(fn: () => void): string[] {
  const lines: string[] = [];
  const out = vi.spyOn(console, 'log').mockImplementation((l: string) => { lines.push(l); });
  const err = vi.spyOn(console, 'error').mockImplementation((l: string) => { lines.push(l); });
  try { fn(); } finally { out.mockRestore(); err.mockRestore(); }
  return lines;
}

const records = (fn: () => void) =>
  captured(fn).map((l) => JSON.parse(l) as Record<string, unknown>);

afterEach(() => configureLogging({ level: 'info', format: 'json' }));

describe('requestIdFrom', () => {
  it('keeps a caller id, which is what makes a trace span services', () => {
    expect(requestIdFrom('abc-123_XY.z')).toBe('abc-123_XY.z');
  });

  it('replaces anything that could forge a log line or escape a terminal', () => {
    const hostile = [
      'a\nb',                    // a second log line
      'a b',                     // breaks a whitespace-delimited parse
      'a"b',                     // breaks a naive JSON reader
      '[31mred',           // ANSI, in a terminal tailing the log
      '../../etc/passwd',
      'x'.repeat(65),            // unbounded growth, one field at a time
      '',
      undefined,
    ];
    for (const value of hostile) {
      expect(requestIdFrom(value)).not.toBe(value);
      expect(requestIdFrom(value)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('takes the first value when the header arrives repeated', () => {
    expect(requestIdFrom(['first-id', 'second-id'])).toBe('first-id');
  });
});

describe('log', () => {
  it('writes one JSON object per line, with the event separate from the prose', () => {
    const [r] = records(() => log.info('ingest.batch_accepted', { accepted: 42, source: 'gw-1' }));
    expect(r).toMatchObject({
      level: 'info', service: 'ingest', event: 'ingest.batch_accepted',
      accepted: 42, source: 'gw-1',
    });
    expect(Date.parse(r!.ts as string)).not.toBeNaN();
  });

  it('carries the request id through an await, without being passed one', async () => {
    const seen = await withRequest({ requestId: 'req-1', route: 'POST /ingest' }, async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      return records(() => log.warn('deep.thing'));
    });
    expect(seen[0]).toMatchObject({ requestId: 'req-1', route: 'POST /ingest' });
  });

  it('adds the tenant to the context already running, not a nested one', () => {
    withRequest({ requestId: 'req-2' }, () => {
      const before = records(() => log.info('before.auth'))[0]!;
      bindRequestTenant('tenant-a');
      const after = records(() => log.info('after.auth'))[0]!;
      expect(before.tenantId).toBeUndefined();
      expect(after.tenantId).toBe('tenant-a');
      expect(currentRequest()?.requestId).toBe('req-2');
    });
  });

  it('logs without a request context rather than failing — timers have none', () => {
    const [r] = records(() => log.info('sweep.ran'));
    expect(r).toMatchObject({ event: 'sweep.ran' });
    expect(r!.requestId).toBeUndefined();
  });

  it('cannot be tricked into forging a second record', () => {
    const lines = captured(() => log.info('x', { note: '\n{"level":"error","event":"forged"}' }));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).note).toContain('forged');
  });

  it('turns an Error into fields and keeps the stack out of the message', () => {
    const [r] = records(() =>
      log.error('alert.open_failed', new TypeError('bad thing'), { rule: 'r1' }));
    expect(r).toMatchObject({ errorName: 'TypeError', error: 'bad thing', rule: 'r1' });
    expect(r!.stack).toContain('TypeError: bad thing');
  });

  it('handles a thrown non-Error, which a rejected promise can be', () => {
    const [r] = records(() => log.error('odd', 'just a string'));
    expect(r).toMatchObject({ error: 'just a string' });
  });

  it('sends warn and error to stderr, and the rest to stdout', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    log.info('a'); log.warn('b'); log.error('c');
    expect(out).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(2);
    out.mockRestore(); err.mockRestore();
  });

  it('drops records below the configured level', () => {
    configureLogging({ level: 'warn' });
    expect(records(() => log.info('quiet'))).toHaveLength(0);
    expect(records(() => log.error('loud'))).toHaveLength(1);
  });

  it('writes a readable line in text mode, without the stack', () => {
    configureLogging({ format: 'text' });
    const [line] = captured(() => withRequest({ requestId: 'abcdef0123' }, () =>
      log.error('boom', new Error('nope'), { zone: 'z1' })));
    expect(line).toContain('ERROR boom');
    expect(line).toContain('[abcdef01]');
    expect(line).toContain('zone=z1');
    expect(line).not.toContain('at Object');
  });
});
