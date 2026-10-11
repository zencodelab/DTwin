'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { z } from 'zod';
import { STATUS, STATUS_TEXT } from '@/lib/colors';
import { NODE_H, NODE_W, layout } from '@/lib/copilot/layout';

/**
 * The copilot graph, drawn from the running graph itself
 * (docs/decisions.md §63, §64; design §9.5).
 *
 * Nothing on this picture is hand-placed or hand-listed. Nodes, edges and
 * what each node IS (its role) come from `/api/copilot/graph`, which reads
 * the compiled LangGraph; positions come from `lib/copilot/layout.ts`, which
 * ranks nodes by those edges. So a second way into `apply` would appear
 * here, drawn in amber and counted in the label, before anyone read a
 * document — and a node added tomorrow is placed like every other, not
 * parked in a spare row.
 *
 * Styling is by role, never by name: the `interrupt` node is a dashed box
 * (it waits for a person), every edge into the `writes-building` node is
 * amber, and the label on it says how many there are. Loops run round the
 * right margin; the forward edges that would otherwise cross the spine run
 * round a margin too.
 */

const Shape = z.object({
  nodes: z.array(z.string()),
  edges: z.array(z.object({ source: z.string(), target: z.string(), conditional: z.boolean() })),
  roles: z.record(z.string(), z.string()),
});
type Shape = z.infer<typeof Shape>;

const LABEL: Record<string, string> = { __start__: 'start', __end__: 'end' };

/** What each role means, for the tooltip and the screen reader. Unknown roles are named as they are. */
const ROLE_TEXT: Record<string, string> = {
  pure: 'pure: no I/O, no model',
  read: 'reads the building’s data',
  llm: 'calls the model',
  join: 'waits for every task in the wave',
  specialist: 'a model with read-only tools',
  'specialist-scratch': 'a model that may run simulations (scratch writes, never the building)',
  'specialist-control': 'the controller: reads, dry-runs, may propose',
  'dry-run': 're-checks every command against the envelope',
  interrupt: 'waits for a person',
  'writes-building': 'the one node that writes to the building',
};

const CALLS_MODEL = new Set(['llm', 'specialist', 'specialist-scratch', 'specialist-control']);

/** The sentence a screen reader hears, from the edges — so it cannot claim one door when there are two. */
function describe(shape: Shape): string {
  const doors = Object.entries(shape.roles).filter(([, r]) => r === 'writes-building').map(([n]) => n);
  const parts = [`The copilot's graph, drawn from the running LangGraph: ${shape.nodes.length} nodes, ${shape.edges.length} edges.`];
  for (const door of doors) {
    const ins = shape.edges.filter((e) => e.target === door).map((e) => e.source);
    parts.push(ins.length === 1
      ? `${door} writes to the building and has one way in, from ${ins[0]}.`
      : `${door} writes to the building and has ${ins.length} ways in, from ${ins.join(', ')}.`);
  }
  const waits = Object.entries(shape.roles).filter(([, r]) => r === 'interrupt').map(([n]) => n);
  if (waits.length > 0) parts.push(`${waits.join(' and ')} waits for a person.`);
  return parts.join(' ');
}

