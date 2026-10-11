import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { memoryLogger } from '../log.ts';
import { PLANNER_TARGETS } from './fanout.ts';
import { NODE_ROLES, RECURSION_LIMIT, buildCopilotGraph } from './graph.ts';
import { inertDeps } from './inert.ts';
import { decide, sendMessage } from './session.ts';
import {
  Z, composeMsg, fakeDeps, message, plannerMsg, toolUse, type Script,
} from './testing/fakes.ts';

/**
 * The safety argument, read off the COMPILED graph — the same object
 * `npm run copilot:graph` renders and the panel draws — flat and xray
 * (design §7 P1–P3, §10 structure.test.ts).
 *
 * The edge list is the first lock, not the only one: the source scan forbids
 * the constructs that route around drawn edges, `confirm` pauses however it
 * is entered, and `apply` issues only a frozen grant. But if anyone adds a
 * second way into `apply`, THIS fails first.
 */

type Drawable = Awaited<ReturnType<ReturnType<typeof buildCopilotGraph>['getGraphAsync']>>;

const compiled = buildCopilotGraph(inertDeps());
const graphs = async () => ({ flat: await compiled.getGraphAsync(), xray: await compiled.getGraphAsync({ xray: true }) });

const into = (g: Drawable, target: string) => g.edges.filter((e) => e.target === target).map((e) => e.source).sort();
const out = (g: Drawable, source: string) => g.edges.filter((e) => e.source === source).map((e) => e.target).sort();

/** Depth-first from __start__, never stepping through `barrier`. */
function reachable(g: Drawable, barrier: string): Set<string> {
  const next = new Map<string, string[]>();
  for (const e of g.edges) next.set(e.source, [...(next.get(e.source) ?? []), e.target]);
  const seen = new Set<string>();
  const stack = ['__start__'];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (seen.has(n) || n === barrier) continue;
    seen.add(n);
    for (const m of next.get(n) ?? []) stack.push(m);
  }
  return seen;
}

const TOP_LEVEL = [
  '__start__', 'intake', 'orient', 'planner', 'diagnose', 'analyse', 'simulate', 'join', 'compose', 'verify',
  'control', 'plan_check', 'confirm', 'apply', 'declined', 'finish', '__end__',
];
const SUBGRAPHS = ['diagnose', 'analyse', 'simulate', 'control'];
const INNER = ['__start__', 'agent', 'tools', 'finish'];

