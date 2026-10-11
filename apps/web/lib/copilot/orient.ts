import type { OrientSnapshot } from '@dtwin/db';
import type { ControlSettings } from '@dtwin/types';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { Logger } from '../log.ts';
import type { ControlProbe, TwinReader } from './deps.ts';
import type { CaveatId, EvidenceRecord } from './evidence.ts';
import { notice, type Notice } from './notices.ts';
import type { CopilotStateType, CopilotUpdate, OrientContext, RequestStamp } from './state.ts';
import { localStamp, toLocalIso } from './time.ts';
import { errorName } from './model.ts';

/**
 * `orient`: what the building is and what its data can answer, read once per
 * request before any model is asked (design §5.1).
 *
 * Deterministic and not model-callable. It reads the directory, the data
 * availability and the control envelope, and records each as CONFIGURED
 * evidence the answer can cite:
 *
 *   C.1  the building and its zone directory (designed setpoints, areas)
 *   C.2  what data exists: which meters (by tag), telemetry span, weather
 *   C.3  the control envelope, or null when ingest could not be asked
 *
 * What the data cannot answer is decided here, in code, not hoped for in a
 * prompt: `plugLoadMetered` and `forecastWeather` are constant false, and
 * `simulate` exists only when the scenario runner does.
 *
 * Failure is said, not hidden. A database that cannot be read ends the
 * request with notice `context_unavailable` — nothing downstream can work
 * without the directory. An envelope that cannot be read is
 * `control_unavailable`, and everything else still works.
 */

export interface OrientDeps {
  reader: TwinReader;
  probe: ControlProbe;
  /** Whether a scenario runner exists (COPILOT_SIM_API_KEY is set). */
  simAvailable: boolean;
  clock: () => number;
  log: Logger;
}

const SIM_UNAVAILABLE_REASON = 'COPILOT_SIM_API_KEY is not set';

export function makeOrient(deps: OrientDeps) {
  return async (s: CopilotStateType, _config: LangGraphRunnableConfig): Promise<CopilotUpdate> => {
    const now = deps.clock();
    const [snapshot, settings] = await Promise.allSettled([deps.reader.orient(), deps.probe.settings()]);

    if (snapshot.status === 'rejected' || snapshot.value.building === null) {
      deps.log.warn('copilot.context_unavailable', {
        cause: snapshot.status === 'rejected' ? errorName(snapshot.reason) : 'no_building',
      });
      return { context: null, notices: [notice('context_unavailable')] };
    }
    const snap = snapshot.value;
    const building = snap.building!;

    // The building's zone decides what "since 9" means. An unknown zone is a
    // broken register, not a reason to answer in UTC.
    let request: RequestStamp | null = null;
    if (s.request !== null) {
      try {
        const stamp = localStamp(Date.parse(s.request.nowIso), building.timezone);
        request = { ...s.request, ...stamp };
      } catch {
        deps.log.warn('copilot.context_unavailable', { cause: 'time_zone' });
        return { context: null, notices: [notice('context_unavailable')] };
      }
    }

    const envelope: ControlSettings | null = settings.status === 'fulfilled' ? settings.value : null;
    const notices: Notice[] = [];
    if (envelope === null) notices.push(notice('control_unavailable'));
    if (snap.multipleBuildings) notices.push(notice('multiple_buildings', { building: building.name }));

    const context: OrientContext = {
      building: {
        id: building.id, name: building.name, timezone: building.timezone,
        grossFloorAreaM2: building.gross_floor_area_m2,
      },
      directory: snap.directory,
      availability: {
        perFloorEnergyMeter: snap.availability.perFloorEnergyMeter,
        perZoneEnergyMeter: snap.availability.perZoneEnergyMeter,
        meters: snap.availability.meters.map((m) => ({ tag: m.tag, type: m.type, unit: m.unit })),
        plugLoadMetered: false,
        forecastWeather: false,
        observedWeather: snap.availability.observedWeather,
        telemetryFrom: snap.availability.telemetryFrom,
        telemetryTo: snap.availability.telemetryTo,
      },
      envelope,
      sim: { available: deps.simAvailable, reason: deps.simAvailable ? null : SIM_UNAVAILABLE_REASON },
    };

    return {
      ...(request ? { request } : {}),
      context,
      evidence: orientEvidence(snap, context, now),
      notices,
    };
  };
}

/** C.1–C.3. Configured evidence: the register, the data catalogue and the envelope, as they stand now. */
export function orientEvidence(
  snap: OrientSnapshot, context: OrientContext, nowMs: number,
): Record<string, EvidenceRecord> {
  const tz = context.building.timezone;
  const at = toLocalIso(nowMs, tz);
  const local = (iso: string | null) => (iso === null ? null : toLocalIso(Date.parse(iso), tz));
  const a = context.availability;
  const noWeather: CaveatId[] = a.observedWeather ? [] : ['NO_WEATHER_STORED'];

  const c1: EvidenceRecord = {
    id: 'C.1', taskId: 'C', tool: 'orient', kind: 'configured', source: 'directory',
    label: `${context.building.name}: building and zone directory (${context.directory.length} zones)`,
    window: null, coverage: null, flaggedExcluded_count: null, truncated: null, caveats: [],
    headline: [{ label: 'Gross floor area', path: 'building.gross_floor_area_m2' }],
    data: {
      building: {
        name: context.building.name,
        timezone: tz,
        gross_floor_area_m2: context.building.grossFloorAreaM2,
        grid_carbon_kg_per_kwh: snap.building!.grid_carbon_kg_per_kwh,
      },
      directory: context.directory,
    },
    at,
  };

  const c2: EvidenceRecord = {
    id: 'C.2', taskId: 'C', tool: 'orient', kind: 'configured', source: 'directory',
    label: `${context.building.name}: what data exists`,
    window: a.telemetryFrom !== null && a.telemetryTo !== null
      ? { from: local(a.telemetryFrom)!, to: local(a.telemetryTo)! } : null,
    coverage: null, flaggedExcluded_count: null, truncated: null, caveats: noWeather,
    headline: [],
    data: {
      per_floor_energy_meter: a.perFloorEnergyMeter,
      per_zone_energy_meter: a.perZoneEnergyMeter,
      meters: a.meters.map((m) => ({ tag: m.tag, type: m.type, unit: m.unit })),
      plug_load_metered: a.plugLoadMetered,
      forecast_weather: a.forecastWeather,
      observed_weather: a.observedWeather,
      telemetry_from: local(a.telemetryFrom),
      telemetry_to: local(a.telemetryTo),
      weather_sources: snap.availability.weather.map((w) => ({
        source: w.source, rows_count: w.rows_count, from: local(w.from), to: local(w.to),
      })),
      simulation_available: context.sim.available,
    },
    at,
  };

  const c3: EvidenceRecord = {
    id: 'C.3', taskId: 'C', tool: 'orient', kind: 'configured', source: 'ingest_control',
    label: context.envelope === null ? 'Control envelope: unavailable' : 'Control envelope',
    window: null, coverage: null, flaggedExcluded_count: null, truncated: null, caveats: [],
    headline: [],
    data: context.envelope,
    at,
  };

  return { 'C.1': c1, 'C.2': c2, 'C.3': c3 };
}
