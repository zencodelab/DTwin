import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { memoryLogger } from '../log.ts';
import { buildCopilotGraph, DEFAULT_MODEL, resolveModels } from './graph.ts';
import { decide, sendMessage, type CopilotTurn } from './session.ts';
import {
  Z, composeMsg, fakeDeps, message, plannerMsg, toolUse, type FakeDeps, type Script,
} from './testing/fakes.ts';
import { toolHarness } from './testing/tools.ts';
import { MAX_PLAN_COMMANDS } from './tools/index.ts';

/**
 * v1's graph tests, ported to the v2 graph (design §10, graph.test.ts 1–11).
 *
 * The control fast path is v1's behaviour kept whole: the planner hands a
 * setpoint request straight to the controller, the controller looks,
 * dry-runs and proposes, and the run STOPS at `confirm` until a person
 * decides. What changed underneath is what these now also prove: the plan is
 * dry-run a third time by plan_check, a decision names the interrupt, the
 * plan and its hash, apply issues the ledger's frozen grant, and no model is
 * called after approval.
 */

const FAST_PATH_PLANNER = () => plannerMsg({
  intent: 'control', next: 'control', allowControl: true,
  controlTask: { mode: 'propose', brief: 'pre-cool L3 offices' }, tasks: [],
});

const REPORT = (status: 'answered' | 'partial' | 'cannot_answer' = 'answered') =>
  toolUse('report_finding', { status, summary: 'done', claims: [], openQuestions: [], caveats: [] });

/** v1's pre-cool script, ending with the finding in the same turn as the plan. */
const preCoolScript = (): Anthropic.Message[] => [
  message([toolUse('list_zones', {})]),
  message([
    toolUse('dry_run_setpoint', { zoneId: Z.off301, setpointTempC: 24.5, durationS: 7200, reason: 'pre-cool' }),
    toolUse('dry_run_setpoint', { zoneId: Z.off303, setpointTempC: 24.5, durationS: 7200, reason: 'pre-cool' }),
  ]),
  message([
    toolUse('propose_plan', {
      summary: 'Raise OFF-301 and OFF-303 ahead of the afternoon peak.',
      commands: [
        { zoneId: Z.off301, setpointTempC: 24.5, durationS: 7200, reason: 'pre-cool for the afternoon peak' },
        { zoneId: Z.off303, setpointTempC: 24.5, durationS: 7200, reason: 'pre-cool for the afternoon peak' },
      ],
    }),
    REPORT(),
  ]),
];

const words = (text: string) => composeMsg({ paragraphs: [{ segments: [{ kind: 'text', text }] }], caveats: [] });

function setup(script: Script, extra: Parameters<typeof fakeDeps>[0] = {}) {
  const fake: FakeDeps = fakeDeps({ script, ...extra });
  const logger = memoryLogger();
  const graph = buildCopilotGraph({ ...fake.deps, log: logger });
  return {
    fake, graph, logger,
    send: (threadId: string, text: string) => sendMessage(graph, threadId, text, { mayCommand: true }),
    decide: (threadId: string, turn: CopilotTurn, decision: 'approved' | 'declined') => decide(graph, threadId, {
      decision,
      interruptId: turn.pendingPlan!.interruptId,
      planId: turn.pendingPlan!.planId,
      planHash: turn.pendingPlan!.planHash,
    }),
  };
}

