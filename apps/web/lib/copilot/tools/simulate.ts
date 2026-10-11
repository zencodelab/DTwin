import type { DirectoryRow } from '@dtwin/db';
import { KeyedLimiter, SimulationRequest, type SimulationStatus } from '@dtwin/types';
import { z } from 'zod';
import type { ScenarioRunner, SimResultRow, SimRunState, SimStartResult } from '../deps.ts';
import type { CaveatId } from '../evidence.ts';
import { DEFAULT_LIMITS } from '../limits.ts';
import { verifyText } from '../verify.ts';
import {
  Ts, evidenceTool, hoursAndDays, isRefused, onWholeHour, refuse, round4, shapeData, windowLabel, windowOf,
  zodIssues, type EvidenceDraft, type Refused, type SimRunRecord, type ToolEnv, type Window,
} from './common.ts';

/**
 * simulate_scenarios: the copilot's one SCRATCH write (docs/decisions.md §64).
 *
 * A what-if runs the physics worker: a baseline and one or two uniform
 * setpoint shifts over the same zones, the same period and the same synthetic
 * design day. The runs write `simulation_runs` and `simulation_results` rows
 * — nothing the building reads — through the `ScenarioRunner` allow-list and
 * its sim-only key. It is not interrupt-gated because the risk is resource
 * use, not actuation, and resource use is what every bound below is for.
 *
 * What makes the comparison honest is built here, in code, not asked of the
 * model:
 *
 * 1. ONE template, built once: every run gets the same zone list, period,
 *    interval and weather object, and weather is always explicit (the
 *    worker's default is `observed`, which would replay whatever rows exist).
 * 2. 24 hours of warm-up are prepended and then dropped: every run starts at
 *    setpoint, and day one under-reports HVAC by about 6%.
 * 3. Runs are SEQUENTIAL — one in flight per request, and one copilot run per
 *    web process (the runner's slot) — because the worker admits two runs
 *    across every tenant and a copilot holding both would 429 every person's
 *    scenario panel.
 * 4. Results are fetched with an exact limit and the row count is ASSERTED:
 *    the worker's /results truncates silently.
 * 5. Comfort is judged against the DESIGNED band. The worker's unmet hours
 *    are measured against each scenario's own shifted band — a +1 K run
 *    reports zero while every occupied office hour sits above design — so
 *    they are returned as `unmet_own_band_zone_h`, a test of the plant.
 *
 * The limits of the model itself travel as caveats on every result, so a
 * simulated figure can never be shown without them (the verifier requires
 * SIM_ANALYTICALLY_VERIFIED on its own authority as well).
 */

// ============================================================ the limiter

/**
 * Runs per person per hour (§54): a token bucket keyed `${tenantId}:${userId}`,
 * charged for every run a call will make, before the first is posted. Per
 * process, like every limiter here — behind N replicas the effective limit is
 * N times this, which is acceptable for a bound that protects a per-process
 * worker slot.
 */
export function makeSimLimiter(opts: { runsPerHour?: number; now?: () => number } = {}): KeyedLimiter {
  const n = opts.runsPerHour ?? DEFAULT_LIMITS.simRunsPerUserPerHour;
  return new KeyedLimiter({ ratePerS: n / 3600, burst: n, maxKeys: 1000, ...(opts.now ? { now: opts.now } : {}) });
}

let shared: KeyedLimiter | null = null;

/**
 * The process's limiter. Module state on purpose: a limiter held by each
 * user's graph would be reset whenever that graph was evicted, which is a
 * way to get a fresh hour by asking enough questions.
 */
export function sharedSimLimiter(): KeyedLimiter {
  shared ??= makeSimLimiter();
  return shared;
}

// =============================================================== the input

const ScenarioInput = z.object({
  name: z.string().regex(/^[a-z0-9-]{1,40}$/, 'a scenario name is 1–40 lowercase letters, digits or hyphens'),
  setpointDeltaK: z.number().finite(),
}).strict();

const SimulateInput = z.object({
  zoneIds: z.array(z.string().uuid('a zone id from the directory')),
  from: Ts,
  to: Ts,
  peakDryBulbC: z.number().finite(),
  minDryBulbC: z.number().finite(),
  peakGhiWM2: z.number().finite(),
  scenarios: z.array(ScenarioInput),
}).strict();
type SimulateInput = z.infer<typeof SimulateInput>;

