import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { CAVEAT_TEXT, CHECK_MODE_CAVEAT } from './caveats.ts';
import type { AnswerDoc, CaveatId, EvidenceRecord } from './evidence.ts';
import { CopilotTurn } from './protocol.ts';
import {
  Z, composeMsg, message, orientFixture, plannerMsg, text, toolUse, type Script,
} from './testing/fakes.ts';
import { dataOf, harness, toolResultsOf } from './testing/run.ts';
import { compoundScript } from './testing/scripts.ts';

/**
 * The graph run end to end on the fakes, through the real session (design
 * §10 orchestration.test.ts 1–11): the diagnostic path through one
 * Send-dispatched specialist, a parallel wave joined once, a second wave that
 * builds on the first, the compound path from a simulation to a plan the card
 * may call "simulated", a failing specialist that leaves its siblings alone,
 * and the planner's, compose's and the controller's ways of not answering.
 *
 * Every run goes through `runTurn` → `graph.stream`, so the trail asserted
 * here is the `step` events the panel receives, and every turn is checked
 * against the protocol schema the panel parses it with.
 */

const SINCE_9 = '2026-09-28T09:00:00+04:00';
const NOW = '2026-09-28T12:40:00+04:00';
const WEEK_AGO = '2026-09-21T12:40:00+04:00';
const OFF305_INDEX = orientFixture(Date.parse('2026-09-28T08:40:00Z')).directory.findIndex((z) => z.name === 'OFF-305');

const REPORT = (claims: Array<{ text: string; evidenceIds: string[] }> = [], status = 'answered', caveats: CaveatId[] = []) =>
  toolUse('report_finding', { status, summary: 'done', claims, openQuestions: [], caveats });
const words = (t: string, caveats: CaveatId[] = []) =>
  composeMsg({ paragraphs: [{ segments: [{ kind: 'text', text: t }] }], caveats });
const caveatsOf = (records: EvidenceRecord[], ids: string[]): CaveatId[] =>
  [...new Set(records.filter((r) => ids.includes(r.id)).flatMap((r) => r.caveats))];
const evidenceIn = (params: Anthropic.MessageCreateParamsNonStreaming) => dataOf(params).evidence as EvidenceRecord[];

const diagnoseTask = (zoneId: string, goal: string) =>
  ({ specialist: 'diagnose' as const, goal, zoneIds: [zoneId], from: SINCE_9, to: NOW });
const analyseTask = (goal: string) => ({ specialist: 'analyse' as const, goal, from: WEEK_AGO, to: NOW });