describe('the copilot graph: the control fast path', () => {
  it('proposes, then STOPS — nothing is issued until a person approves', async () => {
    const { fake, send } = setup({ planner: [FAST_PATH_PLANNER()], control: preCoolScript() });

    const turn = await send('t1', 'Pre-cool the Level 3 offices for the afternoon peak');

    expect(turn.pendingPlan).not.toBeNull();
    expect(turn.pendingPlan!.commands.map((c) => c.zoneName)).toEqual(['OFF-301', 'OFF-303']);
    expect(turn.pendingPlan!.commands.every((c) => c.verdict.allowed)).toBe(true);
    // Dry-run three times over: twice by the model, once more by propose_plan,
    // and again by plan_check just before the card is shown.
    expect(fake.probe.dryRuns).toHaveLength(6);
    expect(fake.issuer.issued).toHaveLength(0);
    expect(fake.model.count('planner')).toBe(1);
    expect(fake.model.count('control')).toBe(3);
    expect(fake.model.count()).toBe(4);
  });

  it('issues every command once the operator approves, attributed as copilot-proposed, with no model call after', async () => {
    const { fake, send, decide: d } = setup({ planner: [FAST_PATH_PLANNER()], control: preCoolScript() });

    const proposed = await send('t2', 'Pre-cool Level 3');
    const calls = fake.model.count();
    const turn = await d('t2', proposed, 'approved');

    expect(fake.issuer.issued).toHaveLength(2);
    expect(fake.issuer.issued.map((c) => c.zoneId)).toEqual([Z.off301, Z.off303]);
    for (const c of fake.issuer.issued) expect(c.reason).toMatch(/^copilot \(operator-approved\): /);
    expect(turn.pendingPlan).toBeNull();
    expect(turn.outcomes).toHaveLength(2);
    expect(turn.outcomes.every((o) => o.result.ok)).toBe(true);
    expect(fake.model.count()).toBe(calls);
  });

  it('issues nothing when the operator declines', async () => {
    const { fake, send, decide: d } = setup({ planner: [FAST_PATH_PLANNER()], control: preCoolScript() });

    const proposed = await send('t3', 'Pre-cool Level 3');
    const turn = await d('t3', proposed, 'declined');

    expect(fake.issuer.issued).toHaveLength(0);
    expect(turn.pendingPlan).toBeNull();
    expect(turn.outcomes).toEqual([]);
    expect(turn.notices.map((n) => n.code)).toContain('plan_declined');
  });

  it('never shows the operator a plan containing a command the envelope refuses', async () => {
    const { fake, send } = setup({
      planner: [FAST_PATH_PLANNER()],
      control: [
        message([toolUse('propose_plan', {
          summary: 'Pre-cool every Level 3 office.',
          commands: [
            { zoneId: Z.off301, setpointTempC: 24.5, reason: 'pre-cool' },
            { zoneId: Z.off305, setpointTempC: 24.5, reason: 'pre-cool' },   // VAV-305 in fault
          ],
        })]),
        // The model reads the refusal and reports rather than retrying.
        message([REPORT('cannot_answer')]),
      ],
      compose: [words('OFF-305 cannot be commanded while its VAV is in fault.')],
    });

    const turn = await send('t4', 'Pre-cool all of Level 3');

    expect(turn.pendingPlan).toBeNull();
    expect(fake.issuer.issued).toHaveLength(0);
    const second = fake.model.calls.control![1]!;
    const results = JSON.stringify(second.messages[second.messages.length - 1]);
    expect(results).toContain('VAV-305 (fault)');
    expect(results).toContain('"is_error":true');
  });

  it('acts on nothing when the model refuses', async () => {
    const refusal = message([toolUse('propose_plan', { summary: 'x', commands: [] })], 'refusal');
    const { fake, send } = setup({
      planner: [FAST_PATH_PLANNER()],
      control: [refusal],
      compose: [words('The copilot could not act on that request.')],
    });

    const turn = await send('t5', 'Do something unwise');

    expect(turn.pendingPlan).toBeNull();
    expect(fake.issuer.issued).toHaveLength(0);
    expect(fake.probe.dryRuns).toHaveLength(0);
    expect(turn.tasks.find((t) => t.taskId === 'K')!.status).toBe('refused');
    expect(turn.notices.map((n) => n.code)).toContain('model_refused');
  });

  it('keeps threads apart', async () => {
    const { send } = setup({
      planner: [
        plannerMsg({ next: 'finish', intent: 'clarify', message: 'Which floor do you mean, thread A?' }),
        plannerMsg({ next: 'finish', intent: 'clarify', message: 'Which zone do you mean, thread B?' }),
      ],
    });
    const a = await send('A', 'hi');
    const b = await send('B', 'hi');
    expect(a.message).toContain('thread A');
    expect(b.message).toContain('thread B');
    expect(a.dialogue).toHaveLength(2);
    expect(b.dialogue).toHaveLength(2);
    expect(JSON.stringify(b.dialogue)).not.toContain('thread A');
  });

  it('survives a backend throw: the next message on the same thread still works', async () => {
    const { fake, send } = setup({
      planner: [
        FAST_PATH_PLANNER(),
        plannerMsg({ next: 'finish', intent: 'clarify', message: 'Which zone should I look at?' }),
      ],
      control: [message([toolUse('control_envelope', {})]), message([REPORT('cannot_answer')])],
      compose: [words('The control service could not be reached, so nothing was proposed.')],
    }, { settingsThrows: true });

    const first = await send('t11', 'Pre-cool Level 3');
    expect(first.notices.map((n) => n.code)).toContain('control_unavailable');
    const results = JSON.stringify(fake.model.calls.control![1]!.messages.at(-1));
    expect(results).toContain('control service unreachable');
    expect(results).toContain('"is_error":true');

    const second = await send('t11', 'and now?');
    expect(second.message).toBe('Which zone should I look at?');
    expect(second.dialogue).toHaveLength(4);
  });
});

