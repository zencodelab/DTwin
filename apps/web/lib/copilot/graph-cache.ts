/**
 * The compiled graphs a web process holds, one per signed-in person
 * (`maxGraphs`, docs/decisions.md §64 bounds).
 *
 * LEAST RECENTLY USED goes first, and never one that is busy. The route's Map
 * evicted by creation order — `get` does not move a key — so the person who
 * had used the copilot longest was the first to lose it, and it evicted with
 * no look at what the graph was doing: an approval mid-`apply` lost its
 * thread (a reload showed an empty conversation, not the commands issued),
 * and a new request on that thread built a second graph with a second lock
 * and ran beside the first (review, ADR 64). Now a use moves a graph to the
 * back, and a graph with a thread locked or a request open — running, or a
 * plan on screen — is passed over. When every graph is busy nothing is
 * evicted and the new person is refused (`GraphsBusy`, a 503 with
 * Retry-After) rather than someone else's work being dropped.
 */

/** Every graph is busy: the route answers 503 with this Retry-After. */
export class GraphsBusy extends Error {
  readonly retryAfterS: number;
  constructor(retryAfterS: number) {
    super('the copilot is serving as many people as it can; try again shortly');
    this.name = 'GraphsBusy';
    this.retryAfterS = retryAfterS;
  }
}

/** Long enough for a run to finish or a plan to be decided; short enough to be worth retrying. */
export const GRAPHS_BUSY_RETRY_AFTER_S = 30;

export class GraphCache<G> {
  readonly #graphs = new Map<string, G>();
  readonly #max: number;
  readonly #busy: (graph: G) => boolean;

  constructor(opts: { max: number; busy: (graph: G) => boolean }) {
    this.#max = opts.max;
    this.#busy = opts.busy;
  }

  /** The graph for a key, if one is held — and a use: it moves to the back. */
  get(key: string): G | undefined {
    const graph = this.#graphs.get(key);
    if (graph !== undefined) {
      this.#graphs.delete(key);
      this.#graphs.set(key, graph);
    }
    return graph;
  }

  /** The graph for a key, built if none is held. Throws `GraphsBusy` when one must go and none may. */
  getOrBuild(key: string, build: () => G): G {
    const held = this.get(key);
    if (held !== undefined) return held;
    if (this.#graphs.size >= this.#max) {
      let evicted = false;
      for (const [k, g] of this.#graphs) {
        if (this.#busy(g)) continue;
        this.#graphs.delete(k);
        evicted = true;
        break;
      }
      if (!evicted) throw new GraphsBusy(GRAPHS_BUSY_RETRY_AFTER_S);
    }
    const graph = build();
    this.#graphs.set(key, graph);
    return graph;
  }

  get size(): number {
    return this.#graphs.size;
  }
}
