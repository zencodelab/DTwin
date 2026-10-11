import { describe, expect, it, vi } from 'vitest';
import {
  Command, END, MemorySaver, START, Send, StateGraph, isInterrupted, type LangGraphRunnableConfig,
} from '@langchain/langgraph';
import { memoryLogger } from '../log.ts';
import { makeApply } from './apply.ts';
import { makeConfirm } from './confirm.ts';
import type { ControlProbe, IssueResult, Issuer } from './deps.ts';
import { buildCopilotGraph, copilotControls, type CopilotGraph } from './graph.ts';
import { ApprovalLedger, hashCommands } from './ledger.ts';
import { makeIntake } from './lifecycle.ts';
import { DEFAULT_LIMITS, resolveLimits } from './limits.ts';
import { makePlanCheck } from './plan-check.ts';
import { RunRegistry } from './registry.ts';
import {
  LockConflict, NoPendingPlan, PlanExpired, decide, pendingDecision, runTurn, sendMessage, stop, type DecisionRequest,
} from './session.ts';
import { CopilotState, type CopilotStateType, type CopilotUpdate, type ReviewedPlan } from './state.ts';
import { USER_ID, Z, fakeDeps, fakeIssuer, message, plannerMsg, toolUse } from './testing/fakes.ts';
import { harness } from './testing/run.ts';
import { fastPathScript } from './testing/scripts.ts';

/**
 * The one door, tested by trying to get round it (design §7 P5–P8 and P14,
 * §10 safety.test.ts 1–8).
 *
 * The structure tests prove the DRAWN graph has one way into `apply`. These
 * prove what happens when something reaches `apply` or `confirm` by a route
 * the drawing cannot show — a Command goto, a stray Send, an error handler —
 * and when a decision is doubled, stale, expired, forged or superseded. The
 * answer each time is the same: nothing is issued that a person did not
 * approve, and nothing a person approved is issued twice.
 *
 * The toy graphs below build `Command({goto})`, `Send` outside a path list
 * and `errorHandler` on purpose. Test files are outside the source scan;
 * production code may contain none of them.
 */

const T = 'thread-safety';
const cfg = (threadId = T): LangGraphRunnableConfig => ({ configurable: { thread_id: threadId } });

function reviewed(commands: Array<{ zoneId: string; zoneName: string; setpointTempC: number; reason: string }>, planId: string): ReviewedPlan {
  const withVerdicts = commands.map((c) => ({
    ...c, durationS: 3600,
    verdict: { allowed: true as const, previousTempC: 23, durationS: 3600, effectiveUntil: '2026-09-28T09:40:00.000Z' },
  }));
  return {
    planId, planHash: hashCommands(withVerdicts), checkedAt: '2026-09-28T08:40:00.000Z',
    expiresAt: '2026-09-28T08:50:00.000Z', summary: 'forged', commands: withVerdicts, simulation: null,
  };
}

const PLAN_ID = '4b0c3c1e-7c1a-4a8e-9d1f-2a7f3a4c5d6e';
const P = reviewed([{ zoneId: Z.off301, zoneName: 'OFF-301', setpointTempC: 22, reason: 'the plan the operator approved' }], PLAN_ID);
/** Same id, different commands: what a forged state would carry. */
const P_PRIME = reviewed([{ zoneId: Z.off303, zoneName: 'OFF-303', setpointTempC: 18, reason: 'a plan nobody approved' }], PLAN_ID);

const FAST_PATH = fastPathScript;

const decisionOf = (turn: { pendingPlan: { interruptId: string; planId: string; planHash: string } | null }, decision: 'approved' | 'declined' = 'approved'): DecisionRequest => ({
  decision, interruptId: turn.pendingPlan!.interruptId, planId: turn.pendingPlan!.planId, planHash: turn.pendingPlan!.planHash,
});

