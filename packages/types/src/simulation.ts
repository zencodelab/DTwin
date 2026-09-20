import { z } from 'zod';
import { BuildingId, ZoneId, SimulationRunId } from './ids.ts';
import { SimulationStatus } from './enums.ts';

/**
 * Contract between the Next.js API and the Python simulation worker.
 *
 * The worker is the only Python in the system and owns exactly one thing: the
 * physics. Its Pydantic models in apps/sim/app/models.py mirror these schemas —
 * that duplication is the price of a two-language split, so keep the field
 * names identical and let the round-trip test catch drift.
 */

/** External boundary conditions for one interval. */
export const WeatherPoint = z.object({
  ts: z.coerce.date(),
  dryBulbC: z.number(),
  rhPct: z.number().min(0).max(100).nullable(),
  /** Global horizontal irradiance — drives the solar gain term. */
  ghiW_m2: z.number().nonnegative().nullable(),
  dniW_m2: z.number().nonnegative().nullable(),
  windM_s: z.number().nonnegative().nullable(),
  cloudPct: z.number().min(0).max(100).nullable(),
});
export type WeatherPoint = z.infer<typeof WeatherPoint>;

/**
 * Scenario overrides applied on top of each zone's stored thermal profile.
 * Free-form knobs change faster than a schema should, but the common ones are
 * typed so the UI can offer them without guessing.
 */
export const SimulationParams = z.object({
  /** Shift every zone setpoint by this many kelvin. The classic what-if. */
  setpointDeltaK: z.number().optional(),
  /** Multiplier on lighting power density, e.g. 0.6 for an LED retrofit. */
  lightingScale: z.number().positive().optional(),
  equipmentScale: z.number().positive().optional(),
  occupancyScale: z.number().positive().optional(),
  /** Multiplier on plant COP, e.g. 1.15 for a chiller replacement. */
  hvacCopScale: z.number().positive().optional(),
  infiltrationScale: z.number().positive().optional(),
  /** Override the grid emission factor, e.g. to model a PPA. */
  gridCarbonKgPerKwh: z.number().nonnegative().optional(),
});
export type SimulationParams = z.infer<typeof SimulationParams>;

export const SimulationRequest = z.object({
  buildingId: BuildingId,
  scenarioName: z.string().min(1),
  description: z.string().optional(),
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
  intervalS: z.number().int().positive().default(3600),
  params: SimulationParams.default({}),
  /** Restrict to a subset of zones; omit to run the whole building. */
  zoneIds: z.array(ZoneId).optional(),
  /**
   * Weather source. `observed` replays weather_observations for the period;
   * `inline` uses the supplied series; `synthetic` generates a design day.
   */
  weather: z
    .discriminatedUnion('mode', [
      z.object({ mode: z.literal('observed') }),
      z.object({ mode: z.literal('inline'), series: z.array(WeatherPoint).min(1) }),
      z.object({
        mode: z.literal('synthetic'),
        peakDryBulbC: z.number(),
        minDryBulbC: z.number(),
        peakGhiW_m2: z.number().nonnegative().default(950),
      }),
    ])
    .default({ mode: 'observed' }),
})
  .refine((r) => r.periodEnd > r.periodStart, {
    message: 'periodEnd must be after periodStart',
  });
export type SimulationRequest = z.infer<typeof SimulationRequest>;

export const SimulationRun = z.object({
  id: SimulationRunId,
  buildingId: BuildingId,
  scenarioName: z.string(),
  description: z.string().nullable(),
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
  intervalS: z.number().int().positive(),
  params: SimulationParams,
  status: SimulationStatus,
  progressPct: z.number().min(0).max(100),
  requestedAt: z.coerce.date(),
  startedAt: z.coerce.date().nullable(),
  completedAt: z.coerce.date().nullable(),
  error: z.string().nullable(),
});
export type SimulationRun = z.infer<typeof SimulationRun>;

