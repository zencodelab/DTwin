import { describe, expect, it } from 'vitest';
import { SIMULATED_FIGURE_CAVEAT } from './caveats.ts';
import { availableSpecialists, offeredTools } from './tools/index.ts';
import { round4 } from './tools/common.ts';
import { summariseRun } from './tools/simulate.ts';
import { USER_ID, Z, fakeSimRows, orientFixture, plannerMsg } from './testing/fakes.ts';
import { toolHarness } from './testing/tools.ts';
import { DEFAULT_LIMITS } from './limits.ts';
import { validatePlan } from './planner.ts';
import { PLANNER_SYSTEM, simulateTasks } from './prompts.ts';
import { dataOf, harness } from './testing/run.ts';
import { SIM_FROM, SIM_TO } from './testing/scripts.ts';

/**
 * simulate_scenarios against `fakeScenarios` (§10 sim.test.ts): the runs are
 * comparable by construction, the warm-up is dropped, comfort is judged
 * against the designed band, and every way the worker can refuse, hang or
 * short-change the tool ends in an is_error — with the running simulation
 * cancelled — and never in a retry.
 */

const FROM = '2026-09-29T08:00:00+04:00';   // tomorrow, 04:00Z
const TO = '2026-09-29T20:00:00+04:00';     // 12 target hours; 36 with the warm-up
const INPUT = {
  zoneIds: [Z.off301, Z.off303, Z.off305],
  from: FROM, to: TO,
  peakDryBulbC: 46, minDryBulbC: 32, peakGhiWM2: 950,
  scenarios: [{ name: 'plus-1', setpointDeltaK: 1 }],
};
const ROWS_PER_RUN = 3 * 36;

const data = (content: string) => (JSON.parse(content) as { data: Record<string, unknown> }).data;

