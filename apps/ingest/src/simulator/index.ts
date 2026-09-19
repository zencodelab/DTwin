import { withTenant } from '@dtwin/db';
import { activeTenants } from '../tenants.ts';
import type { Config } from '../config.ts';
import type { RegisteredSensor, SensorRegistry } from '../registry.ts';
import {
  loadSimContext, localTime, occupancyFraction, outdoorTempC,
  type SimContext, type ZoneContext,
} from './context.ts';

/**
 * Synthetic device feed.
 *
 * Generates values consistent with the seeded model — a zone's temperature sits
 * near the setpoint its thermal profile declares, CO2 tracks its occupancy
 * schedule, and a chiller marked `maintenance` draws nothing. Contradicting the
 * model would make every downstream check meaningless, since there would be no
 * way to tell a correct pipeline from a broken one.
 *
 * Timestamps are real wall-clock time. Only the sampling RATE is accelerated
 * (`SIM_SPEEDUP`), so charts keep an honest time axis.
 */

export type FaultKind = 'drift' | 'flatline' | 'spike' | 'offline';

export interface Fault {
  kind: FaultKind;
  /** drift: units per hour. spike: multiplier. Ignored otherwise. */
  magnitude: number;
  startedAt: number;
}

interface SensorState {
  lastEmit: number;
  lastValue: number | undefined;
  /** Running total for cumulative points (energy, water). */
  accumulator: number;
}

export interface SimulatedReading {
  sensor: RegisteredSensor;
  value: number;
  ts: number;
}

export class DeviceSimulator {
  /**
   * One context per tenant. Each carries its own building timezone and profile
   * values, so a reading is generated against the model that actually describes
   * the point rather than whichever building loaded first.
   */
  #ctx = new Map<string, SimContext>();
  #state = new Map<string, SensorState>();
  #faults = new Map<string, Fault>();
  #timer: NodeJS.Timeout | null = null;
  #emitted = 0;

  constructor(
    private readonly config: Config,
    private readonly registry: SensorRegistry,
    private readonly onReadings: (readings: SimulatedReading[]) => void,
  ) {}

  async start(): Promise<void> {
    for (const tenant of await activeTenants()) {
      this.#ctx.set(tenant.id, await loadSimContext(tenant.id));
    }
    await this.#resumeCounters();
    this.#timer ??= setInterval(() => this.tick(), this.config.SIM_TICK_MS);
  }

  /**
   * Resume cumulative counters from their last stored reading.
   *
   * A real meter does not rewind because our process restarted. Seeding from a
   * constant would make every restart look like a meter reset to `counter_agg`
   * downstream — manufacturing exactly the event the aggregate exists to absorb,
   * and masking whether it handles real ones correctly.
   */
  async #resumeCounters(): Promise<void> {
    const cumulative = this.registry.all().filter((s) => s.isCumulative);
    if (cumulative.length === 0) return;

    // `telemetry_t`, not `telemetry`. The application role is granted INSERT on
    // the hypertable plus SELECT on only (sensor_id, time) — enough for the
    // upsert's conflict inference and nothing more — so reading `value` has to
    // go through the tenant-scoped barrier view. Naming the table here fails
    // with `permission denied`, which is the grant working as intended.
    const last = new Map<string, number>();
    const byTenant = new Map<string, string[]>();
    for (const s of cumulative) {
      const list = byTenant.get(s.tenantId);
      if (list) list.push(s.id);
      else byTenant.set(s.tenantId, [s.id]);
    }

    for (const [tenantId, sensorIds] of byTenant) {
      const { rows } = await withTenant({ tenantId }, (db) =>
        db.query<{ sensor_id: string; value: number }>(
          `SELECT DISTINCT ON (sensor_id) sensor_id, value
             FROM telemetry_t
            WHERE sensor_id = ANY($1::uuid[])
            ORDER BY sensor_id, time DESC`,
          [sensorIds],
        ));
      for (const r of rows) last.set(r.sensor_id, r.value);
    }

