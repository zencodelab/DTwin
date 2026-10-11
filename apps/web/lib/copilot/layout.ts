/**
 * Where the panel draws each node and edge of the copilot graph
 * (docs/decisions.md §64, design §9.5). Pure: the compiled graph's node and
 * edge lists in, coordinates and SVG paths out. No React, no fetch.
 *
 * THE GRAPH DECIDES THE PICTURE. Nothing here names a node. v1 hand-placed
 * seven positions and parked anything it did not know in a "spare row"; a
 * fifteen-node graph drawn that way overlapped, and a node added tomorrow
 * would have landed wherever the spare row happened to be. Instead every
 * node is ranked by the edges themselves:
 *
 * - A BACK edge is one whose target comes before its source in node order
 *   (LangGraph's insertion order) AND that lies on a cycle — `join →
 *   planner`, `verify → compose`, `control → compose` today. Both halves
 *   matter: order alone would call any edge to an earlier-inserted node a
 *   loop, and a cycle alone does not say which of its edges to cut.
 * - Removing the back edges leaves a DAG (every cycle has at least one edge
 *   that runs backwards in a linear order, and that edge is on the cycle),
 *   and a node's rank is its longest path from `__start__` over it — so
 *   `finish` sits below everything that can reach it, and `apply` below
 *   `confirm`, which is the reading the safety argument wants.
 * - Within a rank, nodes are spread evenly in node order.
 *
 * EDGES NEVER RUN THROUGH A NODE. A straight line from `orient` to `finish`
 * would run down the middle of the spine, behind `planner`, `control`,
 * `plan_check` and `confirm`, and read as edges those nodes do not have. So
 * an edge whose straight segment would cross a node it does not join is
 * routed round the side in a lane, as are the back edges (always on the
 * right, where a reader looks for a loop). Lanes sit outside every node, and
 * reach them along a row that is clear or along the gap between two rows,
 * so no segment of any path crosses a node that is not its own endpoint —
 * and the test checks that for the compiled graph rather than trusting it.
 */

export const NODE_W = 64;
export const NODE_H = 20;
/** Centre of rank 0. */
export const TOP = 14;
/** Rank pitch: a 20 px node and a 14 px gap. */
export const RANK_GAP = 34;
/** The narrowest horizontal gap between two nodes of one rank. */
const MIN_GAP_X = 8;
/** First lane's distance from the outermost node edge, and the pitch between lanes. */
const LANE_OFFSET = 6;
const LANE_PITCH = 6;
/** Breathing room between the outermost lane and the viewBox. */
const MARGIN = 4;
/** Between two arrowheads that enter one side of one node. */
const PORT_PITCH = 6;
/** Rounded corners on routed edges, so a lane reads as a curve. */
const CORNER_R = 5;

export interface GraphEdge {
  source: string;
  target: string;
  conditional: boolean;
}

export interface PlacedNode {
  id: string;
  rank: number;
  /** Centre. */
  x: number;
  y: number;
}

/**
 * `straight` from box to box; `back` against node order, round the right
 * margin; `lane` forward, but round a margin because a straight line would
 * cross another node.
 */
export type EdgeRoute = 'straight' | 'back' | 'lane';

export type Point = readonly [number, number];

export interface PlacedEdge extends GraphEdge {
  route: EdgeRoute;
  /** The polyline, first point on the source's box and last on the target's. */
  points: Point[];
  /** SVG path data for `points`, corners rounded. */
  d: string;
  /** Halfway along the path. */
  mid: Point;
  /**
   * Where a label on this edge goes: beside the midpoint, off the line on its
   * upper side, with the text running away from it (`end` when that side is
   * to the left) — so the words never sit on the edge they name.
   */
  label: { x: number; y: number; anchor: 'start' | 'end' };
}