describe('simulate_scenarios', () => {
  it('1. builds ONE template: every run has the same zones, period, interval and synthetic weather; baseline first, one in flight', async () => {
    const h = toolHarness({ scenarios: 'ok', taskId: 'T2' });
    const r = await h.call('simulate', 'simulate_scenarios', INPUT);
    expect(r.isError, r.content).toBeUndefined();

    const requests = h.fake.scenarios!.requests;
    expect(requests).toHaveLength(2);
    const shared = requests.map((q) => JSON.stringify([q.zoneIds, q.periodStart, q.periodEnd, q.intervalS, q.weather]));
    expect(shared[1]).toBe(shared[0]);
    expect(requests[0]!.weather).toEqual({ mode: 'synthetic', peakDryBulbC: 46, minDryBulbC: 32, peakGhiW_m2: 950 });
    // The period starts 24 h before the window: warm-up, dropped from every figure.
    expect(requests[0]!.periodStart.toISOString()).toBe('2026-09-28T04:00:00.000Z');
    expect(requests[0]!.periodEnd.toISOString()).toBe('2026-09-29T16:00:00.000Z');
    expect(requests[0]!.intervalS).toBe(3600);
    expect(requests.map((q) => [q.scenarioName, q.params])).toEqual([
      ['copilot: baseline', {}],
      ['copilot: plus-1', { setpointDeltaK: 1 }],
    ]);
    expect(requests[0]!.description).toBe(`copilot run; user ${USER_ID}; request request-1`);
    expect(h.fake.scenarios!.peakInFlight).toBe(1);
    expect(h.fake.scenarios!.resultCalls.map((c) => c.limit)).toEqual([ROWS_PER_RUN, ROWS_PER_RUN]);

    expect(r.evidence).toMatchObject({ id: 'T2.E1', kind: 'simulated', source: 'simulation', window: { from: FROM, to: TO } });
    expect(r.evidence?.caveats).toEqual([
      'SIM_ANALYTICALLY_VERIFIED', 'SIM_SYNTHETIC_WEATHER', 'SIM_UNIFORM_DELTA', 'SIM_UNMET_OWN_BAND',
      'SIM_CONSTANT_COP_NO_SETBACK', 'SIM_PEAK_INTERVAL_MEAN', 'SIM_PLANT_RESIZED_PER_RUN', 'SIM_SUBSET',
    ]);
    expect(r.evidence?.caveats).toContain(SIMULATED_FIGURE_CAVEAT);
    expect(r.simRuns?.map((s) => [s.role, s.scenario, s.status, s.taskId])).toEqual([
      ['baseline', 'baseline', 'completed', 'T2'], ['scenario', 'plus-1', 'completed', 'T2'],
    ]);
    expect(h.events.map((e) => `${e.scenario}:${e.status}`)).toEqual([
      'baseline:queued', 'baseline:completed', 'plus-1:queued', 'plus-1:completed',
    ]);
    expect(data(r.content).runs).toEqual(r.simRuns!.map((s) => ({ role: s.role, scenario: s.scenario, run_id: s.runId })));
  });

  it('2. drops the warm-up: totals equal a hand sum over the target hours only', async () => {
    const h = toolHarness({ scenarios: 'ok' });
    const r = await h.call('simulate', 'simulate_scenarios', INPUT);
    const rows = fakeSimRows(h.fake.scenarios!.requests[0]!);
    const inWindow = rows.filter((x) => x.intervalStart.getTime() >= Date.parse(FROM) && x.intervalStart.getTime() < Date.parse(TO));
    expect(rows).toHaveLength(ROWS_PER_RUN);
    expect(inWindow).toHaveLength(3 * 12);
    const baseline = data(r.content).baseline as Record<string, number>;
    expect(baseline.total_kwh).toBe(round4(inWindow.reduce((s, x) => s + x.totalKwh, 0)));
    expect(baseline.hvac_kwh).toBe(round4(inWindow.reduce((s, x) => s + x.hvacLoadKwh, 0)));
    expect(baseline.total_kwh).not.toBe(round4(rows.reduce((s, x) => s + x.totalKwh, 0)));
    // The peak hour, over the three zones, as a mean over the hour.
    const perHour = new Map<number, number>();
    for (const x of inWindow) perHour.set(x.intervalStart.getTime(), (perHour.get(x.intervalStart.getTime()) ?? 0) + x.totalKwh);
    expect(baseline.peak_interval_kw).toBe(round4(Math.max(...perHour.values())));
  });

  it('3. judges comfort against the DESIGNED band: +1 K meets its own band and is warm against design', async () => {
    const h = toolHarness({ scenarios: 'ok' });
    const d = data((await h.call('simulate', 'simulate_scenarios', INPUT)).content);
    const baseline = d.baseline as Record<string, number>;
    const [plus] = d.scenarios as Array<Record<string, unknown>>;
    expect(plus).toMatchObject({ name: 'plus-1', setpoint_delta_k: 1, unmet_own_band_zone_h: 0 });
    // Occupied 08:00–18:00 in the window: 10 h × 3 offices at 24.3 °C, above 23 + 0.5 + 0.5.
    expect(plus!.warm_vs_design_zone_h).toBe(30);
    expect(baseline.warm_vs_design_zone_h).toBe(0);
    expect(baseline.unmet_own_band_zone_h).toBe(0);
    expect(plus!.delta_hvac_kwh).toBeLessThan(0);
    expect(plus!.delta_total_pct).toBe(round4(((plus!.total_kwh as number) - baseline.total_kwh!) / baseline.total_kwh! * 100));
    expect(plus!.top_zones).toEqual(['OFF-301', 'OFF-303', 'OFF-305'].map((zone) => ({
      zone, max_occupied_baseline_c: 23.3, max_occupied_scenario_c: 24.3, delta_max_occupied_k: 1, warm_vs_design_zone_h: 10,
    })));
  });

  it('4. surfaces the worker\'s 429 once and never retries it', async () => {
    const h = toolHarness({ scenarios: 'busy429' });
    const r = await h.call('simulate', 'simulate_scenarios', INPUT);
    expect(r).toMatchObject({ isError: true, content: 'simulator busy (worker admission limit reached); not retried' });
    expect(h.fake.scenarios!.requests).toHaveLength(1);
    expect(r.evidence).toBeUndefined();
    expect(h.logs).toContainEqual({ event: 'copilot.sim_refused', fields: { reason: 'run_failed', taskId: 'T1' } });
  });

  it('5. cancels a run that passes its 45 s deadline, on the fake clock, polling every 500 ms', async () => {
    const h = toolHarness({ scenarios: 'hang' });
    const t0 = h.fake.clock.now();
    const r = await h.call('simulate', 'simulate_scenarios', INPUT);
    expect(r).toMatchObject({ isError: true, content: 'simulation timed out after 45 s and was cancelled' });
    expect(h.fake.scenarios!.cancelled).toEqual([h.fake.scenarios!.started[0]]);
    expect(h.fake.scenarios!.requests).toHaveLength(1);   // the scenario run never started
    expect(h.fake.clock.now() - t0).toBe(45_000);
    expect(new Set(h.fake.sleeps)).toEqual(new Set([500]));
    expect(r.simRuns).toEqual([expect.objectContaining({ role: 'baseline', status: 'cancelled' })]);
  });

  it('7a. a name that states its shift runs, with words after it (review)', async () => {
    for (const scenario of [{ name: 'minus-0-5-offices', setpointDeltaK: -0.5 }, { name: 'plus-1', setpointDeltaK: 1 }]) {
      const h = toolHarness({ scenarios: 'ok' });
      const r = await h.call('simulate', 'simulate_scenarios', { ...INPUT, scenarios: [scenario] });
      expect(r.isError, r.content).toBeUndefined();
      expect(r.evidence?.label).toContain(scenario.name);
    }
  });

  it('6. refuses results that are not exactly one row per zone and hour', async () => {
    const h = toolHarness({ scenarios: 'short' });
    const r = await h.call('simulate', 'simulate_scenarios', INPUT);
    expect(r).toMatchObject({ isError: true, content: `incomplete results (${ROWS_PER_RUN - 1} of ${ROWS_PER_RUN} rows)` });
  });

  it('7. refuses past every bound before anything is posted, and names it', async () => {
    const h = toolHarness({ scenarios: 'ok' });
    const refusals: Array<[unknown, RegExp]> = [
      [{ ...INPUT, zoneIds: [Z.off301, '00000000-0000-4000-8000-000000000999'] }, /^unknown zone id\(s\): 00000000-0000-4000-8000-000000000999 — use ids from the directory$/],
      [{ ...INPUT, scenarios: [{ name: 'plus-3-5', setpointDeltaK: 3.5 }] }, /\|setpointDeltaK\| is at most 3 K/],
      [{ ...INPUT, scenarios: [{ name: 'zero', setpointDeltaK: 0 }] }, /a shift of 0 K is the baseline/],
      [{ ...INPUT, scenarios: [{ name: 'baseline', setpointDeltaK: 1 }] }, /cannot be named baseline/],
      [{ ...INPUT, scenarios: [{ name: 'Plus One', setpointDeltaK: 1 }] }, /lowercase letters, digits or hyphens/],
      [{ ...INPUT, scenarios: [1, 2, 3].map((n) => ({ name: `s${n}`, setpointDeltaK: n / 2 })) }, /scenarios holds 1 to 2, got 3/],
      [{ ...INPUT, zoneIds: [Z.off301, Z.off301] }, /is listed twice/],
      [{ ...INPUT, to: '2026-10-02T20:00:00+04:00' }, /window is 84 h; simulate_scenarios answers at most 72 h/],
      [{ ...INPUT, from: '2026-09-29T08:30:00+04:00' }, /whole hours/],
      [{ ...INPUT, peakDryBulbC: 60 }, /peakDryBulbC is 20–52/],
      [{ ...INPUT, minDryBulbC: 47 }, /minDryBulbC is 10 up to peakDryBulbC/],
      // Gate fix: the operator reads a scenario's name (card label, headlines,
      // sim rows, the plan's badge), so it may not state an unchecked figure
      // — "minus-2k" on a +1 K run — or use a banned word.
      [{ ...INPUT, scenarios: [{ name: 'minus-2k', setpointDeltaK: 1 }] }, /scenario minus-2k: a name is shown to the operator/],
      [{ ...INPUT, scenarios: [{ name: 'save-10-pct', setpointDeltaK: 1 }] }, /cannot state a quantity with a unit/],
      [{ ...INPUT, scenarios: [{ name: 'forecast-day', setpointDeltaK: 1 }] }, /or use a banned word/],
      // Review: a name is the label of the shift it ran, so it must state
      // that shift — "plus-1" on a −1 K run verified, and the plan card said
      // "Simulated as plus-1" beside commands that lowered setpoints.
      [{ ...INPUT, scenarios: [{ name: 'plus-1', setpointDeltaK: -1 }] }, /starts with minus-1 for a setpointDeltaK of -1/],
      [{ ...INPUT, scenarios: [{ name: 'minus-2', setpointDeltaK: 1 }] }, /starts with plus-1 /],
      [{ ...INPUT, scenarios: [{ name: 'plus-3', setpointDeltaK: -0.5 }] }, /starts with minus-0-5 /],
      [{ ...INPUT, scenarios: [{ name: 'warmer', setpointDeltaK: -1 }] }, /starts with minus-1 /],
      [{ ...INPUT, scenarios: [{ name: 'plus-1-5', setpointDeltaK: 1 }] }, /only words may follow/],
    ];
    for (const [input, expected] of refusals) {
      const r = await h.call('simulate', 'simulate_scenarios', input);
      expect(r.isError, JSON.stringify(input)).toBe(true);
      expect(r.content).toMatch(expected);
    }
    expect(h.fake.scenarios!.requests).toEqual([]);

    // The envelope's deviation limit is the tighter bound when it is tighter.
    h.fake.probe.settings.maxDeviationK = 1;
    expect((await h.call('simulate', 'simulate_scenarios', { ...INPUT, scenarios: [{ name: 'plus-2', setpointDeltaK: 2 }] })).content)
      .toMatch(/at most 1 K \(the control envelope's deviation limit\)/);
    h.fake.probe.settings.maxDeviationK = 3;

    // One call per request, however the first went.
    expect((await h.call('simulate', 'simulate_scenarios', INPUT)).isError).toBeUndefined();
    expect(await h.call('simulate', 'simulate_scenarios', INPUT))
      .toMatchObject({ isError: true, content: 'simulate_scenarios runs once per request, and it has already run' });
  });

  it('7b. holds twelve runs per person per hour across requests, and says when to retry', async () => {
    const h = toolHarness({ scenarios: 'ok' });
    const two = { ...INPUT, scenarios: [{ name: 'plus-1', setpointDeltaK: 1 }, { name: 'minus-1', setpointDeltaK: -1 }] };
    for (let i = 0; i < 4; i += 1) {
      const r = await h.call('simulate', 'simulate_scenarios', two);
      expect(r.isError, `request ${i + 1}: ${r.content}`).toBeUndefined();
      h.nextRequest();
    }
    expect(h.fake.scenarios!.started).toHaveLength(12);
    const thirteenth = await h.call('simulate', 'simulate_scenarios', INPUT);
    expect(thirteenth).toMatchObject({ isError: true });
    expect(thirteenth.content).toBe('simulation limit reached (12 runs per hour per person); retry after 600 s (retry_after_s 600)');
    expect(h.fake.scenarios!.started).toHaveLength(12);
  });

  it('7c. refuses a run whose zones × hours (with warm-up) exceed the ceiling, before any POST', async () => {
    const h = toolHarness({ scenarios: 'ok', limits: { simMaxZoneH: 100 } });
    const r = await h.call('simulate', 'simulate_scenarios', INPUT);
    expect(r.content).toBe('3 zones × 36 h (including 24 h warm-up) is 108 zone-hours; a run is at most 100');
    expect(h.fake.scenarios!.requests).toEqual([]);
    // Refused on its input, so the request's one call is still unspent.
    expect(h.registry.claimSimCall(h.threadId)).toBe(true);
  });

  it('7d. stop while a run is polling cancels it', async () => {
    let stopped = false;
    const h = toolHarness({
      scenarios: 'hang',
      onSleep: () => { if (!stopped) { stopped = true; h.registry.stop(h.threadId); } },
    });
    const r = await h.call('simulate', 'simulate_scenarios', INPUT);
    expect(r).toMatchObject({ isError: true, content: 'stopped: the running simulation was cancelled' });
    expect(h.fake.scenarios!.cancelled).toHaveLength(1);
    expect(h.fake.sleeps).toEqual([500]);
  });

  it('8. is not offered, and refuses, without a simulator', async () => {
    const h = toolHarness({ scenarios: null });
    const r = await h.call('simulate', 'simulate_scenarios', INPUT);
    expect(r).toMatchObject({ isError: true, content: 'simulator unavailable (COPILOT_SIM_API_KEY is not set)' });
    expect(availableSpecialists(h.ctx.orient)).not.toContain('simulate');
    expect(offeredTools('diagnose')).not.toContain('simulate_scenarios');
    expect(offeredTools('analyse')).not.toContain('simulate_scenarios');
    expect(offeredTools('control', { mode: 'propose' })).not.toContain('simulate_scenarios');
  });

  it('8b. …and the planner, without a simulator, is not offered simulate and cannot dispatch it', async () => {
    const task = { specialist: 'simulate' as const, goal: 'what if one kelvin warmer', zoneIds: [Z.off301], from: SIM_FROM, to: SIM_TO };
    const h = harness({
      planner: [
        plannerMsg({ intent: 'whatif', allowSimulation: true, next: 'dispatch', tasks: [task] }),
        plannerMsg({ intent: 'whatif', allowSimulation: true, next: 'dispatch', tasks: [task] }),
      ],
    });   // scenarios: null (COPILOT_SIM_API_KEY unset)

    const { turn } = await h.send('nosim', 'what if we ran OFF-301 a kelvin warmer?');

    const input = dataOf(h.fake.model.calls.planner![0]!) as { specialists: string[]; simulation: { available: boolean; reason: string } };
    expect(input.specialists).toEqual(['diagnose', 'analyse']);
    expect(input.simulation).toEqual({ available: false, reason: 'COPILOT_SIM_API_KEY is not set' });
    expect(JSON.stringify(h.fake.model.calls.planner![1]!.messages)).toContain('simulate is not available for this request');
    expect(Object.keys((await h.state('nosim')).tasks)).toEqual([]);
    expect(turn.notices.map((n) => n.code)).toEqual(['planner_unavailable']);

    // The rule itself, on the state the planner validates against.
    const s = await h.state('nosim');
    const v = validatePlan(
      { intent: 'whatif', interpretation: '', allowControl: false, allowSimulation: true, next: 'dispatch', tasks: [{ ...task, inputEvidenceIds: [] }], controlTask: null, message: null },
      s, { limits: DEFAULT_LIMITS, scope: { allowControl: false, allowSimulation: true } },
    );
    expect(v.errors).toEqual(['simulate is not available for this request; use diagnose or analyse, or say it cannot be simulated']);
  });
});

describe('8c. one simulate task per request (route stage: the gate found §8 contradicting itself)', () => {
  // §8 allowed 2 simulate tasks, but also 1 simulate_scenarios call per
  // request: a second task could only be refused "runs once per request"
  // after spending its model calls learning that. The planner is now told,
  // and held to, the number the call budget can actually serve.
  const task = (goal: string) => ({ specialist: 'simulate' as const, goal, zoneIds: [Z.off301], from: SIM_FROM, to: SIM_TO, inputEvidenceIds: [] });
  const decision = (tasks: ReturnType<typeof task>[]) => ({
    intent: 'whatif' as const, interpretation: '', allowControl: false, allowSimulation: true, next: 'dispatch' as const,
    tasks, controlTask: null, message: null,
  });
  const state = (earlier: Record<string, unknown>) => ({
    tasks: earlier, taskSeq: Object.keys(earlier).length, evidence: {}, controlTask: null,
    request: { mayCommand: true },
    context: { ...orientFixture(0), sim: { available: true, reason: null } },
  }) as unknown as Parameters<typeof validatePlan>[1];
  const opts = { limits: DEFAULT_LIMITS, scope: { allowControl: false, allowSimulation: true } };

  it('the limit is the call budget, and the prompt says the same number in the same words', () => {
    expect(DEFAULT_LIMITS.maxSimulateTasksPerRequest).toBe(1);
    expect(DEFAULT_LIMITS.maxSimulateTasksPerRequest).toBeLessThanOrEqual(DEFAULT_LIMITS.simCallsPerRequest);
    expect(PLANNER_SYSTEM).toContain(`at most ${simulateTasks(DEFAULT_LIMITS.maxSimulateTasksPerRequest)}:`);
    expect(simulateTasks(1)).toBe('1 simulate task');
    expect(PLANNER_SYSTEM).not.toMatch(/at most \d+ simulate tasks/);
  });

  it('validatePlan refuses a second simulate task, in one wave or across two, and accepts one', () => {
    const refusal = 'a request runs at most 1 simulate task (its one simulation call runs the baseline and every scenario together; put them in one task)';
    expect(validatePlan(decision([task('one')]), state({}), opts).errors).toEqual([]);
    expect(validatePlan(decision([task('one'), task('two')]), state({}), opts).errors).toEqual([refusal]);
    const earlier = { T1: { taskId: 'T1', specialist: 'simulate', goal: 'one', wave: 1, status: 'done' } };
    expect(validatePlan(decision([task('two')]), state(earlier), opts).errors).toEqual([refusal]);
  });
});

describe('summariseRun', () => {
  it('skips zones with no designed band from comfort, and counts only occupied hours', () => {
    const zones = orientFixture(0).directory.filter((z) => z.name === 'OFF-301' || z.name === 'OFF-303')
      .map((z) => (z.name === 'OFF-303' ? { ...z, designed_setpoint_c: null } : z));
    const at = (h: number) => new Date(Date.parse('2026-09-29T00:00:00Z') + h * 3_600_000);
    const row = (zoneId: string, h: number, occupancyCount: number, indoorTempC: number) => ({
      zoneId, intervalStart: at(h), hvacLoadKwh: 1, lightingKwh: 0.5, plugKwh: 0.5, totalKwh: 2, co2Kg: 0.8,
      peakDemandKw: 2, indoorTempC, solarGainKwh: 0, internalGainKwh: 0, envelopeLossKwh: 0, ventilationLossKwh: 0,
      occupancyCount, unmetHours: 0.25,
    });
    const { summary, byZone } = summariseRun([
      row(Z.off301, 0, 10, 25), row(Z.off301, 1, 0, 26), row(Z.off303, 0, 10, 25), row(Z.off301, 2, 0.5, 26),
    ] as never, zones, 1);
    // Occupied above 5% of design (20 people): 10 yes, 0 no, 0.5 no (≤ 1).
    expect(summary.warm_vs_design_zone_h).toBe(1);
    expect(summary.cool_vs_design_zone_h).toBe(0);
    expect(summary.unmet_own_band_zone_h).toBe(1);
    expect(summary.total_kwh).toBe(8);
    expect(summary.peak_interval_kw).toBe(4);
    expect(summary.peak_at).toBe('2026-09-29T00:00:00.000Z');
    expect(byZone.get(Z.off301)).toEqual({ maxOccupiedC: 25, warmH: 1 });
    expect(byZone.get(Z.off303)).toEqual({ maxOccupiedC: 25, warmH: 0 });
  });
});
