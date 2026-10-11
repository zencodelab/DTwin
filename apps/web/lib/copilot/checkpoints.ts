import { MemorySaver } from '@langchain/langgraph';

/**
 * The copilot's checkpointer: LangGraph's MemorySaver, keeping only what a
 * thread can still use (docs/decisions.md §64, bounds).
 *
 * MemorySaver keeps EVERY checkpoint of every superstep of every thread and
 * never lets one go. For the copilot that was about a megabyte per compound
 * question — fifteen root checkpoints and three specialist transcripts,
 * thinking blocks and 8 KB tool results included — held for the life of the
 * web process, because nothing called `deleteThread` and a graph was dropped
 * only when a two-hundred-and-first person signed in (review, ADR 64). Nothing
 * ever read that history back: a run resumes from a thread's LATEST
 * checkpoint and its pending writes, and a turn is read from the same.
 *
 * So, two bounds, each saying what it does when reached (§53):
 *
 * - PER THREAD, a new checkpoint lets go of every earlier one in its
 *   namespace but its parent, and of their pending writes. The latest is what
 *   `getState` and a resume read; the parent is kept so a write still in
 *   flight for the step it came from lands beside a checkpoint that exists.
 *   No channel of the copilot's state is a delta channel, which is the one
 *   kind that rebuilds itself from earlier checkpoints.
 * - PER GRAPH, at most `maxThreads` threads. Past it the least recently used
 *   thread that has no open request is forgotten whole — its conversation
 *   starts afresh on its next message. A thread with an open request (running,
 *   or paused at `confirm` with a plan on screen) is never forgotten, so the
 *   bound can be exceeded while every thread is busy; it is restored as they
 *   finish.
 *
 * The specialist subgraphs have no checkpointer at all (specialist.ts): they
 * never interrupt, and each call wrote its private transcript under a fresh
 * namespace that nothing read again.
 */
export class BoundedMemorySaver extends MemorySaver {
  readonly #maxThreads: number;
  readonly #busy: (threadId: string) => boolean;
  /** Thread ids, least recently used first. */
  readonly #recent = new Map<string, true>();

  constructor(opts: { maxThreads: number; busy: (threadId: string) => boolean }) {
    super();
    this.#maxThreads = opts.maxThreads;
    this.#busy = opts.busy;
  }

  override async getTuple(config: Parameters<MemorySaver['getTuple']>[0]): ReturnType<MemorySaver['getTuple']> {
    const tuple = await super.getTuple(config);
    const threadId = config.configurable?.thread_id;
    // Reading a thread is using it: a run starts by reading its latest checkpoint.
    if (tuple !== undefined && typeof threadId === 'string') this.#touch(threadId);
    return tuple;
  }

  override async put(...args: Parameters<MemorySaver['put']>): ReturnType<MemorySaver['put']> {
    const [config, checkpoint] = args;
    const saved = await super.put(...args);
    const threadId = config.configurable?.thread_id;
    if (typeof threadId === 'string') {
      const ns = typeof config.configurable?.checkpoint_ns === 'string' ? config.configurable.checkpoint_ns : '';
      const parent = config.configurable?.checkpoint_id;
      this.#prune(threadId, ns, new Set([checkpoint.id, ...(typeof parent === 'string' ? [parent] : [])]));
      this.#touch(threadId);
      await this.#evict();
    }
    return saved;
  }

  override async deleteThread(threadId: string): Promise<void> {
    this.#recent.delete(threadId);
    await super.deleteThread(threadId);
  }

  /** Threads held, for the bound's test. */
  threadCount(): number {
    return Object.keys(this.storage).length;
  }

  #touch(threadId: string): void {
    this.#recent.delete(threadId);
    this.#recent.set(threadId, true);
  }

  /** Every checkpoint of one thread and namespace but `keep`, and their writes. */
  #prune(threadId: string, ns: string, keep: ReadonlySet<string>): void {
    const held = this.storage[threadId]?.[ns];
    if (!held) return;
    const dropped = new Set<string>();
    for (const id of Object.keys(held)) {
      if (keep.has(id)) continue;
      delete held[id];
      dropped.add(id);
    }
    if (dropped.size === 0) return;
    // Writes are keyed by [thread, namespace, checkpoint], as MemorySaver's
    // own deleteThread reads them.
    for (const key of Object.keys(this.writes)) {
      const parsed = parseWritesKey(key);
      if (parsed && parsed[0] === threadId && parsed[1] === ns && dropped.has(parsed[2])) delete this.writes[key];
    }
  }

  async #evict(): Promise<void> {
    if (this.#recent.size <= this.#maxThreads) return;
    for (const threadId of [...this.#recent.keys()]) {
      if (this.#recent.size <= this.#maxThreads) return;
      if (this.#busy(threadId)) continue;
      await this.deleteThread(threadId);
    }
  }
}

function parseWritesKey(key: string): [string, string, string] | null {
  try {
    const v: unknown = JSON.parse(key);
    return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'string') ? v as [string, string, string] : null;
  } catch {
    return null;
  }
}
