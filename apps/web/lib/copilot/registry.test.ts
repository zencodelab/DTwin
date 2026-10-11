import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { BudgetError, MAX_CACHE_BREAKPOINTS, RunRegistry, requestShapeError, type ModelCaller } from './registry.ts';
import { DEFAULT_LIMITS } from './limits.ts';

const T0 = Date.parse('2026-09-28T08:40:00Z');

function clock(start = T0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

const PARAMS = { model: 'fake', max_tokens: 16_000, messages: [] } as Anthropic.MessageCreateParamsNonStreaming;

/** A model that answers after a delay, counting how often it was really called. */
function slowModel(delayMs = 5) {
  let calls = 0;
  const call: ModelCaller = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, delayMs));
    return { id: `msg_${calls}` } as Anthropic.Message;
  };
  return { call, get calls() { return calls; } };
}

async function reasonOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof BudgetError ? e.reason : `other: ${String(e)}`;
  }
}

describe('RunRegistry: the model-call budget', () => {
  it('holds across Promise.all: ten parallel calls against a budget of six make six', async () => {
    const reg = new RunRegistry({ limits: { maxModelCalls: 6 }, clock: clock().now });
    const model = slowModel();
    reg.begin('t', 'r1');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => reasonOf(reg.call('t', i % 2 ? 'diagnose' : 'analyse', model.call, PARAMS))),
    );
    expect(model.calls).toBe(6);
    expect(results.filter((r) => r === null)).toHaveLength(6);
    expect(results.filter((r) => r === 'budget')).toHaveLength(4);
    expect(reg.usage('t')).toEqual({
      modelCalls: 6,
      byRole: { planner: 0, compose: 0, diagnose: 3, analyse: 3, simulate: 0, control: 0 },
      simRuns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
  });

  it('is per request, not per thread: every new message gets a fresh budget', async () => {
    const reg = new RunRegistry({ limits: { maxModelCalls: 5 }, clock: clock().now });
    const model = slowModel(0);
    for (const requestId of ['r1', 'r2', 'r3']) {
      reg.begin('t', requestId);
      for (let i = 0; i < 5; i += 1) await reg.call('t', 'planner', model.call, PARAMS);
      expect(await reasonOf(reg.call('t', 'planner', model.call, PARAMS))).toBe('budget');
      expect(reg.requestId('t')).toBe(requestId);
    }
    expect(model.calls).toBe(15);
  });

  it('spends a call that then fails at the API', async () => {
    const reg = new RunRegistry({ clock: clock().now });
    reg.begin('t', 'r1');
    const failing: ModelCaller = async () => { throw new Error('overloaded'); };
    expect(await reasonOf(reg.call('t', 'compose', failing, PARAMS))).toBe('other: Error: overloaded');
    expect(reg.usage('t')?.modelCalls).toBe(1);
  });

  it('refuses at the deadline, and says stop before deadline before budget', async () => {
    const c = clock();
    const reg = new RunRegistry({ limits: { maxModelCalls: 1 }, clock: c.now });
    const model = slowModel(0);
    reg.begin('t', 'r1');
    await reg.call('t', 'planner', model.call, PARAMS);
    expect(reg.refusal('t')).toBe('budget');
    c.advance(DEFAULT_LIMITS.deadlineS * 1000);
    expect(reg.refusal('t')).toBe('deadline');
    reg.stop('t');
    expect(reg.refusal('t')).toBe('stopped');
    expect(await reasonOf(reg.call('t', 'planner', model.call, PARAMS))).toBe('stopped');
    expect(model.calls).toBe(1);
  });

  it('allows a call one millisecond before the deadline', async () => {
    const c = clock();
    const reg = new RunRegistry({ clock: c.now });
    reg.begin('t', 'r1');
    c.advance(179_999);
    expect(reg.refusal('t')).toBeNull();
  });

  it('never calls the model for a thread with no open request', async () => {
    const reg = new RunRegistry({ clock: clock().now });
    const model = slowModel(0);
    expect(await reasonOf(reg.call('nobody', 'planner', model.call, PARAMS))).toBe('stopped');
    reg.begin('t', 'r1');
    reg.end('t');
    expect(await reasonOf(reg.call('t', 'planner', model.call, PARAMS))).toBe('stopped');
    expect(model.calls).toBe(0);
  });

  it('hands usage back as a copy, and end closes the request', async () => {
    const reg = new RunRegistry({ clock: clock().now });
    reg.begin('t', 'r1');
    await reg.call('t', 'control', slowModel(0).call, PARAMS);
    const usage = reg.usage('t')!;
    usage.byRole.control = 99;
    expect(reg.usage('t')!.byRole.control).toBe(1);
    expect(reg.end('t')).toEqual({
      modelCalls: 1,
      byRole: { planner: 0, compose: 0, diagnose: 0, analyse: 0, simulate: 0, control: 1 },
      simRuns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    expect(reg.usage('t')).toBeNull();
    expect(reg.stop('t')).toBe(false);
  });
});

describe('RunRegistry: what a request cost (route stage: gate open issue)', () => {
  const reply = (usage: Partial<Anthropic.Usage> | null) => (async () => ({ id: 'msg', usage }) as Anthropic.Message) as ModelCaller;

  it('adds every reply\'s input, output, cache-read and cache-write tokens to its request', async () => {
    const reg = new RunRegistry({ clock: clock().now });
    reg.begin('t', 'r1');
    await reg.call('t', 'planner', reply({ input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 9000, cache_creation_input_tokens: 4000 }), PARAMS);
    await reg.call('t', 'diagnose', reply({ input_tokens: 800, output_tokens: 150, cache_read_input_tokens: 5000, cache_creation_input_tokens: null }), PARAMS);
    // No usage at all, and a malformed count: nothing added, nothing NaN.
    await reg.call('t', 'compose', reply(null), PARAMS);
    await reg.call('t', 'compose', reply({ input_tokens: Number.NaN, output_tokens: -5 }), PARAMS);
    // A call that failed at the API is a call, with no tokens.
    await reasonOf(reg.call('t', 'compose', async () => { throw new Error('overloaded'); }, PARAMS));
    expect(reg.usage('t')).toMatchObject({
      modelCalls: 5, inputTokens: 2000, outputTokens: 450, cacheReadTokens: 14_000, cacheWriteTokens: 4000,
    });
  });

  it('charges a late reply to the request that made the call, not to the next one', async () => {
    const reg = new RunRegistry({ clock: clock().now });
    reg.begin('t', 'r1');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const late: ModelCaller = async () => {
      await gate;
      return { id: 'late', usage: { input_tokens: 500, output_tokens: 50 } } as Anthropic.Message;
    };
    const inFlight = reg.call('t', 'diagnose', late, PARAMS);
    reg.end('t');
    reg.begin('t', 'r2');
    release();
    await inFlight;
    expect(reg.usage('t')).toMatchObject({ modelCalls: 0, inputTokens: 0, outputTokens: 0 });
  });
});

describe('RunRegistry: request shape', () => {
  it('holds every call to the shared rules before spending anything', async () => {
    const reg = new RunRegistry({ clock: clock().now });
    const model = slowModel(0);
    reg.begin('t', 'r1');
    const bad = [
      { ...PARAMS, max_tokens: 8000 },
      { ...PARAMS, thinking: { type: 'enabled', budget_tokens: 1024 } },
      { ...PARAMS, tool_choice: { type: 'any' } },
      { ...PARAMS, tool_choice: { type: 'tool', name: 'report_finding' } },
      { ...PARAMS, fallbacks: ['claude-other'] },
      { ...PARAMS, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ] as unknown as Anthropic.MessageCreateParamsNonStreaming[];
    for (const params of bad) {
      await expect(reg.call('t', 'planner', model.call, params)).rejects.toThrow(TypeError);
    }
    expect(model.calls).toBe(0);
    expect(reg.usage('t')?.modelCalls).toBe(0);
  });

  it('allows auto and none', () => {
    expect(requestShapeError({ ...PARAMS, tool_choice: { type: 'auto' } }, 16_000)).toBeNull();
    expect(requestShapeError({ ...PARAMS, tool_choice: { type: 'none' } }, 16_000)).toBeNull();
    expect(requestShapeError(PARAMS, 16_000)).toBeNull();
  });

  it('allows prompt caching within the API\'s rules: four breakpoints, the automatic one counted, all five-minute', () => {
    const shape = (p: unknown) => requestShapeError(p as Anthropic.MessageCreateParamsNonStreaming, 16_000);
    const marked = { type: 'text', text: 'x', cache_control: { type: 'ephemeral' } };
    const auto = { cache_control: { type: 'ephemeral' } };
    expect(MAX_CACHE_BREAKPOINTS).toBe(4);

    // What the copilot sends: the system prompt's marker and automatic caching; the planner one more.
    expect(shape({ ...PARAMS, ...auto, system: [marked] })).toBeNull();
    expect(shape({ ...PARAMS, ...auto, system: [marked], messages: [{ role: 'user', content: [marked, { type: 'text', text: 'y' }] }] })).toBeNull();
    expect(shape({ ...PARAMS, cache_control: { type: 'ephemeral', ttl: '5m' } })).toBeNull();
    expect(shape({ ...PARAMS, cache_control: null })).toBeNull();

    // Four in all, wherever they sit; a fifth is refused before the API's 400.
    const four = { ...PARAMS, ...auto, system: [marked], messages: [{ role: 'user', content: [marked, marked] }] };
    expect(shape(four)).toBeNull();
    expect(shape({ ...four, tools: [{ name: 't', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }] }))
      .toMatch(/at most 4 cache breakpoints, the automatic one included; got 5/);
    // A tool result's inner blocks count; a key in the model's own tool input is data, and does not.
    const results = {
      ...PARAMS,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'report_finding', input: { cache_control: { type: 'x' } } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: [marked, marked, marked, marked] }] },
      ],
    };
    expect(shape(results)).toBeNull();
    expect(shape({ ...results, ...auto })).toMatch(/got 5/);

    // Only the default ephemeral marker: the API refuses a longer TTL after a shorter one.
    expect(shape({ ...PARAMS, cache_control: { type: 'ephemeral', ttl: '1h' } })).toMatch(/default TTL/);
    expect(shape({ ...PARAMS, system: [{ ...marked, cache_control: { type: 'persistent' } }] })).toMatch(/default TTL/);
  });
});

