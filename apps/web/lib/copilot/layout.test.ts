import { describe, expect, it } from 'vitest';
import { buildCopilotGraph } from './graph.ts';
import { inertDeps } from './inert.ts';
import {
  NODE_H, NODE_W, backEdges, layout, roundedPath, segmentHitsBox, type GraphEdge, type Layout, type Point,
} from './layout.ts';

/**
 * The panel's diagram of the copilot graph is laid out from the COMPILED
 * graph — the same object the structure tests read and `npm run
 * copilot:graph` renders (design §9.5, §10 layout.test.ts). So these tests
 * build it, lay it out, and check the picture: every node placed, none
 * overlapping, everything inside the viewBox, no edge drawn through a node
 * it does not join, and the placement table the design wrote down.
 */

async function compiledFlat(): Promise<{ nodes: string[]; edges: GraphEdge[] }> {
  const g = await buildCopilotGraph(inertDeps()).getGraphAsync();
  return {
    nodes: Object.keys(g.nodes),
    edges: g.edges.map((e) => ({ source: e.source, target: e.target, conditional: Boolean(e.conditional) })),
  };
}

const box = (n: { x: number; y: number }) => ({
  left: n.x - NODE_W / 2, right: n.x + NODE_W / 2, top: n.y - NODE_H / 2, bottom: n.y + NODE_H / 2,
});

const segments = (points: readonly Point[]): Array<[Point, Point]> =>
  points.slice(1).map((p, i) => [points[i]!, p]);

function assertWellFormed(l: Layout, nodeIds: readonly string[]) {
  // every node placed, once
  expect(l.nodes.map((n) => n.id).sort()).toEqual([...new Set(nodeIds)].sort());
  for (const n of l.nodes) {
    expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
  }
  // no two boxes overlap
  for (let i = 0; i < l.nodes.length; i += 1) {
    for (let j = i + 1; j < l.nodes.length; j += 1) {
      const a = box(l.nodes[i]!);
      const b = box(l.nodes[j]!);
      const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      expect(overlap, `${l.nodes[i]!.id} overlaps ${l.nodes[j]!.id}`).toBe(false);
    }
  }
  // inside the viewBox: every box and every point of every edge
  const vb = l.viewBox;
  const inside = ([x, y]: Point) => x >= vb.x && x <= vb.x + vb.width && y >= vb.y && y <= vb.y + vb.height;
  for (const n of l.nodes) {
    const b = box(n);
    expect(inside([b.left, b.top]) && inside([b.right, b.bottom]), `${n.id} outside the viewBox`).toBe(true);
  }
  for (const e of l.edges) {
    for (const p of e.points) expect(inside(p), `${e.source}→${e.target} leaves the viewBox`).toBe(true);
    expect(inside(e.mid)).toBe(true);
  }
}