export function GraphDiagram({ activeNodes }: { activeNodes: ReadonlySet<string> }) {
  const [shape, setShape] = useState<Shape | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Marker ids must be unique on the page; useId's colons are not welcome in url(#…).
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/copilot/graph', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`graph ${r.status}`))))
      .then((d: unknown) => {
        if (cancelled) return;
        const parsed = Shape.safeParse(d);
        if (parsed.success) setShape(parsed.data);
        else setError('the graph route answered in a shape this panel does not read');
      })
      .catch((err: unknown) => { if (!cancelled) setError((err as Error).message); });
    return () => { cancelled = true; };
  }, []);

  const placed = useMemo(() => (shape ? layout(shape.nodes, shape.edges) : null), [shape]);

  if (error) return <p style={{ color: STATUS_TEXT.critical, fontSize: 11 }}>graph unavailable — {error}</p>;
  if (!shape || !placed) return null;

  const role = (n: string) => shape.roles[n] ?? null;
  const intoDoor = (target: string) => role(target) === 'writes-building';
  const doorIns = (target: string) => shape.edges.filter((e) => e.target === target).length;
  const vb = placed.viewBox;

  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`${vb.x} ${vb.y} ${vb.width} ${vb.height}`}
        width="100%"
        role="img"
        aria-label={describe(shape)}
        style={{ fontFamily: 'inherit', fontSize: 10, display: 'block' }}
      >
        <defs>
          <marker id={`${uid}-arrow`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" fill="var(--text-muted)" />
          </marker>
          <marker id={`${uid}-arrow-hot`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" fill={STATUS.warning} />
          </marker>
        </defs>

        {/* Edges first, so a node is never drawn under a line. */}
        {placed.edges.map((e, i) => {
          const hot = intoDoor(e.target);
          return (
            <g key={`${e.source}->${e.target}:${i}`}>
              <path
                d={e.d}
                fill="none"
                stroke={hot ? STATUS.warning : 'var(--text-muted)'}
                strokeWidth={hot ? 1.8 : 1}
                strokeDasharray={e.conditional && !hot ? '3 3' : undefined}
                markerEnd={`url(#${uid}-${hot ? 'arrow-hot' : 'arrow'})`}
                opacity={hot ? 1 : 0.7}
              >
                <title>{`${e.source} → ${e.target}${e.conditional ? ' (conditional)' : ''}${e.route === 'back' ? ', a loop' : ''}`}</title>
              </path>
              {hot && (
                <text x={e.label.x} y={e.label.y} fill={STATUS_TEXT.warning} textAnchor={e.label.anchor} fontSize={9}>
                  {doorIns(e.target) === 1 ? 'the only way in' : `${doorIns(e.target)} ways in`}
                </text>
              )}
            </g>
          );
        })}

        {placed.nodes.map((n) => {
          const r = role(n.id);
          const terminal = n.id === '__start__' || n.id === '__end__';
          const active = activeNodes.has(n.id);
          const waits = r === 'interrupt';
          const door = r === 'writes-building';
          const amber = active || waits || door;
          return (
            <g key={n.id}>
              <title>{`${n.id}${r ? ` — ${ROLE_TEXT[r] ?? r}` : ''}${active ? ' (active now)' : ''}`}</title>
              <rect
                x={n.x - NODE_W / 2} y={n.y - NODE_H / 2} width={NODE_W} height={NODE_H}
                rx={terminal ? NODE_H / 2 : 4}
                fill={active ? 'rgba(250,178,25,0.18)' : 'var(--surface-1)'}
                stroke={amber ? STATUS.warning : 'var(--border)'}
                strokeWidth={active || door ? 1.6 : 1}
                strokeDasharray={waits ? '3 2' : undefined}
              />
              {r && CALLS_MODEL.has(r) && (
                // A model is called here: a small mark, top-left, explained in the key below.
                <circle cx={n.x - NODE_W / 2 + 5} cy={n.y - NODE_H / 2 + 5} r={2} fill="var(--accent)" />
              )}
              <text x={n.x} y={n.y + 3.5} textAnchor="middle" fill="var(--text-primary)"
                    fontWeight={door ? 600 : undefined}>
                {LABEL[n.id] ?? n.id}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption style={{ color: 'var(--text-muted)', fontSize: 10, marginTop: 4 }}>
        Drawn from the running LangGraph, not a picture of it. Dashed edges are conditional; the dashed
        box waits for you; <span style={{ color: 'var(--accent)' }}>●</span> calls a model; amber is the
        way to the building{Object.values(shape.roles).includes('writes-building') ? '' : ' (none drawn)'}.
        {activeNodes.size > 0 && ' The highlighted node is where the run is now.'}
      </figcaption>
    </figure>
  );
}