/** Weather bounds for the synthetic design day. The worker accepts anything; these are what the building's climate makes plausible. */
const PEAK_DRY_BULB_C = [20, 52] as const;
const MIN_DRY_BULB_C = 10;
const PEAK_GHI_W_PER_M2 = [0, 1100] as const;

/** A scenario may not be called this: it is the name of the run everything is compared with. */
const BASELINE = 'baseline';

/**
 * The name a shift is known by: its direction and size, `plus-1` for +1 K,
 * `minus-0-5` for −0.5 K (to 0.01 K). A scenario's name is shown to the
 * operator as its label — on the record, its headlines, the sim rows and the
 * plan card's "simulated as" badge — and a name chosen freely could say the
 * opposite of what ran: `plus-1` on a −1 K run verified, and the badge sat
 * beside commands that LOWER setpoints (review, ADR 64). So every name
 * starts with this, and only words may follow it.
 */
export function shiftName(deltaK: number): string {
  const size = Number(Math.abs(deltaK).toFixed(2)).toString().replace('.', '-');
  return `${deltaK > 0 ? 'plus' : 'minus'}-${size}`;
}

function namesItsShift(name: string, deltaK: number): boolean {
  const shift = shiftName(deltaK);
  return name === shift || (name.startsWith(`${shift}-`) && /^[a-z]+(?:-[a-z]+)*$/.test(name.slice(shift.length + 1)));
}

interface SimPlan {
  zones: DirectoryRow[];
  w: Window;
  weather: { mode: 'synthetic'; peakDryBulbC: number; minDryBulbC: number; peakGhiW_m2: number };
  scenarios: Array<{ name: string; setpointDeltaK: number }>;
  runner: ScenarioRunner;
  /** Intervals per run, warm-up included. */
  intervals: number;
}

/**
 * Every bound, checked before anything is spent: the model's input against
 * the directory, the window, the weather, the scenarios and the envelope;
 * then the size of the work. Each refusal names its limit (§53).
 */
