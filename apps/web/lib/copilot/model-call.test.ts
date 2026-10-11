import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { realModelCaller } from './model.ts';
import { BudgetError, RunRegistry, type ModelCallOptions, type ModelCaller } from './registry.ts';
import { stop, threadRunning } from './session.ts';
import { composeMsg, plannerMsg } from './testing/fakes.ts';
import { harness } from './testing/run.ts';

/**
 * A model call in flight is bounded by Stop and by the request's deadline
 * (review, ADR 64). Both used to be checked only BEFORE a call: a stalled one
 * ran on the SDK's defaults — ten minutes an attempt, retried twice — holding
 * the thread's lock throughout, while Stop answered "stopping" and did
 * nothing.
 */

const PARAMS = {
  model: 'claude-opus-5', max_tokens: 16_000, messages: [{ role: 'user', content: 'hello' }],
} as Anthropic.MessageCreateParamsNonStreaming;

/** A model that never answers, and remembers what it was handed. */
function stalled() {
  const seen: Array<ModelCallOptions | undefined> = [];
  const call: ModelCaller = (_params, options) => {
    seen.push(options);
    return new Promise(() => {});
  };
  return { call, seen };
}

const reasonOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof BudgetError ? e.reason : String(e)));

afterEach(() => { vi.useRealTimers(); });

describe('a model call in flight', () => {
  it('is aborted by Stop, and the SDK is handed the signal and the time left', async () => {
    const reg = new RunRegistry({ clock: () => Date.parse('2026-09-28T08:40:00Z') });
    reg.begin('t', 'r1');
    const model = stalled();
    const call = reasonOf(reg.call('t', 'planner', model.call, PARAMS));
    expect(model.seen[0]?.signal.aborted).toBe(false);
    expect(model.seen[0]?.timeout).toBe(300_000);

    expect(reg.stop('t')).toBe(true);
    expect(await call).toBe('stopped');
    expect(model.seen[0]!.signal.aborted).toBe(true);
  });

  it('is aborted at the request\'s deadline, not left to the SDK\'s own ten minutes', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-28T08:40:00Z') });
    const reg = new RunRegistry({ clock: Date.now });
    reg.begin('t', 'r1');
    vi.advanceTimersByTime(250_000);
    const model = stalled();
    const call = reasonOf(reg.call('t', 'compose', model.call, PARAMS));
    expect(model.seen[0]?.timeout).toBe(50_000);
    vi.advanceTimersByTime(50_000);
    expect(await call).toBe('deadline');
  });

  it('through the real SDK: Stop ends the HTTP request itself', async () => {
    // A server that takes the request and never answers: a stalled API.
    const arrived: IncomingMessage[] = [];
    let closed = false;
    const server = createServer((req) => {
      arrived.push(req);
      req.socket.on('close', () => { closed = true; });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as AddressInfo).port;
    const env = { ...process.env };
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-a-key';
    try {
      const reg = new RunRegistry();
      reg.begin('t', 'r1');
      const call = reasonOf(reg.call('t', 'planner', realModelCaller(), PARAMS));
      await vi.waitFor(() => expect(arrived).toHaveLength(1), { timeout: 5_000 });
      // The time left of the request's deadline, not the SDK's default 600 s.
      const timeoutS = Number(arrived[0]!.headers['x-stainless-timeout']);
      expect(timeoutS).toBeGreaterThan(290);
      expect(timeoutS).toBeLessThanOrEqual(300);

      reg.stop('t');
      expect(await call).toBe('stopped');
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5_000 });
      expect(arrived).toHaveLength(1);   // not retried
    } finally {
      process.env = env;
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  });

  it('in the graph: Stop ends a run whose planner call stalled, says so, and frees the thread', async () => {
    const h = harness({
      planner: [() => new Promise<Anthropic.Message>(() => {}), plannerMsg({ next: 'finish', intent: 'clarify', message: 'Which zone?' })],
      compose: [composeMsg({ paragraphs: [{ segments: [{ kind: 'text', text: 'never asked' }] }], caveats: [] })],
    });
    const run = h.send('stall', 'why is OFF-305 warm');
    await vi.waitFor(() => expect(h.fake.model.count('planner')).toBe(1));
    expect(threadRunning(h.graph, 'stall')).toBe(true);

    expect(stop(h.graph, 'stall')).toBe(true);
    const { turn } = await run;
    expect(turn.notices.map((n) => n.code)).toContain('stopped');
    expect(threadRunning(h.graph, 'stall')).toBe(false);

    const next = await h.send('stall', 'and now?');
    expect(next.turn.message).toBe('Which zone?');
  });
});
