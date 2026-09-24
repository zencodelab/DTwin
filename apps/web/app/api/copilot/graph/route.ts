import { NextResponse } from 'next/server';
import { currentTenant, unauthorized } from '@/lib/tenant';
import { buildCopilotGraph } from '@/lib/copilot/graph';
import type { CopilotBackend } from '@/lib/copilot/backend';

export const dynamic = 'force-dynamic';

/**
 * The copilot's graph, as structure: nodes and edges from the compiled
 * LangGraph, so the panel draws the graph that is actually running rather
 * than a picture of one. Positions are the panel's business; edges are not.
 *
 * Built with an inert backend and no model — the shape of the graph does not
 * depend on either, and nothing here is ever invoked.
 */
const inert: CopilotBackend = {
  listZones: async () => [],
  settings: async () => ({ enabled: false, maxDeviationK: 0, maxStepK: 0, minIntervalS: 0,
    defaultDurationS: 0, maxDurationS: 0, commandTtlS: 0 }),
  dryRun: async () => ({ allowed: false, refusal: 'control_disabled', message: 'inert' }),
  issue: async () => ({ ok: false, refusal: 'control_disabled', message: 'inert' }),
};

let cached: { nodes: string[]; edges: Array<{ source: string; target: string; conditional: boolean }>; mermaid: string } | null = null;

export async function GET() {
  // Scoped like every other route, though the graph reveals nothing about a
  // tenant: consistency is cheaper than an exception to reason about.
  if (!(await currentTenant())) return unauthorized();

  if (!cached) {
    const compiled = buildCopilotGraph({
      backend: inert, callModel: async () => { throw new Error('never'); }, model: 'none',
    });
    const g = await compiled.getGraphAsync();
    cached = {
      nodes: Object.keys(g.nodes),
      edges: g.edges.map((e) => ({ source: e.source, target: e.target, conditional: Boolean(e.conditional) })),
      mermaid: g.drawMermaid(),
    };
  }
  return NextResponse.json(cached);
}