describe('safety', () => {
  it('1. forged routes into the REAL apply issue nothing: Command goto, Send outside the path list, errorHandler goto', async () => {
    const forged = { pendingPlan: P, decision: 'approved' as const };
    const routes = {
      commandGoto: (apply: ReturnType<typeof makeApply>) => new StateGraph(CopilotState)
        .addNode('rogue', (_s: CopilotStateType) => new Command({ goto: 'apply', update: forged }), { ends: ['apply'] })
        .addNode('apply', apply)
        .addEdge(START, 'rogue').addEdge('apply', END),
      // `gate → apply` is the drawn door, and never runs: the router's Send goes round it.
      sendOutsidePathList: (apply: ReturnType<typeof makeApply>) => new StateGraph(CopilotState)
        .addNode('fan', (_s: CopilotStateType) => ({}))
        .addNode('gate', (_s: CopilotStateType) => ({}))
        .addNode('apply', apply)
        .addEdge(START, 'fan')
        .addConditionalEdges('fan', () => [new Send('apply', forged)] as unknown as 'gate', ['gate'])
        .addEdge('gate', 'apply').addEdge('apply', END),
      errorHandlerGoto: (apply: ReturnType<typeof makeApply>) => new StateGraph(CopilotState)
        .addNode('tools', (_s: CopilotStateType): CopilotUpdate => { throw new Error('boom'); }, {
          errorHandler: (() => new Command({ goto: 'apply', update: forged })) as never,
        })
        .addNode('apply', apply)
        .addEdge(START, 'tools').addEdge('tools', END).addEdge('apply', END),
    };

    for (const [name, build] of Object.entries(routes)) {
      const issuer = fakeIssuer();
      const ledger = new ApprovalLedger();
      // A real approval on ANOTHER thread: a forged route here must not reach it.
      expect(ledger.grant('someone-else', reviewed([{ zoneId: Z.off301, zoneName: 'OFF-301', setpointTempC: 23, reason: 'theirs' }],
        '0f1e2d3c-4b5a-4968-8776-655443322110'))).toBe(true);
      const logger = memoryLogger();
      const graph = build(makeApply(issuer.issuer, ledger, logger, () => false)).compile();

      const out = await graph.invoke({}, cfg());

      expect(issuer.issued, name).toEqual([]);
      expect(logger.records.map((r) => r.event), name).toContain('copilot.apply_refused');
      expect(out.notices.map((n) => n.code), name).toContain('apply_refused');
      expect(out.pendingPlan, name).toBeNull();
      expect(ledger.has('someone-else'), name).toBe(true);
    }
  });

  it('1b. a forged updateState(…, "confirm") on the REAL graph routes into apply — and apply issues nothing', async () => {
    // Gate finding (scratchpad lg/e12_updatestate.ts, LangGraph 1.4.17):
    // `updateState(config, values, asNode)` writes as if `asNode` had run, so
    // the next invoke continues from that node's edges. Written as `confirm`,
    // it reaches `apply` without `confirm` ever running — a fifth route the
    // edge list cannot show. The source scan now forbids it in production
    // code; this proves the ledger holds if it were ever used.
    for (const thread of ['pending-plan', 'fresh-thread'] as const) {
      const h = harness(FAST_PATH());
      if (thread === 'pending-plan') {
        const { turn } = await h.send(T, 'pre-cool L3');
        expect(turn.pendingPlan).not.toBeNull();
      }
      const config = cfg(thread === 'pending-plan' ? T : 'never-asked');
      // On the pending thread, keep the plan plan_check reviewed; elsewhere, forge one.
      await h.graph.updateState(config, thread === 'pending-plan'
        ? { decision: 'approved' } : { decision: 'approved', pendingPlan: P }, 'confirm');
      expect((await h.graph.getState(config)).next, thread).toEqual(['apply']);

      const steps: string[] = [];
      for await (const chunk of await h.graph.stream(null, { ...config, streamMode: 'updates' })) {
        steps.push(...Object.keys(chunk as object));
      }

      expect(steps, thread).toContain('apply');                // the route is real …
      expect(steps, thread).not.toContain('confirm');          // … and goes round the person
      expect(h.fake.issuer.issued, thread).toEqual([]);        // … and issues nothing: no grant
      expect(h.logger.records.map((r) => r.event), thread).toContain('copilot.apply_refused');
      const s = await h.state(config.configurable!.thread_id as string);
      expect(s.notices.map((n) => n.code), thread).toContain('apply_refused');
      expect(s.outcomes, thread).toEqual([]);
    }
  });

  it('2. forged state with a different plan under the same id issues the frozen grant only', async () => {
    const issuer = fakeIssuer();
    const ledger = new ApprovalLedger();
    expect(ledger.grant(T, P)).toBe(true);
    const apply = makeApply(issuer.issuer, ledger, memoryLogger(), () => false);

    const state = { pendingPlan: P_PRIME, decision: 'approved' } as unknown as CopilotStateType;
    const out = await apply(state, cfg());

    expect(issuer.issued).toEqual([{
      zoneId: Z.off301, setpointTempC: 22, durationS: 3600, reason: 'copilot (operator-approved): the plan the operator approved',
    }]);
    expect(out.outcomes).toHaveLength(1);
    // Consumed: the same forged state a second time finds nothing.
    await apply(state, cfg());
    expect(issuer.issued).toHaveLength(1);
  });

  it('3. a forged route into confirm pauses (interrupt first) and grants nothing', async () => {
    for (const via of ['send', 'goto'] as const) {
      const ledger = new ApprovalLedger();
      const confirm = makeConfirm(ledger, () => Date.parse('2026-09-28T08:40:00Z'));
      const builder = new StateGraph(CopilotState).addNode('fan', (_s: CopilotStateType) => ({}), { ends: ['confirm'] })
        .addNode('other', (_s: CopilotStateType) => ({}))
        .addNode('confirm', confirm)
        .addEdge(START, 'fan')
        .addEdge('other', END).addEdge('confirm', END);
      const graph = (via === 'send'
        ? builder.addConditionalEdges('fan', () => [new Send('confirm', { pendingPlan: P, decision: 'approved' })] as unknown as 'other', ['other'])
        : new StateGraph(CopilotState)
          .addNode('fan', (_s: CopilotStateType) => new Command({ goto: 'confirm', update: { pendingPlan: P } }), { ends: ['confirm'] })
          .addNode('confirm', confirm)
          .addEdge(START, 'fan').addEdge('confirm', END)
      ).compile({ checkpointer: new MemorySaver() });

      const out = await graph.invoke({}, cfg(`confirm-${via}`));

      expect(isInterrupted(out), via).toBe(true);
      expect(ledger.has(`confirm-${via}`), via).toBe(false);
    }
  });

  it('4. a double Approve issues once: through the lock the second is a LockConflict; with the lock bypassed the ledger holds', async () => {
    // Through the lock (the route's path): one runs, one is refused (409).
    {
      const h = harness(FAST_PATH());
      const { turn } = await h.send(T, 'pre-cool L3');
      const d = decisionOf(turn);
      const results = await Promise.allSettled([decide(h.graph, T, d), decide(h.graph, T, d)]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toBeInstanceOf(LockConflict);
      expect((refused.reason as LockConflict).retryAfterS).toBe(2);
      expect(h.fake.issuer.issued.map((c) => c.zoneId)).toEqual([Z.off301, Z.off303]);
    }

    // Lock bypassed: both pass the pending check before either runs.
    {
      const h = harness(FAST_PATH());
      const { turn } = await h.send(T, 'pre-cool L3');
      const d = { kind: 'decision' as const, ...decisionOf(turn) };
      await Promise.allSettled([runTurn(h.graph, T, d), runTurn(h.graph, T, d)]);
      expect(h.fake.issuer.issued.map((c) => c.zoneId)).toEqual([Z.off301, Z.off303]);
    }

    // Lock AND pending check bypassed, at the worst moment: a second resume
    // replayed from the interrupted checkpoint while the first apply is
    // mid-issue — after it has TAKEN the grant. Take-once alone would let
    // the replayed confirm grant again; the ledger grants a plan once.
    {
      const fake = fakeDeps({ script: FAST_PATH() });
      const issued: string[] = [];
      let release!: () => void;
      const firstIssueStarted = new Promise<void>((resolve) => { release = resolve; });
      const slow: Issuer = {
        issue: async (c) => {
          issued.push(c.zoneId);
          release();
          await new Promise((r) => setTimeout(r, 20));
          return { ok: true, commandId: `c${issued.length}`, state: 'pending', effectiveUntil: '2026-09-28T10:40:00.000Z' } satisfies IssueResult;
        },
      };
      const graph = buildCopilotGraph({ ...fake.deps, issuer: slow, log: memoryLogger() });
      const turn = await sendMessage(graph, T, 'pre-cool L3', { mayCommand: true });
      const interrupted = (await graph.getState(cfg())).config;
      const d = decisionOf(turn);
      const resume = (): Parameters<typeof graph.stream>[0] =>
        new Command({ resume: { [d.interruptId]: { decision: 'approved', planId: d.planId, planHash: d.planHash } } });

      const first = runTurn(graph, T, { kind: 'decision', ...d });
      await firstIssueStarted;
      expect(copilotControls(graph).hasGrant(T)).toBe(false);   // taken
      const replay = await graph.stream(resume(), { ...interrupted, streamMode: 'updates' });
      const replayed: string[] = [];
      for await (const chunk of replay) replayed.push(...Object.keys(chunk as object));
      await first;

      expect(replayed).toContain('confirm');   // the replay really did run confirm again
      expect(issued).toEqual([Z.off301, Z.off303]);
    }
  });

  it('5. stale, forged, finished-thread, unknown-thread and expired decisions are refused BEFORE the graph runs', async () => {
    const h = harness(FAST_PATH());
    const { turn } = await h.send(T, 'pre-cool L3');
    const good = decisionOf(turn);
    const stream = vi.spyOn(h.graph, 'stream');

    const wrong: Array<[string, string, DecisionRequest]> = [
      ['wrong hash', T, { ...good, planHash: 'f'.repeat(64) }],
      ['wrong plan id', T, { ...good, planId: '0f1e2d3c-4b5a-4968-8776-655443322110' }],
      ['wrong interrupt id', T, { ...good, interruptId: 'not-the-interrupt' }],
      ['unknown thread', 'no-such-thread', good],
    ];
    for (const [why, threadId, d] of wrong) {
      const err = await decide(h.graph, threadId, d).catch((e: unknown) => e);
      expect(err, why).toBeInstanceOf(NoPendingPlan);
      expect(err, why).not.toBeInstanceOf(PlanExpired);
    }
    expect(stream).not.toHaveBeenCalled();

    // Expired: 601 s after plan_check, the route refuses it as plan_expired.
    h.fake.clock.advance(601_000);
    const expired = await decide(h.graph, T, good).catch((e: unknown) => e);
    expect(expired).toBeInstanceOf(PlanExpired);
    expect((expired as PlanExpired).code).toBe('plan_expired');
    expect(stream).not.toHaveBeenCalled();
    expect(h.fake.issuer.issued).toHaveLength(0);

    // A late resume that got past the route anyway: confirm judges the clock
    // itself — expired, declined, nothing issued.
    const lateValue = { decision: 'approved', planId: good.planId, planHash: good.planHash };
    for await (const _ of await h.graph.stream(new Command({ resume: { [good.interruptId]: lateValue } }),
      { configurable: { thread_id: T }, streamMode: 'updates' })) { /* drain */ }
    const s = await h.state(T);
    expect(s.notices.map((n) => n.code)).toContain('plan_expired');
    expect(h.fake.issuer.issued).toHaveLength(0);

    // Finished: once decided, the same decision finds nothing pending.
    const h2 = harness(FAST_PATH());
    const t2 = (await h2.send(T, 'pre-cool L3')).turn;
    await h2.decide(T, t2, 'declined');
    await expect(decide(h2.graph, T, decisionOf(t2))).rejects.toBeInstanceOf(NoPendingPlan);
    expect(h2.fake.issuer.issued).toHaveLength(0);
  });

  it('6. the resume is keyed by the interrupt id, never a scalar — and a scalar or malformed resume is stale', async () => {
    const h = harness(FAST_PATH());
    const { turn } = await h.send(T, 'pre-cool L3');
    const d = decisionOf(turn);
    const stream = vi.spyOn(h.graph, 'stream');

    await decide(h.graph, T, d);

    const input = stream.mock.calls[0]![0];
    expect(input).toBeInstanceOf(Command);
    expect((input as Command).resume).toEqual({ [d.interruptId]: { decision: 'approved', planId: d.planId, planHash: d.planHash } });
    expect(h.fake.issuer.issued).toHaveLength(2);

    // Past the session, a scalar "approved" answers the interrupt — and
    // confirm refuses it, as it refuses any resume that is not exactly
    // {decision, planId, planHash} naming this plan.
    const bads: Array<(p: { planId: string; planHash: string }) => unknown> = [
      () => 'approved',
      () => ({ decision: 'approved' }),
      (p) => ({ decision: 'approved', ...p, extra: true }),
      (p) => ({ decision: 'approved', planId: p.planId, planHash: 'f'.repeat(64) }),
    ];
    for (const bad of bads) {
      const hx = harness(FAST_PATH());
      const tx = (await hx.send(T, 'pre-cool L3')).turn;
      const value = bad({ planId: tx.pendingPlan!.planId, planHash: tx.pendingPlan!.planHash });
      for await (const _ of await hx.graph.stream(new Command({ resume: value }), { configurable: { thread_id: T }, streamMode: 'updates' })) { /* drain */ }
      const s = await hx.state(T);
      expect(s.notices.map((n) => n.code)).toContain('plan_stale');
      expect(hx.fake.issuer.issued).toHaveLength(0);
    }
  });

  it('7. a viewer cannot reach the controller: the task is dropped with a notice, the controller never called', async () => {
    const h = harness({
      planner: [plannerMsg({ intent: 'control', next: 'control', allowControl: true, controlTask: { mode: 'propose', brief: 'pre-cool L3' } })],
    });
    const { turn, trail } = await h.send('viewer', 'pre-cool level 3', { mayCommand: false });
    expect(h.fake.model.count('control')).toBe(0);
    expect(trail).not.toContain('control');
    expect(turn.notices.map((n) => n.code)).toContain('control_not_permitted');
    expect((await h.state('viewer')).controlTask).toBeNull();
  });

  it('8. a new message supersedes a pending plan: cleared, said, the grant revoked, nothing issued', async () => {
    const script = FAST_PATH();
    script.planner!.push(plannerMsg({ next: 'finish', intent: 'clarify', message: 'What next?' }));
    const h = harness(script);
    const first = await h.send('super', 'pre-cool L3');
    expect(first.turn.pendingPlan).not.toBeNull();

    const second = await h.send('super', 'actually, never mind');

    expect(second.turn.pendingPlan).toBeNull();
    expect(second.turn.notices.map((n) => n.code)).toContain('plan_superseded');
    expect(copilotControls(h.graph).hasGrant('super')).toBe(false);
    expect(h.fake.issuer.issued).toHaveLength(0);
    // The superseded plan cannot be approved afterwards.
    await expect(decide(h.graph, 'super', decisionOf(first.turn))).rejects.toBeInstanceOf(NoPendingPlan);

    // And intake revokes a grant that IS held — whatever state says.
    const ledger = new ApprovalLedger();
    expect(ledger.grant('held', P)).toBe(true);
    const intake = makeIntake({ registry: new RunRegistry(), ledger, clock: Date.now, identity: { userId: USER_ID }, log: memoryLogger() });
    const update = intake({
      inbox: { requestId: 'r2', text: 'next', receivedAt: '2026-09-28T08:41:00.000Z', mayCommand: true },
      pendingPlan: P, request: null,
    } as unknown as CopilotStateType, cfg('held'));
    expect(ledger.has('held')).toBe(false);
    expect(update.pendingPlan).toBeNull();
    expect(update.notices).toEqual({ replace: [{ code: 'plan_superseded', params: {} }] });
  });
});

describe('10. the duration approved is the duration issued (review)', () => {
  // A command may leave its duration to the tenant default. The card showed
  // the default the dry run resolved, but the hash bound "no duration" and
  // ingest resolved the default again at issue time: an admin who changed it
  // between the plan and the approval gave the building a duration nobody saw.
  const noDuration = () => {
    const script = FAST_PATH();
    script.control = [message([
      toolUse('propose_plan', {
        summary: 'Pre-cool OFF-301 for the afternoon peak.',
        commands: [{ zoneId: Z.off301, setpointTempC: 22, reason: 'pre-cool for the afternoon peak' }],
      }),
      toolUse('report_finding', { status: 'answered', summary: 'done', claims: [], openQuestions: [], caveats: [] }),
    ])];
    return script;
  };

  it('pins an omitted duration to the default shown, in the hash and in what is issued', async () => {
    const h = harness(noDuration());
    const { turn } = await h.send(T, 'pre-cool OFF-301');
    const shown = turn.pendingPlan!.commands[0]!;
    expect(shown.verdict).toMatchObject({ allowed: true, durationS: 3600 });
    expect(shown.durationS).toBe(3600);

    // An admin lengthens the tenant default before the operator approves.
    h.fake.probe.settings.defaultDurationS = 14_400;
    await h.decide(T, turn, 'approved');
    expect(h.fake.issuer.issued).toEqual([expect.objectContaining({ zoneId: Z.off301, durationS: 3600 })]);
  });
});

describe('9. Stop and the deadline hold at plan_check (route stage: gate open issue)', () => {
  // The controller drops its own proposal on Stop, but plan_check ran after
  // it without asking: Stop pressed while plan_check's dry runs were out
  // still put a plan in front of the operator. Now plan_check reads the
  // registry before and after its dry runs, and nothing reaches confirm.
  const FAST_PATH_DRY_RUNS = 4;   // 2 inside propose_plan, then 2 in plan_check

  async function withHook(hook: (graph: CopilotGraph, fake: ReturnType<typeof fakeDeps>) => void) {
    const fake = fakeDeps({ script: FAST_PATH() });
    let calls = 0;
    const box: { graph: CopilotGraph | null } = { graph: null };
    const probe: ControlProbe = {
      settings: () => fake.deps.probe.settings(),
      dryRun: async (c) => {
        calls += 1;
        // The third dry run is plan_check's first.
        if (calls === 3) hook(box.graph!, fake);
        return fake.deps.probe.dryRun(c);
      },
    };
    const graph = buildCopilotGraph({ ...fake.deps, probe, log: memoryLogger() });
    box.graph = graph;
    const events: string[] = [];
    const types: string[] = [];
    const turn = await sendMessage(graph, T, 'pre-cool L3', {
      mayCommand: true, onEvent: (e) => { types.push(e.t); if (e.t === 'step') events.push(e.node); },
    });
    const snapshot = await graph.getState(cfg());
    return { fake, graph, turn, trail: events, types, next: snapshot.next, dryRuns: () => calls };
  }

  it('9a. without Stop the same run reaches confirm (the control case)', async () => {
    const r = await withHook(() => {});
    expect(r.turn.pendingPlan).not.toBeNull();
    expect(r.trail.at(-1)).toBe('plan_check');
    expect(r.next).toEqual(['confirm']);   // paused in confirm's interrupt
    expect(r.types).toContain('plan');
    expect(r.dryRuns()).toBe(FAST_PATH_DRY_RUNS);
  });

  it('9b. Stop while its dry runs are out: no plan, notice `stopped`, no interrupt, nothing issued', async () => {
    const r = await withHook((graph) => { expect(stop(graph, T)).toBe(true); });
    expect(r.turn.pendingPlan).toBeNull();
    expect(r.turn.notices).toContainEqual({ code: 'stopped', text: 'Stopped at your request.' });
    expect(r.trail).toEqual(expect.arrayContaining(['plan_check', 'finish']));
    expect(r.trail).not.toContain('confirm');
    expect(r.next).toEqual([]);
    expect(r.types).not.toContain('plan');
    expect(r.dryRuns()).toBe(FAST_PATH_DRY_RUNS);   // Stop landed during them: they finished, the plan did not
    expect(r.fake.issuer.issued).toHaveLength(0);
    // The thread is not wedged: the request closed, and nothing is pending.
    expect(copilotControls(r.graph).running(T)).toBe(false);
    await expect(pendingDecision(r.graph, T, {
      decision: 'approved', interruptId: 'x', planId: PLAN_ID, planHash: 'a'.repeat(64),
    })).rejects.toBeInstanceOf(NoPendingPlan);
  });

  it('9c. the deadline passing while they are out: no plan, notice `deadline`', async () => {
    const r = await withHook((_graph, fake) => { fake.clock.advance((DEFAULT_LIMITS.deadlineS + 1) * 1000); });
    expect(r.turn.pendingPlan).toBeNull();
    expect(r.turn.notices.map((n) => n.code)).toContain('deadline');
    expect(r.trail).not.toContain('confirm');
    expect(r.next).toEqual([]);
    expect(r.fake.issuer.issued).toHaveLength(0);
  });

  it('9d. a request already stopped makes no dry run at all', async () => {
    const fake = fakeDeps();
    const node = makePlanCheck({
      probe: fake.deps.probe, limits: resolveLimits(), clock: () => fake.clock.now(), log: memoryLogger(),
      interrupted: () => 'stopped',
    });
    const h = harness(FAST_PATH());
    await h.send(T, 'pre-cool L3');
    const s = await h.state(T);
    const before = fake.probe.dryRuns.length;
    const update = await node({ ...s, proposal: { summary: 'x', commands: s.pendingPlan!.commands, basis: null } } as CopilotStateType, cfg());
    expect(update).toEqual({ pendingPlan: null, notices: [{ code: 'stopped', params: {} }] });
    expect(fake.probe.dryRuns.length).toBe(before);
  });
});