    for (const sensor of cumulative) {
      this.#state.set(sensor.id, {
        lastEmit: 0,
        lastValue: undefined,
        accumulator: last.get(sensor.id) ?? seedAccumulator(sensor),
      });
    }
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  get stats(): { enabled: boolean; emitted: number; faults: number; tracking: number } {
    return {
      enabled: this.#timer !== null,
      emitted: this.#emitted,
      faults: this.#faults.size,
      tracking: this.#state.size,
    };
  }

  injectFault(sensorId: string, kind: FaultKind, magnitude = 1): void {
    this.#faults.set(sensorId, { kind, magnitude, startedAt: Date.now() });
  }

  clearFault(sensorId: string): boolean {
    return this.#faults.delete(sensorId);
  }

  clearAllFaults(): void {
    this.#faults.clear();
  }

  /**
   * Clear only the faults belonging to one tenant.
   *
   * `clearAllFaults` still exists for shutdown and tests, but it must not be
   * reachable from an HTTP route: one tenant clearing another's injected faults
   * would silently change what that tenant's dashboard is showing.
   */
  clearFaultsForTenant(tenantId: string, registry: SensorRegistry): number {
    let cleared = 0;
    for (const sensorId of [...this.#faults.keys()]) {
      if (registry.byId(sensorId)?.tenantId !== tenantId) continue;
      this.#faults.delete(sensorId);
      cleared++;
    }
    return cleared;
  }

  tick(): void {
    if (this.#ctx.size === 0) return;

    const now = Date.now();
    const out: SimulatedReading[] = [];
    // Local time is per tenant, since each has its own building timezone.
    // Computed once per tenant rather than per sensor: Intl.DateTimeFormat is
    // not cheap and this loop runs every tick over every point.
    const clock = new Map<string, ReturnType<typeof localTime>>();
    for (const [tenantId, c] of this.#ctx) {
      clock.set(tenantId, localTime(new Date(now), c.timezone));
    }

    for (const sensor of this.registry.all()) {
      const ctx = this.#ctx.get(sensor.tenantId);
      const time = clock.get(sensor.tenantId);
      if (!ctx || !time) continue;
      const { hour, dayType } = time;

      let state = this.#state.get(sensor.id);
      if (!state) {
        state = { lastEmit: 0, lastValue: undefined, accumulator: seedAccumulator(sensor) };
        this.#state.set(sensor.id, state);
      }

      // Each point reports at its own declared interval, compressed by the
      // speedup factor — a 15-minute meter should not stream like a 60-second
      // zone temperature just because it is easier.
      const intervalMs = Math.max(
        200,
        (sensor.sampleIntervalS * 1000) / this.config.SIM_SPEEDUP,
      );
      if (now - state.lastEmit < intervalMs) continue;

      const fault = this.#faults.get(sensor.id);
      if (fault?.kind === 'offline') continue;

      const dtHours = (state.lastEmit === 0 ? intervalMs : now - state.lastEmit) / 3_600_000;
      let value = generate(ctx, sensor, hour, dayType, state, dtHours);
      value = applyFault(value, fault, state, now);

      state.lastEmit = now;
      state.lastValue = value;
      out.push({ sensor, value, ts: now });
    }

    if (out.length > 0) {
      this.#emitted += out.length;
      this.onReadings(out);
    }
  }
}

function applyFault(
  value: number,
  fault: Fault | undefined,
  state: SensorState,
  now: number,
): number {
  if (!fault) return value;
  switch (fault.kind) {
    case 'drift':
      return value + fault.magnitude * ((now - fault.startedAt) / 3_600_000);
    case 'flatline':
      // Hold whatever was last reported — a stuck sensor, not a frozen process.
      return state.lastValue ?? value;
    case 'spike':
      return value * fault.magnitude;
    case 'offline':
      return value; // handled by skipping emission
  }
}

/** Cumulative points start mid-life so deltas are exercised from the first read. */
function seedAccumulator(sensor: RegisteredSensor): number {
  if (!sensor.isCumulative) return 0;
  return sensor.metric === 'water_m3' ? 12_000 : 1_250_000;
}

function noise(scale: number): number {
  return (Math.random() - 0.5) * 2 * scale;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function generate(
  ctx: SimContext,
  sensor: RegisteredSensor,
  hour: number,
  dayType: import('@dtwin/types').DayType,
  state: SensorState,
  dtHours: number,
): number {
  const zone: ZoneContext | undefined = sensor.zoneId ? ctx.zones.get(sensor.zoneId) : undefined;
  const equip = sensor.equipmentId ? ctx.equipment.get(sensor.equipmentId) : undefined;
  const occ = occupancyFraction(ctx, zone, hour, dayType);
  const outdoor = outdoorTempC(hour);
  const setpoint = zone?.setpointC ?? 23;

  // How hard the air side is working: baseline ventilation plus occupancy plus
  // whatever the envelope is letting in.
  const demand = clamp(0.2 + 0.55 * occ + (outdoor - setpoint) * 0.018, 0.15, 1);

  switch (sensor.metric) {
    case 'temperature_c': {
      // Equipment-mounted probes measure the plant, not the room.
      if (equip?.equipmentType === 'chiller') return 6.5 + noise(0.4);
      if (equip?.equipmentType === 'ahu') return setpoint - 8 + noise(0.5);
      // Zone temperature: near setpoint, sagging slightly as load rises.
      return setpoint + (outdoor - setpoint) * 0.035 + occ * 0.5 + noise(0.18);
    }

    case 'setpoint_temp_c':
      return setpoint;

    case 'humidity_pct':
      return clamp(48 + 6 * Math.sin(((hour - 4) / 24) * 2 * Math.PI) + occ * 6 + noise(1.5), 20, 85);

    case 'co2_ppm': {
      // Server rooms have no people; everything else tracks its schedule.
      if (zone?.zoneType === 'server_room') return 420 + noise(12);
      return clamp(430 + occ * 620 + noise(25), 400, 2500);
    }

    case 'occupancy_count': {
      const design = zone?.designOccupancy ?? 0;
      return Math.max(0, Math.round(design * occ + noise(Math.max(1, design * 0.08))));
    }

    case 'airflow_cmh':
      return clamp((equip?.ratedAirflowCmh ?? 3000) * demand + noise(60), 0, 4000);

    case 'damper_position_pct':
    case 'valve_position_pct':
      return clamp(demand * 100 + noise(3), 10, 100);

    case 'power_kw': {
      // Anything not running draws nothing — CH-02 sits in maintenance in the
      // seed, and the feed must agree with the asset register.
      if (equip && !equip.isRunning) return 0;
      const rated = equip?.ratedPowerKw ?? 5;
      switch (equip?.equipmentType) {
        case 'chiller':       return clamp(rated * (0.35 + 0.5 * demand) + noise(4), 0, rated * 1.1);
        case 'ahu':           return clamp(rated * (0.3 + 0.6 * demand) + noise(0.4), 0, rated);
        case 'pump':          return clamp(rated * 0.72 + noise(0.6), 0, rated);
        case 'cooling_tower': return clamp(rated * (0.4 + 0.45 * demand) + noise(0.8), 0, rated);
        case 'lighting_circuit': return clamp(rated * (occ > 0.05 ? 0.9 : 0.12) + noise(0.3), 0, rated);
        // Charging is bursty rather than continuous; mostly idle.
        case 'ev_charger':    return Math.random() < 0.12 ? rated * (0.6 + Math.random() * 0.4) : 0;
        default:              return clamp(rated * demand + noise(0.2), 0, rated);
      }
    }

    case 'energy_kwh': {
      // A monotonic counter, advanced by an estimate of site load. This is the
      // point that makes counter_agg earn its place downstream.
      const siteKw = 180 + 260 * demand;
      state.accumulator += siteKw * dtHours;
      return state.accumulator;
    }

    case 'water_m3': {
      state.accumulator += (0.4 + 1.6 * demand) * dtHours;
      return state.accumulator;
    }

    case 'pressure_pa':
      return clamp(250 * demand + noise(8), 0, 400);

    case 'illuminance_lux':
      return clamp(occ > 0.05 ? 480 + noise(40) : 40 + noise(15), 0, 1200);
  }
}
