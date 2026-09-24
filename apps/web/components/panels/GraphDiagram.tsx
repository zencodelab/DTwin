'use client';

import { useEffect, useState } from 'react';
import { STATUS } from '@/lib/colors';

/**
 * The copilot graph, drawn from the running graph's own edge list.
 *
 * Only the POSITIONS are hand-placed. Every node and edge comes from
 * `/api/copilot/graph`, which reads them off the compiled LangGraph — so if
 * someone adds a second route into `apply`, it appears here, drawn, before
 * anyone reads the README. A node the layout does not know about is not
 * hidden: it lands in a spare row so the change is visible rather than lost.
 *
 * `confirm → apply` is drawn in amber with its label, because it is the one
 * edge the whole safety argument rests on (docs/decisions.md §63).
 */

interface Shape {
  nodes: string[];
  edges: Array<{ source: string; target: string; conditional: boolean }>;
}

const W = 300;
const H = 190;
const NODE_W = 64;
const NODE_H = 22;

/** Centre of each known node. Anything else goes in the spare row. */
const LAYOUT: Record<string, [number, number]> = {
  __start__: [40, 20],
  agent:     [120, 60],
  tools:     [220, 60],
  confirm:   [220, 110],
  apply:     [150, 160],
  declined:  [260, 160],
  __end__:   [40, 160],
};

const LABEL: Record<string, string> = { __start__: 'start', __end__: 'end' };

export function GraphDiagram({ activeNode }: { activeNode: string | null }) {
  const [shape, setShape] = useState<Shape | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/copilot/graph', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`graph ${r.status}`))))
      .then((d: Shape) => { if (!cancelled) setShape(d); })
      .catch((err: unknown) => { if (!cancelled) setError((err as Error).message); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <p style={{ color: STATUS.critical, fontSize: 11 }}>graph unavailable — {error}</p>;
  if (!shape) return null;

  // Place unknown nodes in a spare row rather than dropping them.
  const positions = new Map<string, [number, number]>();
  let spare = 0;
  for (const n of shape.nodes) {
    positions.set(n, LAYOUT[n] ?? [40 + 70 * spare++, H - 12]);
  }
  const at = (n: string) => positions.get(n) ?? [0, 0];

  const key = (e: Shape['edges'][number]) => `${e.source}->${e.target}`;
  const guarded = (e: Shape['edges'][number]) => e.source === 'confirm' && e.target === 'apply';

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label="The copilot's control graph. apply has one incoming edge, from confirm."
      style={{ fontFamily: 'inherit', fontSize: 10 }}
    >
      <defs>
        <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 z" fill="var(--text-muted)" />
        </marker>
        <marker id="arrow-hot" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 z" fill={STATUS.warning} />
        </marker>
      </defs>

      {shape.edges.map((e) => {
        const [x1, y1] = at(e.source);
        const [x2, y2] = at(e.target);
        // Shorten each end so the arrowhead meets the node's edge, not its centre.
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        const pad = Math.min(NODE_W, NODE_H) / 2 + 2;
        const sx = x1 + ux * pad, sy = y1 + uy * pad;
        const tx = x2 - ux * pad, ty = y2 - uy * pad;
        const hot = guarded(e);
        return (
          <g key={key(e)}>
            <line
              x1={sx} y1={sy} x2={tx} y2={ty}
              stroke={hot ? STATUS.warning : 'var(--text-muted)'}
              strokeWidth={hot ? 1.8 : 1}
              strokeDasharray={e.conditional && !hot ? '3 3' : undefined}
              markerEnd={hot ? 'url(#arrow-hot)' : 'url(#arrow)'}
              opacity={hot ? 1 : 0.7}
            />
            {hot && (
              <text x={(sx + tx) / 2 - 6} y={(sy + ty) / 2 + 3} fill={STATUS.warning} textAnchor="end">
                the only way in
              </text>
            )}
          </g>
        );
      })}

      {shape.nodes.map((n) => {
        const [x, y] = at(n);
        const terminal = n === '__start__' || n === '__end__';
        const active = n === activeNode;
        const interrupt = n === 'confirm';
        return (
          <g key={n}>
            <rect
              x={x - NODE_W / 2} y={y - NODE_H / 2} width={NODE_W} height={NODE_H}
              rx={terminal ? NODE_H / 2 : 4}
              fill={active ? 'rgba(250,178,25,0.18)' : 'var(--surface-1)'}
              stroke={active ? STATUS.warning : interrupt ? STATUS.warning : 'var(--border)'}
              strokeWidth={active ? 1.6 : 1}
              strokeDasharray={interrupt && !active ? '2 2' : undefined}
            />
            <text x={x} y={y + 3.5} textAnchor="middle" fill="var(--text-primary)">
              {LABEL[n] ?? n}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
