import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DIAGRAM_DOCS, GRAPH_END, GRAPH_START, fencedMermaid, markedBlock, replaceMarkedBlock,
} from './diagram.ts';
import { buildCopilotGraph } from './graph.ts';
import { inertDeps } from './inert.ts';
import { hasModelCredential } from './model.ts';
import { TOOL_CLASS } from './tools/index.ts';

/**
 * The diagram in the documents is the graph (design §7 P22, §10 docs.test).
 *
 * README.md and ADR 64 embed the flat graph between copilot-graph markers,
 * and `npm run copilot:graph -- --write` is the only thing that should write
 * there. This fails when the graph changes and nobody regenerated — the
 * failure this project keeps finding in hand-written documents — and when
 * someone hand-edits a block instead.
 *
 * ADR 63's Mermaid is NOT held to the current graph: it is the record of what
 * v1 was, and it must stay that way.
 */

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (rel: string) => readFileSync(`${ROOT}${rel}`, 'utf8');

const mermaid = (await buildCopilotGraph(inertDeps()).getGraphAsync()).drawMermaid();

/** The body of one ADR: from its heading to the next `## ` heading, without the `---` between them. */
function adr(decisions: string, n: number): string {
  const start = decisions.search(new RegExp(`^## ${n}\\. `, 'm'));
  expect(start, `ADR ${n} exists`).toBeGreaterThanOrEqual(0);
  const rest = decisions.slice(start + 1);
  const next = rest.search(/^## \d+\. /m);
  const body = next < 0 ? decisions.slice(start) : decisions.slice(start, start + 1 + next);
  return body.replace(/\n---\s*$/, '\n');
}

describe('the documents embed the generated graph', () => {
  it('README and ADR 64 embed the generated Mermaid, verbatim', () => {
    expect(DIAGRAM_DOCS).toEqual(['README.md', 'docs/decisions.md']);
    for (const rel of DIAGRAM_DOCS) {
      expect(markedBlock(read(rel), rel), `${rel} is stale: run npm run copilot:graph -- --write`)
        .toBe(fencedMermaid(mermaid));
    }
    // The block is the flat v2 graph, not a leftover.
    expect(mermaid).toContain('confirm -.-> apply');
    expect(mermaid).toContain('planner -.-> diagnose');
  });

  it('the decisions block sits inside ADR 64, and ADR 63 keeps the v1 graph as history', () => {
    const decisions = read('docs/decisions.md');
    expect(adr(decisions, 64)).toContain(GRAPH_START);
    expect(adr(decisions, 64)).toContain(GRAPH_END);

    const v1 = adr(decisions, 63);
    expect(v1).not.toContain(GRAPH_START);
    expect(v1).toContain('agent -.-> tools;');   // the v1 edge list, as it was drawn
    expect(v1).toContain('tools -.-> confirm;');
    expect(v1.trimEnd().endsWith('Extended by §64.')).toBe(true);
  });
});

describe('diagram.ts: the marked block', () => {
  const doc = `# Title\n\nbefore\n${GRAPH_START}\nold\n${GRAPH_END}\nafter\n`;

  it('rewrites only the text between the markers, and is idempotent', () => {
    const out = replaceMarkedBlock(doc, 'new\nlines', 'doc');
    expect(out).toBe(`# Title\n\nbefore\n${GRAPH_START}\nnew\nlines\n${GRAPH_END}\nafter\n`);
    expect(markedBlock(out, 'doc')).toBe('new\nlines');
    expect(replaceMarkedBlock(out, 'new\nlines', 'doc')).toBe(out);
  });

  it('fences the Mermaid once, whether or not it ends in a newline', () => {
    expect(fencedMermaid('graph TD;\n')).toBe('```mermaid\ngraph TD;\n```');
    expect(fencedMermaid('graph TD;')).toBe('```mermaid\ngraph TD;\n```');
  });

  it('refuses a document without exactly one pair of markers, in order', () => {
    expect(() => markedBlock('no markers here', 'a.md')).toThrow(/a\.md: expected exactly one/);
    expect(() => replaceMarkedBlock(`${doc}${GRAPH_START}\n`, 'x', 'b.md')).toThrow(/b\.md: expected exactly one/);
    expect(() => markedBlock(`${GRAPH_END}\n${GRAPH_START}\n`, 'c.md')).toThrow(/c\.md: .* comes before/);
  });
});

/**
 * Claims the review found false in the documents, each checked against the
 * code it describes — this project's recurring defect is a document asserting
 * behaviour the code no longer has.
 */
describe('the documents say what the code does (review)', () => {
  const decisions = read('docs/decisions.md');

  it('an `ant auth login` profile is never offered as a credential: the route asks for a variable', () => {
    expect(hasModelCredential({})).toBe(false);
    expect(hasModelCredential({ ANTHROPIC_AUTH_TOKEN: 'x' })).toBe(true);
    for (const rel of ['docs/operations.md', '.env.example']) {
      const mentions = read(rel).split('\n').filter((l) => l.includes('ant auth login'));
      for (const line of mentions) expect(line, rel).toMatch(/\bnot\b|\bNOT\b/);
    }
  });

  it('the setup names every environment variable bootstrap prints, and no other', () => {
    const envs = [...read('packages/db/src/bootstrap.ts').matchAll(/env: '(\w+)'/g)].map((m) => m[1]!);
    expect(envs).toEqual(['INGEST_API_KEY', 'SIM_API_KEY', 'COPILOT_SIM_API_KEY']);
    const ops = read('docs/operations.md');
    const setup = ops.slice(ops.indexOf('`bootstrap` prints'), ops.indexOf('idempotent'));
    for (const env of envs) expect(setup, env).toContain(env);
    expect(ops).not.toMatch(/SIM_SERVICE_KEY|the two API keys/);
  });

  it('the max_tokens bound says what reaching it does for each role that calls a model', () => {
    const row = adr(decisions, 64).split('\n').find((l) => l.startsWith('| `max_tokens`'));
    expect(row).toBeDefined();
    for (const role of ['specialist', 'controller', 'planner', 'compose']) expect(row, role).toContain(role);
  });

  it('no document calls the specialists read-only: simulate writes scratch simulation runs', () => {
    expect(TOOL_CLASS.simulate_scenarios).toBe('scratch');
    for (const rel of ['README.md', 'CLAUDE.md', 'docs/architecture.md', 'docs/decisions.md']) {
      expect(read(rel), rel).not.toMatch(/read-only specialists/);
    }
  });

  it('stale claims stay gone', () => {
    const STALE: Array<[string, RegExp, string]> = [
      ['CLAUDE.md', /`apps\/ingest` is unchanged since it last passed/, 'this change edits apps/ingest'],
      ['docs/multi-tenancy.md', /suites total \d+ checks/, 'counts are kept, re-counted, in CLAUDE.md'],
      ['docs/architecture.md', /Not yet tenant-scoped or authenticated/, 'apps/web takes its tenant from the session'],
      ['README.md', /runs all of it on every push/, 'CI skips the copilot decision check (no operator, no model credential)'],
      ['README.md', /per-zone energy is not\s+metered[^.]*with a fixed caveat/, 'no caveat code covers per-zone energy'],
    ];
    for (const [rel, claim, why] of STALE) expect(read(rel), `${rel}: ${why}`).not.toMatch(claim);
  });
});
