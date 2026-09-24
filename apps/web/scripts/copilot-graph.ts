/**
 * Print the copilot graph as Mermaid, from the compiled graph itself.
 *
 * Generated, not drawn: the diagram is whatever the edge list says, so it
 * cannot describe a graph the code no longer has — which is the failure this
 * project keeps finding in its hand-written documents. `npm run copilot:graph`
 * regenerates it; the README and ADR 63 embed the output.
 */
import { buildCopilotGraph } from '../lib/copilot/graph.ts';
import type { CopilotBackend } from '../lib/copilot/backend.ts';

const inert: CopilotBackend = {
  listZones: async () => [],
  settings: async () => ({ enabled: false, maxDeviationK: 0, maxStepK: 0, minIntervalS: 0,
    defaultDurationS: 0, maxDurationS: 0, commandTtlS: 0 }),
  dryRun: async () => ({ allowed: false, refusal: 'control_disabled', message: 'inert' }),
  issue: async () => ({ ok: false, refusal: 'control_disabled', message: 'inert' }),
};

const graph = buildCopilotGraph({
  backend: inert,
  callModel: async () => { throw new Error('never called'); },
  model: 'none',
});

// Not top-level await: this package compiles scripts as CommonJS.
graph.getGraphAsync().then((drawable) => {
  process.stdout.write(drawable.drawMermaid());
}).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
