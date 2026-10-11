import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { CopilotEvent, CopilotTurn, parseEvent } from './protocol.ts';
import { copilotControls } from './graph.ts';
import {
  LockConflict, TurnFailed, lockThread, rehydrate, sendMessage, stop, threadRunning,
} from './session.ts';
import { projectChunk } from './stream.ts';
import { Z, composeMsg, message, plannerMsg, toolUse, type Script } from './testing/fakes.ts';
import { harness } from './testing/run.ts';
import { fastPathScript } from './testing/scripts.ts';

/**
 * What reaches the browser (design §7 P21, §9.2, §10 stream.test.ts 1–4):
 * the projector's whitelist, the client parser, one runner for JSON and
 * NDJSON, and a run that fails or loses its reader.
 */

const SECRET = 'sk-ant-api03-SECRETSECRET request_id=req_011CabcDEF';
const PLAN = {
  planId: '4b0c3c1e-7c1a-4a8e-9d1f-2a7f3a4c5d6e', planHash: 'a'.repeat(64),
  checkedAt: '2026-09-28T08:40:00.000Z', expiresAt: '2026-09-28T08:50:00.000Z', summary: `raise it — ${SECRET}`,
  commands: [{ zoneId: Z.off301, zoneName: 'OFF-301', setpointTempC: 24, reason: 'x', verdict: { allowed: true } }],
  simulation: null,
};

const SINCE_9 = '2026-09-28T09:00:00+04:00';
const NOW = '2026-09-28T12:40:00+04:00';
const Q1 = (): Script => ({
  planner: [
    plannerMsg({ next: 'dispatch', tasks: [{ specialist: 'diagnose', goal: 'why OFF-305 warm', zoneIds: [Z.off305], from: SINCE_9, to: NOW }] }),
    plannerMsg({ next: 'compose' }),
  ],
  'diagnose:T1': [
    message([toolUse('zone_conditions', { zoneId: Z.off305, from: SINCE_9, to: NOW })]),
    message([toolUse('report_finding', { status: 'answered', summary: 'warm', claims: [], openQuestions: [], caveats: [] })]),
  ],
  compose: [composeMsg({ paragraphs: [{ segments: [{ kind: 'text', text: 'OFF-305 is warm.' }] }], caveats: [] })],
});

