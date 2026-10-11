/**
 * Where the documents embed the copilot's generated diagram, and how a block
 * is found and rewritten (docs/decisions.md §64; design P22).
 *
 * The diagram is the compiled graph's own `drawMermaid()`, never drawn by
 * hand. Two documents embed it, each between one pair of HTML-comment
 * markers: `npm run copilot:graph -- --write` rewrites the text between them
 * and nothing else, and docs.test.ts fails when either block differs from
 * what the graph draws now. ADR 63's Mermaid is deliberately NOT marked: it
 * is the historical record of the v1 graph, and regenerating it would erase
 * what v1 was.
 *
 * Pure string functions, shared by the script and the test so the two cannot
 * disagree about what "the block" is. Strict on purpose: a document with no
 * markers, two pairs, or an end before its start is refused by name rather
 * than written somewhere unexpected.
 */

export const GRAPH_START = '<!-- copilot-graph:start -->';
export const GRAPH_END = '<!-- copilot-graph:end -->';

/** The documents that embed the flat graph, relative to the repository root. */
export const DIAGRAM_DOCS = ['README.md', 'docs/decisions.md'] as const;

/** The Mermaid as a fenced block, ending in the closing fence (no newline after it). */
export function fencedMermaid(mermaid: string): string {
  const body = mermaid.endsWith('\n') ? mermaid : `${mermaid}\n`;
  return `\`\`\`mermaid\n${body}\`\`\``;
}

/** Where the one pair of markers sits; throws naming the document otherwise. */
function markers(doc: string, name: string): { start: number; end: number } {
  const count = (m: string) => doc.split(m).length - 1;
  if (count(GRAPH_START) !== 1 || count(GRAPH_END) !== 1) {
    throw new Error(`${name}: expected exactly one ${GRAPH_START} and one ${GRAPH_END}, `
      + `found ${count(GRAPH_START)} and ${count(GRAPH_END)}`);
  }
  const start = doc.indexOf(GRAPH_START);
  const end = doc.indexOf(GRAPH_END);
  if (end < start) throw new Error(`${name}: ${GRAPH_END} comes before ${GRAPH_START}`);
  return { start, end };
}

/** The text between the markers, without the one newline on each side. */
export function markedBlock(doc: string, name: string): string {
  const { start, end } = markers(doc, name);
  const inner = doc.slice(start + GRAPH_START.length, end);
  return inner.replace(/^\n/, '').replace(/\n$/, '');
}

/** The document with only the text between its markers replaced by `block`. */
export function replaceMarkedBlock(doc: string, block: string, name: string): string {
  const { start, end } = markers(doc, name);
  return `${doc.slice(0, start + GRAPH_START.length)}\n${block}\n${doc.slice(end)}`;
}
