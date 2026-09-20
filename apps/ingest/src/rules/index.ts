import { METRIC_UNITS, topics, type AlertWithContext, type Reading, type ServerMessage, type Topic } from '@dtwin/types';
import type { Config } from '../config.ts';
import type { Fanout } from '../fanout.ts';
import type { RegisteredSensor, SensorRegistry } from '../registry.ts';
import {
  evaluate, isEvaluable, FLATLINE_EPSILON,
  type EvalContext, type SensorState,
} from './conditions.ts';
import {
  expandAll, loadRules, loadZoneSetpoints,
  type AlertRuleRow, type RuleTarget,
} from './targets.ts';
import {
  acknowledgeAlert, loadLiveAlerts, openAlert, resolveAlert,
} from './store.ts';
import { activeTenants } from '../tenants.ts';
import { Notifier } from './notify.ts';

/** Conditions answerable from the current value; the rest need the sweep. */
const INSTANTANEOUS = new Set([
  'threshold_above', 'threshold_below', 'out_of_range', 'deviation_from_setpoint',
]);

interface TargetState {
  /** Consecutive breaching evaluations; the rule's debounce counter. */
  breaches: number;
  /** Consecutive clear evaluations — the symmetric counter for resolving. */
  clears: number;
  openAlertId: string | null;
  lastResolvedAt: number;
}

export interface EngineStats {
  rules: number;
  targets: number;
  tracked: number;
  live: number;
  opened: number;
  resolved: number;
  suppressedByCooldown: number;
  /** `stats` is a getter, so index the type rather than using ReturnType. */
  notify: Notifier['stats'];
}

/**
 * Alert rule engine.
 *
 * Two evaluation paths, because the conditions are genuinely different shapes.
 * Threshold and range checks answer from the reading in hand, so they run
 * in-stream. Flatline, no-data and rate-of-change are statements about a window
 * of time — nothing arrives to trigger them, and `no_data` is by definition the
 * absence of an event — so they need a timer sweep.
 *
 * Debounce is symmetric: a rule needing N consecutive breaches to open also
 * needs N consecutive clears to resolve. The schema only specifies the opening
 * side, but resolving on the first clear reading makes any value hovering near
 * its threshold flap open and shut, which is how an alert list becomes noise
 * nobody reads. The cooldown then bounds how quickly the same target may
 * re-open after resolving.
 */
export class AlertEngine {
  #rules: AlertRuleRow[] = [];
  #targets: RuleTarget[] = [];
  #bySensor = new Map<string, RuleTarget[]>();
  #needHistory = new Map<string, number>(); // sensorId -> longest window (ms)
  #sensorState = new Map<string, SensorState>();
  #targetState = new Map<string, TargetState>();
  #profileSetpoints = new Map<string, number>();
  #liveSetpoints = new Map<string, number>();
  #inFlight = new Set<string>();
  #startedAt = 0;
  #sweepTimer: NodeJS.Timeout | null = null;
  #refreshTimer: NodeJS.Timeout | null = null;
  #counts = { opened: 0, resolved: 0, suppressedByCooldown: 0 };
  readonly notifier: Notifier;

  constructor(
    private readonly config: Config,
    private readonly registry: SensorRegistry,
    private readonly fanout: Fanout,
  ) {
    this.notifier = new Notifier(config);
  }

