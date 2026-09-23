import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { CommandSpec, CopilotBackend, ZoneSummary } from './backend.ts';
import { MAX_TURNS, buildCopilotGraph, decide, sendMessage, type ModelCaller } from './graph.ts';
import { MAX_PLAN_COMMANDS, TOOL_NAMES, runTool } from './tools.ts';

// ---------------------------------------------------------------- fixtures

const Z = {
  off301: '00000000-0000-4000-8000-000000000301',
  off303: '00000000-0000-4000-8000-000000000303',
  off305: '00000000-0000-4000-8000-000000000305',
  ser105: '00000000-0000-4000-8000-000000000105',
};

const ZONES: ZoneSummary[] = [
  { id: Z.off301, name: 'OFF-301', floorName: 'Level 3', zoneType: 'office', areaM2: 200,
    temperatureC: 24.2, designedSetpointC: 23, deadbandK: 1, activeOverrideC: null,
    overrideUntil: null, equipment: [{ tag: 'AHU-04', status: 'operational' }] },
  { id: Z.off303, name: 'OFF-303', floorName: 'Level 3', zoneType: 'office', areaM2: 200,
    temperatureC: 23.9, designedSetpointC: 23, deadbandK: 1, activeOverrideC: null,
    overrideUntil: null, equipment: [{ tag: 'AHU-04', status: 'operational' }] },
  // Serving AHU in fault: the envelope refuses this one.
  { id: Z.off305, name: 'OFF-305', floorName: 'Level 3', zoneType: 'office', areaM2: 200,
    temperatureC: 24.0, designedSetpointC: 23, deadbandK: 1, activeOverrideC: null,
    overrideUntil: null, equipment: [{ tag: 'AHU-04', status: 'fault' }] },
  // Stale sensor: temperatureC null.
  { id: Z.ser105, name: 'SER-105', floorName: 'Level 1', zoneType: 'server_room', areaM2: 40,
    temperatureC: null, designedSetpointC: 18, deadbandK: 0.5, activeOverrideC: null,
    overrideUntil: null, equipment: [] },
];

/** Refuses OFF-305 (equipment) and SER-105 (feedback), allows the rest. */
function fakeBackend() {
  const issued: CommandSpec[] = [];
  const dryRuns: CommandSpec[] = [];
  const backend: CopilotBackend = {
    async listZones() { return ZONES; },
    async settings() {
      return { enabled: true, maxDeviationK: 3, maxStepK: 2, minIntervalS: 900,
        defaultDurationS: 3600, maxDurationS: 43_200, commandTtlS: 300 };
    },
    async dryRun(c) {
      dryRuns.push(c);
      if (c.zoneId === Z.off305) {
        return { allowed: false, refusal: 'equipment_unavailable', message: 'AHU-04 (fault)' };
      }
      if (c.zoneId === Z.ser105) {
        return { allowed: false, refusal: 'feedback_unusable', message: 'no reading' };
      }
      return { allowed: true, previousTempC: 23, durationS: c.durationS ?? 3600,
        effectiveUntil: '2026-09-24T15:00:00.000Z' };
    },
    async issue(c) {
      issued.push(c);
      return { ok: true, commandId: `cmd-${issued.length}`, state: 'pending',
        effectiveUntil: '2026-09-24T15:00:00.000Z' };
    },
  };
  return { backend, issued, dryRuns };
}

let ids = 0;
// Test doubles for what a model returns. Cast through unknown because the
// SDK's block types carry fields (caller, container) a fake need not fill.
const toolUse = (name: string, input: unknown): Anthropic.ToolUseBlock =>
  ({ type: 'tool_use', id: `tu_${++ids}`, name, input } as unknown as Anthropic.ToolUseBlock);
const text = (t: string): Anthropic.TextBlock =>
  ({ type: 'text', text: t, citations: null });

function message(
  content: Anthropic.ContentBlock[], stop: Anthropic.Message['stop_reason'] = 'end_turn',
): Anthropic.Message {
  return {
    id: `msg_${++ids}`, type: 'message', role: 'assistant', model: 'fake', content,
    stop_reason: stop, stop_sequence: null, stop_details: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0, server_tool_use: null, service_tier: null,
      cache_creation: null, inference_geo: null, iterations: null, speed: null },
  } as unknown as Anthropic.Message;
}