export interface Layout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  /** Width the nodes are spread across (W, unless a rank needs more). */
  width: number;
  /** 14 + maxRank·34 + 34. */
  height: number;
  /** Nodes, lanes and a margin; lanes may sit left of 0 or right of `width`. */
  viewBox: { x: number; y: number; width: number; height: number };
}

type Box = { left: number; right: number; top: number; bottom: number };

const boxOf = (n: PlacedNode): Box => ({
  left: n.x - NODE_W / 2, right: n.x + NODE_W / 2, top: n.y - NODE_H / 2, bottom: n.y + NODE_H / 2,
});

// ================================================================ ranking

/** Every node that can be reached from `from`, including itself only if a cycle leads back. */
function reachFrom(from: string, next: ReadonlyMap<string, readonly string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(next.get(from) ?? [])];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(next.get(n) ?? []));
  }
  return seen;
}

/**
 * The back edges: target at or before source in node order, and on a cycle
 * (the target can reach the source). A self-loop is both.
 */
export function backEdges(order: readonly string[], edges: readonly GraphEdge[]): Set<GraphEdge> {
  const index = new Map(order.map((n, i) => [n, i]));
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.source, [...(next.get(e.source) ?? []), e.target]);
  const reach = new Map<string, Set<string>>();
  const reaches = (from: string, to: string) => {
    let r = reach.get(from);
    if (!r) { r = reachFrom(from, next); reach.set(from, r); }
    return r.has(to);
  };
  return new Set(edges.filter((e) => index.get(e.target)! <= index.get(e.source)! && reaches(e.target, e.source)));
}

/**
 * Longest path from a source over the DAG left once back edges are cut.
 * `__start__` is the graph's only source; a node nothing reaches (none
 * today) is a source of its own and ranks 0 rather than vanishing.
 */
function ranks(order: readonly string[], forward: readonly GraphEdge[]): Map<string, number> {
  const preds = new Map<string, string[]>(order.map((n) => [n, []]));
  for (const e of forward) preds.get(e.target)!.push(e.source);
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const of = (n: string): number => {
    const known = rank.get(n);
    if (known !== undefined) return known;
    // Unreachable: the forward edges are acyclic by construction. Guarded
    // anyway, so a bug here costs a picture and never a hung tab.
    if (visiting.has(n)) throw new Error(`layout: cycle through ${n} after removing back edges`);
    visiting.add(n);
    const r = Math.max(-1, ...preds.get(n)!.map(of)) + 1;
    visiting.delete(n);
    rank.set(n, r);
    return r;
  };
  for (const n of order) of(n);
  return rank;
}

// ================================================================ geometry

