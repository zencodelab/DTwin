'use client';

import { useMemo, useState } from 'react';

export interface Point {
  t: number;
  v: number;
}

/**
 * A small time series with a hover readout.
 *
 * An HTML chart is interactive by default, so this ships a crosshair and value
 * rather than leaving the reader to estimate from pixels. Only the endpoints are
 * labelled — a number on every point is noise at this size.
 */
export function Sparkline({
  points, unit, width = 260, height = 56, color = '#3987e5',
}: {
  points: Point[];
  unit: string;
  width?: number;
  height?: number;
  color?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const { path, scaled, min, max } = useMemo(() => {
    if (points.length < 2) return { path: '', scaled: [], min: 0, max: 0 };

    const vs = points.map((p) => p.v);
    const lo = Math.min(...vs);
    const hi = Math.max(...vs);
    // A flat series must not divide by zero or render on the top edge.
    const span = hi - lo || 1;
    const pad = 4;

    const scaled = points.map((p, i) => ({
      x: (i / (points.length - 1)) * (width - pad * 2) + pad,
      y: height - pad - ((p.v - lo) / span) * (height - pad * 2),
      ...p,
    }));

    return {
      path: scaled.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
      scaled,
      min: lo,
      max: hi,
    };
  }, [points, width, height]);

  if (points.length < 2) {
    return (
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Not enough history yet.
      </div>
    );
  }

  const active = hover !== null ? scaled[hover] : undefined;

  return (
    <div>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Trend, ${min.toFixed(1)} to ${max.toFixed(1)} ${unit}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - rect.left) / rect.width;
          setHover(Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1)))));
        }}
      >
        <path d={path} fill="none" stroke={color} strokeWidth={2}
              strokeLinejoin="round" strokeLinecap="round" />
        {active && (
          <>
            <line x1={active.x} y1={0} x2={active.x} y2={height}
                  stroke="var(--axis)" strokeWidth={1} />
            {/* 2px surface ring keeps the marker legible over the line */}
            <circle cx={active.x} cy={active.y} r={4} fill={color}
                    stroke="var(--surface-1)" strokeWidth={2} />
          </>
        )}
      </svg>
      <div className="tnum flex justify-between text-[10px]" style={{ color: 'var(--text-muted)' }}>
        <span>{min.toFixed(1)}</span>
        <span style={{ color: active ? 'var(--text-primary)' : 'transparent' }}>
          {active ? `${active.v.toFixed(1)} ${unit}` : '·'}
        </span>
        <span>{max.toFixed(1)} {unit}</span>
      </div>
    </div>
  );
}
