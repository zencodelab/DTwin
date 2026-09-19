'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { topics as topicFor, type SpatialTree, type Topic, type AlertWithContext } from '@dtwin/types';
import type { ZoneVisual } from './three/BuildingCanvas';
import { AlertList } from './panels/AlertList';
import { Legend } from './panels/Legend';
import { ScenarioPanel } from './panels/ScenarioPanel';
import { ZonePanel } from './panels/ZonePanel';
import {
  OVERLAY_LABELS, NO_DATA_DARK, NO_DATA_LIGHT, STATUS,
  magnitudeColor, temperatureColor, type OverlayMetric,
} from '@/lib/colors';
import { useIsDark } from '@/lib/theme';
import { useLiveData } from '@/lib/ws';

/**
 * The canvas is loaded client-side only.
 *
 * There is no WebGL context on a server, so a 3D view has nothing to render
 * there — and react-three-fiber reaches for React internals at module scope that
 * the SSR runtime does not expose, so merely importing it server-side throws.
 * Excluding it from SSR is what the component is, not a workaround for a bug.
 */
const BuildingCanvas = dynamic(
  () => import('./three/BuildingCanvas').then((m) => m.BuildingCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="grid h-full place-items-center text-sm"
           style={{ color: 'var(--text-muted)' }}>
        Preparing 3D view…
      </div>
    ),
  },
);

interface ZoneProfile {
  value: number | null;
  setpointC: number | null;
  deadbandK: number | null;
}

const OVERLAYS: OverlayMetric[] = ['temperature_c', 'occupancy_count', 'co2_ppm'];

/** Full-saturation point for each magnitude overlay's sequential ramp. */
const OVERLAY_MAX: Record<OverlayMetric, number> = {
  temperature_c: 0, // diverging; uses setpoint instead
  occupancy_count: 20,
  co2_ppm: 1400,
};