/** Does the segment p→q pass through the box (grown by `pad`)? Liang–Barsky clipping. */
export function segmentHitsBox(p: Point, q: Point, box: Box, pad = 1): boolean {
  const [x0, y0] = p;
  const dx = q[0] - x0;
  const dy = q[1] - y0;
  let t0 = 0;
  let t1 = 1;
  const clip = (den: number, num: number): boolean => {
    if (den === 0) return num >= 0;
    const t = num / den;
    if (den < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, x0 - (box.left - pad)) && clip(dx, box.right + pad - x0)
    && clip(-dy, y0 - (box.top - pad)) && clip(dy, box.bottom + pad - y0)
    && t1 - t0 > 1e-9;
}

/** Where the line from a box's centre towards (dx, dy) leaves the box. */
function boundary(n: PlacedNode, dx: number, dy: number): Point {
  const sx = dx === 0 ? Infinity : (NODE_W / 2) / Math.abs(dx);
  const sy = dy === 0 ? Infinity : (NODE_H / 2) / Math.abs(dy);
  const s = Math.min(sx, sy);
  return [n.x + dx * s, n.y + dy * s];
}

const round = (v: number) => Math.round(v * 100) / 100;

/** SVG path through the points, each interior corner rounded. */
export function roundedPath(points: readonly Point[], r = CORNER_R): string {
  const fmt = ([x, y]: Point) => `${round(x)},${round(y)}`;
  if (points.length < 3) return `M${points.map(fmt).join(' L')}`;
  let d = `M${fmt(points[0]!)}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const [px, py] = points[i - 1]!;
    const [cx, cy] = points[i]!;
    const [nx, ny] = points[i + 1]!;
    const inLen = Math.hypot(cx - px, cy - py);
    const outLen = Math.hypot(nx - cx, ny - cy);
    const k = Math.min(r, inLen / 2, outLen / 2);
    const a: Point = inLen === 0 ? [cx, cy] : [cx - ((cx - px) / inLen) * k, cy - ((cy - py) / inLen) * k];
    const b: Point = outLen === 0 ? [cx, cy] : [cx + ((nx - cx) / outLen) * k, cy + ((ny - cy) / outLen) * k];
    d += ` L${fmt(a)} Q${fmt([cx, cy])} ${fmt(b)}`;
  }
  return `${d} L${fmt(points[points.length - 1]!)}`;
}

const LABEL_GAP = 6;

/** Beside the midpoint of the segment it falls on, offset along that segment's upward normal. */
function labelSpot(points: readonly Point[]): PlacedEdge['label'] {
  const [mx, my] = midpoint(points);
  // The segment holding the midpoint: the one whose bounding box contains it.
  const i = Math.max(0, points.findIndex((p, k) => k > 0
    && Math.min(points[k - 1]![0], p[0]) - 1e-6 <= mx && mx <= Math.max(points[k - 1]![0], p[0]) + 1e-6
    && Math.min(points[k - 1]![1], p[1]) - 1e-6 <= my && my <= Math.max(points[k - 1]![1], p[1]) + 1e-6) - 1);
  const a = points[i]!;
  const b = points[i + 1] ?? a;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  let nx = -(b[1] - a[1]) / len;
  let ny = (b[0] - a[0]) / len;
  if (ny > 0 || (ny === 0 && nx > 0)) { nx = -nx; ny = -ny; } // the upper side; on a vertical, the left
  return { x: round(mx + nx * LABEL_GAP), y: round(my + ny * LABEL_GAP), anchor: nx < 0 ? 'end' : 'start' };
}

/** The point halfway along a polyline. */
function midpoint(points: readonly Point[]): Point {
  const lens = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i]![0], p[1] - points[i]![1]));
  let half = lens.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lens.length; i += 1) {
    if (half <= lens[i]! && lens[i]! > 0) {
      const t = half / lens[i]!;
      const [x0, y0] = points[i]!;
      const [x1, y1] = points[i + 1]!;
      return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    }
    half -= lens[i]!;
  }
  return points[0]!;
}


// ================================================================== layout

type Side = 'left' | 'right';

interface LaneEdge {
  edge: GraphEdge;
  route: 'back' | 'lane';
  side: Side;
  s: PlacedNode;
  t: PlacedNode;
  /** The target is above the source. */
  up: boolean;
  /** Leaves along its own row (`row`), or drops into the gap below it (`below`). */
  exit: 'row' | 'below';
  /** Arrives along its own row, or from the gap above it (`above`). */
  entry: 'row' | 'above';
  /** Offset of this edge's port along its side of the node (y on a side, x on the top or bottom). */
  exitShift: number;
  entryShift: number;
  lane: number;
}

/** Spread k ports evenly about a side's centre. */
const shiftOf = (j: number, k: number) => (j - (k - 1) / 2) * PORT_PITCH;

function groupBy<T>(items: readonly T[], key: (t: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const i of items) groups.set(key(i), [...(groups.get(key(i)) ?? []), i]);
  return [...groups.values()];
}

export function layout(nodeIds: readonly string[], edgeList: readonly GraphEdge[], W = 300): Layout {
  // Every endpoint is a node, even one the node list forgot: nothing is dropped.
  const order = [...new Set([...nodeIds, ...edgeList.flatMap((e) => [e.source, e.target])])];
  const back = backEdges(order, edgeList);
  const rank = ranks(order, edgeList.filter((e) => !back.has(e)));

  const byRank = new Map<number, string[]>();
  for (const n of order) byRank.set(rank.get(n)!, [...(byRank.get(rank.get(n)!) ?? []), n]);
  const maxRank = Math.max(0, ...rank.values());
  // The spec's spread is W·(i+0.5)/n. A rank too full for W would overlap, so
  // it widens instead; for the compiled graph (four at most) it is exactly W.
  const widest = Math.max(1, ...[...byRank.values()].map((r) => r.length));
  const width = Math.max(W, widest * (NODE_W + MIN_GAP_X));

  const nodes: PlacedNode[] = [];
  for (const [r, members] of byRank) {
    members.forEach((id, i) => {
      nodes.push({ id, rank: r, x: (width * (i + 0.5)) / members.length, y: TOP + r * RANK_GAP });
    });
  }
  nodes.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const at = new Map(nodes.map((n) => [n.id, n]));
  const boxes = new Map(nodes.map((n) => [n.id, boxOf(n)]));
  const height = TOP + maxRank * RANK_GAP + RANK_GAP;

  const clear = (p: Point, q: Point, except: readonly string[]) =>
    nodes.every((n) => except.includes(n.id) || !segmentHitsBox(p, q, boxes.get(n.id)!));

  const leftmost = Math.min(...nodes.map((n) => n.x - NODE_W / 2));
  const rightmost = Math.max(...nodes.map((n) => n.x + NODE_W / 2));
  const laneX = (side: Side, lane: number) => (side === 'right'
    ? rightmost + LANE_OFFSET + lane * LANE_PITCH
    : leftmost - LANE_OFFSET - lane * LANE_PITCH);
  const sideX = (n: PlacedNode, side: Side) => (side === 'right' ? n.x + NODE_W / 2 : n.x - NODE_W / 2);

  // ---- classify: straight, or round a margin
  const straight = new Map<GraphEdge, Point[]>();
  const laned: LaneEdge[] = [];
  for (const e of edgeList) {
    const s = at.get(e.source)!;
    const t = at.get(e.target)!;
    if (!back.has(e)) {
      const a = boundary(s, t.x - s.x, t.y - s.y);
      const b = boundary(t, s.x - t.x, s.y - t.y);
      if (clear(a, b, [e.source, e.target])) { straight.set(e, [a, b]); continue; }
    }
    // Back edges always right. A forward edge that would cross a node goes on
    // the side its source is on, so its first leg is short.
    const side: Side = back.has(e) || s.x > width / 2 ? 'right' : 'left';
    const lane0 = laneX(side, 0);
    laned.push({
      edge: e, route: back.has(e) ? 'back' : 'lane', side, s, t, up: t.y < s.y,
      // Along its own row if nothing else is on it that way; otherwise via
      // the gap between rows, which no node occupies.
      exit: clear([sideX(s, side), s.y], [lane0, s.y], [e.source]) ? 'row' : 'below',
      entry: clear([lane0, t.y], [sideX(t, side), t.y], [e.target]) ? 'row' : 'above',
      exitShift: 0, entryShift: 0, lane: 0,
    });
  }

  // ---- exit ports. Edges leaving one side of one node are spread apart:
  // those heading up take the upper ports and those heading down the lower,
  // and within each the longest span sits nearest the middle — so no edge's
  // first leg crosses another's lane.
  const span = (l: LaneEdge) => Math.abs(l.t.y - l.s.y);
  for (const group of groupBy(laned, (l) => `${l.edge.source}:${l.exit === 'row' ? l.side : 'bottom'}`)) {
    const ups = group.filter((l) => l.up).sort((a, b) => span(a) - span(b));
    const downs = group.filter((l) => !l.up).sort((a, b) => span(b) - span(a));
    [...ups, ...downs].forEach((l, j) => { l.exitShift = shiftOf(j, group.length); });
  }

  // ---- lanes. Shortest spans nearest the nodes; a lane is shared only by
  // spans that do not meet. An arrival's port is not known until lanes are
  // (below), so its end of the span is widened by the most it could move.
  const entryGroups = groupBy(laned, (l) => `${l.edge.target}:${l.entry === 'row' ? l.side : 'top'}`);
  const entrySlack = new Map<LaneEdge, number>();
  for (const g of entryGroups) for (const l of g) entrySlack.set(l, l.entry === 'row' ? ((g.length - 1) / 2) * PORT_PITCH : 0);
  const exitY = (l: LaneEdge) => (l.exit === 'row' ? l.s.y + l.exitShift : l.s.y + RANK_GAP / 2);
  const entryCentre = (l: LaneEdge) => (l.entry === 'row' ? l.t.y : l.t.y - RANK_GAP / 2);
  for (const side of ['left', 'right'] as const) {
    const lanes: Array<Array<[number, number]>> = [];
    const mine = laned.filter((l) => l.side === side).map((l) => {
      const a = exitY(l);
      const b = entryCentre(l);
      const slack = entrySlack.get(l)!;
      return { l, lo: Math.min(a, b - slack), hi: Math.max(a, b + slack) };
    }).sort((x, y) => (x.hi - x.lo) - (y.hi - y.lo));
    for (const { l, lo, hi } of mine) {
      let k = lanes.findIndex((taken) => taken.every(([a, b]) => hi < a || lo > b));
      if (k === -1) { lanes.push([]); k = lanes.length - 1; }
      lanes[k]!.push([lo, hi]);
      l.lane = k;
    }
  }

  // ---- entry ports. Arrivals from above take the upper ports, inner lane
  // highest; arrivals from below the lower, inner lane lowest. Each lane's
  // last leg then passes no other lane still running to its own port.
  for (const group of entryGroups) {
    const fromAbove = group.filter((l) => !l.up).sort((a, b) => a.lane - b.lane);
    const fromBelow = group.filter((l) => l.up).sort((a, b) => b.lane - a.lane);
    [...fromAbove, ...fromBelow].forEach((l, j) => { l.entryShift = shiftOf(j, group.length); });
  }

  const edges: PlacedEdge[] = edgeList.map((e) => {
    const line = straight.get(e);
    if (line) return { ...e, route: 'straight', points: line, d: roundedPath(line), mid: midpoint(line), label: labelSpot(line) };
    const l = laned.find((x) => x.edge === e)!;
    const { s, t } = l;
    const x = laneX(l.side, l.lane);
    const pts: Point[] = [];
    if (l.exit === 'row') pts.push([sideX(s, l.side), s.y + l.exitShift]);
    else pts.push([s.x + l.exitShift, s.y + NODE_H / 2], [s.x + l.exitShift, exitY(l)]);
    pts.push([x, pts[pts.length - 1]![1]]);
    if (l.entry === 'row') pts.push([x, t.y + l.entryShift], [sideX(t, l.side), t.y + l.entryShift]);
    else pts.push([x, entryCentre(l)], [t.x + l.entryShift, entryCentre(l)], [t.x + l.entryShift, t.y - NODE_H / 2]);
    return { ...e, route: l.route, points: pts, d: roundedPath(pts), mid: midpoint(pts), label: labelSpot(pts) };
  });

  const outer = (side: Side) => {
    const on = laned.filter((l) => l.side === side);
    return on.length === 0 ? null : laneX(side, Math.max(...on.map((l) => l.lane)));
  };
  const left = outer('left');
  const right = outer('right');
  const minX = Math.min(0, left === null ? 0 : left - MARGIN);
  const maxX = Math.max(width, right === null ? width : right + MARGIN);

  return {
    nodes,
    edges,
    width,
    height,
    viewBox: { x: round(minX), y: 0, width: round(maxX - minX), height },
  };
}