function checkInput(p: SimulateInput, env: ToolEnv): Omit<SimPlan, 'runner'> | Refused {
  const { limits, orient } = env.ctx;

  if (p.zoneIds.length < 1 || p.zoneIds.length > limits.simMaxZones) {
    return refuse(`zoneIds holds 1 to ${limits.simMaxZones} zones, got ${p.zoneIds.length}`);
  }
  const seen = new Set<string>();
  const zones: DirectoryRow[] = [];
  const unknown: string[] = [];
  for (const id of p.zoneIds) {
    if (seen.has(id)) return refuse(`zone ${id} is listed twice`);
    seen.add(id);
    const z = orient.directory.find((d) => d.id === id);
    if (z) zones.push(z); else unknown.push(id);
  }
  // Refused BY ID: the worker drops an unknown id silently, and the totals
  // would then describe fewer zones than the model believes it asked for.
  if (unknown.length > 0) {
    return refuse(`unknown zone id(s): ${unknown.slice(0, 6).join(', ')} — use ids from the directory`);
  }

  if (!onWholeHour(p.from) || !onWholeHour(p.to)) return refuse('from and to must be on whole hours (the simulator steps hourly)');
  const w = { fromMs: Date.parse(p.from), toMs: Date.parse(p.to) };
  if (w.toMs <= w.fromMs) return refuse('to must be after from');
  const spanH = (w.toMs - w.fromMs) / 3_600_000;
  if (spanH > limits.simMaxWindowH) {
    return refuse(`window is ${spanH} h; simulate_scenarios answers at most ${hoursAndDays(limits.simMaxWindowH)}`);
  }

  if (p.peakDryBulbC < PEAK_DRY_BULB_C[0] || p.peakDryBulbC > PEAK_DRY_BULB_C[1]) {
    return refuse(`peakDryBulbC is ${PEAK_DRY_BULB_C[0]}–${PEAK_DRY_BULB_C[1]}`);
  }
  if (p.minDryBulbC < MIN_DRY_BULB_C || p.minDryBulbC > p.peakDryBulbC) {
    return refuse(`minDryBulbC is ${MIN_DRY_BULB_C} up to peakDryBulbC`);
  }
  if (p.peakGhiWM2 < PEAK_GHI_W_PER_M2[0] || p.peakGhiWM2 > PEAK_GHI_W_PER_M2[1]) {
    return refuse(`peakGhiWM2 is ${PEAK_GHI_W_PER_M2[0]}–${PEAK_GHI_W_PER_M2[1]}`);
  }

  if (p.scenarios.length < 1 || p.scenarios.length > limits.simMaxScenarios) {
    return refuse(`scenarios holds 1 to ${limits.simMaxScenarios}, got ${p.scenarios.length}`);
  }
  const maxDeltaK = Math.min(limits.simMaxDeltaK, orient.envelope?.maxDeviationK ?? limits.simMaxDeltaK);
  const names = new Set<string>();
  for (const s of p.scenarios) {
    if (s.name === BASELINE) return refuse(`a scenario cannot be named ${BASELINE}; the baseline is run for you`);
    if (names.has(s.name)) return refuse(`scenario ${s.name} is named twice`);
    names.add(s.name);
    // The name is the model's text and the operator reads it — in the
    // record's label, its headlines, the sim rows and the plan card's
    // "simulated as" badge — so it is held to the verifier's wording rules.
    // "minus-2k" on a +1 K run would state a figure nobody recomputed.
    if (s.setpointDeltaK === 0) return refuse(`scenario ${s.name}: a shift of 0 K is the baseline`);
    if (verifyText(s.name, orient).length > 0) {
      return refuse(`scenario ${s.name}: a name is shown to the operator, so it cannot state a quantity with a unit ` +
        `or use a banned word; name the shift without a unit (${shiftName(s.setpointDeltaK)})`);
    }
    if (Math.abs(s.setpointDeltaK) > maxDeltaK) {
      return refuse(`scenario ${s.name}: |setpointDeltaK| is at most ${maxDeltaK} K (the control envelope's deviation limit)`);
    }
    if (!namesItsShift(s.name, s.setpointDeltaK)) {
      return refuse(`scenario ${s.name}: a name is the operator's label for the shift it simulates, so it starts ` +
        `with ${shiftName(s.setpointDeltaK)} for a setpointDeltaK of ${s.setpointDeltaK}, and only words may follow ` +
        `(e.g. ${shiftName(s.setpointDeltaK)}-offices)`);
    }
  }

  const runs = 1 + p.scenarios.length;
  if (runs > limits.simRunsPerRequest) return refuse(`at most ${limits.simRunsPerRequest} runs per request`);
  const intervals = spanH + limits.simWarmupH;
  if (zones.length * intervals > limits.simMaxZoneH) {
    return refuse(`${zones.length} zones × ${intervals} h (including ${limits.simWarmupH} h warm-up) is ` +
      `${zones.length * intervals} zone-hours; a run is at most ${limits.simMaxZoneH}`);
  }

  return {
    zones, w, intervals,
    weather: { mode: 'synthetic', peakDryBulbC: p.peakDryBulbC, minDryBulbC: p.minDryBulbC, peakGhiW_m2: p.peakGhiWM2 },
    scenarios: p.scenarios.map((s) => ({ name: s.name, setpointDeltaK: s.setpointDeltaK })),
  };
}

// =========================================================== the analysis

/** The designed band's tolerance before a zone-hour counts as warm or cool (as the worker's unmet test). */
const COMFORT_TOLERANCE_K = 0.5;
/** The engine's occupancy rule: occupied above this share of design occupancy. */
const OCCUPIED_SHARE = 0.05;
const TOP_ZONES = 5;

interface RunSummary {
  total_kwh: number;
  hvac_kwh: number;
  lighting_kwh: number;
  plug_kwh: number;
  peak_interval_kw: number | null;
  peak_at: string | null;
  unmet_own_band_zone_h: number | null;
  warm_vs_design_zone_h: number;
  cool_vs_design_zone_h: number;
}

interface ZoneComfort {
  maxOccupiedC: number | null;
  warmH: number;
}

/**
 * One run over the TARGET window (warm-up rows already dropped). Peak demand
 * is the largest hourly interval's summed energy over the simulated zones ÷
 * the interval — an interval mean, not a 15-minute demand peak.
 */
