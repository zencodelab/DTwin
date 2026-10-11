import type {
  AlertListRow, Capped, CommandHistoryRow, CompareMetric, CompareOrder, CompareZonesRows,
  CopilotZoneMetric, CopilotZoneSummary, EnergyGroupBy, EnergyRows, EquipmentStatusRow,
  MeterRows, OrientSnapshot, ZoneConditionsRows, ZoneHistoryRows, ZoneTimelineRows,
} from '@dtwin/db';
import type {
  ControlRefusal, ControlSettings, SimulationRequest, SimulationResult, SimulationStatus,
} from '@dtwin/types';
import type { Logger } from '../log.ts';
import type { Limits } from './limits.ts';
import type { ModelCaller, Role } from './registry.ts';

/**
 * What the copilot may touch, split by capability (docs/decisions.md §64).
 *
 * v1 had one `CopilotBackend` with four verbs, and the verb that writes to
 * the building sat beside the three that read: anything holding the backend
 * could issue. Here each kind of authority is its own interface, and a
 * component is handed only the ones it needs:
 *
 *   TwinReader      reads the twin, in READ ONLY transactions
 *   ControlProbe    asks the envelope — settings and dry runs, never an issue
 *   ScenarioRunner  runs what-ifs on the simulation worker (scratch writes)
 *   Issuer          issues setpoint commands — held by `apply` and nothing else
 *
 * `ControlProbe` has no `issue`, `SpecialistDeps` has no `issuer`, and the
 * compiler says so (capability.test.ts). That is the type half of P9; the
 * runtime half is that the real probe's fetch refuses any request that is not
 * a dry run, and the scratch runner's fetch refuses any worker route that is
 * not on its allow-list — both before a byte is sent.
 *
 * Type-only imports from `@dtwin/db` on purpose: this module, the fakes and
 * every pure module that needs these types must load without `pg`.
 */

export type { Capped, ModelCaller, Role };

// ------------------------------------------------------------------- reading

/** v1's `ZoneSummary`, which `list_zones` keeps verbatim (§5.3, control vocabulary). */
export type ZoneSummary = CopilotZoneSummary;

/**
 * Every read the copilot makes. One method per query in
 * packages/db/src/queries/copilot.ts, each one READ ONLY transaction in the
 * real implementation (`realReader`), and each one a fixture in the fake.
 *
 * Query windows are `Date`s: the tool layer has already parsed, bounded and
 * refused them (§5.2), so nothing here re-validates a window — but the db
 * layer still refuses what would otherwise truncate silently.
 *
 * Every read that is not scoped by a zone id from the directory names
 * orient's building (`buildingId`). RLS scopes a transaction to the TENANT,
 * and a tenant may hold several buildings; unscoped, those reads summed and
 * ranked across all of them under a notice that said the answer covered one
 * (review, ADR 64).
 */
export interface TwinReader {
  orient(): Promise<OrientSnapshot>;
  /** v1's query, unchanged: the latest GOOD temperature per zone (§55). */
  listZones(): Promise<ZoneSummary[]>;
  /** Null when the zone is not visible to this tenant (missing or another tenant's). */
  zoneConditions(q: { zoneId: string; from: Date; to: Date }): Promise<ZoneConditionsRows | null>;
  zoneHistory(q: {
    zoneId: string; metrics: readonly CopilotZoneMetric[]; resolution: '5m' | '1h'; from: Date; to: Date;
  }): Promise<ZoneHistoryRows>;
  zoneTimeline(q: { zoneId: string; from: Date; to: Date; limit: number }): Promise<ZoneTimelineRows>;
  equipmentStatus(q: {
    tag: string | null; zoneId: string | null; limit: number; buildingId: string;
  }): Promise<Capped<EquipmentStatusRow>>;
  listAlerts(q: {
    state: 'live' | 'resolved' | 'any'; from: Date; to: Date; zoneId: string | null; limit: number; buildingId: string;
  }): Promise<Capped<AlertListRow>>;
  controlHistory(q: {
    zoneId: string | null; from: Date; to: Date; limit: number; buildingId: string;
  }): Promise<Capped<CommandHistoryRow>>;
  energyByEndUse(q: {
    from: Date; to: Date; groupBy: EnergyGroupBy; timezone: string; buildingId: string;
  }): Promise<EnergyRows>;
  meterConsumption(q: {
    meterTag: string; from: Date; to: Date; bucket: 'hour' | 'local_day'; timezone: string; buildingId: string;
  }): Promise<MeterRows | { unknownMeter: true }>;
  compareZones(q: {
    metric: CompareMetric; from: Date; to: Date; floorLevel: number | null; orderBy: CompareOrder; limit: number;
    buildingId: string;
    /** The tool's clock: `covered` ends no later than this. */
    now: Date;
  }): Promise<CompareZonesRows>;
}

/**
 * The method names, as data: what a strict fake allows and nothing else, and
 * what a test enumerates to prove every read opens READ ONLY. The two
 * assertions below make the list and the interface the same set, so adding
 * a method without listing it (or the reverse) is a compile error.
 */
