import { describe, expect, it } from 'vitest';
import { ingestMetrics, renderMetrics, type IngestSnapshot } from './metrics.ts';

const snapshot: IngestSnapshot = {
  ready: true, uptimeS: 12.5, sensors: 190,
  writer: { written: 1000, dropped: 3, flushes: 10, failedFlushes: 1, buffered: 7, lastFlushMs: null },
  fanout: {
    framesSent: 40, readingsSent: 900, framesSkipped: 2, backloggedClosed: 1,
    subscribesDenied: 0, subscribers: 3, authenticated: 2, topics: 4,
  },
  alerts: {
    rules: 7, live: 1, opened: 5, resolved: 4, suppressedByCooldown: 2,
    notify: { delivered: 3, failed: 1, blocked: 1, skipped: 0 },
  },
  limits: {
    readings: { keys: 2, refused: 9, overflowed: 0 },
    authFailures: { keys: 1, refused: 4, overflowed: 0 },
  },
};

describe('renderMetrics', () => {
  const text = renderMetrics(ingestMetrics(snapshot));
  const lines = text.trimEnd().split('\n');

  it('ends with a newline, which the exposition format requires', () => {
    expect(text.endsWith('\n')).toBe(true);
  });

  it('declares HELP and TYPE exactly once per metric, before its samples', () => {
    const types = lines.filter((l) => l.startsWith('# TYPE ')).map((l) => l.split(' ')[2]);
    expect(new Set(types).size).toBe(types.length);
    for (const name of types) {
      const help = lines.indexOf(lines.find((l) => l.startsWith(`# HELP ${name} `))!);
      const firstSample = lines.findIndex((l) => l.startsWith(`${name} `) || l.startsWith(`${name}{`));
      expect(help).toBeGreaterThanOrEqual(0);
      expect(firstSample).toBeGreaterThan(help);
    }
  });

  it('writes every sample line in a form a scraper parses', () => {
    const sample = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[a-zA-Z_][a-zA-Z0-9_]*="[^"]*"(,[a-zA-Z_][a-zA-Z0-9_]*="[^"]*")*\})? (NaN|[+-]Inf|-?\d+(\.\d+)?(e[+-]?\d+)?)$/;
    for (const line of lines.filter((l) => !l.startsWith('#'))) expect(line).toMatch(sample);
  });

  it('carries the numbers through, labelled', () => {
    expect(lines).toContain('dtwin_ingest_readings_dropped_total 3');
    expect(lines).toContain('dtwin_ingest_ws_backlogged_closed_total 1');
    expect(lines).toContain('dtwin_ingest_rate_limit_refused_total{limiter="readings"} 9');
    expect(lines).toContain('dtwin_ingest_ws_connections{state="unauthenticated"} 1');
    expect(lines).toContain('dtwin_ingest_notifications_total{outcome="blocked"} 1');
  });

  it('reports a duration that does not exist yet as NaN, not as zero', () => {
    expect(lines).toContain('dtwin_ingest_writer_last_flush_milliseconds NaN');
  });

  it('omits the alert series entirely when the engine is disabled, rather than reporting zeros', () => {
    const without = renderMetrics(ingestMetrics({ ...snapshot, alerts: null }));
    expect(without).not.toContain('dtwin_ingest_alerts_');
    expect(without).toContain('dtwin_ingest_readings_written_total 1000');
  });

  it('carries no tenant in any label — the endpoint is served without a key', () => {
    // Sample lines only: the help text is free to SAY "across all tenants".
    for (const line of lines.filter((l) => !l.startsWith('#'))) expect(line).not.toMatch(/tenant/i);
  });

  it('escapes label values and help text', () => {
    const out = renderMetrics([{
      name: 'x_total', kind: 'counter', help: 'line one\nline two \\ done',
      samples: [{ labels: { path: 'a"b\\c\nd' }, value: 1 }],
    }]);
    expect(out).toContain('# HELP x_total line one\\nline two \\\\ done');
    expect(out).toContain('x_total{path="a\\"b\\\\c\\nd"} 1');
  });

  it('refuses what a scraper would reject for the whole payload', () => {
    const m = (name: string, kind: 'counter' | 'gauge' = 'gauge') =>
      ({ name, kind, help: 'h', samples: [{ value: 1 }] });
    expect(() => renderMetrics([m('a'), m('a')])).toThrow(/duplicate/);
    expect(() => renderMetrics([m('9lives')])).toThrow(/invalid metric name/);
    expect(() => renderMetrics([m('requests', 'counter')])).toThrow(/_total/);
    expect(() => renderMetrics([{ ...m('a'), samples: [{ labels: { 'bad-label': 'x' }, value: 1 }] }]))
      .toThrow(/invalid label/);
  });
});