describe('layout of the compiled flat graph', () => {
  it('every node placed, no overlaps, inside the viewBox', async () => {
    const { nodes, edges } = await compiledFlat();
    const l = layout(nodes, edges);
    assertWellFormed(l, nodes);
    expect(l.edges).toHaveLength(edges.length);
  });

  it('placement table (design §9.5)', async () => {
    const { nodes, edges } = await compiledFlat();
    const l = layout(nodes, edges);
    const table = l.nodes.map((n) => [n.id, n.rank, n.x, n.y]);
    expect(table).toEqual([
      ['__start__', 0, 150, 14],
      ['intake', 1, 150, 48],
      ['orient', 2, 150, 82],
      ['planner', 3, 150, 116],
      ['diagnose', 4, 37.5, 150],
      ['analyse', 4, 112.5, 150],
      ['simulate', 4, 187.5, 150],
      ['join', 5, 75, 184],
      ['compose', 4, 262.5, 150],
      ['verify', 5, 225, 184],
      ['control', 6, 150, 218],
      ['plan_check', 7, 150, 252],
      ['confirm', 8, 150, 286],
      ['apply', 9, 75, 320],
      ['declined', 9, 225, 320],
      ['finish', 10, 150, 354],
      ['__end__', 11, 150, 388],
    ]);
    // H = 14 + maxRank·34 + 34
    expect(l.height).toBe(14 + 11 * 34 + 34);
    expect(l.width).toBe(300);
  });

  it('the back edges are the three loops, drawn round the right margin', async () => {
    const { nodes, edges } = await compiledFlat();
    const l = layout(nodes, edges);
    const back = l.edges.filter((e) => e.route === 'back').map((e) => `${e.source}->${e.target}`).sort();
    expect(back).toEqual(['control->compose', 'join->planner', 'verify->compose']);
    const rightmost = Math.max(...l.nodes.map((n) => n.x + NODE_W / 2));
    for (const e of l.edges.filter((x) => x.route === 'back')) {
      // Its lane runs right of every node.
      expect(e.points.slice(1, -1).some(([x]) => x > rightmost)).toBe(true);
      expect(e.d).toMatch(/Q/); // corners rounded: a curve, not a kinked line
    }
  });

  it('no edge is drawn through a node it does not join', async () => {
    // The failure this rules out: orient → finish as a straight line down the
    // spine, reading as edges planner, control, plan_check and confirm lack.
    const { nodes, edges } = await compiledFlat();
    const l = layout(nodes, edges);
    for (const e of l.edges) {
      for (const n of l.nodes) {
        if (n.id === e.source || n.id === e.target) continue;
        for (const [p, q] of segments(e.points)) {
          expect(segmentHitsBox(p, q, box(n)), `${e.source}→${e.target} crosses ${n.id}`).toBe(false);
        }
      }
    }
    const laned = l.edges.filter((e) => e.route === 'lane').map((e) => `${e.source}->${e.target}`).sort();
    expect(laned).toEqual(['orient->finish', 'plan_check->finish', 'planner->finish', 'verify->finish']);
  });

  it('confirm → apply is a straight edge, ending on apply, with room for its label off the line', async () => {
    const { nodes, edges } = await compiledFlat();
    const l = layout(nodes, edges);
    const e = l.edges.find((x) => x.source === 'confirm' && x.target === 'apply')!;
    expect(e.route).toBe('straight');
    const apply = l.nodes.find((n) => n.id === 'apply')!;
    const end = e.points[e.points.length - 1]!;
    expect(segmentHitsBox(end, end, box(apply))).toBe(true);
    // The label ("the only way in", ~70 px at 9 px) runs left from above the
    // line and touches neither the line nor a node.
    expect(e.label.anchor).toBe('end');
    const text = { left: e.label.x - 72, right: e.label.x, top: e.label.y - 9, bottom: e.label.y + 1 };
    for (const [p, q] of segments(e.points)) expect(segmentHitsBox(p, q, text, 0)).toBe(false);
    for (const n of l.nodes) {
      const b = box(n);
      const overlap = text.left < b.right && b.left < text.right && text.top < b.bottom && b.top < text.bottom;
      expect(overlap, `label overlaps ${n.id}`).toBe(false);
    }
  });

  it('two arrows into one side of a node land on different ports', async () => {
    const { nodes, edges } = await compiledFlat();
    const l = layout(nodes, edges);
    const ends = l.edges.filter((e) => e.route !== 'straight').map((e) => e.points[e.points.length - 1]!.join(','));
    expect(new Set(ends).size).toBe(ends.length);
  });
});

describe('layout rules on small graphs', () => {
  const E = (source: string, target: string): GraphEdge => ({ source, target, conditional: false });

  it('a back edge needs BOTH: target earlier in node order, and on a cycle', () => {
    const order = ['__start__', 'b', 'a', '__end__'];
    // b → a is forward in order; a → b is earlier-target AND on a cycle.
    const edges = [E('__start__', 'b'), E('b', 'a'), E('a', 'b'), E('a', '__end__')];
    expect([...backEdges(order, edges)].map((e) => `${e.source}->${e.target}`)).toEqual(['a->b']);
    // b → a: the target comes earlier in node order, but a cannot reach b.
    const acyclic = [E('__start__', 'b'), E('b', 'a'), E('a', '__end__')];
    expect(backEdges(['__start__', 'a', 'b', '__end__'], acyclic).size).toBe(0);
  });

  it('a self-loop is a back edge and does not hang the ranking', () => {
    const edges = [E('__start__', 'a'), E('a', 'a'), E('a', '__end__')];
    const l = layout(['__start__', 'a', '__end__'], edges);
    expect(l.edges.find((e) => e.source === 'a' && e.target === 'a')!.route).toBe('back');
    expect(l.nodes.map((n) => n.rank)).toEqual([0, 1, 2]);
  });

  it('a node only an edge names is still placed (nothing is dropped)', () => {
    const l = layout(['__start__', '__end__'], [E('__start__', 'ghost'), E('ghost', '__end__')]);
    expect(l.nodes.map((n) => n.id)).toEqual(['__start__', '__end__', 'ghost']);
    assertWellFormed(l, ['__start__', '__end__', 'ghost']);
  });

  it('a rank too full for W widens rather than overlapping', () => {
    const kids = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'];
    const edges = [...kids.map((k) => E('__start__', k)), ...kids.map((k) => E(k, '__end__'))];
    const l = layout(['__start__', ...kids, '__end__'], edges);
    expect(l.width).toBeGreaterThan(300);
    assertWellFormed(l, ['__start__', ...kids, '__end__']);
  });

  it('rounds interior corners and leaves a two-point path straight', () => {
    expect(roundedPath([[0, 0], [10, 0]])).toBe('M0,0 L10,0');
    expect(roundedPath([[0, 0], [20, 0], [20, 20]])).toBe('M0,0 L15,0 Q20,0 20,5 L20,20');
  });
});
