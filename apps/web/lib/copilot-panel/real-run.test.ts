import { describe, expect, it } from 'vitest';
import type { CopilotEvent } from '../copilot/protocol.ts';
import { harness, type Run } from '../copilot/testing/run.ts';
import { compoundScript, fastPathScript } from '../copilot/testing/scripts.ts';
import { citationOrder, paragraphPieces, planBasis } from './answer.ts';
import { countdown } from './countdown.ts';
import {
  EMPTY, activeNodes, activityLines, applyEvents, beginDecision, beginMessage, chips, endStream, simRows,
  type PanelState,
} from './run.ts';
import { parseTurn, readEvents } from './wire.ts';

/**
 * The panel against REAL runs: the core's graph on its fakes, driven through
 * the real session (`sendMessage` / `decide` → `runTurn` → `graph.stream`),
 * its events written as NDJSON, read back by the panel's reader, and folded
 * by the panel's reducer. Nothing here is hand-built — if the server's
 * events or turn change shape, this is where the panel finds out.
 */

/** Fold a run event by event, checking before each `step` that the lit nodes included the one that finished. */
function foldChecked(start: PanelState, run: Run): PanelState {
  let s = start;
  for (const e of run.events) {
    if (e.t === 'step') {
      const lit = activeNodes(s);
      if (lit.size > 0) expect([...lit], `lit before '${e.node}' finished`).toContain(e.node);
    }
    s = applyEvents(s, [e]);
  }
  return endStream(s, 'turn');
}

/** The run's events as the route writes them, cut into awkward chunks, read back by the panel. */
async function overTheWire(events: readonly CopilotEvent[]): Promise<CopilotEvent[]> {
  const bytes = new TextEncoder().encode(events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= bytes.length) { c.close(); return; }
      c.enqueue(bytes.slice(at, at + 97)); // not a line, not a character boundary
      at += 97;
    },
  });
  const got: CopilotEvent[] = [];
  expect(await readEvents(body, (batch) => got.push(...batch))).toBe('turn');
  return got;
}

describe('the panel folding real runs', () => {
  it('compound (diagnose → simulate → compose → propose): chips, activity, sim rows, answer, plan basis', async () => {
    const h = harness(compoundScript(), { scenarios: 'ok' });
    const text = 'Check the Level 3 offices, simulate a 1 K cooler setpoint against baseline, then propose it';
    const run = await h.send('q3', text);

    const read = await overTheWire(run.events);
    expect(read).toEqual(run.events);

    const s = foldChecked(beginMessage(EMPTY, text), { ...run, events: read });
    expect(s.turn).toEqual(run.turn);
    expect(chips(s).map((c) => c.text)).toEqual(['Diagnosing ✓', 'Simulating ✓', 'Dry-running ✓']);
    expect(activityLines(s).map((a) => a.text)).toEqual([
      'diagnose: 1 read', 'simulate: 1 simulation', 'control: 1 read, 1 proposal',
    ]);
    expect(simRows(s, new Map()).map((r) => [r.label, r.status, r.progressPct])).toEqual([
      ['baseline', 'completed', 100], ['plus-1', 'completed', 100],
    ]);

    // The answer's simulated number: tinted, chip 1 opens the simulation's card.
    const { number, cards } = citationOrder(s.turn!.answer, s.turn!.cards);
    expect(cards[0]!.id).toBe('T2.E1');
    const pieces = s.turn!.answer!.paragraphs.flatMap((p) => paragraphPieces(p, number));
    expect(pieces.find((p) => p.kind === 'num')).toMatchObject({ simulated: true, cites: [{ n: 1, id: 'T2.E1' }] });

    // Waiting at confirm: confirm lit, the badge earned, ten minutes on the clock.
    const plan = s.turn!.pendingPlan!;
    expect([...activeNodes(s)]).toEqual(['confirm']);
    expect(planBasis(plan)).toMatchObject({ kind: 'simulated', scenario: 'plus-1' });
    expect(countdown(plan.expiresAt, Date.parse(plan.checkedAt)).text).toBe('10:00 left');

    // Approve: the same request resumes; its chips stay; the outcome arrives.
    const done = await h.decide('q3', run.turn, 'approved');
    const after = foldChecked(beginDecision(s, 'approved'), done);
    expect(after.turn!.pendingPlan).toBeNull();
    expect(after.turn!.outcomes.map((o) => o.result.ok)).toEqual([true, true]);
    expect(activeNodes(after).size).toBe(0);
    expect(chips(after).map((c) => c.text)).toEqual(['Diagnosing ✓', 'Simulating ✓', 'Dry-running ✓']);
  });

  it('the control fast path: the guess after the planner is the controller, and it is right', async () => {
    const h = harness(fastPathScript());
    const run = await h.send('fast', 'pre-cool the Level 3 offices');
    const s = foldChecked(beginMessage(EMPTY, 'pre-cool the Level 3 offices'), run);
    expect(run.trail).toEqual(['intake', 'orient', 'planner', 'control', 'plan_check']);
    expect(s.turn!.pendingPlan!.commands).toHaveLength(2);
    expect(planBasis(s.turn!.pendingPlan!)).toEqual({ kind: 'none' });
  });

  it('a rehydrated turn (GET ?threadId) reads back through parseTurn unchanged', async () => {
    const h = harness(fastPathScript());
    const run = await h.send('fast', 'pre-cool');
    // As the JSON route sends it: the turn alone, through JSON and back.
    const json = JSON.parse(JSON.stringify(run.turn)) as unknown;
    expect(parseTurn(json)).toEqual(run.turn);
  });
});
