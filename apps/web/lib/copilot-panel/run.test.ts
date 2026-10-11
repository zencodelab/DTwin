import { describe, expect, it } from 'vitest';
import { buildCopilotGraph } from '../copilot/graph.ts';
import { inertDeps } from '../copilot/inert.ts';
import { COPILOT_NODES, type CopilotEvent, type CopilotNode } from '../copilot/protocol.ts';
import { TOOL_CLASS } from '../copilot/tools/index.ts';
import { card, planFixture, turnFixture } from './fixtures.ts';
import {
  ACTIVITY_CLASS, EMPTY, activeNodes, activityLines, applyEvents, applyTurn, beginDecision, beginMessage, chips,
  currentTurn, endStream, evidenceCards, hiddenSimRuns, isRunning, likelyNext, refuse, simRows, splitDialogue,
  type PanelState,
} from './run.ts';

/**
 * The panel's reducer over events and turns: one chip per task keyed by
 * task id, activity grouped per task, simulation rows merged with the
 * dashboard socket and capped at two, and a best guess at where the graph
 * is that never contradicts the compiled graph's edges.
 */

const RUN = '0b6d3c34-8f2a-4c1e-9d0a-3f5e7a9b1c2d';
const RUN2 = '1b6d3c34-8f2a-4c1e-9d0a-3f5e7a9b1c2d';
const RUN3 = '2b6d3c34-8f2a-4c1e-9d0a-3f5e7a9b1c2d';

const fold = (state: PanelState, ...events: CopilotEvent[]) => applyEvents(state, events);

