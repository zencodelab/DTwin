'use client';

import { useEffect, useRef, useState } from 'react';
import type { SimRunState } from '@/lib/ws';

interface Breakdown {
  hvacKwh: number; lightingKwh: number; plugKwh: number;
  totalKwh: number; co2Kg: number; euiKwhPerM2: number | null; unmetHours: number | null;
}

interface Scenario {
  name: string;
  params: Record<string, number>;
}

/** Categorical slots 1-3, the three that validate all-pairs in both modes. */
const END_USES = [
  { key: 'hvacKwh', label: 'HVAC', color: '#3987e5' },
  { key: 'lightingKwh', label: 'Lighting', color: '#d95926' },
  { key: 'plugKwh', label: 'Plug', color: '#199e70' },
] as const;

const PRESETS: Scenario[] = [
  { name: 'Baseline', params: {} },
  { name: 'Setpoint +2 K', params: { setpointDeltaK: 2 } },
  { name: 'LED retrofit', params: { lightingScale: 0.5 } },
  { name: 'Chiller upgrade', params: { hvacCopScale: 1.25 } },
];

/**
 * Runs a scenario against the Python worker and compares it to the baseline.
 *
 * Absolute kWh over three days means little on its own; the comparison is the
 * product. Both runs cover the same period with the same weather, so the delta
 * is attributable to the change rather than to the days chosen.
 */
export function ScenarioPanel({
  buildingId, simRuns,
}: {
  buildingId: string;
  simRuns: Map<string, SimRunState>;
}) {
  const [results, setResults] = useState<Record<string, Breakdown>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Live progress comes over the WebSocket; the HTTP poll below is what
  // actually completes the run. The socket is a nicety — if ingest is down the
  // run still finishes, it just finishes without a moving bar.
  const live = runId ? simRuns.get(runId) : undefined;
  const liveRef = useRef(live);
  useEffect(() => { liveRef.current = live; }, [live]);

  async function run(scenario: Scenario) {
    setRunning(scenario.name);
    setError(null);
    try {
      const start = new Date('2026-06-20T00:00:00+04:00');
      const end = new Date('2026-06-23T00:00:00+04:00');

      const started = await fetch('/api/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          buildingId,
          scenarioName: scenario.name,
          periodStart: start.toISOString(),
          periodEnd: end.toISOString(),
          intervalS: 3600,
          params: scenario.params,
          weather: {
            mode: 'synthetic', peakDryBulbC: 42, minDryBulbC: 30, peakGhiW_m2: 950,
          },
        }),
      }).then((r) => r.json());

      if (!started.runId) throw new Error(started.error ?? 'worker rejected the run');
      setRunId(started.runId);

      // The worker runs asynchronously; poll rather than hold a request open.
      // Whichever arrives first — the pushed summary or the poll — finishes it.
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 500));

        const pushed = liveRef.current;
        if (pushed?.status === 'completed' && pushed.summary) {
          setResults((prev) => ({ ...prev, [scenario.name]: pushed.summary!.building }));
          return;
        }
        if (pushed?.status === 'failed') throw new Error(pushed.error ?? 'run failed');

        const poll = await fetch(`/api/simulate?runId=${started.runId}`).then((r) => r.json());
        if (poll.building) {
          setResults((prev) => ({ ...prev, [scenario.name]: poll.building }));
          return;
        }
        if (poll.run?.status === 'failed') throw new Error(poll.run.error ?? 'run failed');
      }
      throw new Error('run did not finish in time');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(null);
      setRunId(null);
    }
  }

  const baseline = results.Baseline;
  const max = Math.max(...Object.values(results).map((r) => r.totalKwh), 1);

  return (
    <div className="px-4 pb-4">
      <div className="mb-3 flex flex-wrap gap-1.5">
        {PRESETS.map((scenario) => (
          <button
            key={scenario.name}
            type="button"
            disabled={running !== null}
            onClick={() => void run(scenario)}
            className="rounded border px-2 py-1 text-xs disabled:opacity-40"
            style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
          >
            {running === scenario.name ? 'running…' : scenario.name}
          </button>
        ))}
      </div>

      {running && (
        <div className="mb-3">
          <div className="mb-1 flex justify-between text-[11px]"
               style={{ color: 'var(--text-secondary)' }}>
            <span>{running}</span>
            <span className="tnum">
              {live ? `${live.progressPct.toFixed(0)}%` : 'starting…'}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded" style={{ background: 'var(--grid)' }}>
            <div
              className="h-full rounded transition-[width] duration-300"
              style={{ width: `${live?.progressPct ?? 0}%`, background: 'var(--accent)' }}
            />
          </div>
        </div>
      )}

      {error && (
        <p className="mb-2 text-xs" style={{ color: '#d03b3b' }}>
          ‼ {error}
        </p>
      )}

      {Object.keys(results).length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Run the baseline, then a scenario, to compare three simulated days.
        </p>
      ) : (
        <>
          {/* Legend: three series, so identity is never colour-alone. */}
          <div className="mb-2 flex gap-3 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            {END_USES.map((u) => (
              <span key={u.key} className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-sm" style={{ background: u.color }} />
                {u.label}
              </span>
            ))}
          </div>

          <ul className="space-y-2">
            {Object.entries(results).map(([name, value]) => {
              const delta =
                baseline && name !== 'Baseline'
                  ? ((value.totalKwh - baseline.totalKwh) / baseline.totalKwh) * 100
                  : null;

              return (
                <li key={name}>
                  <div className="flex items-baseline justify-between text-xs">
                    <span>{name}</span>
                    <span className="tnum" style={{ color: 'var(--text-secondary)' }}>
                      {value.totalKwh.toFixed(0)} kWh
                      {delta !== null && (
                        <span style={{ color: delta < 0 ? '#0ca30c' : '#d03b3b' }}>
                          {' '}({delta > 0 ? '+' : ''}{delta.toFixed(1)}%)
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="mt-1 flex h-3 overflow-hidden rounded"
                       style={{ width: `${(value.totalKwh / max) * 100}%` }}>
                    {END_USES.map((u) => (
                      <div
                        key={u.key}
                        title={`${u.label}: ${value[u.key].toFixed(0)} kWh`}
                        style={{
                          background: u.color,
                          // 2px surface gap between stacked segments
                          marginRight: 2,
                          flexGrow: value[u.key],
                        }}
                      />
                    ))}
                  </div>
                  <div className="tnum mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {value.co2Kg.toFixed(0)} kg CO₂
                    {value.euiKwhPerM2 !== null && ` · ${value.euiKwhPerM2.toFixed(2)} kWh/m²`}
                    {value.unmetHours ? ` · ${value.unmetHours.toFixed(0)} unmet h` : ''}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