export const TWIN_READER_METHODS = [
  'orient', 'listZones', 'zoneConditions', 'zoneHistory', 'zoneTimeline', 'equipmentStatus',
  'listAlerts', 'controlHistory', 'energyByEndUse', 'meterConsumption', 'compareZones',
] as const satisfies ReadonlyArray<keyof TwinReader>;
export type ReaderMethod = (typeof TWIN_READER_METHODS)[number];
type _ReaderListIsComplete = AssertNever<Exclude<keyof TwinReader, ReaderMethod>>;

// ------------------------------------------------------------------- control

export interface CommandSpec {
  zoneId: string;
  setpointTempC: number;
  durationS?: number | undefined;
  reason: string;
}

export type DryRunResult =
  | { allowed: true; previousTempC: number; durationS: number; effectiveUntil: string }
  | { allowed: false; refusal: ControlRefusal | 'unknown_zone' | string; message: string };

export type IssueResult =
  | { ok: true; commandId: string; state: string; effectiveUntil: string }
  | { ok: false; refusal: string; message: string };

/**
 * The dry-run capability: read the envelope, ask whether a command WOULD be
 * allowed. No `issue`. `settings()` throws when the envelope cannot be read
 * (orient then records `control_unavailable`); `dryRun()` answers a refusal
 * for anything the control service says, including a reply it cannot read,
 * and throws only when the service cannot be reached.
 */
export interface ControlProbe {
  settings(): Promise<ControlSettings>;
  dryRun(command: CommandSpec): Promise<DryRunResult>;
}
export const CONTROL_PROBE_METHODS = ['settings', 'dryRun'] as const satisfies ReadonlyArray<keyof ControlProbe>;
type _ProbeListIsComplete = AssertNever<Exclude<keyof ControlProbe, (typeof CONTROL_PROBE_METHODS)[number]>>;

/** The one write to the building. Held ONLY by `apply` (§3.1, §5.5). */
export interface Issuer {
  issue(command: CommandSpec): Promise<IssueResult>;
}
export const ISSUER_METHODS = ['issue'] as const satisfies ReadonlyArray<keyof Issuer>;

// ---------------------------------------------------------------- simulation

/** One result row as the worker's `/runs/{id}/results` returns it (no runId). */
export type SimResultRow = Omit<SimulationResult, 'runId'>;

/**
 * Why a run did not start. `busy` with `status` 429 is the worker's admission
 * limit; `busy` with `status` 0 is this web process's own one-copilot-run slot,
 * refused before any request was sent. Neither is retried.
 */
export type SimStartResult =
  | { ok: true; runId: string }
  | { ok: false; reason: 'busy' | 'unavailable' | 'refused'; status: number; message: string };

export interface SimRunState {
  status: SimulationStatus;
  progressPct: number;
  error: string | null;
}

/**
 * The scratch capability: the simulation worker, through an allow-list of
 * routes — start a run, read it, read its results, cancel it. Every run-scoped
 * call is refused unless this runner started the run. There is no route to
 * `/weather/generate` (it writes `weather_observations`, which an `observed`
 * simulation would then read as real) and none to ingest.
 */
export interface ScenarioRunner {
  start(req: SimulationRequest): Promise<SimStartResult>;
  getRun(runId: string): Promise<SimRunState>;
  /** Exactly the worker's rows, at most `limit` (1–10,000); the caller asserts the count. */
  getResults(runId: string, limit: number): Promise<SimResultRow[]>;
  cancel(runId: string): Promise<void>;
}
export const SCENARIO_RUNNER_METHODS = [
  'start', 'getRun', 'getResults', 'cancel',
] as const satisfies ReadonlyArray<keyof ScenarioRunner>;
type _RunnerListIsComplete = AssertNever<Exclude<keyof ScenarioRunner, (typeof SCENARIO_RUNNER_METHODS)[number]>>;

// ---------------------------------------------------------------- the graph

/**
 * Everything `buildCopilotGraph` is given. It destructures `issuer` and hands
 * it to `makeApply` alone; every other node receives a narrower slice
 * (`SpecialistDeps`, or the probe for plan_check).
 */
export interface GraphDeps {
  reader: TwinReader;
  probe: ControlProbe;
  issuer: Issuer;
  /** Null when COPILOT_SIM_API_KEY is unset: `simulate` is then never offered (§5.1). */
  scenarios: ScenarioRunner | null;
  callModel: ModelCaller;
  models: { lead: string; specialist: string };
  identity: { tenantId: string; userId: string };
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  clock?: () => number;
  /** Defaults to a real timer; the fakes resolve at once and advance the fake clock. */
  sleep?: (ms: number) => Promise<void>;
  limits?: Partial<Limits>;
  /** Event names and fields (§61). Defaults to the web service's JSON-line logger. */
  log?: Logger;
}

/**
 * What a specialist subgraph holds: diagnose and analyse `{reader}`, simulate
 * `{reader, scenarios}`, control `{reader, probe}` (§6). No `issuer` — not
 * optional, absent — so a specialist cannot be handed one by mistake.
 */
export type SpecialistDeps = {
  reader: TwinReader;
  probe?: ControlProbe;
  scenarios?: ScenarioRunner | null;
};

type AssertNever<T extends never> = T;
