import { NextResponse } from 'next/server';
import { currentTenant, unauthorized } from '@/lib/tenant';
import { NODE_ROLES, buildCopilotGraph } from '@/lib/copilot/graph';
import { inertDeps } from '@/lib/copilot/inert';

export const dynamic = 'force-dynamic';

/**
 * The copilot's graph, as structure: nodes and edges from the compiled
 * LangGraph, so the panel draws the graph that is actually running rather
 * than a picture of one. Positions are the panel's business; edges are not.
 *
 * Built from `inertDeps()` — the shape of the graph depends on none of its
 * capabilities, and every one of them refuses if anything ever invoked it.
 * `roles` says what each node IS (reads, calls a model, writes the building),
 * for styling. `?xray=1` expands the four specialist subgraphs, as the
 * structure tests and the docs read them.
 */
interface Shape {
  nodes: string[];
  edges: Array<{ source: string; target: string; conditional: boolean }>;
  mermaid: string;
  roles: typeof NODE_ROLES;
}

const cached: { flat: Shape | null; xray: Shape | null } = { flat: null, xray: null };

export async function GET(request: globalThis.Request) {
  // Scoped like every other route, though the graph reveals nothing about a
  // tenant: consistency is cheaper than an exception to reason about.
  if (!(await currentTenant())) return unauthorized();

  const xray = new URL(request.url).searchParams.get('xray') === '1';
  const key = xray ? 'xray' : 'flat';
  if (!cached[key]) {
    const g = await buildCopilotGraph(inertDeps()).getGraphAsync(xray ? { xray: true } : undefined);
    cached[key] = {
      nodes: Object.keys(g.nodes),
      edges: g.edges.map((e) => ({ source: e.source, target: e.target, conditional: Boolean(e.conditional) })),
      mermaid: g.drawMermaid(),
      roles: NODE_ROLES,
    };
  }
  return NextResponse.json(cached[key]);
}