/**
 * One (run, zone, interval) result.
 *
 * Energy is stored disaggregated by end use. The total is trivially recoverable
 * from the parts but the parts are not recoverable from the total, and the
 * split is the entire point — a facility manager needs to know which end use to
 * attack. The heat balance terms answer the follow-up question ("why is this
 * zone expensive?"), which kWh alone cannot.
 */
export const SimulationResult = z.object({
  runId: SimulationRunId,
  zoneId: ZoneId,
  intervalStart: z.coerce.date(),
  hvacLoadKwh: z.number().nonnegative(),
  lightingKwh: z.number().nonnegative(),
  plugKwh: z.number().nonnegative(),
  totalKwh: z.number().nonnegative(),
  co2Kg: z.number().nonnegative(),
  peakDemandKw: z.number().nonnegative().nullable(),
  indoorTempC: z.number().nullable(),
  solarGainKwh: z.number().nullable(),
  internalGainKwh: z.number().nullable(),
  envelopeLossKwh: z.number().nullable(),
  ventilationLossKwh: z.number().nullable(),
  occupancyCount: z.number().nonnegative().nullable(),
  /** Hours the zone spent outside its setpoint deadband — the comfort penalty. */
  unmetHours: z.number().nonnegative().nullable(),
});
export type SimulationResult = z.infer<typeof SimulationResult>;

/** Whole-run rollup, which is what the dashboard headline actually shows. */
export const EnergyBreakdown = z.object({
  hvacKwh: z.number().nonnegative(),
  /**
   * The dehumidification share of `hvacKwh` — a SUBSET of it, not an addition.
   *
   * Reported separately because "why is this building expensive?" has a
   * different answer in Abu Dhabi than in Munich, and one HVAC number cannot
   * give it. Nullable: a run made before the latent model existed has none to
   * report, and zero would claim it looked and found none. See
   * docs/decisions.md §48.
   */
  latentKwh: z.number().nonnegative().nullable(),
  /**
   * Supply-fan electricity — also a SUBSET of `hvacKwh`.
   *
   * Separate from latent because they answer different questions: latent asks
   * what the climate costs, fan asks what the air-side costs, and only one of
   * those has an answer a facilities manager can act on this month.
   */
  fanKwh: z.number().nonnegative().nullable(),
  lightingKwh: z.number().nonnegative(),
  plugKwh: z.number().nonnegative(),
  totalKwh: z.number().nonnegative(),
  co2Kg: z.number().nonnegative(),
  peakDemandKw: z.number().nonnegative().nullable(),
  /** Energy use intensity, kWh/m2 over the period — the comparable number. */
  euiKwhPerM2: z.number().nonnegative().nullable(),
  unmetHours: z.number().nonnegative().nullable(),
});
export type EnergyBreakdown = z.infer<typeof EnergyBreakdown>;

export const SimulationSummary = z.object({
  run: SimulationRun,
  building: EnergyBreakdown,
  byZone: z.array(EnergyBreakdown.extend({ zoneId: ZoneId, zoneName: z.string() })),
});
export type SimulationSummary = z.infer<typeof SimulationSummary>;

/**
 * Event the simulation worker posts to the ingest service so progress and
 * results reach browsers over the WebSocket.
 *
 * The worker deliberately holds no socket of its own. It is a batch compute
 * service that may run on a different box, scale separately, or be restarted
 * mid-run; giving it a fan-out responsibility would mean two services owning
 * client connections and two places to get backpressure wrong. Ingest already
 * owns every subscription, so the worker tells it what happened and ingest
 * decides who hears about it.
 */
export const SimEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sim.progress'),
    runId: SimulationRunId,
    buildingId: BuildingId,
    progressPct: z.number().min(0).max(100),
  }),
  z.object({
    type: z.literal('sim.complete'),
    runId: SimulationRunId,
    buildingId: BuildingId,
    summary: SimulationSummary,
  }),
  z.object({
    type: z.literal('sim.failed'),
    runId: SimulationRunId,
    buildingId: BuildingId,
    error: z.string(),
  }),
]);
export type SimEvent = z.infer<typeof SimEvent>;