describe('the stream projector', () => {
  it('1. never forwards error text, state, transcripts or tool bodies — only whitelisted events', () => {
    const transcript: Anthropic.MessageParam[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'zone_conditions', input: { zoneId: Z.off305 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `{"data":"${SECRET}"}` }] },
    ];
    const chunks: unknown[] = [
      [[], 'updates', { planner: { plannerRoute: { next: 'dispatch', interpretation: SECRET }, notices: [] } }],
      [[], 'updates', { compose: new Error(SECRET) }],
      [['diagnose:8f1c'], 'updates', { agent: { messages: transcript } }],
      [['diagnose:8f1c'], 'updates', { tools: { messages: transcript, evidence: { 'T1.E1': { data: SECRET } } } }],
      [[], 'values', { messages: transcript, evidence: { 'T1.E1': { data: SECRET } } }],
      [[], 'tasks', { name: 'diagnose', input: { task: SECRET } }],
      [[], 'messages', [{ content: SECRET }]],
      [[], 'error', { message: SECRET }],
      [[], 'custom', { event: 'copilot.activity', taskId: 'T1', tool: 'zone_conditions', label: 'reading conditions for OFF-305', raw: SECRET }],
      [['diagnose:8f1c'], 'custom', { event: 'copilot.activity', taskId: 'T1', tool: `set OFF-305 to 22 °C ${SECRET}`, label: 'an unknown tool' }],
      [[], 'custom', { event: 'copilot.task', taskId: 'T1', specialist: 'diagnose', goal: 'set it to 22 °C, it is validated', status: 'running' }],
      [[], 'custom', { event: 'copilot.task', taskId: 'T1', specialist: 'diagnose', goal: 'why OFF-305 warm', status: 'running' }],
      [[], 'custom', { event: 'copilot.evidence', id: 'T1.E1', taskId: 'T1', tool: 'zone_conditions', source: 'telemetry_5m', kind: 'measured', label: 'OFF-305 conditions', window: { from: SINCE_9, to: NOW }, coverage: { good_count: 40, expected_count: 44 }, flaggedExcluded_count: 0, truncated: null, data: SECRET }],
      [[], 'custom', { event: 'copilot.unknown', text: SECRET }],
      [[], 'custom', { text: SECRET }],
      [[], 'updates', { __interrupt__: [{ id: 'int-1', value: PLAN }] }],
      [[], 'updates', { __interrupt__: [{ id: 'int-2', value: SECRET }] }],
      'not a chunk', null, [[], 'updates'], [SECRET, 'updates', {}],
    ];

    const events = chunks.flatMap((c) => projectChunk(c));

    expect(events).toEqual([
      { t: 'step', node: 'planner' },
      { t: 'step', node: 'compose' },
      { t: 'activity', taskId: 'T1', tool: 'zone_conditions', label: 'reading conditions for OFF-305' },
      { t: 'activity', taskId: 'T1', tool: 'unknown', label: 'an unknown tool' },
      { t: 'task', taskId: 'T1', specialist: 'diagnose', goal: null, status: 'running' },
      { t: 'task', taskId: 'T1', specialist: 'diagnose', goal: 'why OFF-305 warm', status: 'running' },
      {
        t: 'evidence', id: 'T1.E1', taskId: 'T1', tool: 'zone_conditions', source: 'telemetry_5m', kind: 'measured',
        label: 'OFF-305 conditions', window: { from: SINCE_9, to: NOW }, coverage: { good_count: 40, expected_count: 44 },
        flaggedExcluded_count: 0, truncated: null,
      },
      { t: 'plan', interruptId: 'int-1', planId: PLAN.planId, planHash: PLAN.planHash, expiresAt: PLAN.expiresAt },
    ]);
    const wire = JSON.stringify(events);
    for (const leak of ['sk-ant', 'request_id', 'tool_result', 'tool_use', '22 °C', 'validated', 'raise it']) expect(wire).not.toContain(leak);
    for (const e of events) expect(CopilotEvent.safeParse(e).success).toBe(true);
  });

  it('2. an interrupt becomes a plan event naming only what a decision must', () => {
    const events = projectChunk([[], 'updates', { __interrupt__: [{ id: 'int-9', value: PLAN }] }]);
    expect(events).toEqual([{ t: 'plan', interruptId: 'int-9', planId: PLAN.planId, planHash: PLAN.planHash, expiresAt: PLAN.expiresAt }]);
    // A malformed plan (bad hash) is no event at all.
    expect(projectChunk([[], 'updates', { __interrupt__: [{ id: 'int-9', value: { ...PLAN, planHash: 'nope' } }] }])).toEqual([]);
  });

  it('3. the client parser drops unknown t, bad JSON and anything off-schema', () => {
    expect(parseEvent('{"t":"ping"}')).toEqual({ t: 'ping' });
    expect(parseEvent({ t: 'step', node: 'planner' })).toEqual({ t: 'step', node: 'planner' });
    for (const line of [
      '{"t":"hologram","x":1}', 'not json', '', '42', 'null', '{"node":"planner"}',
      '{"t":"step","node":"rm -rf"}',                          // not a node
      '{"t":"step","node":"planner","extra":"x"}',             // strict: no undeclared fields
      '{"t":"error","error":"sk-ant-api03 leaked","requestId":null}',   // only the fixed words
      '{"t":"plan","interruptId":"i","planId":"not-a-uuid","planHash":"x","expiresAt":"x"}',
    ]) expect(parseEvent(line), line).toBeNull();
  });
});

