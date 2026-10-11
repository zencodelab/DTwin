/**
 * Print the copilot graph as Mermaid, from the compiled graph itself — or,
 * with `--write`, put it into the documents that embed it.
 *
 * Generated, not drawn: the diagram is whatever the edge list says, so it
 * cannot describe a graph the code no longer has — which is the failure this
 * project keeps finding in its hand-written documents.
 *
 *   npm run copilot:graph                 # the flat graph, to stdout
 *   npm run copilot:graph -- --xray       # the four specialist subgraphs expanded
 *   npm run copilot:graph -- --write      # rewrite the marked blocks in README.md
 *                                         # and ADR 64 (docs/decisions.md)
 *
 * `--write` touches only the text between each document's copilot-graph
 * markers (lib/copilot/diagram.ts), and a document without exactly one pair
 * is refused, not guessed at. docs.test.ts fails whenever a block and the
 * graph disagree, so a changed graph is caught before a stale picture ships.
 * ADR 63's Mermaid is unmarked on purpose: it records the v1 graph.
 *
 * Built from `inertDeps()`: the graph's shape depends on none of its
 * capabilities, and each of them refuses if anything ever called it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DIAGRAM_DOCS, fencedMermaid, replaceMarkedBlock } from '../lib/copilot/diagram.ts';
import { buildCopilotGraph } from '../lib/copilot/graph.ts';
import { inertDeps } from '../lib/copilot/inert.ts';

const args = process.argv.slice(2);
const xray = args.includes('--xray');
const write = args.includes('--write');
const unknown = args.filter((a) => a !== '--xray' && a !== '--write');

// apps/web/scripts → the repository root. This package runs scripts as
// CommonJS, where __dirname is defined.
const ROOT = resolve(__dirname, '..', '..', '..');

function writeDocs(mermaid: string): void {
  const block = fencedMermaid(mermaid);
  for (const rel of DIAGRAM_DOCS) {
    const path = join(ROOT, rel);
    const before = readFileSync(path, 'utf8');
    const after = replaceMarkedBlock(before, block, rel);
    if (after === before) {
      console.log(`copilot-graph: ${rel} unchanged`);
    } else {
      writeFileSync(path, after);
      console.log(`copilot-graph: ${rel} updated`);
    }
  }
}

if (unknown.length > 0 || (xray && write)) {
  console.error(unknown.length > 0
    ? `copilot-graph: unknown argument ${unknown.join(' ')} (use --xray or --write)`
    : 'copilot-graph: the documents embed the flat graph; --write takes no --xray');
  process.exit(2);
}

// Not top-level await: this package compiles scripts as CommonJS.
buildCopilotGraph(inertDeps()).getGraphAsync(xray ? { xray: true } : undefined).then((drawable) => {
  const mermaid = drawable.drawMermaid();
  if (write) writeDocs(mermaid);
  else process.stdout.write(mermaid);
}).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