export function summariseRun(
  rows: readonly SimResultRow[], zones: readonly DirectoryRow[], intervalH: number,
): { summary: RunSummary; byZone: Map<string, ZoneComfort> } {
  const dir = new Map(zones.map((z) => [z.id, z]));
  const perInterval = new Map<number, number>();
  const byZone = new Map<string, ZoneComfort>(zones.map((z) => [z.id, { maxOccupiedC: null, warmH: 0 }]));
  let total = 0; let hvac = 0; let lighting = 0; let plug = 0;
  let unmet: number | null = null;
  let warm = 0; let cool = 0;

  for (const r of rows) {
    total += r.totalKwh; hvac += r.hvacLoadKwh; lighting += r.lightingKwh; plug += r.plugKwh;
    if (r.unmetHours !== null) unmet = (unmet ?? 0) + r.unmetHours;
    const t = new Date(r.intervalStart).getTime();
    perInterval.set(t, (perInterval.get(t) ?? 0) + r.totalKwh);

    const z = dir.get(r.zoneId);
    const zc = byZone.get(r.zoneId);
    if (!z || !zc || r.indoorTempC === null) continue;
    const occupied = (r.occupancyCount ?? 0) > OCCUPIED_SHARE * (z.design_occupancy_count ?? 0);
    if (!occupied) continue;
    zc.maxOccupiedC = zc.maxOccupiedC === null ? r.indoorTempC : Math.max(zc.maxOccupiedC, r.indoorTempC);
    // Judged against the DESIGNED band; a zone with no profile cannot be judged.
    if (z.designed_setpoint_c === null || z.deadband_k === null) continue;
    const half = z.deadband_k / 2 + COMFORT_TOLERANCE_K;
    if (r.indoorTempC > z.designed_setpoint_c + half) { warm += intervalH; zc.warmH += intervalH; }
    if (r.indoorTempC < z.designed_setpoint_c - half) cool += intervalH;
  }

  let peakAt: number | null = null;
  let peak = -Infinity;
  for (const [t, kwh] of perInterval) {
    if (kwh > peak || (kwh === peak && peakAt !== null && t < peakAt)) { peak = kwh; peakAt = t; }
  }
  return {
    summary: {
      total_kwh: total, hvac_kwh: hvac, lighting_kwh: lighting, plug_kwh: plug,
      peak_interval_kw: peakAt === null ? null : peak / intervalH,
      peak_at: peakAt === null ? null : new Date(peakAt).toISOString(),
      unmet_own_band_zone_h: unmet,
      warm_vs_design_zone_h: warm,
      cool_vs_design_zone_h: cool,
    },
    byZone,
  };
}