describe('resolveModels', () => {
  it('treats a blank COPILOT_MODEL or COPILOT_SPECIALIST_MODEL as unset, and defaults the specialist to the lead', () => {
    expect(resolveModels({ COPILOT_MODEL: '' })).toEqual({ lead: DEFAULT_MODEL, specialist: DEFAULT_MODEL });
    expect(resolveModels({ COPILOT_MODEL: '   ', COPILOT_SPECIALIST_MODEL: ' ' })).toEqual({ lead: DEFAULT_MODEL, specialist: DEFAULT_MODEL });
    expect(resolveModels({})).toEqual({ lead: DEFAULT_MODEL, specialist: DEFAULT_MODEL });
    expect(resolveModels({ COPILOT_MODEL: 'claude-opus-5-5' })).toEqual({ lead: 'claude-opus-5-5', specialist: 'claude-opus-5-5' });
    expect(resolveModels({ COPILOT_MODEL: 'claude-opus-5-5', COPILOT_SPECIALIST_MODEL: 'claude-opus-5' }))
      .toEqual({ lead: 'claude-opus-5-5', specialist: 'claude-opus-5' });
    expect(DEFAULT_MODEL).toBe('claude-opus-5');
  });
});

describe("the controller's vocabulary (v1)", () => {
  it('bounds a plan', async () => {
    const h = toolHarness({ taskId: 'K', mode: 'propose' });
    const tooMany = Array.from({ length: MAX_PLAN_COMMANDS + 1 }, (_, i) =>
      ({ zoneId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, setpointTempC: 24, reason: 'pre-cool' }));
    const out = await h.call('control', 'propose_plan', { summary: 'too many', commands: tooMany });
    expect(out.isError).toBe(true);
    expect(out.proposal).toBeUndefined();
  });

  it('refuses a plan naming the same zone twice', async () => {
    const h = toolHarness({ taskId: 'K', mode: 'propose' });
    const out = await h.call('control', 'propose_plan', {
      summary: 'duplicate zones',
      commands: [
        { zoneId: Z.off301, setpointTempC: 24, reason: 'first attempt' },
        { zoneId: Z.off301, setpointTempC: 25, reason: 'second attempt' },
      ],
    });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('twice');
  });

  it('answers an unknown tool as an error rather than throwing', async () => {
    const h = toolHarness({ taskId: 'K', mode: 'propose' });
    const out = await h.call('control', 'enable_control', {});
    expect(out.isError).toBe(true);
  });

  it('hides a stale sensor as null rather than as a number', async () => {
    const h = toolHarness({ taskId: 'K', mode: 'propose' });
    const out = await h.call('control', 'list_zones', {});
    const zones = (JSON.parse(out.content) as { data: Array<{ name: string; temperatureC: number | null }> }).data;
    expect(zones.find((z) => z.name === 'SER-105')!.temperatureC).toBeNull();
    expect(zones.find((z) => z.name === 'OFF-301')!.temperatureC).toBe(24.2);
  });
});
