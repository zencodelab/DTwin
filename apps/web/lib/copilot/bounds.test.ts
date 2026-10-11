import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { GraphRecursionError } from '@langchain/langgraph';
import { memoryLogger } from '../log.ts';
import type { CommandSpec, Issuer } from './deps.ts';
import { buildCopilotGraph, RECURSION_LIMIT, type CopilotGraph } from './graph.ts';
import { DEFAULT_LIMITS } from './limits.ts';
import { LAST_TURN_NUDGE } from './prompts.ts';
import { decide, sendMessage, stop } from './session.ts';
import {
  Z, composeMsg, fakeDeps, message, plannerMsg, toolUse, type FakeClock, type Script,
} from './testing/fakes.ts';
import { harness, toolResultsOf } from './testing/run.ts';
import { fastPathScript } from './testing/scripts.ts';

/**
 * Every bound says what it does when it is reached (docs/decisions.md §53,
 * design §8, §10 bounds.test.ts 1–8): the model-call budget is per REQUEST
 * and holds across parallel specialists, a specialist's turns and tool calls
 * are capped with the transcript kept valid, the waves stop, the worst case
 * fits the recursion limit with room to spare, and Stop and the deadline are
 * cooperative — noticed at the next call or tool, never a run killed mid-node.
 */

const SINCE_9 = '2026-09-28T09:00:00+04:00';
const NOW = '2026-09-28T12:40:00+04:00';
const WEEK_AGO = '2026-09-21T12:40:00+04:00';
const READ = () => toolUse('zone_conditions', { zoneId: Z.off305, from: SINCE_9, to: NOW });
const REPORT = (status = 'answered') =>
  toolUse('report_finding', { status, summary: 'done', claims: [], openQuestions: [], caveats: [] });
const words = (t: string) => composeMsg({ paragraphs: [{ segments: [{ kind: 'text', text: t }] }], caveats: [] });
const diagnose = (goal: string) => ({ specialist: 'diagnose' as const, goal, zoneIds: [Z.off305], from: SINCE_9, to: NOW });
const endless = (n = 20): Anthropic.Message[] => Array.from({ length: n }, () => message([READ()]));