export function Dashboard({
  tree,
  tenantId,
  wsUrl,
}: {
  tree: SpatialTree;
  tenantId: string;
  wsUrl: string;
}) {
  const [focusedFloorId, setFocusedFloorId] = useState<string | null>(null);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<OverlayMetric>('temperature_c');
  const [showEquipment, setShowEquipment] = useState(true);
  const [baseline, setBaseline] = useState<Map<string, ZoneProfile>>(new Map());
  const [standingAlerts, setStandingAlerts] = useState<AlertWithContext[]>([]);
  const isDark = useIsDark();

  // Subscribe to the floor in frame, not the whole building: the server fans
  // out per topic, so a building-wide subscription would ship all 190 points to
  // a view showing 45 of them.
  const subscribed = useMemo<Topic[]>(() => {
    const list: Topic[] = [topicFor.tenantAlerts(tenantId)];
    list.push(
      focusedFloorId
        ? topicFor.floor(focusedFloorId)
        : topicFor.building(tree.building.id),
    );
    return list;
  }, [focusedFloorId, tree.building.id, tenantId]);

  const { values, alerts: liveAlerts, simRuns, connected } = useLiveData(wsUrl, subscribed);

  // Historical means for the first paint. Live values replace them as they
  // arrive, but they only cover points that have reported since the page
  // opened — without this the building renders grey for the first seconds.
  useEffect(() => {
    fetch(`/api/heatmap?buildingId=${tree.building.id}&metric=${overlay}&hours=1`)
      .then((r) => r.json())
      .then((d: { zones: Array<ZoneProfile & { zoneId: string }> }) => {
        setBaseline(new Map(d.zones.map((z) => [z.zoneId, z])));
      })
      .catch(() => undefined);
  }, [tree.building.id, overlay]);

  useEffect(() => {
    fetch('/api/alerts')
      .then((r) => r.json())
      .then((d: { alerts: AlertWithContext[] }) => setStandingAlerts(d.alerts))
      .catch(() => undefined);
  }, []);

  // Alerts raised since load are merged over the list fetched at open, so the
  // panel shows both history and anything that fires while it is watched.
  const alerts = useMemo(() => {
    const merged = new Map(standingAlerts.map((a) => [a.id, a]));
    for (const a of liveAlerts) merged.set(a.id, a);
    return [...merged.values()].filter((a) => a.state !== 'resolved');
  }, [standingAlerts, liveAlerts]);

  const alertingZones = useMemo(
    () => new Set(alerts.filter((a) => a.zoneId).map((a) => a.zoneId!)),
    [alerts],
  );

  /** Sensors per zone for the active overlay metric, resolved once. */
  const sensorsByZone = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const sensor of tree.sensors) {
      if (sensor.metric !== overlay || !sensor.zoneId) continue;
      const list = map.get(sensor.zoneId);
      if (list) list.push(sensor.id);
      else map.set(sensor.zoneId, [sensor.id]);
    }
    return map;
  }, [tree.sensors, overlay]);

  const visuals = useMemo(() => {
    const out = new Map<string, ZoneVisual>();

    for (const floor of tree.floors) {
      for (const zone of floor.zones) {
        const live = (sensorsByZone.get(zone.id) ?? [])
          .map((id) => values.get(id))
          .filter((v): v is number => v !== undefined);

        const fallback = baseline.get(zone.id);
        const value =
          live.length > 0
            ? live.reduce((s, v) => s + v, 0) / live.length
            : fallback?.value ?? null;

        if (value === null) {
          // Absent is not zero. Painting a zone with no coverage as the bottom
          // of the ramp invents a cold spot where there is simply no sensor.
          out.set(zone.id, {
            color: isDark ? NO_DATA_DARK : NO_DATA_LIGHT,
            label: null,
            alerting: alertingZones.has(zone.id),
          });
          continue;
        }

        const setpoint = fallback?.setpointC ?? 23;
        out.set(zone.id, {
          color:
            overlay === 'temperature_c'
              ? temperatureColor(value, setpoint, 4, isDark, fallback?.deadbandK ?? 1)
              : magnitudeColor(value, OVERLAY_MAX[overlay]),
          label:
            overlay === 'temperature_c' ? `${value.toFixed(1)} °C`
            : overlay === 'co2_ppm' ? `${value.toFixed(0)} ppm`
            : `${value.toFixed(0)} ppl`,
          alerting: alertingZones.has(zone.id),
        });
      }
    }
    return out;
  }, [tree.floors, sensorsByZone, values, baseline, overlay, alertingZones, isDark]);

  const selected = useMemo(() => {
    for (const floor of tree.floors) {
      const zone = floor.zones.find((z) => z.id === selectedZoneId);
      if (zone) return { zone, floor };
    }
    return null;
  }, [tree.floors, selectedZoneId]);

  const livePowerKw = useMemo(() => {
    let sum = 0;
    for (const sensor of tree.sensors) {
      if (sensor.metric !== 'power_kw') continue;
      sum += values.get(sensor.id) ?? 0;
    }
    return sum;
  }, [tree.sensors, values]);

  const selectZoneFromAlert = useCallback((zoneId: string) => {
    const floor = tree.floors.find((f) => f.zones.some((z) => z.id === zoneId));
    if (floor) setFocusedFloorId(floor.id);
    setSelectedZoneId(zoneId);
  }, [tree.floors]);

  const setpointForLegend = selected
    ? baseline.get(selected.zone.id)?.setpointC ?? 23
    : 23;

  return (
    <div className="grid h-screen grid-rows-[auto_1fr]"
         style={{ gridTemplateColumns: '180px 1fr 340px' }}>
      <header className="col-span-3 flex items-center gap-4 border-b px-4 py-2"
              style={{ borderColor: 'var(--border)' }}>
        <h1 className="text-sm font-semibold">{tree.building.name}</h1>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {tree.floors.length} floors · {tree.floors.reduce((s, f) => s + f.zones.length, 0)} zones ·{' '}
          {tree.sensors.length} points
        </span>

        <div className="ml-auto flex items-center gap-4 text-xs">
          <Kpi label="Live load" value={`${livePowerKw.toFixed(1)} kW`} />
          <Kpi
            label="Open alerts"
            value={String(alerts.length)}
            color={alerts.length > 0 ? STATUS.warning : undefined}
          />
          <span className="flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: connected ? STATUS.good : STATUS.critical }}
            />
            {connected ? 'live' : 'reconnecting'}
          </span>
        </div>
      </header>

      <nav className="overflow-y-auto border-r p-2" style={{ borderColor: 'var(--border)' }}>
        <button
          type="button"
          onClick={() => { setFocusedFloorId(null); setSelectedZoneId(null); }}
          className="mb-1 w-full rounded px-2 py-1.5 text-left text-xs"
          style={{
            background: focusedFloorId === null ? 'var(--grid)' : undefined,
            color: 'var(--text-secondary)',
          }}
        >
          Whole building
        </button>

        {[...tree.floors].reverse().map((floor) => {
          const floorAlerts = alerts.filter((a) =>
            floor.zones.some((z) => z.id === a.zoneId),
          ).length;

          return (
            <button
              key={floor.id}
              type="button"
              onClick={() => { setFocusedFloorId(floor.id); setSelectedZoneId(null); }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs"
              style={{ background: focusedFloorId === floor.id ? 'var(--grid)' : undefined }}
            >
              <span>{floor.name}</span>
              {floorAlerts > 0 && (
                <span className="tnum ml-auto rounded px-1 text-[10px]"
                      style={{ color: STATUS.warning, border: `1px solid ${STATUS.warning}` }}>
                  {floorAlerts}
                </span>
              )}
            </button>
          );
        })}

        <div className="mt-3 border-t pt-2" style={{ borderColor: 'var(--border)' }}>
          <label className="flex cursor-pointer items-center gap-2 px-2 text-xs"
                 style={{ color: 'var(--text-secondary)' }}>
            <input
              type="checkbox"
              checked={showEquipment}
              onChange={(e) => setShowEquipment(e.target.checked)}
            />
            Equipment
          </label>
        </div>
      </nav>

      <main className="relative">
        <BuildingCanvas
          tree={tree}
          visuals={visuals}
          focusedFloorId={focusedFloorId}
          selectedZoneId={selectedZoneId}
          onSelectZone={setSelectedZoneId}
          onSelectFloor={setFocusedFloorId}
          showEquipment={showEquipment}
          isDark={isDark}
        />

        {/* Filters in one row above the view, per the interaction spec. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-3">
          <div className="pointer-events-auto flex gap-1">
            {OVERLAYS.map((metric) => (
              <button
                key={metric}
                type="button"
                onClick={() => setOverlay(metric)}
                className="rounded border px-2 py-1 text-xs"
                style={{
                  borderColor: 'var(--border)',
                  // Tokens, not a hardcoded dark wash: these sit over the canvas
                  // in both themes, and a fixed dark chip is an unreadable block
                  // on a light surface.
                  background: 'var(--surface-1)',
                  opacity: overlay === metric ? 1 : 0.75,
                  fontWeight: overlay === metric ? 600 : 400,
                  color: overlay === metric ? 'var(--text-primary)' : 'var(--text-secondary)',
                }}
              >
                {OVERLAY_LABELS[metric]}
              </button>
            ))}
          </div>

          <div className="pointer-events-auto w-64">
            <Legend
              metric={overlay}
              setpoint={setpointForLegend}
              max={OVERLAY_MAX[overlay]}
              dark={isDark}
            />
          </div>
        </div>

        {focusedFloorId === null && (
          <p className="pointer-events-none absolute bottom-3 left-3 text-xs"
             style={{ color: 'var(--text-muted)' }}>
            Click a floor or zone to drill in · drag to orbit
          </p>
        )}
      </main>

      <aside className="overflow-y-auto border-l" style={{ borderColor: 'var(--border)' }}>
        {selected ? (
          <>
            <button
              type="button"
              onClick={() => setSelectedZoneId(null)}
              className="px-4 pt-3 text-xs"
              style={{ color: 'var(--text-muted)' }}
            >
              ← back to overview
            </button>
            <ZonePanel
              zoneId={selected.zone.id}
              zoneName={selected.zone.name}
              zoneType={selected.zone.zoneType}
              areaM2={selected.zone.areaM2}
              floorName={selected.floor.name}
              liveValues={values}
            />
          </>
        ) : (
          <>
            <h2 className="px-4 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: 'var(--text-muted)' }}>
              Open alerts
            </h2>
            <AlertList alerts={alerts} onSelectZone={selectZoneFromAlert} />

            <h2 className="px-4 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: 'var(--text-muted)' }}>
              Energy scenarios
            </h2>
            <ScenarioPanel buildingId={tree.building.id} simRuns={simRuns} />
          </>
        )}
      </aside>
    </div>
  );
}

function Kpi({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="tnum font-medium" style={{ color: color ?? 'var(--text-primary)' }}>
        {value}
      </span>
    </span>
  );
}
