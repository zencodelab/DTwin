'use client';

import { OVERLAY_LABELS, legendStops, type OverlayMetric } from '@/lib/colors';

/**
 * Always present. With only colour on screen the reader cannot recover a value,
 * and a heatmap without a legend is decoration rather than a chart.
 */
export function Legend({
  metric, setpoint, max, dark,
}: {
  metric: OverlayMetric;
  setpoint: number;
  max: number;
  dark: boolean;
}) {
  const stops = legendStops(metric, setpoint, max, dark);

  return (
    <div className="panel px-3 py-2">
      <div className="mb-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
        {OVERLAY_LABELS[metric]}
      </div>
      <div className="flex items-end gap-0">
        {stops.map((stop) => (
          <div key={stop.label} className="flex-1">
            {/* 2px surface gap between swatches so adjacent steps stay separate */}
            <div className="h-3 rounded-sm" style={{ background: stop.color, marginRight: 2 }} />
            <div className="tnum mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {stop.label}
            </div>
          </div>
        ))}
      </div>
      {metric === 'temperature_c' && (
        <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          Deviation from each zone&apos;s own setpoint, not absolute temperature.
        </div>
      )}
    </div>
  );
}