describe('bounds', () => {
  it('1. the budget is per request: three requests on one thread each spend 5 calls against a ceiling of 6', async () => {
    const perRequest = (): Script => ({
      planner: [plannerMsg({ next: 'dispatch', tasks: [diagnose('why OFF-305 warm')] }), plannerMsg({ next: 'compose' })],
      'diagnose:T1': [message([READ()]), message([REPORT()])],
      compose: [words('OFF-305 was looked at.')],
    });
    const script: Script = { planner: [], 'diagnose:T1': [], compose: [] };
    for (let i = 0; i < 3; i += 1) for (const [k, steps] of Object.entries(perRequest())) script[k]!.push(...steps);
    const h = harness(script, { limits: { maxModelCalls: 6 } });

    for (let i = 1; i <= 3; i += 1) {
      const { turn } = await h.send('long', `question ${i}`);
      expect(turn.answer, `request ${i}`).not.toBeNull();
      expect(turn.usage?.modelCalls, `request ${i}`).toBe(5);
      expect(turn.notices.map((n) => n.code), `request ${i}`).not.toContain('budget');
    }
    expect(h.fake.model.count()).toBe(15);   // v1 counted per THREAD, and refused the third
  });

  it('2. the call cap holds across a parallel wave: two endless specialists and a ceiling of 6', async () => {
    const h = harness({
      planner: [plannerMsg({
        next: 'dispatch',
        tasks: [diagnose('why OFF-305 warm'), { specialist: 'analyse', goal: 'rank floors', from: WEEK_AGO, to: NOW }],
      })],
      'diagnose:T1': endless(),
      'analyse:T2': Array.from({ length: 20 }, () => message([toolUse('energy_by_end_use', { from: WEEK_AGO, to: NOW, groupBy: 'floor' })])),
      compose: [words('never asked')],
    }, { limits: { maxModelCalls: 6 } });

    const { turn } = await h.send('cap', 'look at everything');

    expect(h.fake.model.count()).toBe(6);
    expect(h.fake.model.count('compose')).toBe(0);
    const s = await h.state('cap');
    expect([s.findings.T1, s.findings.T2].map((f) => [f!.status, f!.reason])).toEqual([['partial', 'budget'], ['partial', 'budget']]);
    expect(turn.answer).toBeNull();
    expect(turn.cards.map((c) => c.id)).toEqual(expect.arrayContaining(['T1.E1', 'T2.E1']));
    expect(turn.notices.map((n) => n.code)).toEqual(expect.arrayContaining(['budget', 'compose_unavailable']));
    expect(h.logger.records.map((r) => r.event)).toContain('copilot.budget_exhausted');
    expect(turn.usage).toMatchObject({ modelCalls: 6 });
  });

  it('3. a specialist gets 6 turns; the last one is told so; then it is partial / turn_limit', async () => {
    const h = harness({
      planner: [plannerMsg({ next: 'dispatch', tasks: [diagnose('why OFF-305 warm')] }), plannerMsg({ next: 'compose' })],
      'diagnose:T1': endless(),
      compose: [words('OFF-305 was looked at.')],
    });

    await h.send('turns', 'why is OFF-305 warm');

    const calls = h.fake.model.calls['diagnose:T1']!;
    expect(calls).toHaveLength(DEFAULT_LIMITS.maxSpecialistTurns);
    const lastUser = (params: Anthropic.MessageCreateParamsNonStreaming) => JSON.stringify(params.messages.at(-1));
    expect(lastUser(calls[5]!)).toContain(LAST_TURN_NUDGE);
    for (const c of calls.slice(0, 5)) expect(lastUser(c)).not.toContain(LAST_TURN_NUDGE);
    expect((await h.state('turns')).findings.T1).toMatchObject({ status: 'partial', reason: 'turn_limit' });
  });

  it('4. tool calls: 6 per turn and 12 per task, each extra one an is_error naming the limit', async () => {
    const h = harness({
      planner: [plannerMsg({ next: 'dispatch', tasks: [diagnose('why OFF-305 warm')] }), plannerMsg({ next: 'compose' })],
      'diagnose:T1': [
        message(Array.from({ length: 7 }, READ)),   // 6 run, the 7th refused for the turn
        message(Array.from({ length: 6 }, READ)),   // 12 have run
        message([READ()]),                          // the 13th, refused for the task
        message([REPORT()]),
      ],
      compose: [words('OFF-305 was looked at.')],
    });

    await h.send('tools', 'why is OFF-305 warm');

    const calls = h.fake.model.calls['diagnose:T1']!;
    const errors = (i: number) => toolResultsOf(calls[i]!).filter((b) => b.is_error === true).map((b) => b.content);
    expect(toolResultsOf(calls[1]!)).toHaveLength(7);   // one result per tool_use: the transcript stays valid
    expect(errors(1)).toEqual(['at most 6 tool calls per turn: call again next turn']);
    expect(errors(2)).toEqual([]);
    expect(errors(3)).toEqual(['at most 12 tool calls per task: call report_finding now']);
    expect(h.fake.reader.spy.calls.zoneConditions).toHaveLength(12);
    expect((await h.state('tools')).findings.T1).toMatchObject({ status: 'answered' });
  });

  it('5. waves stop at 3: the fourth planner execution makes no call', async () => {
    const wave = (i: number) => plannerMsg({ next: 'dispatch', tasks: [diagnose(`look again, round ${i}`)] });
    const h = harness({
      planner: [wave(1), wave(2), wave(3), wave(4)],
      'diagnose:T1': [message([REPORT()])],
      'diagnose:T2': [message([REPORT()])],
      'diagnose:T3': [message([REPORT()])],
      compose: [words('Three rounds were enough.')],
    });

    const { turn, trail } = await h.send('waves', 'keep looking');

    expect(h.fake.model.count('planner')).toBe(3);
    expect(h.fake.model.remaining('planner')).toBe(1);
    expect(trail.filter((n) => n === 'planner')).toHaveLength(4);
    expect(turn.notices).toContainEqual({ code: 'wave_limit', text: expect.stringContaining('3 rounds') });
    expect(turn.answer).not.toBeNull();
  });

  it('6. the worst case needs well under RECURSION_LIMIT supersteps at every level', async () => {
    // Three waves (4 + 3 + 1: the request's 8 tasks), every task spending all
    // 6 turns, three failing drafts, the controller, plan_check, confirm —
    // and the resume. Run at 25, not 40: it completes, so the limit the
    // session uses leaves a margin at the top level and inside a specialist.
    const task = (goal: string) => ({ specialist: 'diagnose' as const, goal });
    const bad = words('It is about 1 K warmer.');
    const script: Script = {
      planner: [
        plannerMsg({
          intent: 'compound', allowControl: true, next: 'dispatch',
          tasks: [task('look at L3'), task('look at L2'), task('look at L1'), task('look at L0')],
          controlTask: { mode: 'propose', brief: 'pre-cool L3 offices' },
        }),
        plannerMsg({ next: 'dispatch', tasks: [task('look again'), task('and again'), task('and once more')] }),
        plannerMsg({ next: 'dispatch', tasks: [task('last look')] }),
      ],
      compose: [bad, bad, bad],
      control: [
        message([toolUse('list_zones', {})]),
        message([
          toolUse('propose_plan', {
            summary: 'Raise OFF-301 ahead of the afternoon peak.',
            commands: [{ zoneId: Z.off301, setpointTempC: 24.5, durationS: 7200, reason: 'pre-cool for the afternoon peak' }],
          }),
          REPORT(),
        ]),
      ],
    };
    // Refused calls (no input), so no evidence is spent and every turn is used.
    for (let i = 1; i <= 8; i += 1) script[`diagnose:T${i}`] = Array.from({ length: 6 }, () => message([toolUse('zone_conditions', {})]));
    const fake = fakeDeps({ script, limits: { maxModelCalls: 200 } });
    const graph = buildCopilotGraph({ ...fake.deps, log: memoryLogger() });
    const config = { configurable: { thread_id: 'worst' }, recursionLimit: 25, maxConcurrency: 3 };

    const first = graph.stream({ inbox: { requestId: 'r1', text: 'look at everything, then pre-cool L3', receivedAt: NOW, mayCommand: true } },
      { ...config, streamMode: 'updates' });
    await expect((async () => { for await (const _ of await first) { /* drain */ } })()).resolves.toBeUndefined();

    const snapshot = await graph.getState({ configurable: { thread_id: 'worst' } });
    expect(snapshot.next).toEqual(['confirm']);
    expect(fake.model.count()).toBe(3 + 8 * 6 + 3 + 2);

    // The resume is its own run, and small. Through the session, at the real limit.
    expect(RECURSION_LIMIT).toBe(40);
    const pending = snapshot.tasks[0]!.interrupts[0]!;
    const plan = pending.value as { planId: string; planHash: string };
    const done = await decide(graph, 'worst', { decision: 'approved', interruptId: pending.id!, planId: plan.planId, planHash: plan.planHash });
    expect(done.outcomes).toHaveLength(1);
    expect(fake.issuer.issued).toHaveLength(1);

    // And the limit is a real bound, not a setting LangGraph ignores: far
    // below the worst case the run fails — in every one of the parallel
    // specialists, which LangGraph reports together.
    const tooLow = buildCopilotGraph({ ...fakeDeps({ script: structuredClone(script) }).deps, log: memoryLogger() });
    const err = await (async () => {
      for await (const _ of await tooLow.stream({ inbox: { requestId: 'r2', text: 'x', receivedAt: NOW, mayCommand: true } },
        { configurable: { thread_id: 'low' }, recursionLimit: 8, streamMode: 'updates' })) { /* drain */ }
    })().then(() => null, (e: unknown) => e);
    const errors = err instanceof AggregateError ? err.errors : [err];
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) expect(e).toBeInstanceOf(GraphRecursionError);
  });

  it('7. Stop mid-wave cancels the running simulation, says so, and the next message works', async () => {
    let onSleep: () => void = () => {};
    const FROM = '2026-09-29T08:00:00+04:00';
    const TO = '2026-09-29T20:00:00+04:00';
    const h = harness({
      planner: [
        plannerMsg({
          intent: 'whatif', allowSimulation: true, next: 'dispatch',
          tasks: [{ specialist: 'simulate', goal: 'raise setpoints one kelvin', zoneIds: [Z.off301], from: FROM, to: TO }],
        }),
        plannerMsg({ next: 'finish', intent: 'clarify', message: 'Which zone next?' }),
      ],
      'simulate:T1': [
        message([toolUse('simulate_scenarios', {
          zoneIds: [Z.off301], from: FROM, to: TO, peakDryBulbC: 46, minDryBulbC: 32, peakGhiWM2: 950,
          scenarios: [{ name: 'plus-1', setpointDeltaK: 1 }],
        })]),
        message([REPORT()]),
      ],
    }, { scenarios: 'hang', onSleep: () => onSleep() });
    let stopped = 0;
    onSleep = () => { if (stopped === 0) stopped += Number(stop(h.graph, 'stop')); };

    const { turn } = await h.send('stop', 'what if we raise OFF-301 by a kelvin?');

    expect(stopped).toBe(1);
    expect(h.fake.scenarios!.cancelled).toHaveLength(1);
    expect(h.fake.model.count('simulate:T1')).toBe(1);   // the next call was refused: stopped
    expect((await h.state('stop')).findings.T1).toMatchObject({ status: 'partial', reason: 'stopped' });
    expect(turn.notices.map((n) => n.code)).toContain('stopped');
    expect(h.fake.model.count('compose')).toBe(0);

    const next = await h.send('stop', 'and now?');
    expect(next.turn.message).toBe('Which zone next?');
    expect(next.turn.notices.map((n) => n.code)).not.toContain('stopped');
  });

  it('8. the deadline: past it mid-wave, no further model call and no further read', async () => {
    let clock: FakeClock | null = null;
    const h = harness({
      planner: [plannerMsg({ next: 'dispatch', tasks: [diagnose('why OFF-305 warm')] })],
      'diagnose:T1': [
        () => {
          clock!.advance((DEFAULT_LIMITS.deadlineS + 1) * 1000);
          return message([READ()]);
        },
        message([REPORT()]),
      ],
      compose: [words('never asked')],
    });
    clock = h.fake.clock;

    const { turn } = await h.send('late', 'why is OFF-305 warm');

    expect(h.fake.model.count()).toBe(2);   // the planner, and the one call in flight when the clock passed
    expect(h.fake.reader.spy.calls.zoneConditions).toHaveLength(0);
    expect((await h.state('late')).findings.T1).toMatchObject({ status: 'partial', reason: 'deadline' });
    expect(turn.notices.map((n) => n.code)).toContain('deadline');
    expect(turn.notices.find((n) => n.code === 'deadline')!.text).toContain(`${DEFAULT_LIMITS.deadlineS}-second`);
  });

  it('9. Stop during an approved apply keeps back the commands not yet sent, and says so (review)', async () => {
    // The panel shows Stop while a decision runs, and the route answers
    // "stopping". Two commands go out one at a time; Stop lands after the first.
    let graph: CopilotGraph | null = null;
    const issued: CommandSpec[] = [];
    const issuer: Issuer = {
      async issue(command) {
        issued.push(command);
        if (issued.length === 1) expect(stop(graph!, 'apply-stop')).toBe(true);
        return { ok: true, commandId: `cmd-${issued.length}`, state: 'pending', effectiveUntil: '2026-09-28T10:40:00.000Z' };
      },
    };
    const fake = fakeDeps({ script: fastPathScript() });
    graph = buildCopilotGraph({ ...fake.deps, issuer, log: memoryLogger() });
    const first = await sendMessage(graph, 'apply-stop', 'pre-cool the L3 offices', { mayCommand: true });
    const plan = first.pendingPlan!;
    const done = await decide(graph, 'apply-stop', {
      decision: 'approved', interruptId: plan.interruptId, planId: plan.planId, planHash: plan.planHash,
    });

    expect(issued).toHaveLength(1);
    expect(done.outcomes.map((o) => o.result.ok)).toEqual([true, false]);
    expect(done.outcomes[1]!.result).toEqual({ ok: false, refusal: 'stopped', message: 'not issued: stopped by the operator' });
    expect(done.notices.map((n) => n.code)).toContain('stopped');
  });

  it('10. a Stop pressed while the plan waited is answered by the approval, which is issued whole', async () => {
    const h = harness(fastPathScript());
    const { turn } = await h.send('wait-stop', 'pre-cool the L3 offices');
    expect(stop(h.graph, 'wait-stop')).toBe(true);
    const done = await h.decide('wait-stop', turn, 'approved');
    expect(h.fake.issuer.issued).toHaveLength(2);
    expect(done.turn.outcomes.every((o) => o.result.ok)).toBe(true);
    expect(done.turn.notices.map((n) => n.code)).not.toContain('stopped');
  });
});
