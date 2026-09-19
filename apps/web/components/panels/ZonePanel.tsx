'use client';

import { useEffect, useState } from 'react';
import { METRIC_UNITS, type MetricType } from '@dtwin/types';
import { STATUS } from '@/lib/colors';
import { Sparkline, type Point } from './Sparkline';

interface Reading {
  sensorId: string;
  metric: MetricType;
  unit: string;
  value: number;
  quality: number;
  ts: string;
  isStale: boolean;
}

interface ZoneDetail {
  readings: Reading[];
  equipment: Array<{
    id: string; tag: string; equipmentType: string; status: string;
    manufacturer: string | null; model: string | null; ratedPowerKw: number | null;
  }>;
  maintenance: Array<{
    id: string; performedAt: string; logType: string; technician: string | null;
    notes: string | null; downtimeMinutes: number | null; nextDueAt: string | null;
    equipmentTag: string;
  }>;
  profile: {
    name: string; setpointC: number; deadbandK: number; hvacCop: number;
    ventilationLSPerson: number; windowToWallRatio: number;
  } | null;
}

export function ZonePanel({
  zoneId, zoneName, zoneType, areaM2, floorName, liveValues,
}: {
  zoneId: string;
  zoneName: string;
  zoneType: string;
  areaM2: number | null;
  floorName: string;
  liveValues: Map<string, number>;
}) {
  const [detail, setDetail] = useState<ZoneDetail | null>(null);
  const [history, setHistory] = useState<Point[]>([]);
  const [selectedSensor, setSelectedSensor] = useState<Reading | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setSelectedSensor(null);
    setHistory([]);

    fetch(`/api/zones/${zoneId}`)
      .then((r) => r.json())
      .then((d: ZoneDetail) => {
        if (cancelled) return;
        setDetail(d);
        // Default to temperature: it is what a facility manager checks first.
        setSelectedSensor(
          d.readings.find((r) => r.metric === 'temperature_c') ?? d.readings[0] ?? null,
        );
      })
      .catch(() => undefined);

    return () => { cancelled = true; };
  }, [zoneId]);

  useEffect(() => {
    if (!selectedSensor) return;
    let cancelled = false;

    fetch(`/api/sensors/${selectedSensor.sensorId}/history?resolution=5m&hours=6`)
      .then((r) => r.json())
      .then((d: { buckets: Array<{ bucket: string; avgValue: number | null }> }) => {
        if (cancelled) return;
        setHistory(
          d.buckets
            .filter((b) => b.avgValue !== null)
            .map((b) => ({ t: new Date(b.bucket).getTime(), v: b.avgValue! })),
        );
      })
      .catch(() => undefined);

    return () => { cancelled = true; };
  }, [selectedSensor]);

  if (!detail) {
    return <div className="p-4 text-sm" style={{ color: 'var(--text-muted)' }}>Loading zone…</div>;
  }

  // The live socket wins over the value fetched at open: it is newer by
  // definition, and a panel showing a stale number beside a live 3D view is
  // worse than one that shows nothing.
  const valueOf = (r: Reading) => liveValues.get(r.sensorId) ?? r.value;

  const temperature = detail.readings.find((r) => r.metric === 'temperature_c');
  const setpoint = detail.profile?.setpointC ?? null;
  const deviation =
    temperature && setpoint !== null ? valueOf(temperature) - setpoint : null;
  const deadband = detail.profile?.deadbandK ?? 1;
  const inBand = deviation !== null && Math.abs(deviation) <= deadband / 2;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="px-4 pb-3 pt-4">
        <h2 className="text-lg font-semibold">{zoneName}</h2>
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {floorName} · {zoneType.replace('_', ' ')}
          {areaM2 ? ` · ${areaM2.toFixed(0)} m²` : ''}
        </p>
      </header>

      {/* Thermal condition as a hero figure: one number the reader came for,
          with its comparison beside it rather than in a separate chart. */}
      {temperature && setpoint !== null && (
        <section className="mx-4 mb-3 panel px-4 py-3">
          <div className="flex items-baseline gap-2">
            <span className="tnum text-3xl font-semibold">
              {valueOf(temperature).toFixed(1)}
            </span>
            <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>°C</span>
            <span
              className="ml-auto text-xs font-medium"
              style={{ color: inBand ? STATUS.good : STATUS.warning }}
            >
              {inBand ? '✓ within deadband' : '▲ outside deadband'}
            </span>
          </div>
          <div className="tnum mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
            setpoint {setpoint.toFixed(1)} °C · deviation{' '}
            {deviation! >= 0 ? '+' : ''}{deviation!.toFixed(1)} K · deadband ±{(deadband / 2).toFixed(1)} K
          </div>
        </section>
      )}

      <Section title="Live sensors">
        <table className="w-full text-sm">
          <tbody>
            {detail.readings.map((reading) => {
              const active = selectedSensor?.sensorId === reading.sensorId;
              return (
                <tr
                  key={reading.sensorId}
                  onClick={() => setSelectedSensor(reading)}
                  className="cursor-pointer"
                  style={{ background: active ? 'var(--grid)' : undefined }}
                >
                  <td className="py-1 pl-4 pr-2" style={{ color: 'var(--text-secondary)' }}>
                    {reading.metric.replace(/_.*$/, '').replace('temperature', 'temp')}
                  </td>
                  <td className="tnum py-1 pr-1 text-right">
                    {valueOf(reading).toFixed(reading.metric === 'occupancy_count' ? 0 : 1)}
                  </td>
                  <td className="py-1 pr-4 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {METRIC_UNITS[reading.metric]}
                    {reading.isStale && !liveValues.has(reading.sensorId) && (
                      <span title="No recent reading" style={{ color: STATUS.warning }}> stale</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {selectedSensor && (
          <div className="px-4 pb-3 pt-2">
            <div className="mb-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {selectedSensor.metric.replace(/_/g, ' ')} · last 6 h
            </div>
            <Sparkline points={history} unit={METRIC_UNITS[selectedSensor.metric]} />
          </div>
        )}
      </Section>

      <Section title="Serving equipment">
        <ul className="px-4 pb-2 text-sm">
          {detail.equipment.map((e) => (
            <li key={e.id} className="flex items-baseline gap-2 py-1">
              <span className="font-medium">{e.tag}</span>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {e.equipmentType.toUpperCase()}
                {e.ratedPowerKw ? ` · ${e.ratedPowerKw} kW` : ''}
              </span>
              <StatusPill status={e.status} />
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Maintenance log">
        {detail.maintenance.length === 0 ? (
          <p className="px-4 pb-3 text-xs" style={{ color: 'var(--text-muted)' }}>
            No service history recorded.
          </p>
        ) : (
          <ul className="px-4 pb-4 text-sm">
            {detail.maintenance.map((m) => (
              <li key={m.id} className="border-l-2 py-1.5 pl-2"
                  style={{ borderColor: 'var(--axis)' }}>
                <div className="flex items-baseline gap-2">
                  <span className="font-medium">{m.equipmentTag}</span>
                  <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {m.logType}
                  </span>
                  <span className="tnum ml-auto text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {new Date(m.performedAt).toLocaleDateString()}
                  </span>
                </div>
                {m.notes && (
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{m.notes}</p>
                )}
                {m.nextDueAt && (
                  <p className="tnum text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    next due {new Date(m.nextDueAt).toLocaleDateString()}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-2">
      <h3 className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--text-muted)' }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function StatusPill({ status }: { status: string }) {
  const color =
    status === 'fault' ? STATUS.critical
    : status === 'maintenance' ? STATUS.warning
    : status === 'degraded' ? STATUS.serious
    : status === 'offline' ? 'var(--text-muted)'
    : STATUS.good;

  return (
    <span className="ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium"
          style={{ color, border: `1px solid ${color}` }}>
      {status}
    </span>
  );
}