describe('the reducer', () => {
  it('an event with no run on screen changes nothing', () => {
    expect(fold(EMPTY, { t: 'step', node: 'orient' })).toBe(EMPTY);
  });

  it('a message shows at once, and a run is running until its stream ends', () => {
    const s = beginMessage(EMPTY, 'why is OFF-305 warm?');
    expect(s.live).toMatchObject({ kind: 'message', asked: 'why is OFF-305 warm?', streaming: true });
    expect(isRunning(s)).toBe(true);
    const done = endStream(fold(s, { t: 'turn', turn: turnFixture() }), 'turn');
    expect(isRunning(done)).toBe(false);
    expect(done.live!.ended).toBe('turn');
  });

  it('one chip per task, keyed by task id, whatever happens inside it', () => {
    let s = beginMessage(EMPTY, 'q');
    // As a stream carries them: the planner dispatches inside its own step.
    s = fold(s,
      { t: 'step', node: 'intake' }, { t: 'step', node: 'orient' },
      { t: 'task', taskId: 'T1', specialist: 'diagnose', goal: 'why OFF-305 is warm', status: 'running' },
      { t: 'task', taskId: 'T2', specialist: 'analyse', goal: 'rank floors', status: 'running' },
      { t: 'step', node: 'planner' },
      { t: 'activity', taskId: 'T1', tool: 'zone_conditions', label: 'reading conditions for OFF-305' },
      { t: 'activity', taskId: 'T1', tool: 'zone_history', label: 'reading history for OFF-305' },
      { t: 'task', taskId: 'T2', specialist: 'analyse', goal: null, status: 'answered' },
      { t: 'step', node: 'analyse' },
    );
    expect(chips(s).map((c) => [c.key, c.text, c.tone])).toEqual([
      ['T1', 'Diagnosing', 'running'], ['T2', 'Analysing ✓', 'done'],
    ]);
    // The end event carries no goal; the dispatch's is kept for the tooltip.
    expect(chips(s)[1]!.title).toBe('rank floors');
    expect([...activeNodes(s)]).toEqual(['diagnose']);
    s = fold(s, { t: 'task', taskId: 'T1', specialist: 'diagnose', goal: null, status: 'partial' }, { t: 'step', node: 'diagnose' });
    expect(chips(s).map((c) => c.text)).toEqual(['Diagnosing · partial', 'Analysing ✓', 'Planning']);
  });

  it('while no task runs, one phase chip says where the graph is', () => {
    let s = beginMessage(EMPTY, 'q');
    expect(chips(s).map((c) => c.text)).toEqual(['Starting']);
    s = fold(s, { t: 'accepted', requestId: 'r' }, { t: 'step', node: 'intake' });
    expect(chips(s).map((c) => c.text)).toEqual(['Reading the building']);
    s = fold(s, { t: 'step', node: 'orient' });
    expect(chips(s).map((c) => c.text)).toEqual(['Planning']);
    s = fold(s,
      { t: 'task', taskId: 'T1', specialist: 'diagnose', goal: null, status: 'running' },
      { t: 'step', node: 'planner' }, { t: 'task', taskId: 'T1', specialist: 'diagnose', goal: null, status: 'answered' },
      { t: 'step', node: 'diagnose' }, { t: 'step', node: 'join' }, { t: 'step', node: 'planner' });
    expect(chips(s).map((c) => c.text)).toEqual(['Diagnosing ✓', 'Composing']);
    expect([...activeNodes(s)]).toEqual(['compose']);
    s = fold(s, { t: 'step', node: 'compose' }, { t: 'step', node: 'verify' });
    // verify leads to compose, control or finish, and the stream does not say which.
    expect(chips(s).map((c) => c.text)).toEqual(['Diagnosing ✓', 'Working']);
    expect(activeNodes(s).size).toBe(0);
  });

  it('a specialist whose task has ended is still lit until its own step arrives', () => {
    let s = beginMessage(EMPTY, 'q');
    s = fold(s, { t: 'step', node: 'intake' }, { t: 'step', node: 'orient' },
      { t: 'task', taskId: 'T1', specialist: 'diagnose', goal: null, status: 'running' });
    // Dispatched inside the planner, whose own step has not arrived yet.
    expect([...activeNodes(s)]).toEqual(['planner', 'diagnose']);
    s = fold(s, { t: 'step', node: 'planner' }, { t: 'task', taskId: 'T1', specialist: 'diagnose', goal: null, status: 'answered' });
    expect([...activeNodes(s)]).toEqual(['diagnose']);
    expect(chips(s).map((c) => c.key)).toEqual(['T1']); // no phase chip while a specialist finishes
    s = fold(s, { t: 'step', node: 'diagnose' });
    expect([...activeNodes(s)]).toEqual(['join']);
  });

  it('activity is grouped per task: "diagnose: 5 reads"', () => {
    let s = beginMessage(EMPTY, 'q');
    s = fold(s,
      { t: 'task', taskId: 'T1', specialist: 'diagnose', goal: null, status: 'running' },
      ...['zone_conditions', 'zone_history', 'zone_timeline', 'list_alerts', 'equipment_status', 'report_finding']
        .map((tool): CopilotEvent => ({ t: 'activity', taskId: 'T1', tool, label: `doing ${tool}` })),
      { t: 'activity', taskId: 'K', tool: 'dry_run_setpoint', label: 'dry-running a setpoint for OFF-301' },
      { t: 'activity', taskId: 'K', tool: 'unknown', label: 'an unknown tool' },
    );
    expect(activityLines(s)).toEqual([
      // report_finding ends a task; it is not a read.
      { key: 'T1', text: 'diagnose: 5 reads', last: 'doing report_finding' },
      { key: 'K', text: 'K: 1 dry run, 1 other call', last: 'an unknown tool' },
    ]);
  });

  it('evidence is recorded once per id; a plan marker lights confirm', () => {
    let s = beginMessage(EMPTY, 'q');
    const e: CopilotEvent = {
      t: 'evidence', id: 'T1.E1', taskId: 'T1', tool: 'zone_conditions', source: 'telemetry_5m', kind: 'measured',
      label: 'OFF-305 conditions', window: null, coverage: null, flaggedExcluded_count: null, truncated: null,
    };
    s = fold(s, e, e);
    expect(s.live!.evidence).toHaveLength(1);
    s = fold(s, { t: 'plan', interruptId: 'i', planId: planFixture().planId, planHash: 'a'.repeat(64), expiresAt: '2026-09-28T08:50:00.000Z' });
    expect([...activeNodes(s)]).toEqual(['confirm']);
    expect(chips(s).at(-1)!.text).toBe('Awaiting your decision');
  });

  it('a pending plan keeps confirm lit after the stream; nothing is lit when idle', () => {
    const waiting = endStream(fold(beginMessage(EMPTY, 'q'), { t: 'turn', turn: turnFixture({ pendingPlan: planFixture() }) }), 'turn');
    expect([...activeNodes(waiting)]).toEqual(['confirm']);
    expect(chips(waiting).some((c) => c.key === 'phase')).toBe(false);
    const idle = endStream(fold(beginMessage(EMPTY, 'q'), { t: 'turn', turn: turnFixture() }), 'turn');
    expect(activeNodes(idle).size).toBe(0);
  });

  it('the turn is authoritative for task status; the run keeps its activity beside it', () => {
    let s = beginMessage(EMPTY, 'q');
    s = fold(s,
      { t: 'task', taskId: 'T1', specialist: 'diagnose', goal: 'g', status: 'running' },
      { t: 'activity', taskId: 'T1', tool: 'zone_conditions', label: 'reading' },
      { t: 'turn', turn: turnFixture({ tasks: [
        { taskId: 'T1', specialist: 'diagnose', goal: 'g', status: 'partial', reason: 'turn_limit' },
        { taskId: 'K', specialist: 'control', goal: null, status: 'pending', reason: null },
      ] }) });
    s = endStream(s, 'turn');
    expect(chips(s).map((c) => [c.text, c.title])).toEqual([['Diagnosing · partial', 'g (turn limit)'], ['Dry-running · waiting', null]]);
    expect(activityLines(s)).toHaveLength(1);
  });

  it('a decision resumes the same request: its tasks stay, its progress restarts inside confirm', () => {
    let s = beginMessage(EMPTY, 'q');
    s = fold(s, { t: 'accepted', requestId: 'r' }, { t: 'task', taskId: 'T1', specialist: 'diagnose', goal: null, status: 'answered' });
    s = endStream(fold(s, { t: 'turn', turn: turnFixture({ requestId: 'r', pendingPlan: planFixture() }) }), 'turn');
    s = beginDecision(s, 'approved');
    expect(s.live).toMatchObject({ kind: 'decision', decision: 'approved', requestId: 'r', lastStep: null, plan: null });
    expect(s.live!.tasks.map((t) => t.taskId)).toEqual(['T1']);
    expect([...activeNodes(s)]).toEqual(['confirm']);
    expect(chips(s).at(-1)!.text).toBe('Recording your decision');
    s = fold(s, { t: 'step', node: 'confirm' });
    expect(chips(s).at(-1)!.text).toBe('Issuing');
    expect([...activeNodes(beginDecision(EMPTY, 'declined'))]).toEqual(['confirm']);
  });

  it('a whole turn from GET replaces the picture unless it answers the run on screen', () => {
    let s = beginMessage(EMPTY, 'q');
    s = endStream(fold(s, { t: 'accepted', requestId: 'r' }, { t: 'activity', taskId: 'T1', tool: 'zone_history', label: 'x' }), 'lost');
    expect(s.live!.ended).toBe('lost');
    const same = applyTurn(s, turnFixture({ requestId: 'r' }));
    expect(same.live).not.toBeNull();
    const other = applyTurn(s, turnFixture({ requestId: 'someone-else' }));
    expect(other).toEqual({ turn: turnFixture({ requestId: 'someone-else' }), live: null });
    // While a stream is open, a GET turn does not end it.
    const open = applyTurn(beginMessage(EMPTY, 'q'), turnFixture({ running: true }));
    expect(open.live!.streaming).toBe(true);
    expect(isRunning(applyTurn(EMPTY, turnFixture({ running: true })))).toBe(true);
  });

  it('an error event ends the run as an error', () => {
    const s = endStream(fold(beginMessage(EMPTY, 'q'), { t: 'error', error: 'the copilot could not complete this turn', requestId: 'r' }), 'error');
    expect(s.live).toMatchObject({ ended: 'error', requestId: 'r', streaming: false });
  });
});