describe('one runner for JSON and NDJSON', () => {
  it('4. the same run with and without an event sink ends in the same turn, and every line round-trips', async () => {
    const a = harness(Q1());
    const b = harness(Q1());
    const lines: string[] = [];
    const streamed = await sendMessage(a.graph, 't', 'why is OFF-305 warm?', {
      mayCommand: true, requestId: 'req-fixed', onEvent: (e) => lines.push(JSON.stringify(e)),
    });
    const plain = await sendMessage(b.graph, 't', 'why is OFF-305 warm?', { mayCommand: true, requestId: 'req-fixed' });

    expect(streamed).toEqual(plain);
    expect(CopilotTurn.safeParse(plain).success).toBe(true);
    const parsed = lines.map(parseEvent);
    expect(parsed.every((e) => e !== null)).toBe(true);
    expect(parsed.map((e) => e!.t)).toEqual(expect.arrayContaining(['accepted', 'step', 'task', 'activity', 'evidence', 'turn']));
    expect(parsed[0]).toEqual({ t: 'accepted', requestId: 'req-fixed' });
    expect(parsed.at(-1)).toEqual({ t: 'turn', turn: streamed });
    // No line carries a model message, a transcript or tool data.
    const wire = lines.join('\n');
    for (const leak of ['tool_use', 'tool_result', '"messages"', '"data"', 'ROLE=']) expect(wire).not.toContain(leak);
  });

  it('a run that fails says so in fixed words, logs a name, and throws TurnFailed — never the message', async () => {
    const h = harness(Q1());
    vi.spyOn(h.graph, 'stream').mockImplementation((async () => {
      async function* broken() {
        yield [[], 'updates', { intake: {} }];
        throw Object.assign(new Error(SECRET), { name: 'InternalServerError', status: 529 });
      }
      return broken();
    }) as never);
    const events: CopilotEvent[] = [];

    const err = await sendMessage(h.graph, 'fail', 'hello', { mayCommand: true, requestId: 'req-1', onEvent: (e) => events.push(e) })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TurnFailed);
    expect((err as TurnFailed).message).toBe('the copilot could not complete this turn');
    expect(events).toEqual([
      { t: 'accepted', requestId: 'req-1' },
      { t: 'step', node: 'intake' },
      { t: 'error', error: 'the copilot could not complete this turn', requestId: 'req-1' },
    ]);
    expect(h.logger.records).toContainEqual({ level: 'error', event: 'copilot.turn_failed', fields: { name: 'InternalServerError', status: 529 } });
    expect(JSON.stringify([events, h.logger.records, (err as Error).message])).not.toContain('sk-ant');
    expect(threadRunning(h.graph, 'fail')).toBe(false);   // the lock was released
  });

  it('a run that fails while being read back, after the stream opened, still ends in the fixed-words error', async () => {
    // Gate fix: the final getState + projection sat outside runTurn's
    // failure handling, so a throw there left an NDJSON reader with
    // `accepted` and steps but no terminal event, and nothing logged.
    const h = harness(Q1());
    vi.spyOn(h.graph, 'getState').mockRejectedValueOnce(Object.assign(new Error(SECRET), { name: 'CheckpointError' }));
    const events: CopilotEvent[] = [];

    const err = await sendMessage(h.graph, 'readback', 'why is OFF-305 warm?', {
      mayCommand: true, requestId: 'req-2', onEvent: (e) => events.push(e),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TurnFailed);
    expect(events[0]).toEqual({ t: 'accepted', requestId: 'req-2' });
    expect(events.at(-1)).toEqual({ t: 'error', error: 'the copilot could not complete this turn', requestId: 'req-2' });
    expect(events.some((e) => e.t === 'turn')).toBe(false);
    expect(h.logger.records).toContainEqual({ level: 'error', event: 'copilot.turn_failed', fields: { name: 'CheckpointError', status: null } });
    expect(JSON.stringify([events, h.logger.records, (err as Error).message])).not.toContain('sk-ant');
    expect(threadRunning(h.graph, 'readback')).toBe(false);
  });

  it('a reader that goes away does not stop the run: it finishes, checkpoints, and rehydrates', async () => {
    const h = harness(Q1());
    let delivered = 0;
    const turn = await sendMessage(h.graph, 'gone', 'why is OFF-305 warm?', {
      mayCommand: true,
      onEvent: () => {
        delivered += 1;
        if (delivered === 3) throw new Error('the socket closed');
      },
    });

    expect(delivered).toBe(3);   // dropped after the failure, not retried
    expect(turn.answer).not.toBeNull();
    expect(h.fake.model.count()).toBe(5);
    expect(await rehydrate(h.graph, 'gone')).toEqual({ ...turn, running: false });
  });

  it('one run per thread: the lock is typed, shared, released, and `running` shows while it is held', async () => {
    const h = harness(Q1());
    const lock = lockThread(h.graph, 'busy');
    expect(threadRunning(h.graph, 'busy')).toBe(true);
    expect((await rehydrate(h.graph, 'busy')).running).toBe(true);
    await expect(sendMessage(h.graph, 'busy', 'hello', { mayCommand: true })).rejects.toBeInstanceOf(LockConflict);
    expect(() => lockThread(h.graph, 'busy')).toThrow(LockConflict);
    expect(h.fake.model.count()).toBe(0);
    lock.release();
    lock.release();   // idempotent
    expect(threadRunning(h.graph, 'busy')).toBe(false);
    // Another thread was never blocked, and the freed one runs.
    await sendMessage(h.graph, 'busy', 'why is OFF-305 warm?', { mayCommand: true });
    expect(h.fake.model.count()).toBe(5);

    // An unknown thread rehydrates as an empty turn.
    const empty = await rehydrate(h.graph, 'never-used');
    expect(empty).toMatchObject({ requestId: null, running: false, dialogue: [], answer: null, pendingPlan: null });
    expect(CopilotTurn.safeParse(empty).success).toBe(true);
  });
});