  async start(): Promise<void> {
    this.#startedAt = Date.now();
    this.#profileSetpoints = await loadZoneSetpoints();
    await this.refresh();

    // Adopt alerts already live in the database, so a restart resolves them
    // when conditions clear instead of leaving permanent ghosts.
    //
    // Per tenant, because the read is. Keys are `ruleId:sensorId` and both are
    // UUIDs, so one map across tenants cannot collide.
    for (const tenant of await activeTenants()) {
      for (const [key, alertId] of await loadLiveAlerts(tenant.id)) {
        this.#targetState.set(key, {
          breaches: 0, clears: 0, openAlertId: alertId, lastResolvedAt: 0,
        });
      }
    }

    this.notifier.start();
    this.#sweepTimer ??= setInterval(() => this.sweep(), this.config.ALERT_SWEEP_INTERVAL_MS);
    this.#refreshTimer ??= setInterval(() => {
      void this.refresh().catch((err: unknown) => {
        console.error('[alerts] refresh failed:', (err as Error).message);
      });
    }, this.config.ALERT_REFRESH_MS);
  }

  stop(): void {
    this.notifier.stop();
    for (const t of [this.#sweepTimer, this.#refreshTimer]) if (t) clearInterval(t);
    this.#sweepTimer = null;
    this.#refreshTimer = null;
  }

  get stats(): EngineStats {
    const live = [...this.#targetState.values()].filter((s) => s.openAlertId !== null).length;
    return {
      rules: this.#rules.length,
      targets: this.#targets.length,
      tracked: this.#sensorState.size,
      live,
      ...this.#counts,
      notify: this.notifier.stats,
    };
  }

  /** Reload rules and re-expand them over the current registry. */
  async refresh(): Promise<void> {
    this.#rules = await loadRules();
    this.#targets = expandAll(this.#rules, this.registry);

    const bySensor = new Map<string, RuleTarget[]>();
    const needHistory = new Map<string, number>();
    for (const t of this.#targets) {
      const list = bySensor.get(t.sensor.id);
      if (list) list.push(t);
      else bySensor.set(t.sensor.id, [t]);

      // Only sensors a rate_of_change rule watches need retained samples;
      // keeping history for all 190 would be pure waste.
      if (t.rule.condition === 'rate_of_change' && t.rule.windowS !== null) {
        const ms = t.rule.windowS * 1000;
        needHistory.set(t.sensor.id, Math.max(needHistory.get(t.sensor.id) ?? 0, ms));
      }
    }
    this.#bySensor = bySensor;
    this.#needHistory = needHistory;
  }

  /** Hot path: record the reading, then evaluate the instantaneous rules. */
  onReading(sensor: RegisteredSensor, reading: Reading): void {
    const prev = this.#sensorState.get(sensor.id);
    const changed =
      prev === undefined || Math.abs(prev.lastValue - reading.value) > FLATLINE_EPSILON;

    const state: SensorState = {
      lastValue: reading.value,
      lastTs: reading.ts,
      lastChangedAt: changed ? reading.ts : prev.lastChangedAt,
      lastQuality: reading.quality,
    };
    if (prev?.history) state.history = prev.history;

    const windowMs = this.#needHistory.get(sensor.id);
    if (windowMs !== undefined) {
      const history = state.history ?? [];
      history.push({ ts: reading.ts, value: reading.value });
      // Drop samples older than the longest window that needs them.
      const cutoff = reading.ts - windowMs;
      while (history.length > 0 && history[0]!.ts < cutoff) history.shift();
      state.history = history;
    }

    this.#sensorState.set(sensor.id, state);

    // A live setpoint point overrides the zone's profile value.
    if (sensor.metric === 'setpoint_temp_c' && sensor.zoneId) {
      this.#liveSetpoints.set(sensor.zoneId, reading.value);
    }

    const targets = this.#bySensor.get(sensor.id);
    if (!targets) return;
    const now = Date.now();
    for (const target of targets) {
      if (INSTANTANEOUS.has(target.rule.condition)) this.#evaluateTarget(target, state, now);
    }
  }

  /** Windowed conditions: nothing arrives to trigger these. */
  sweep(): void {
    const now = Date.now();
    for (const target of this.#targets) {
      if (INSTANTANEOUS.has(target.rule.condition)) continue;
      this.#evaluateTarget(target, this.#sensorState.get(target.sensor.id), now);
    }
  }

  #evaluateTarget(target: RuleTarget, state: SensorState | undefined, now: number): void {
    const { rule, sensor, key } = target;
    if (!isEvaluable(rule, state)) return;

    const ctx: EvalContext = {
      now,
      setpoint: sensor.zoneId
        ? this.#liveSetpoints.get(sensor.zoneId) ?? this.#profileSetpoints.get(sensor.zoneId)
        : undefined,
      startedAt: this.#startedAt,
    };

    const { breaching, value } = evaluate(rule, sensor, state, ctx);

    let ts = this.#targetState.get(key);
    if (!ts) {
      ts = { breaches: 0, clears: 0, openAlertId: null, lastResolvedAt: 0 };
      this.#targetState.set(key, ts);
    }

    if (breaching) {
      ts.clears = 0;
      ts.breaches++;
      if (ts.openAlertId !== null || ts.breaches < rule.consecutiveBreaches) return;

      if (now - ts.lastResolvedAt < rule.cooldownS * 1000) {
        this.#counts.suppressedByCooldown++;
        return;
      }
      void this.#open(target, value, now);
    } else {
      ts.breaches = 0;
      if (ts.openAlertId === null) return;
      ts.clears++;
      if (ts.clears < rule.consecutiveBreaches) return;
      void this.#close(target, now);
    }
  }

  // `_now` is unused: an alert's opened_at comes from the database's clock,
  // not the engine's. Kept so #open and #close share one shape.
  async #open(target: RuleTarget, value: number | null, _now: number): Promise<void> {
    const { rule, sensor, key } = target;
    if (this.#inFlight.has(key)) return;
    this.#inFlight.add(key);

    try {
      const alert = await openAlert({
        tenantId: sensor.tenantId,
        ruleId: rule.id,
        sensorId: sensor.id,
        equipmentId: sensor.equipmentId,
        zoneId: sensor.zoneId,
        severity: rule.severity,
        message: describe(rule, sensor, value),
        triggerValue: value,
        threshold: rule.threshold,
        context: { condition: rule.condition, windowS: rule.windowS, metric: sensor.metric },
      });

      const ts = this.#targetState.get(key);
      if (!alert) return; // another replica already holds it
      if (ts) {
        ts.openAlertId = alert.id;
        ts.clears = 0;
      }
      this.#counts.opened++;
      this.#emit({ type: 'alert.raised', alert }, sensor);

      // Delivery is recorded and retried independently; a webhook that is down
      // must not prevent the alert from being opened or broadcast.
      void this.notifier.dispatch(sensor.tenantId, alert, rule.notify).catch((err: unknown) => {
        console.error('[alerts] notify failed:', (err as Error).message);
      });
    } catch (err) {
      console.error(`[alerts] failed to open ${rule.name}:`, (err as Error).message);
    } finally {
      this.#inFlight.delete(key);
    }
  }

  async #close(target: RuleTarget, now: number): Promise<void> {
    const { key, sensor } = target;
    const ts = this.#targetState.get(key);
    if (!ts?.openAlertId || this.#inFlight.has(key)) return;
    this.#inFlight.add(key);

    const alertId = ts.openAlertId;
    try {
      const alert = await resolveAlert(sensor.tenantId, alertId);
      ts.openAlertId = null;
      ts.lastResolvedAt = now;
      ts.clears = 0;
      this.#counts.resolved++;
      if (alert) this.#emit({ type: 'alert.resolved', alert }, sensor);
    } catch (err) {
      console.error('[alerts] failed to resolve:', (err as Error).message);
    } finally {
      this.#inFlight.delete(key);
    }
  }

  /**
   * `byUserId` comes from the authenticated session, and `tenantId` from the
   * same place — not from the request body. An alert id belonging to another
   * tenant matches nothing under the policy and returns null, which the route
   * reports as 409 exactly like an alert that is no longer open. Telling the
   * caller apart from those two cases would confirm the id exists.
   */
  async acknowledge(
    tenantId: string,
    alertId: string,
    byUserId: string,
  ): Promise<AlertWithContext | null> {
    const alert = await acknowledgeAlert(tenantId, alertId, byUserId);
    if (alert) {
      const sensor = alert.sensorId ? this.registry.byId(alert.sensorId) : undefined;
      this.#emit({ type: 'alert.acknowledged', alert }, sensor, tenantId);
    }
    return alert;
  }

  /**
   * Alerts are sent immediately rather than through the telemetry coalescing
   * path. Telemetry is safe to shed because the next tick carries the current
   * value; an alert has no successor, so dropping one loses it outright.
   */
  #emit(
    message: ServerMessage,
    sensor: RegisteredSensor | undefined,
    tenantId = sensor?.tenantId,
  ): void {
    // The tenant's own alert stream, not a global one. `alerts:all` used to be
    // this line and was a cross-tenant broadcast of every alert in the system.
    const targets: Topic[] = tenantId ? [topics.tenantAlerts(tenantId)] : [];
    if (sensor) {
      if (sensor.zoneId) targets.push(topics.zone(sensor.zoneId));
      if (sensor.floorId) targets.push(topics.floor(sensor.floorId));
      if (sensor.buildingId) targets.push(topics.building(sensor.buildingId));
    }
    for (const topic of targets) this.fanout.send(topic, message);
  }
}

function describe(rule: AlertRuleRow, sensor: RegisteredSensor, value: number | null): string {
  const unit = METRIC_UNITS[sensor.metric] ?? '';
  const shown = value === null ? null : `${round(value)}${unit}`;

  switch (rule.condition) {
    case 'no_data':
      return `${rule.name}: ${sensor.name} has reported nothing for ${rule.windowS}s`;
    case 'flatline':
      return `${rule.name}: ${sensor.name} stuck at ${shown} for ${rule.windowS}s`;
    case 'rate_of_change':
      return `${rule.name}: ${sensor.name} changing at ${shown}/h (limit ${rule.threshold}${unit}/h)`;
    case 'out_of_range':
      return `${rule.name}: ${sensor.name} reported ${shown}, outside its plausible range`;
    case 'deviation_from_setpoint':
      return `${rule.name}: ${sensor.name} at ${shown}, more than ${rule.threshold}${unit} from setpoint`;
    case 'threshold_above':
      return `${rule.name}: ${sensor.name} at ${shown}, above ${rule.threshold}${unit}`;
    case 'threshold_below':
      return `${rule.name}: ${sensor.name} at ${shown}, below ${rule.threshold}${unit}`;
  }
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
