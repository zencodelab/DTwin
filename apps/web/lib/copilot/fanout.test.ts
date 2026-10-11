import { describe, expect, it } from 'vitest';
import { Send } from '@langchain/langgraph';
import { SPECIALIST_NODES, afterPlanner, join } from './fanout.ts';
import type { CopilotStateType, TaskSpec } from './state.ts';
import { ZONES, orientFixture } from './testing/fakes.ts';

/**
 * The fan-out router (design §10 fanout.test.ts). Its one job besides
 * dispatching is never to return an EMPTY Send list: LangGraph treats that as
 * "nothing to do", skips the join and ends the run without a word (fact 3).
 * So it is run against a thousand generated states, sane and not.
 */

/** A small deterministic PRNG, so a failure names a seed that reproduces. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const snapshot = orientFixture(Date.parse('2026-09-28T08:40:00Z'));
const CONTEXT: NonNullable<CopilotStateType['context']> = {
  building: { id: snapshot.building!.id, name: snapshot.building!.name, timezone: snapshot.building!.timezone, grossFloorAreaM2: 4800 },
  directory: snapshot.directory,
  availability: {
    perFloorEnergyMeter: true, perZoneEnergyMeter: false, meters: [], plugLoadMetered: false, forecastWeather: false,
    observedWeather: false, telemetryFrom: null, telemetryTo: null,
  },
  envelope: null,
  sim: { available: true, reason: null },
};
const REQUEST: NonNullable<CopilotStateType['request']> = {
  requestId: 'r', seq: 1, text: 'why', nowIso: '2026-09-28T12:40:00+04:00', timezone: 'Asia/Dubai',
  localDate: '2026-09-28', weekday: 'Monday', userId: 'u', mayCommand: true,
};

function generate(rand: () => number): CopilotStateType {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const specialists = [...SPECIALIST_NODES, 'control', 'nonsense'] as const;
  const tasks: Record<string, TaskSpec> = {};
  const n = Math.floor(rand() * 9);
  for (let i = 1; i <= n; i += 1) {
    tasks[`T${i}`] = {
      taskId: `T${i}`, specialist: pick(specialists) as TaskSpec['specialist'], goal: 'a goal', zoneIds: [pick(ZONES).id],
      from: null, to: null, inputEvidenceIds: [], wave: 1 + Math.floor(rand() * 3), status: pick(['running', 'done'] as const),
    };
  }
  const ids = [...Object.keys(tasks), 'T9', 'K', ''];
  const findings: CopilotStateType['findings'] = {};
  for (const id of Object.keys(tasks)) {
    if (rand() < 0.4) {
      findings[id] = {
        taskId: id, specialist: 'diagnose', status: 'answered', reason: null, summary: '', claims: [],
        openQuestions: [], caveats: [], evidenceIds: [],
      };
    }
  }
  const route = rand() < 0.1 ? null : {
    next: pick(['dispatch', 'compose', 'control', 'finish'] as const),
    taskIds: ids.filter(() => rand() < 0.5),
    interpretation: null,
    message: null,
  };
  return {
    inbox: null,
    request: rand() < 0.9 ? REQUEST : null,
    dialogue: [],
    context: rand() < 0.9 ? CONTEXT : null,
    scope: rand() < 0.2 ? null : { allowControl: rand() < 0.5, allowSimulation: rand() < 0.5, source: 'planner' },
    plannerRoute: route,
    waves: Math.floor(rand() * 4),
    taskSeq: n,
    tasks,
    findings,
    evidence: {},
    simRuns: {},
    controlTask: rand() < 0.5 ? null : { mode: pick(['propose', 'check'] as const), brief: 'b', inputEvidenceIds: [], status: pick(['pending', 'done'] as const) },
    proposal: null,
    answer: null,
    violations: [],
    drafts: 0,
    notices: [],
    pendingPlan: null,
    decision: null,
    outcomes: [],
    usage: null,
  };
}

describe('afterPlanner', () => {
  it('1. never returns an empty array: 1,000 generated states', () => {
    const rand = prng(20260928);
    const seen = { sends: 0, compose: 0, control: 0, finish: 0 };
    for (let i = 0; i < 1000; i += 1) {
      const s = generate(rand);
      const r = afterPlanner(s);
      if (Array.isArray(r)) {
        expect(r.length, `state ${i}`).toBeGreaterThan(0);
        for (const send of r) expect(send).toBeInstanceOf(Send);
        seen.sends += 1;
      } else {
        expect(['compose', 'control', 'finish'], `state ${i}`).toContain(r);
        seen[r] += 1;
      }
    }
    // The generator reached every outcome, so the property was tested, not assumed.
    for (const n of Object.values(seen)) expect(n).toBeGreaterThan(0);
  });

  it('2. sends only to the three specialists, each carrying its task', () => {
    const rand = prng(7);
    for (let i = 0; i < 1000; i += 1) {
      const s = generate(rand);
      const r = afterPlanner(s);
      if (!Array.isArray(r)) continue;
      for (const send of r) {
        expect(SPECIALIST_NODES).toContain(send.node);
        const task = (send.args as { task: { taskId: string; specialist: string } }).task;
        expect(task.specialist).toBe(send.node);
        expect(s.plannerRoute!.taskIds).toContain(task.taskId);
      }
    }
  });

  it('3. routes to control only before anything was found', () => {
    const base = generate(prng(1));
    const s: CopilotStateType = {
      ...base, request: REQUEST, context: CONTEXT,
      scope: { allowControl: true, allowSimulation: false, source: 'planner' },
      controlTask: { mode: 'propose', brief: 'pre-cool', inputEvidenceIds: [], status: 'pending' },
      plannerRoute: { next: 'control', taskIds: [], interpretation: null, message: null },
      findings: {},
    };
    expect(afterPlanner(s)).toBe('control');
    const withFindings: CopilotStateType = {
      ...s,
      findings: {
        T1: {
          taskId: 'T1', specialist: 'diagnose', status: 'answered', reason: null, summary: '', claims: [],
          openQuestions: [], caveats: [], evidenceIds: [],
        },
      },
    };
    expect(afterPlanner(withFindings)).toBe('compose');
    // …and never for a request that may not control, whatever the route says.
    expect(afterPlanner({ ...s, request: { ...REQUEST, mayCommand: false } })).toBe('finish');
    expect(afterPlanner({ ...s, scope: { ...s.scope!, allowControl: false } })).toBe('finish');
  });

  it('turns an empty dispatch into compose when something was found, else finish', () => {
    const s = generate(prng(3));
    const empty: CopilotStateType = {
      ...s, request: REQUEST, context: CONTEXT, tasks: {},
      plannerRoute: { next: 'dispatch', taskIds: [], interpretation: null, message: null },
    };
    expect(afterPlanner({ ...empty, findings: {} })).toBe('finish');
    expect(afterPlanner({
      ...empty,
      findings: {
        T1: {
          taskId: 'T1', specialist: 'analyse', status: 'partial', reason: 'budget', summary: '', claims: [],
          openQuestions: [], caveats: [], evidenceIds: [],
        },
      },
    })).toBe('compose');
  });
});

describe('join', () => {
  it('marks exactly the running tasks that reported as done', () => {
    const s = generate(prng(11));
    const tasks: Record<string, TaskSpec> = {
      T1: { taskId: 'T1', specialist: 'diagnose', goal: 'g', zoneIds: [], from: null, to: null, inputEvidenceIds: [], wave: 1, status: 'running' },
      T2: { taskId: 'T2', specialist: 'analyse', goal: 'g', zoneIds: [], from: null, to: null, inputEvidenceIds: [], wave: 1, status: 'running' },
    };
    const findings = {
      T1: {
        taskId: 'T1', specialist: 'diagnose' as const, status: 'answered' as const, reason: null, summary: '',
        claims: [], openQuestions: [], caveats: [], evidenceIds: [],
      },
    };
    expect(join({ ...s, tasks, findings })).toEqual({ tasks: { T1: { ...tasks.T1, status: 'done' } } });
  });
});