describe('orchestration', () => {
  it('1. a diagnostic question (Q1): one specialist, one composed answer, every figure verified', async () => {
    const zoneWindow = { zoneId: Z.off305, from: SINCE_9, to: NOW };
    const doc = (params: Anthropic.MessageCreateParamsNonStreaming) => {
      const mean = { evidenceId: 'T1.E1', path: 'metrics.temperature_c.mean_c' };
      const answer: AnswerDoc = {
        paragraphs: [{
          segments: [
            { kind: 'text', text: 'OFF-305 has averaged ' },
            { kind: 'num', value: 23.97, decimals: 2, unit: 'c', basis: 'measured', ref: mean, derive: null },
            { kind: 'text', text: ' since 09:00, which is ' },
            {
              kind: 'num', value: 0.97, decimals: 2, unit: 'k', basis: 'derived', ref: null,
              derive: { op: 'difference', refs: [mean, { evidenceId: 'C.1', path: `directory[${OFF305_INDEX}].designed_setpoint_c` }] },
            },
            { kind: 'text', text: ' above its designed setpoint: its VAV is near capacity.' },
            { kind: 'cite', evidenceIds: ['T1.E1'] },
          ],
        }],
        caveats: caveatsOf(evidenceIn(params), ['T1.E1', 'C.1']),
      };
      return composeMsg(answer);
    };
    const h = harness({
      planner: [
        plannerMsg({ intent: 'diagnose', next: 'dispatch', allowControl: false, tasks: [diagnoseTask(Z.off305, 'why OFF-305 warm')] }),
        plannerMsg({ next: 'compose' }),
      ],
      'diagnose:T1': [
        message([toolUse('zone_conditions', zoneWindow), toolUse('zone_timeline', { ...zoneWindow, limit: 20 })]),
        message([toolUse('equipment_status', { tag: null, zoneId: Z.off305 })]),
        message([REPORT([{ text: 'VAV near capacity', evidenceIds: ['T1.E1'] }])]),
      ],
      compose: [doc],
    });

    const { turn, trail, events } = await h.send('q1', 'Why has OFF-305 been warm since 9?');

    expect(trail).toEqual(['intake', 'orient', 'planner', 'diagnose', 'join', 'planner', 'compose', 'verify', 'finish']);
    expect([h.fake.model.count('planner'), h.fake.model.count('diagnose:T1'), h.fake.model.count('compose')]).toEqual([2, 3, 1]);
    expect(Object.keys((await h.state('q1')).evidence)).toEqual(['C.1', 'C.2', 'C.3', 'T1.E1', 'T1.E2', 'T1.E3']);
    expect(turn.answer).not.toBeNull();
    expect(turn.answer!.paragraphs.flat().filter((s) => s.kind === 'num').map((s) => s.text)).toEqual(['23.97 °C', '0.97 K']);
    expect(turn.cards.map((c) => c.id)).toEqual(['C.1', 'C.2', 'C.3', 'T1.E1', 'T1.E2', 'T1.E3']);
    expect(turn.tasks).toEqual([{ taskId: 'T1', specialist: 'diagnose', goal: 'why OFF-305 warm', status: 'answered', reason: null }]);
    expect(turn.dialogue.at(-1)).toMatchObject({ role: 'copilot' });
    expect((turn.dialogue.at(-1) as { text: string }).text).toContain('23.97 °C');
    expect(h.fake.issuer.issued).toHaveLength(0);
    expect(CopilotTurn.safeParse(turn).success).toBe(true);

    // The specialist saw its task and nothing of the parent's transcript.
    const firstCall = h.fake.model.calls['diagnose:T1']![0]!;
    expect(firstCall.messages).toHaveLength(1);
    expect(dataOf(firstCall)).toMatchObject({ taskId: 'T1', goal: 'why OFF-305 warm', zoneIds: [Z.off305] });

    // The panel heard the task start and end, three reads, and three records.
    expect(events.filter((e) => e.t === 'task').map((e) => (e.t === 'task' ? e.status : ''))).toEqual(['running', 'answered']);
    expect(events.filter((e) => e.t === 'activity')).toHaveLength(4);   // three reads and the report
    expect(events.filter((e) => e.t === 'evidence').map((e) => (e.t === 'evidence' ? e.id : ''))).toEqual(['T1.E1', 'T1.E2', 'T1.E3']);
    expect(events[0]).toEqual({ t: 'accepted', requestId: turn.requestId });
    expect(events.at(-1)).toEqual({ t: 'turn', turn });
  });

  it('2. a parallel wave: diagnose and analyse at the same time, joined once', async () => {
    const h = harness({
      planner: [
        plannerMsg({ intent: 'analyse', next: 'dispatch', tasks: [diagnoseTask(Z.off305, 'why OFF-305 warm'), analyseTask('which floor used most')] }),
        plannerMsg({ next: 'compose' }),
      ],
      'diagnose:T1': [message([toolUse('zone_conditions', { zoneId: Z.off305, from: SINCE_9, to: NOW })]), message([REPORT()])],
      'analyse:T2': [message([toolUse('energy_by_end_use', { from: WEEK_AGO, to: NOW, groupBy: 'floor' })]), message([REPORT()])],
      compose: [words('Both were looked at.')],
    });
    h.fake.reader.delayMs.set('zoneConditions', 40);
    h.fake.reader.delayMs.set('energyByEndUse', 20);

    const { trail } = await h.send('wave', 'why is OFF-305 warm, and which floor used most?');

    expect(trail.filter((n) => n === 'join')).toHaveLength(1);
    expect(trail.filter((n) => n === 'diagnose' || n === 'analyse').sort()).toEqual(['analyse', 'diagnose']);
    expect(h.fake.reader.spy.peakInFlight).toBe(2);
    const s = await h.state('wave');
    expect(Object.keys(s.findings).sort()).toEqual(['T1', 'T2']);
    expect(Object.values(s.tasks).map((t) => t.status)).toEqual(['done', 'done']);
    // Ids follow each task, whichever read finished first.
    expect(Object.keys(s.evidence).filter((id) => id.startsWith('T')).sort()).toEqual(['T1.E1', 'T2.E1']);
  });

  it('3. a second wave is handed the first wave\'s evidence', async () => {
    const h = harness({
      planner: [
        plannerMsg({ next: 'dispatch', tasks: [diagnoseTask(Z.off305, 'why OFF-305 warm'), analyseTask('rank the floors')] }),
        plannerMsg({ next: 'dispatch', tasks: [{ ...diagnoseTask(Z.off305, 'follow up on OFF-305'), inputEvidenceIds: ['T1.E1'] }] }),
        plannerMsg({ next: 'compose' }),
      ],
      'diagnose:T1': [message([toolUse('zone_conditions', { zoneId: Z.off305, from: SINCE_9, to: NOW })]), message([REPORT()])],
      'analyse:T2': [message([REPORT()])],
      'diagnose:T3': [message([REPORT()])],
      compose: [words('Followed up.')],
    });

    const { trail } = await h.send('waves', 'dig into OFF-305');

    expect(trail.filter((n) => n === 'join')).toHaveLength(2);
    const t3 = dataOf(h.fake.model.calls['diagnose:T3']![0]!);
    const inputs = t3.inputs as EvidenceRecord[];
    expect(inputs.map((e) => e.id)).toEqual(['T1.E1']);
    expect(inputs[0]).toEqual((await h.state('waves')).evidence['T1.E1']);
    // T1 was not given T2's work, nor T3 anything it was not handed.
    expect(dataOf(h.fake.model.calls['diagnose:T1']![0]!).inputs).toEqual([]);
  });

  it('4. compound (Q3): diagnose, then simulate, then propose — stops at confirm; the plan matches its simulation', async () => {
    const h = harness(compoundScript(), { scenarios: 'ok' });

    const { turn, trail, events } = await h.send('q3', 'Check the Level 3 offices, simulate a 1 K cooler setpoint against baseline, then propose it');

    expect(trail).toEqual([
      'intake', 'orient', 'planner', 'diagnose', 'join', 'planner', 'simulate', 'join', 'planner',
      'compose', 'verify', 'control', 'plan_check',
    ]);
    expect(turn.pendingPlan).not.toBeNull();
    expect(turn.pendingPlan!.simulation).toEqual({
      evidenceId: 'T2.E1', scenario: 'plus-1', zonesMatch: true, setpointsMatch: true, timing: 'whole_window_vs_override',
    });
    expect(turn.answer).not.toBeNull();
    expect(turn.answer!.caveatLines).toContain(CAVEAT_TEXT.SIM_ANALYTICALLY_VERIFIED);
    expect(turn.answer!.paragraphs.flat().find((s) => s.kind === 'num')).toMatchObject({ basis: 'simulated', simulated: true });
    expect(h.fake.issuer.issued).toHaveLength(0);
    expect(h.fake.scenarios!.requests).toHaveLength(2);
    const sims = events.flatMap((e) => (e.t === 'sim' ? [`${e.role}:${e.scenario}:${e.status}`] : []));
    expect(sims).toEqual(expect.arrayContaining(['baseline:baseline:completed', 'scenario:plus-1:completed']));
    const plan = events.find((e) => e.t === 'plan');
    expect(plan).toEqual({
      t: 'plan', interruptId: turn.pendingPlan!.interruptId, planId: turn.pendingPlan!.planId,
      planHash: turn.pendingPlan!.planHash, expiresAt: turn.pendingPlan!.expiresAt,
    });
    // The controller was handed the simulation it follows, in propose mode.
    const brief = dataOf(h.fake.model.calls.control![0]!) as { inputs: Array<{ id: string }>; mode: string };
    expect(brief.inputs.map((e) => e.id)).toEqual(['T2.E1']);
    expect(brief.mode).toBe('propose');

    const done = await h.decide('q3', turn, 'approved');
    expect(done.trail).toEqual(['confirm', 'apply', 'finish']);
    expect(h.fake.issuer.issued.map((c) => [c.zoneId, c.setpointTempC])).toEqual([[Z.off301, 24], [Z.off303, 24]]);
    expect(done.turn.outcomes.every((o) => o.result.ok)).toBe(true);
    expect(done.turn.pendingPlan).toBeNull();
  });

  it('4c. compound as the real planner wrote it: controlTask on the FIRST decision, before the simulation exists (E2E)', async () => {
    // The first real compound run: the planner dispatched diagnose and
    // simulate in one wave and gave the controlTask in that same first
    // decision, when no simulation id existed to name. The controller was
    // then never handed the simulation, could not name it as its basis, and
    // the card lost its "simulated as" badge. The request's simulated record
    // now reaches the controller whether or not the planner named it.
    const base = compoundScript();
    const zones = [Z.off301, Z.off303];
    const script: Script = {
      ...base,
      planner: [
        plannerMsg({
          intent: 'compound', allowControl: true, allowSimulation: true, next: 'dispatch',
          tasks: [
            { specialist: 'diagnose', goal: 'check the Level 3 offices', zoneIds: zones, from: SINCE_9, to: NOW },
            { specialist: 'simulate', goal: 'simulate a uniform shift against baseline', zoneIds: zones, from: null, to: null },
          ],
          controlTask: { mode: 'propose', brief: 'propose the shift that was simulated', inputEvidenceIds: ['C.3'] },
        }),
        plannerMsg({ next: 'compose' }),
      ],
      'simulate:T2': base['simulate:T2']!,
    };
    const h = harness(script, { scenarios: 'ok' });
    const { turn, trail } = await h.send('q4', 'Check the Level 3 offices, simulate a 1 K warmer setpoint, then propose it');

    expect(trail).toEqual(['intake', 'orient', 'planner', 'diagnose', 'simulate', 'join', 'planner', 'compose', 'verify', 'control', 'plan_check']);
    const brief = dataOf(h.fake.model.calls.control![0]!) as { inputs: Array<{ id: string }> };
    // The simulation first, then what the planner named.
    expect(brief.inputs.map((e) => e.id)).toEqual(['T2.E1', 'C.3']);
    expect(turn.pendingPlan!.simulation).toEqual({
      evidenceId: 'T2.E1', scenario: 'plus-1', zonesMatch: true, setpointsMatch: true, timing: 'whole_window_vs_override',
    });
    expect(h.fake.issuer.issued).toHaveLength(0);
  });

  it('4b. a plan whose setpoints differ from the simulation gets no match, and so no badge', async () => {
    const { simulationMatch } = await import('./plan-check.ts');
    const record: EvidenceRecord = {
      id: 'T2.E1', taskId: 'T2', tool: 'simulate_scenarios', kind: 'simulated', source: 'simulation', label: 'sim',
      window: null, coverage: null, flaggedExcluded_count: null, truncated: null, caveats: [], headline: [], at: NOW,
      data: { zone_ids: [Z.off301], scenarios: [{ name: 'plus-1', setpoint_delta_k: 1 }] },
    };
    const snap = orientFixture(Date.parse('2026-09-28T08:40:00Z'));
    const context = { directory: snap.directory } as unknown as Parameters<typeof simulationMatch>[2]['context'];
    const m = simulationMatch({ evidenceId: 'T2.E1', scenario: 'plus-1' },
      [{ zoneId: Z.off301, setpointTempC: 24.5 }, { zoneId: Z.off303, setpointTempC: 24 }], { evidence: { 'T2.E1': record }, context });
    expect(m).toMatchObject({ zonesMatch: false, setpointsMatch: false });
    expect(simulationMatch({ evidenceId: 'T2.E1', scenario: 'minus-1' }, [], { evidence: { 'T2.E1': record }, context })).toBeNull();
  });

  it('5. a specialist that fails never aborts or re-runs its siblings, and nothing throws', async () => {
    const script = (): Script => ({
      planner: [
        plannerMsg({ next: 'dispatch', tasks: [diagnoseTask(Z.off305, 'why OFF-305 warm'), analyseTask('rank the floors'), diagnoseTask(Z.off301, 'and OFF-301')] }),
        plannerMsg({ next: 'compose' }),
      ],
      // T1's read fails: it sees an is_error and reports what it could.
      'diagnose:T1': [message([toolUse('zone_conditions', { zoneId: Z.off305, from: SINCE_9, to: NOW })]), message([REPORT([], 'partial')])],
      'analyse:T2': [message([toolUse('energy_by_end_use', { from: WEEK_AGO, to: NOW, groupBy: 'floor' })]), message([REPORT()])],
      // T3's model call fails outright (an API error).
      'diagnose:T3': [Object.assign(new Error('overloaded'), { status: 529 })],
      compose: [words('One task could not complete.')],
    });
    const h = harness(script());
    h.fake.reader.throwOn.add('zoneConditions');
    h.fake.reader.delayMs.set('energyByEndUse', 30);

    const { turn } = await h.send('fails', 'look at OFF-305, OFF-301 and the floors');

    const s = await h.state('fails');
    expect(s.findings.T1).toMatchObject({ status: 'partial' });
    expect(s.findings.T2).toMatchObject({ status: 'answered' });
    expect(s.findings.T3).toMatchObject({ status: 'failed', reason: 'model_error' });
    // Each ran once: the failure re-ran nothing.
    expect(h.fake.reader.spy.calls.energyByEndUse).toHaveLength(1);
    expect(h.fake.reader.spy.calls.zoneConditions).toHaveLength(1);
    expect([h.fake.model.count('diagnose:T1'), h.fake.model.count('analyse:T2'), h.fake.model.count('diagnose:T3')]).toEqual([2, 2, 1]);
    const t1Results = toolResultsOf(h.fake.model.calls['diagnose:T1']![1]!);
    expect(t1Results[0]).toMatchObject({ is_error: true, content: expect.stringContaining('database unavailable') });
    expect(h.logger.records.map((r) => r.event)).toContain('copilot.specialist_failed');
    expect(turn.answer).not.toBeNull();
    // The error's message went nowhere near the turn.
    expect(JSON.stringify(turn)).not.toContain('overloaded');
  });

  it('6. a planner refusal acts on nothing and calls nothing else', async () => {
    const h = harness({ planner: [message([], 'refusal')] });
    const { turn, trail } = await h.send('refuse', 'do something');
    expect(turn.notices.map((n) => n.code)).toEqual(['model_refused']);
    expect(h.fake.model.count()).toBe(1);
    expect(trail).toEqual(['intake', 'orient', 'planner', 'finish']);
  });

  it('7. a planner that cannot decide falls back to v1 — the controller — for someone who may command', async () => {
    const h = harness({
      planner: [message([text('not json')]), message([text('still not json')])],
      control: [message([REPORT([], 'cannot_answer')])],
      compose: [words('Nothing was proposed.')],
    });
    await h.send('fallback', 'pre-cool level 3');
    expect(h.fake.model.count('planner')).toBe(2);
    expect(h.fake.model.count('control')).toBe(1);
    expect((await h.state('fallback')).scope).toEqual({ allowControl: true, allowSimulation: false, source: 'fallback' });
    expect(h.logger.records.map((r) => r.event)).toContain('copilot.planner_fallback');
    // The repair call carried the issue as data.
    expect(JSON.stringify(h.fake.model.calls.planner![1]!.messages)).toContain('not JSON');

    // …and for someone who may not command, it says it could not plan.
    const viewer = harness({ planner: [message([text('not json')]), message([text('still not json')])] });
    const { turn } = await viewer.send('fallback-viewer', 'pre-cool level 3', { mayCommand: false });
    expect(viewer.fake.model.count()).toBe(2);
    expect(turn.notices.map((n) => n.code)).toEqual(['planner_unavailable']);
  });

  it('8. clarify: the question is shown only if it passes the wording rules', async () => {
    const ok = harness({ planner: [plannerMsg({ next: 'finish', intent: 'clarify', message: 'Which floor?' })] });
    const { turn: t1 } = await ok.send('c1', 'make it nicer');
    expect(t1.message).toBe('Which floor?');
    expect(ok.fake.model.count()).toBe(1);
    expect(t1.dialogue.at(-1)).toEqual({ role: 'copilot', text: 'Which floor?', notices: [] });

    const figure = harness({ planner: [plannerMsg({ next: 'finish', intent: 'clarify', message: 'Should I set it to 22 °C?' })] });
    const { turn: t2 } = await figure.send('c2', 'make it nicer');
    expect(t2.message).toBeNull();
    expect(t2.notices.map((n) => n.code)).toEqual(['message_unverified']);
    expect(JSON.stringify(t2)).not.toContain('22 °C');
  });

  it('9. three drafts that fail verification leave evidence cards and a notice, never the prose', async () => {
    const bad = words('It is about 1 K warmer.');
    const h = harness({
      planner: [
        plannerMsg({ next: 'dispatch', tasks: [diagnoseTask(Z.off305, 'why OFF-305 warm')] }),
        plannerMsg({ next: 'compose' }),
      ],
      'diagnose:T1': [message([toolUse('zone_conditions', { zoneId: Z.off305, from: SINCE_9, to: NOW })]), message([REPORT()])],
      compose: [bad, bad, bad],
    });
    const { turn } = await h.send('drafts', 'why is OFF-305 warm');
    expect(h.fake.model.count('compose')).toBe(3);
    expect(turn.answer).toBeNull();
    expect(turn.cards.map((c) => c.id)).toContain('T1.E1');
    expect(turn.notices.map((n) => n.code)).toContain('verify_failed');
    expect(h.logger.records.map((r) => r.event)).toContain('copilot.verify_failed');
    // The retries carried the violations as data.
    expect(JSON.stringify(h.fake.model.calls.compose![1]!.messages)).toContain('unit_number_in_text');
    expect(JSON.stringify(turn)).not.toContain('about 1 K');
    expect(turn.dialogue.at(-1)).toMatchObject({ role: 'copilot', text: null });
  });

  it('10. the controller in check mode ("pre-cool tomorrow"): no plan, no confirm, and the answer says why', async () => {
    const h = harness({
      planner: [plannerMsg({
        intent: 'control', allowControl: true, next: 'control',
        controlTask: { mode: 'check', brief: 'pre-cool the Level 3 offices tomorrow morning' },
      })],
      control: [
        message([toolUse('control_envelope', {})]),
        message([REPORT([{ text: 'the envelope allows a pre-cool, but not a scheduled one', evidenceIds: ['K.E1'] }], 'cannot_answer')]),
      ],
      // The first draft forgets the caveat a check owes; the verifier sends it back.
      compose: [
        words('The Level 3 offices can be pre-cooled, but only once the window opens.'),
        words('The Level 3 offices can be pre-cooled, but only once the window opens.', [CHECK_MODE_CAVEAT]),
      ],
    });

    const { turn, trail } = await h.send('tomorrow', 'Pre-cool the Level 3 offices tomorrow at 7');

    expect(trail).toEqual(['intake', 'orient', 'planner', 'control', 'compose', 'verify', 'compose', 'verify', 'finish']);
    expect(trail).not.toContain('confirm');
    expect(turn.pendingPlan).toBeNull();
    expect(h.fake.probe.dryRuns).toHaveLength(0);
    // Check mode: propose_plan was never offered.
    expect(h.fake.model.calls.control![0]!.tools!.map((t) => (t as Anthropic.Tool).name)).not.toContain('propose_plan');
    const s = await h.state('tomorrow');
    expect(s.findings.K).toMatchObject({ status: 'cannot_answer', caveats: [CHECK_MODE_CAVEAT] });
    expect(JSON.stringify(h.fake.model.calls.compose![1]!.messages)).toContain('caveat_required');
    expect(turn.answer!.caveatLines).toEqual([CAVEAT_TEXT.NO_SCHEDULED_START]);
    expect(turn.tasks).toEqual([{ taskId: 'K', specialist: 'control', goal: 'pre-cool the Level 3 offices tomorrow morning', status: 'cannot_answer', reason: null }]);
  });

  it('10b. …and an answer that never carries that caveat is not shown, though its prose verifies against the evidence', async () => {
    const draft = words('The Level 3 offices can be pre-cooled, but only once the window opens.');
    const h = harness({
      planner: [plannerMsg({
        intent: 'control', allowControl: true, next: 'control',
        controlTask: { mode: 'check', brief: 'pre-cool the Level 3 offices tomorrow morning' },
      })],
      control: [message([REPORT([], 'cannot_answer')])],
      compose: [draft, draft, draft],
    });

    const { turn } = await h.send('tomorrow-bad', 'Pre-cool the Level 3 offices tomorrow at 7');

    expect(h.fake.model.count('compose')).toBe(3);
    expect(turn.answer).toBeNull();
    expect(turn.notices.map((n) => n.code)).toContain('verify_failed');
    expect(turn.dialogue.at(-1)).toMatchObject({ role: 'copilot', text: null });
    expect(JSON.stringify(turn)).not.toContain('only once the window opens');
  });

  it('11. an empty dispatch is repaired, never a silent end', async () => {
    const h = harness({
      planner: [
        plannerMsg({ next: 'dispatch', tasks: [] }),
        plannerMsg({ next: 'finish', intent: 'clarify', message: 'What should I look at?' }),
      ],
    });
    const { turn, events } = await h.send('empty', 'hmm');
    expect(h.fake.model.count('planner')).toBe(2);
    expect(JSON.stringify(h.fake.model.calls.planner![1]!.messages)).toContain('needs 1 to 4 tasks');
    expect(turn.message).toBe('What should I look at?');
    expect(events.at(-1)?.t).toBe('turn');
  });
});