describe('RunRegistry: tools', () => {
  it('interrupts tools on stop and deadline, but not on the model budget', async () => {
    const c = clock();
    const reg = new RunRegistry({ limits: { maxModelCalls: 1 }, clock: c.now });
    reg.begin('t', 'r1');
    await reg.call('t', 'diagnose', slowModel(0).call, PARAMS);
    expect(reg.refusal('t')).toBe('budget');
    expect(reg.interrupted('t')).toBeNull();
    c.advance(DEFAULT_LIMITS.deadlineS * 1000);
    expect(reg.interrupted('t')).toBe('deadline');
    reg.stop('t');
    expect(reg.interrupted('t')).toBe('stopped');
  });

  it('counts evidence to the request limit, then refuses', () => {
    const reg = new RunRegistry({ clock: clock().now });
    reg.begin('t', 'r1');
    for (let i = 0; i < 60; i += 1) expect(reg.claimEvidence('t')).toBe(true);
    expect(reg.evidenceFull('t')).toBe(true);
    expect(reg.claimEvidence('t')).toBe(false);
    reg.begin('t', 'r2');
    expect(reg.evidenceFull('t')).toBe(false);
  });
});

describe('RunRegistry: simulation', () => {
  it('allows one simulate call per request', () => {
    const reg = new RunRegistry({ clock: clock().now });
    reg.begin('t', 'r1');
    expect(reg.claimSimCall('t')).toBe(true);
    expect(reg.claimSimCall('t')).toBe(false);
    reg.begin('t', 'r2');
    expect(reg.claimSimCall('t')).toBe(true);
  });

  it('runs sequentially, at most three per request', () => {
    const reg = new RunRegistry({ clock: clock().now });
    reg.begin('t', 'r1');
    expect(reg.beginSimRun('t')).toBeNull();
    expect(reg.beginSimRun('t')).toBe('in_flight');
    reg.endSimRun('t');
    expect(reg.beginSimRun('t')).toBeNull();
    reg.endSimRun('t');
    expect(reg.beginSimRun('t')).toBeNull();
    reg.endSimRun('t');
    expect(reg.beginSimRun('t')).toBe('run_limit');
    expect(reg.usage('t')?.simRuns).toBe(3);
    reg.endSimRun('t');
    reg.endSimRun('t');
    expect(reg.beginSimRun('t')).toBe('run_limit');
  });

  it('admits no run once stopped or past the deadline', () => {
    const c = clock();
    const reg = new RunRegistry({ clock: c.now });
    expect(reg.beginSimRun('t')).toBe('no_request');
    reg.begin('t', 'r1');
    c.advance(DEFAULT_LIMITS.deadlineS * 1000);
    expect(reg.beginSimRun('t')).toBe('deadline');
    reg.begin('t', 'r2');
    reg.stop('t');
    expect(reg.beginSimRun('t')).toBe('stopped');
    expect(reg.claimSimCall('t')).toBe(false);
  });
});

describe('RunRegistry: bounded', () => {
  it('drops a request that never reached finish once its plan could no longer be decided', () => {
    const c = clock();
    const reg = new RunRegistry({ clock: c.now });
    reg.begin('crashed', 'r1');
    c.advance((DEFAULT_LIMITS.deadlineS + DEFAULT_LIMITS.planTtlS) * 1000 - 1);
    reg.begin('other', 'r2');
    expect(reg.usage('crashed')).not.toBeNull();
    c.advance(1);
    reg.begin('other', 'r3');
    expect(reg.usage('crashed')).toBeNull();
  });

  it('refuses limits that would disable a bound', () => {
    expect(() => new RunRegistry({ limits: { maxModelCalls: 0 } })).toThrow(RangeError);
  });
});