/** Exactly one row per (zone, interval) over the whole run, or the reason there is not. */
function completeRows(rows: readonly SimResultRow[], plan: SimPlan, periodStartMs: number): boolean {
  if (rows.length !== plan.zones.length * plan.intervals) return false;
  const want = new Set(plan.zones.map((z) => z.id));
  const seen = new Set<string>();
  for (const r of rows) {
    const t = new Date(r.intervalStart).getTime();
    const i = (t - periodStartMs) / 3_600_000;
    if (!want.has(r.zoneId) || !Number.isInteger(i) || i < 0 || i >= plan.intervals) return false;
    const key = `${r.zoneId}@${t}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

// ================================================================ the tool

/** One run: the baseline (no params) or a scenario (one uniform shift). */
interface RunSpec {
  role: 'baseline' | 'scenario';
  scenario: string;
  params: { setpointDeltaK?: number };
}

const SERVICE = 'simulator' as const;

const WORKER_BUSY = 'simulator busy (worker admission limit reached); not retried';
const SLOT_BUSY = 'simulator busy (another copilot simulation is running in this service); not retried';

export const simulateScenarios = evidenceTool<SimPlan>({
  name: 'simulate_scenarios',
  service: SERVICE,
  definition: {
    name: 'simulate_scenarios',
    description:
      'What-if on the building model: a baseline and 1–2 scenarios, each shifting EVERY listed zone\'s ' +
      'setpoint by the same amount (K) for the whole period, over the same zones, period and synthetic ' +
      'clear-sky design day (peak and minimum dry bulb °C, peak GHI W/m²). 24 h of warm-up are added and ' +
      'dropped. Returns energy (total, HVAC, lighting, plug), the peak hourly interval, unmet zone-hours ' +
      'against each run\'s OWN band, zone-hours warm or cool against the DESIGNED band while occupied, and ' +
      'per scenario the change from baseline with the zones whose occupied maximum moved most. Model output, ' +
      'not measurement. Runs take seconds; call once per request. Limits: ' +
      `1–${DEFAULT_LIMITS.simMaxZones} zones, from and to on whole hours, window at most ${DEFAULT_LIMITS.simMaxWindowH} h, ` +
      `|shift| at most ${DEFAULT_LIMITS.simMaxDeltaK} K (or the envelope's deviation limit), scenario names lowercase-hyphenated.`,
    input_schema: {
      type: 'object',
      properties: {
        zoneIds: { type: 'array', items: { type: 'string', format: 'uuid' }, description: 'Zones to simulate, ids from the directory.' },
        from: { type: 'string', format: 'date-time', description: 'Target window start, on a whole hour, with offset.' },
        to: { type: 'string', format: 'date-time', description: 'Target window end, on a whole hour, with offset.' },
        peakDryBulbC: { type: 'number', description: 'Design-day peak outdoor dry bulb, °C (20–52).' },
        minDryBulbC: { type: 'number', description: 'Design-day minimum outdoor dry bulb, °C (10 up to the peak).' },
        peakGhiWM2: { type: 'number', description: 'Peak global horizontal irradiance, W/m² (0–1100; 950 is clear sky).' },
        scenarios: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'The shift it simulates, which the operator reads as its label: plus-1 for +1, ' +
                  'minus-0-5 for -0.5; only words may follow (plus-1-offices).',
              },
              setpointDeltaK: { type: 'number', description: 'Uniform setpoint shift, K; not 0.' },
            },
            required: ['name', 'setpointDeltaK'],
            additionalProperties: false,
          },
          description: '1 or 2 scenarios; the baseline is run for you.',
        },
      },
      required: ['zoneIds', 'from', 'to', 'peakDryBulbC', 'minDryBulbC', 'peakGhiWM2', 'scenarios'],
      additionalProperties: false,
    },
    strict: true,
  },

  prepare(input, env) {
    const { ctx } = env;
    const runner = ctx.deps.scenarios ?? null;
    if (runner === null || !ctx.orient.sim.available) return refuse('simulator unavailable (COPILOT_SIM_API_KEY is not set)');
    const r = SimulateInput.safeParse(input);
    if (!r.success) return refuse(`invalid input: ${zodIssues(r.error)}`);
    const plan = checkInput(r.data, env);
    if (isRefused(plan)) return plan;

    // Spent only by a call that passed every check above, so a model can fix
    // its input and try again; once spent, a second call in the request is
    // refused however the first went — a retry loop against the worker is
    // exactly what the bound prevents.
    if (!ctx.run.claimSimCall()) return refuse('simulate_scenarios runs once per request, and it has already run');

    const limiter = ctx.simLimiter;
    if (!limiter) return refuse('simulator unavailable (no run limiter configured)');
    const key = `${ctx.identity.tenantId}:${ctx.identity.userId}`;
    const cost = 1 + plan.scenarios.length;
    const taken = limiter.take(key, cost);
    if (!taken.ok) {
      ctx.log?.('copilot.sim_refused', { reason: 'user_limit', retryAfterS: taken.retryAfterS });
      const retry = Number.isFinite(taken.retryAfterS) ? `${taken.retryAfterS} s` : 'an hour';
      return refuse(`simulation limit reached (${ctx.limits.simRunsPerUserPerHour} runs per hour per person); ` +
        `retry after ${retry} (retry_after_s ${Number.isFinite(taken.retryAfterS) ? taken.retryAfterS : 3600})`);
    }
    return { ...plan, runner };
  },

  async execute(plan, env): Promise<EvidenceDraft | Refused> {
    const { ctx, task } = env;
    const { limits } = ctx;
    const periodStartMs = plan.w.fromMs - limits.simWarmupH * 3_600_000;
    // The ONE template. Every run below spreads this same object, so zones,
    // period, interval and weather cannot differ between them.
    const template = Object.freeze({
      buildingId: ctx.orient.building.id,
      periodStart: new Date(periodStartMs).toISOString(),
      periodEnd: new Date(plan.w.toMs).toISOString(),
      intervalS: 3600,
      zoneIds: Object.freeze(plan.zones.map((z) => z.id)),
      weather: Object.freeze({ ...plan.weather }),
    });
    const specs: RunSpec[] = [
      { role: 'baseline', scenario: BASELINE, params: {} },
      ...plan.scenarios.map((s): RunSpec => ({ role: 'scenario', scenario: s.name, params: { setpointDeltaK: s.setpointDeltaK } })),
    ];

    const runs: SimRunRecord[] = [];
    const results: Array<{ spec: RunSpec; rows: SimResultRow[] }> = [];
    const fail = (message: string, reason: string): Refused => {
      ctx.log?.('copilot.sim_refused', { reason, taskId: task.taskId });
      return refuse(message, runs.map((r) => ({ ...r })));
    };

    // SEQUENTIAL, baseline first: one run of this request in flight at a time.
    for (const spec of specs) {
      const admitted = ctx.run.beginSimRun();
      if (admitted !== null) {
        return fail(admitted === 'stopped' ? 'stopped before the simulation could run'
          : admitted === 'deadline' ? 'the request passed its deadline before the simulation could run'
          : `simulation run refused (${admitted})`, admitted);
      }
      try {
        const outcome = await runOne(spec, template, plan, env, runs);
        if (isRefused(outcome)) return fail(outcome.refused, 'run_failed');
        results.push({ spec, rows: outcome });
      } finally {
        ctx.run.endSimRun();
      }
    }

    // ---- over the TARGET window only: the warm-up is dropped here.
    const target = (rows: readonly SimResultRow[]) => rows.filter((r) => {
      const t = new Date(r.intervalStart).getTime();
      return t >= plan.w.fromMs && t < plan.w.toMs;
    });
    const intervalH = 1;
    const [baseRun, ...scenarioRuns] = results.map((r) => ({ ...r, ...summariseRun(target(r.rows), plan.zones, intervalH) }));
    const base = baseRun!;
    const zoneName = new Map(plan.zones.map((z) => [z.id, z.name]));

    const scenarios = scenarioRuns.map((s) => {
      const d = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
      const top = plan.zones.flatMap((z) => {
        const b = base.byZone.get(z.id)?.maxOccupiedC ?? null;
        const c = s.byZone.get(z.id)?.maxOccupiedC ?? null;
        return b === null || c === null ? [] : [{
          zone: zoneName.get(z.id)!,
          max_occupied_baseline_c: b,
          max_occupied_scenario_c: c,
          delta_max_occupied_k: c - b,
          warm_vs_design_zone_h: s.byZone.get(z.id)?.warmH ?? 0,
        }];
      }).sort((x, y) => Math.abs(y.delta_max_occupied_k) - Math.abs(x.delta_max_occupied_k) || x.zone.localeCompare(y.zone))
        .slice(0, TOP_ZONES);
      return {
        name: s.spec.scenario,
        setpoint_delta_k: s.spec.params.setpointDeltaK ?? 0,
        ...s.summary,
        delta_total_kwh: s.summary.total_kwh - base.summary.total_kwh,
        delta_total_pct: base.summary.total_kwh > 0
          ? ((s.summary.total_kwh - base.summary.total_kwh) / base.summary.total_kwh) * 100 : null,
        delta_hvac_kwh: s.summary.hvac_kwh - base.summary.hvac_kwh,
        delta_peak_kw: d(s.summary.peak_interval_kw, base.summary.peak_interval_kw),
        top_zones: top,
      };
    });

    const caveats: CaveatId[] = [
      'SIM_ANALYTICALLY_VERIFIED', 'SIM_SYNTHETIC_WEATHER', 'SIM_UNIFORM_DELTA', 'SIM_UNMET_OWN_BAND',
      'SIM_CONSTANT_COP_NO_SETBACK', 'SIM_PEAK_INTERVAL_MEAN', 'SIM_PLANT_RESIZED_PER_RUN',
    ];
    if (plan.zones.length < ctx.orient.directory.length) caveats.push('SIM_SUBSET');

    const headline = [
      { label: 'Baseline total', path: 'baseline.total_kwh' },
      ...scenarios.slice(0, 2).flatMap((s, i) => [
        { label: `${s.name}: change in total`, path: `scenarios[${i}].delta_total_kwh` },
        { label: `${s.name}: change in total, %`, path: `scenarios[${i}].delta_total_pct` },
      ]),
      { label: `${scenarios[0]?.name ?? ''}: warm zone-hours vs design`, path: 'scenarios[0].warm_vs_design_zone_h' },
    ];

    return {
      tool: 'simulate_scenarios',
      kind: 'simulated',
      source: 'simulation',
      label: `What-if ${plan.scenarios.map((s) => s.name).join(', ')} vs baseline: ${plan.zones.length} zones, ` +
        `${windowLabel(plan.w, env)}, synthetic day peaking at ${round4(plan.weather.peakDryBulbC)} °C`,
      window: windowOf(plan.w, env),
      coverage: null,
      flaggedExcluded_count: null,
      truncated: null,
      caveats,
      headline,
      data: shapeData({
        weather: {
          mode: 'synthetic',
          peak_dry_bulb_c: plan.weather.peakDryBulbC,
          min_dry_bulb_c: plan.weather.minDryBulbC,
          // Not `_w_m2`: the unit table would read that as m². `_per_m2` is uncitable, correctly.
          peak_ghi_w_per_m2: plan.weather.peakGhiW_m2,
        },
        warmup_h: limits.simWarmupH,
        interval_s: 3600,
        zones_count: plan.zones.length,
        // Which zones were simulated, by id: plan_check matches a proposed
        // plan against them before the card may say "simulated as".
        zone_ids: plan.zones.map((z) => z.id),
        runs: runs.map((r) => ({ role: r.role, scenario: r.scenario, run_id: r.runId })),
        baseline: base.summary,
        scenarios,
      }, env),
      simRuns: runs.map((r) => ({ ...r })),
    };
  },
});