describe('the compiled graph, as LangGraph draws it', () => {
  it('1. apply has one way in: from confirm, flat and xray', async () => {
    const { flat, xray } = await graphs();
    expect(into(flat, 'apply')).toEqual(['confirm']);
    expect(into(xray, 'apply')).toEqual(['confirm']);
  });

  it('2. the gate chain: control → plan_check → confirm → apply → finish', async () => {
    const { flat, xray } = await graphs();
    expect(into(flat, 'confirm')).toEqual(['plan_check']);
    expect(into(flat, 'plan_check')).toEqual(['control']);
    expect(into(flat, 'control')).toEqual(['planner', 'verify']);
    expect(into(flat, '__end__')).toEqual(['finish']);
    expect(out(flat, 'apply')).toEqual(['finish']);

    expect(into(xray, 'confirm')).toEqual(['plan_check']);
    expect(into(xray, 'plan_check')).toEqual(['control:finish']);
    expect(into(xray, 'control:__start__')).toEqual(['planner', 'verify']);
    expect(into(xray, '__end__')).toEqual(['finish']);
    expect(out(xray, 'apply')).toEqual(['finish']);
  });

  it('3. DFS barrier: no walk from __start__ reaches apply without passing confirm', async () => {
    const { flat, xray } = await graphs();
    const f = reachable(flat, 'confirm');
    expect(f.has('apply')).toBe(false);
    for (const n of ['diagnose', 'analyse', 'simulate', 'compose', 'finish', 'plan_check']) expect(f.has(n)).toBe(true);

    const x = reachable(xray, 'confirm');
    expect(x.has('apply')).toBe(false);
    for (const n of ['diagnose:agent', 'analyse:agent', 'simulate:agent', 'control:agent', 'compose', 'finish', 'plan_check']) {
      expect(x.has(n)).toBe(true);
    }
  });

  it('4. specialists, join, compose and verify have no edge into the gate (xray)', async () => {
    const { xray } = await graphs();
    const readers = (s: string) => ['diagnose:', 'analyse:', 'simulate:'].some((p) => s.startsWith(p))
      || s === 'join' || s === 'compose' || s === 'verify';
    const gate = new Set(['plan_check', 'confirm', 'apply']);
    const bad = xray.edges.filter((e) => readers(e.source) && gate.has(e.target));
    expect(bad).toEqual([]);
    // …and the only edge into the gate from a subgraph is the controller's finish.
    const fromSubgraphs = xray.edges.filter((e) => e.source.includes(':') && gate.has(e.target)).map((e) => `${e.source}->${e.target}`);
    expect(fromSubgraphs).toEqual(['control:finish->plan_check']);
  });

  it('5. lists its nodes verbatim, and xray expands each specialist to __start__, agent, tools, finish', async () => {
    const { flat, xray } = await graphs();
    expect(Object.keys(flat.nodes)).toEqual(TOP_LEVEL);
    const expanded = TOP_LEVEL.flatMap((n) => (SUBGRAPHS.includes(n) ? INNER.map((i) => `${n}:${i}`) : [n]));
    expect(Object.keys(xray.nodes)).toEqual(expanded);
  });

  it('6. draws the planner\'s conditional edges as exactly its path list', async () => {
    const { flat } = await graphs();
    const edges = flat.edges.filter((e) => e.source === 'planner');
    expect(edges.every((e) => e.conditional)).toBe(true);
    expect(edges.map((e) => e.target).sort()).toEqual([...PLANNER_TARGETS].sort());
  });

  it('7. NODE_ROLES names every node, and only apply writes the building', async () => {
    const { flat } = await graphs();
    expect(Object.keys(NODE_ROLES).sort()).toEqual(TOP_LEVEL.filter((n) => !n.startsWith('__')).sort());
    expect(Object.entries(NODE_ROLES).filter(([, r]) => r === 'writes-building').map(([n]) => n)).toEqual(['apply']);
    expect(Object.entries(NODE_ROLES).filter(([, r]) => r === 'interrupt').map(([n]) => n)).toEqual(['confirm']);
    expect(flat.drawMermaid()).toContain('confirm -.-> apply');
  });

  it('8. RECURSION_LIMIT covers the worst case: three full waves, three failing drafts, the controller and the gate', async () => {
    // Every specialist task spends all its turns on calls that are refused
    // (so no evidence is used up), the planner dispatches three waves (4 + 3
    // + 1 tasks: the request's 8), every draft fails verification, and then
    // the controller proposes. Each graph level must finish inside
    // RECURSION_LIMIT supersteps, and the resume must too.
    const turns = 6;
    const busy = (): Anthropic.Message[] => Array.from({ length: turns }, () => message([toolUse('zone_conditions', {})]));
    const task = (goal: string) => ({ specialist: 'diagnose' as const, goal });
    const bad = composeMsg({ paragraphs: [{ segments: [{ kind: 'text', text: 'It is about 1 K warmer.' }] }], caveats: [] });
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
          toolUse('report_finding', { status: 'answered', summary: 'proposed', claims: [], openQuestions: [], caveats: [] }),
        ]),
      ],
    };
    for (let i = 1; i <= 8; i += 1) script[`diagnose:T${i}`] = busy();

    const fake = fakeDeps({ script, limits: { maxModelCalls: 200 } });
    const logger = memoryLogger();
    const graph = buildCopilotGraph({ ...fake.deps, log: logger });

    const turn = await sendMessage(graph, 'worst', 'look at everything, then pre-cool L3', { mayCommand: true });

    expect(RECURSION_LIMIT).toBe(40);
    expect(fake.model.count('planner')).toBe(3);   // the 4th planner execution is past the wave limit: no call
    expect(fake.model.count('compose')).toBe(3);
    for (let i = 1; i <= 8; i += 1) expect(fake.model.count(`diagnose:T${i}`)).toBe(turns);
    expect(turn.tasks.filter((t) => t.taskId !== 'K').map((t) => [t.status, t.reason]))
      .toEqual(Array.from({ length: 8 }, () => ['partial', 'turn_limit']));
    expect(turn.notices.map((n) => n.code)).toEqual(expect.arrayContaining(['wave_limit', 'verify_failed']));
    expect(turn.answer).toBeNull();
    expect(turn.pendingPlan).not.toBeNull();

    const done = await decide(graph, 'worst', {
      decision: 'approved', interruptId: turn.pendingPlan!.interruptId,
      planId: turn.pendingPlan!.planId, planHash: turn.pendingPlan!.planHash,
    });
    expect(fake.issuer.issued).toHaveLength(1);
    expect(done.outcomes).toHaveLength(1);
  });
});