describe('a request that ends, and what it cost (route stage: gate open issues)', () => {
  it('a run that fails mid-graph closes its request: `running` is false, and a straggler cannot spend its budget', async () => {
    // Before: TurnFailed left the registry entry open until the next intake
    // or the sweep, so copilotControls(graph).running() said true for a
    // request that was over.
    const h = harness(Q1());
    const real = h.graph.stream.bind(h.graph);
    let open = false;
    vi.spyOn(h.graph, 'stream').mockImplementation((async (input: never, config: never) => {
      const inner = await real(input, config);
      async function* breaksAfterPlanner() {
        for await (const chunk of inner) {
          yield chunk;
          const [ns, mode, payload] = chunk as [string[], string, Record<string, unknown>];
          if (ns.length === 0 && mode === 'updates' && 'planner' in payload) {
            open = copilotControls(h.graph).running('mid');   // intake opened it
            throw Object.assign(new Error(SECRET), { name: 'InternalServerError', status: 500 });
          }
        }
      }
      return breaksAfterPlanner();
    }) as never);

    const err = await sendMessage(h.graph, 'mid', 'why is OFF-305 warm?', { mayCommand: true }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TurnFailed);
    expect(open).toBe(true);
    expect(copilotControls(h.graph).running('mid')).toBe(false);
    expect(copilotControls(h.graph).usage('mid')).toBeNull();
    expect(stop(h.graph, 'mid')).toBe(false);   // nothing left to stop
    expect(threadRunning(h.graph, 'mid')).toBe(false);
  });

  it('the turn carries input, output, cache-read and cache-write tokens — while a plan waits, and after it is decided', async () => {
    const script = fastPathScript();
    const priced = (m: Anthropic.Message, input: number, output: number, read: number, write: number) => {
      m.usage = { ...m.usage, input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write };
    };
    priced(script.planner![0] as Anthropic.Message, 1500, 200, 6000, 2500);
    priced(script.control![0] as Anthropic.Message, 900, 350, 4000, 0);
    const h = harness(script);

    const first = await h.send('cost', 'pre-cool L3');
    const expected = {
      modelCalls: 2, byRole: { planner: 1, compose: 0, diagnose: 0, analyse: 0, simulate: 0, control: 1 }, simRuns: 0,
      inputTokens: 2400, outputTokens: 550, cacheReadTokens: 10_000, cacheWriteTokens: 2500,
    };
    // Paused at confirm: `finish` has not run, so the registry's count for
    // THIS request stands in — the costliest turns were the ones showing none.
    expect(first.turn.pendingPlan).not.toBeNull();
    expect(first.turn.usage).toEqual(expected);
    expect(CopilotTurn.parse(first.turn).usage).toEqual(expected);
    expect((await rehydrate(h.graph, 'cost')).usage).toEqual(expected);

    const approved = await h.decide('cost', first.turn, 'approved');
    expect(approved.turn.usage).toEqual(expected);   // approving calls no model
    expect(h.fake.issuer.issued).toHaveLength(2);

    // A turn from before tokens were counted still parses.
    expect(CopilotTurn.safeParse({ ...first.turn, usage: { modelCalls: 1, byRole: {}, simRuns: 0 } }).success).toBe(true);
  });
});