/** A model that returns a fixed script, one message per call. */
function scriptedModel(script: Anthropic.Message[]): { call: ModelCaller; calls: number } {
  const state = { calls: 0 };
  const call: ModelCaller = async () => {
    const next = script[state.calls];
    state.calls += 1;
    if (!next) throw new Error(`script exhausted after ${state.calls - 1} calls`);
    return next;
  };
  return { call, get calls() { return state.calls; } };
}

const preCoolScript = () => [
  message([toolUse('list_zones', {})], 'tool_use'),
  message([
    toolUse('dry_run_setpoint', { zoneId: Z.off301, setpointTempC: 24.5, durationS: 7200, reason: 'pre-cool' }),
    toolUse('dry_run_setpoint', { zoneId: Z.off303, setpointTempC: 24.5, durationS: 7200, reason: 'pre-cool' }),
  ], 'tool_use'),
  message([toolUse('propose_plan', {
    summary: 'Raise OFF-301 and OFF-303 to 24.5 °C for two hours ahead of the afternoon peak.',
    commands: [
      { zoneId: Z.off301, setpointTempC: 24.5, durationS: 7200, reason: 'pre-cool for the afternoon peak' },
      { zoneId: Z.off303, setpointTempC: 24.5, durationS: 7200, reason: 'pre-cool for the afternoon peak' },
    ],
  })], 'tool_use'),
];

// ------------------------------------------------------------------ tests