/**
 * One run: start it, poll it to a terminal state within its deadline, fetch
 * exactly its rows. Refusals are returned, never thrown; a run this call
 * started and cannot finish is cancelled before the refusal is.
 */
async function runOne(
  spec: RunSpec,
  template: Readonly<Record<string, unknown>>,
  plan: SimPlan,
  env: ToolEnv,
  runs: SimRunRecord[],
): Promise<SimResultRow[] | Refused> {
  const { ctx, task } = env;
  const { limits } = ctx;
  const req = SimulationRequest.parse({
    ...template,
    scenarioName: `copilot: ${spec.scenario}`,
    description: `copilot run; user ${ctx.identity.userId}; request ${ctx.requestId}`,
    params: spec.params,
  });

  let started: SimStartResult;
  try {
    started = await plan.runner.start(req);
  } catch {
    return refuse('simulator unavailable');
  }
  if (!started.ok) {
    if (started.reason === 'busy') return refuse(started.status === 429 ? WORKER_BUSY : SLOT_BUSY);
    if (started.reason === 'unavailable') return refuse('simulator unavailable');
    return refuse(`simulator refused the run: ${started.message.slice(0, 200)}`);
  }

  const record: SimRunRecord = { runId: started.runId, taskId: task.taskId, role: spec.role, scenario: spec.scenario, status: 'queued' };
  runs.push(record);
  const report = (status: SimulationStatus, progressPct: number) => {
    record.status = status;
    ctx.emit?.({ event: 'copilot.sim', taskId: task.taskId, runId: record.runId, role: spec.role, scenario: spec.scenario, status, progressPct });
  };
  report('queued', 0);

  const cancel = async (): Promise<void> => {
    try {
      await plan.runner.cancel(record.runId);
    } catch {
      // The runner's slot lease is the backstop for a cancel that cannot reach the worker.
    }
    report('cancelled', 0);
  };

  const startedAt = ctx.now();
  for (;;) {
    let state: SimRunState;
    try {
      state = await plan.runner.getRun(record.runId);
    } catch {
      await cancel();
      return refuse('simulator unavailable');
    }
    if (state.status === 'completed') { report('completed', 100); break; }
    if (state.status === 'failed') {
      report('failed', state.progressPct);
      return refuse(`simulation failed on the worker (${(state.error ?? 'no reason given').slice(0, 200)})`);
    }
    if (state.status === 'cancelled') { report('cancelled', state.progressPct); return refuse('simulation was cancelled'); }
    report(state.status, state.progressPct);

    const why = ctx.run.interrupted();
    if (why !== null) {
      await cancel();
      return refuse(why === 'stopped' ? 'stopped: the running simulation was cancelled'
        : 'the request passed its deadline: the running simulation was cancelled');
    }
    if (ctx.now() - startedAt >= limits.simRunDeadlineS * 1000) {
      await cancel();
      return refuse(`simulation timed out after ${limits.simRunDeadlineS} s and was cancelled`);
    }
    await ctx.sleep(limits.simPollIntervalMs);
  }

  const expected = plan.zones.length * plan.intervals;
  let rows: SimResultRow[];
  try {
    rows = await plan.runner.getResults(record.runId, expected);
  } catch {
    return refuse('simulator unavailable');
  }
  if (!completeRows(rows, plan, Date.parse(String(template.periodStart)))) {
    return refuse(`incomplete results (${rows.length} of ${expected} rows)`);
  }
  return rows;
}

export const SIMULATE_TOOL_SET = [simulateScenarios] as const;