describe('what belongs to the current request', () => {
  const previous = turnFixture({
    requestId: 'old',
    dialogue: [
      { role: 'operator', text: 'first question' },
      { role: 'copilot', text: 'first answer', notices: [] },
      { role: 'operator', text: 'pre-cool L3' },
    ],
    pendingPlan: planFixture(),
    cards: [card('C.1')],
  });
  const settled: PanelState = { turn: previous, live: null };

  it('with nothing running, the last operator message is the current one and the rest is history', () => {
    expect(currentTurn(settled)).toBe(previous);
    expect(splitDialogue(settled)).toEqual({
      history: [{ role: 'operator', text: 'first question' }, { role: 'copilot', text: 'first answer', notices: [] }],
      asked: 'pre-cool L3',
    });
  });

  it('a new message makes the previous answer, plan and cards history at once, before its own turn arrives', () => {
    let s = beginMessage(settled, 'actually, why is OFF-305 warm?');
    expect(currentTurn(s)).toBeNull();
    expect(splitDialogue(s)).toEqual({ history: previous.dialogue, asked: 'actually, why is OFF-305 warm?' });
    expect(evidenceCards(s)).toEqual([]);
    s = fold(s, { t: 'accepted', requestId: 'new' }, {
      t: 'evidence', id: 'T1.E1', taskId: 'T1', tool: 'zone_conditions', source: 'telemetry_5m', kind: 'measured',
      label: 'OFF-305 conditions', window: null, coverage: null, flaggedExcluded_count: null, truncated: null,
    });
    // Provisional cards from the stream; their headlines come with the turn.
    expect(evidenceCards(s)).toEqual([card('T1.E1', { label: 'OFF-305 conditions' })]);
    const next = turnFixture({ requestId: 'new', cards: [card('T1.E1', { headline: [{ label: 'Mean', text: '24.1 °C' }] })] });
    s = fold(s, { t: 'turn', turn: next });
    expect(currentTurn(s)).toBe(next);
    expect(evidenceCards(s)[0]!.headline).toHaveLength(1);
  });

  it('a decision keeps the current turn — the plan card stays up while the decision runs', () => {
    const s = beginDecision({ turn: previous, live: null }, 'approved');
    expect(currentTurn(s)?.pendingPlan).not.toBeNull();
    expect(splitDialogue(s).asked).toBe('pre-cool L3');
  });

  it('a refusal before any run puts back what was on screen', () => {
    const first = endStream(fold(beginMessage(EMPTY, 'q1'), { t: 'accepted', requestId: 'r1' }, { t: 'turn', turn: turnFixture({ requestId: 'r1' }) }), 'turn');
    const refused = refuse(beginMessage(first, 'q2'));
    expect(refused.live).toEqual({ ...first.live!, previous: null });
    expect(refuse(beginMessage(EMPTY, 'q'))).toEqual(EMPTY);
    // Only one level is kept.
    expect(beginMessage(beginMessage(first, 'a'), 'b').live!.previous!.previous).toBeNull();
  });
});