describe('the copilot graph', () => {
  it('proposes, then STOPS — nothing is issued until a person approves', async () => {
    const { backend, issued, dryRuns } = fakeBackend();
    const model = scriptedModel(preCoolScript());
    const graph = buildCopilotGraph({ backend, callModel: model.call, model: 'fake' });

    const turn = await sendMessage(graph, 't1', 'Pre-cool the Level 3 offices for the afternoon peak');

    expect(turn.pendingPlan).not.toBeNull();
    expect(turn.pendingPlan!.commands.map((c) => c.zoneName)).toEqual(['OFF-301', 'OFF-303']);
    expect(turn.pendingPlan!.commands.every((c) => c.verdict.allowed)).toBe(true);
    // The graph re-ran the dry runs itself when the plan was proposed: two by
    // the model, two more by propose_plan. The operator sees verdicts from now.
    expect(dryRuns).toHaveLength(4);
    expect(issued).toHaveLength(0);
    expect(model.calls).toBe(3);
  });

  it('issues every command once the operator approves, attributed as copilot-proposed', async () => {
    const { backend, issued } = fakeBackend();
    const model = scriptedModel([
      ...preCoolScript(),
      message([text('Queued both overrides; they lapse at 15:00.')]),
    ]);
    const graph = buildCopilotGraph({ backend, callModel: model.call, model: 'fake' });

    await sendMessage(graph, 't2', 'Pre-cool Level 3');
    const turn = await decide(graph, 't2', 'approved');

    expect(issued).toHaveLength(2);
    expect(issued.map((c) => c.zoneId)).toEqual([Z.off301, Z.off303]);
    for (const c of issued) expect(c.reason).toMatch(/^copilot \(operator-approved\): /);
    expect(turn.pendingPlan).toBeNull();
    expect(turn.outcomes.every((o) => o.result.ok)).toBe(true);
    const last = turn.messages[turn.messages.length - 1]!;
    expect(JSON.stringify(last.content)).toContain('Queued both');
  });

  it('issues nothing when the operator declines', async () => {
    const { backend, issued } = fakeBackend();
    const model = scriptedModel([
      ...preCoolScript(),
      message([text('Understood — what would you like instead?')]),
    ]);
    const graph = buildCopilotGraph({ backend, callModel: model.call, model: 'fake' });

    await sendMessage(graph, 't3', 'Pre-cool Level 3');
    const turn = await decide(graph, 't3', 'declined');

    expect(issued).toHaveLength(0);
    expect(turn.pendingPlan).toBeNull();
    expect(turn.outcomes).toEqual([]);
  });

  it('never shows the operator a plan containing a command the envelope refuses', async () => {
    const { backend, issued } = fakeBackend();
    const model = scriptedModel([
      message([toolUse('propose_plan', {
        summary: 'Pre-cool every Level 3 office',
        commands: [
          { zoneId: Z.off301, setpointTempC: 24.5, reason: 'pre-cool' },
          { zoneId: Z.off305, setpointTempC: 24.5, reason: 'pre-cool' },   // AHU in fault
        ],
      })], 'tool_use'),
      // The model receives the error and explains rather than retrying.
      message([text('OFF-305 cannot be commanded: AHU-04 is in fault. I can proceed with OFF-301 alone.')]),
    ]);
    const graph = buildCopilotGraph({ backend, callModel: model.call, model: 'fake' });

    const turn = await sendMessage(graph, 't4', 'Pre-cool all of Level 3');

    expect(turn.pendingPlan).toBeNull();
    expect(issued).toHaveLength(0);
    const toolResult = turn.messages.find((m) =>
      Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
    expect(JSON.stringify(toolResult!.content)).toContain('AHU-04 (fault)');
    expect(JSON.stringify(toolResult!.content)).toContain('"is_error":true');
  });

  it('stops at the turn ceiling instead of looping for ever', async () => {
    const { backend, issued } = fakeBackend();
    // A model that only ever looks and never proposes.
    const looping = Array.from({ length: MAX_TURNS + 5 }, () =>
      message([toolUse('list_zones', {})], 'tool_use'));
    const model = scriptedModel(looping);
    const graph = buildCopilotGraph({ backend, callModel: model.call, model: 'fake' });

    const turn = await sendMessage(graph, 't5', 'Look at everything');

    expect(model.calls).toBe(MAX_TURNS);
    expect(turn.notice).toMatch(/stopped after/);
    expect(issued).toHaveLength(0);
  });

  it('acts on nothing when the model refuses', async () => {
    const { backend, issued } = fakeBackend();
    const refusal = message([toolUse('propose_plan', { summary: 'x', commands: [] })], 'refusal');
    (refusal as { stop_details: unknown }).stop_details =
      { type: 'refusal', category: 'cyber', explanation: 'declined' };
    const model = scriptedModel([refusal]);
    const graph = buildCopilotGraph({ backend, callModel: model.call, model: 'fake' });

    const turn = await sendMessage(graph, 't6', 'Do something unwise');

    expect(turn.notice).toMatch(/declined/);
    expect(turn.pendingPlan).toBeNull();
    expect(issued).toHaveLength(0);
  });

  it('keeps threads apart', async () => {
    const { backend } = fakeBackend();
    const model = scriptedModel([
      message([text('Hello from thread A')]),
      message([text('Hello from thread B')]),
    ]);
    const graph = buildCopilotGraph({ backend, callModel: model.call, model: 'fake' });
    const a = await sendMessage(graph, 'A', 'hi');
    const b = await sendMessage(graph, 'B', 'hi');
    expect(a.messages).toHaveLength(2);
    expect(b.messages).toHaveLength(2);
    expect(JSON.stringify(b.messages)).not.toContain('thread A');
  });
});

describe("the copilot's vocabulary", () => {
  it('cannot switch control on, change the envelope, cancel, or apply', () => {
    // The whole safety argument rests on this list. If a tool that writes
    // anything other than a dry run ever appears here, the interrupt is no
    // longer the only path to equipment.
    expect(TOOL_NAMES).toEqual(['list_zones', 'control_envelope', 'dry_run_setpoint', 'propose_plan']);
  });

  it('bounds a plan', async () => {
    const { backend } = fakeBackend();
    const tooMany = Array.from({ length: MAX_PLAN_COMMANDS + 1 }, (_, i) =>
      ({ zoneId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, setpointTempC: 24, reason: 'x' }));
    const out = await runTool('propose_plan', { summary: 'too many', commands: tooMany }, backend);
    expect(out.isError).toBe(true);
    expect(out.plan).toBeUndefined();
  });

  it('refuses a plan naming the same zone twice', async () => {
    const { backend } = fakeBackend();
    const out = await runTool('propose_plan', {
      summary: 'dup',
      commands: [
        { zoneId: Z.off301, setpointTempC: 24, reason: 'first attempt' },
        { zoneId: Z.off301, setpointTempC: 25, reason: 'second attempt' },
      ],
    }, backend);
    expect(out.isError).toBe(true);
    expect(out.content).toContain('twice');
  });

  it('answers an unknown tool as an error rather than throwing', async () => {
    const { backend } = fakeBackend();
    const out = await runTool('enable_control', {}, backend);
    expect(out.isError).toBe(true);
  });

  it('hides a stale sensor as null rather than as a number', async () => {
    const { backend } = fakeBackend();
    const out = await runTool('list_zones', {}, backend);
    const zones = JSON.parse(out.content) as Array<{ name: string; temperatureC: number | null }>;
    expect(zones.find((z) => z.name === 'SER-105')!.temperatureC).toBeNull();
  });
});