describe('simulation rows', () => {
  const sim = (runId: string, role: 'baseline' | 'scenario', scenario: string, status: 'queued' | 'running' | 'completed' | 'failed', progressPct: number): CopilotEvent =>
    ({ t: 'sim', taskId: 'T2', runId, role, scenario, status, progressPct });

  it('merge the socket\'s live progress for the same run; a finished status wins; at most two', () => {
    let s = beginMessage(EMPTY, 'q');
    s = fold(s,
      { t: 'task', taskId: 'T2', specialist: 'simulate', goal: null, status: 'running' },
      sim(RUN, 'baseline', 'baseline', 'running', 10),
      sim(RUN2, 'scenario', 'plus-1', 'queued', 0),
      sim(RUN3, 'scenario', 'minus-1', 'queued', 0),
    );
    const socket = new Map([
      [RUN, { progressPct: 66, status: 'running' as const }],
      [RUN2, { progressPct: 0, status: 'completed' as const }],
    ]);
    expect(simRows(s, socket)).toEqual([
      { runId: RUN, taskId: 'T2', label: 'baseline', status: 'running', progressPct: 66 },
      { runId: RUN3, taskId: 'T2', label: 'minus-1', status: 'queued', progressPct: 0 },
    ]);
    expect(hiddenSimRuns(s)).toBe(1);
    // The simulate chip shows the mean progress of its runs: (66 + 100 + 0) / 3.
    expect(chips(s, socket)[0]!.text).toBe('Simulating 55%');
    // The socket never takes a finished run back to running.
    s = fold(s, sim(RUN, 'baseline', 'baseline', 'completed', 100));
    expect(simRows(s, new Map([[RUN, { progressPct: 70, status: 'running' as const }]]), 5)[0]).toMatchObject({ runId: RUN2, status: 'queued' });
    expect(simRows(s, new Map(), 5).find((r) => r.runId === RUN)).toMatchObject({ status: 'completed', progressPct: 100 });
  });
});

describe('the reducer agrees with the code it mirrors', () => {
  it('ACTIVITY_CLASS is the tools module\'s TOOL_CLASS, verbatim', () => {
    expect(ACTIVITY_CLASS).toEqual(TOOL_CLASS);
  });

  it('every guess at the next node is reachable in the compiled graph in at most two steps', async () => {
    const g = await buildCopilotGraph(inertDeps()).getGraphAsync();
    const next = new Map<string, string[]>();
    for (const e of g.edges) next.set(e.source, [...(next.get(e.source) ?? []), e.target]);
    const within2 = (from: string, to: string) =>
      (next.get(from) ?? []).some((m) => m === to || (next.get(m) ?? []).includes(to));
    const opts = [
      { hasFindings: true, decision: null }, { hasFindings: false, decision: null },
      { hasFindings: false, decision: 'approved' as const }, { hasFindings: false, decision: 'declined' as const },
    ];
    for (const last of [null, ...COPILOT_NODES] as Array<CopilotNode | null>) {
      for (const o of opts) {
        const guess = likelyNext(last, o);
        if (guess === null) continue;
        if (last === null) {
          // A message starts at intake; a decision resumes inside confirm.
          expect(guess).toBe(o.decision ? 'confirm' : 'intake');
          continue;
        }
        expect(within2(last, guess), `${last} → ${guess}`).toBe(true);
      }
    }
    expect(within2('__start__', 'intake')).toBe(true);
  });
});
