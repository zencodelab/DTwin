import { describe, expect, it } from 'vitest';
import type { MemorySaver } from '@langchain/langgraph';
import { BoundedMemorySaver } from './checkpoints.ts';
import { Z, composeMsg, message, plannerMsg, toolUse, type Script } from './testing/fakes.ts';
import { harness, type Harness } from './testing/run.ts';
import { NOW_LOCAL, SINCE_9, compoundScript, fastPathScript, report } from './testing/scripts.ts';

/**
 * The checkpointer is bounded (review, ADR 64). MemorySaver kept every
 * checkpoint of every superstep, and each specialist wrote its private
 * transcript under a namespace of its own — about a megabyte per compound
 * question, kept for the life of the process and never read again.
 */

function saverOf(h: Harness): BoundedMemorySaver {
  const saver = (h.graph as unknown as { checkpointer: MemorySaver }).checkpointer;
  expect(saver).toBeInstanceOf(BoundedMemorySaver);
  return saver as BoundedMemorySaver;
}

/** Bytes the saver holds for one thread: checkpoints and pending writes. */
function heldBytes(saver: MemorySaver, threadId: string): number {
  let n = 0;
  for (const ns of Object.values(saver.storage[threadId] ?? {})) {
    for (const [checkpoint, metadata] of Object.values(ns)) n += checkpoint.length + metadata.length;
  }
  for (const [key, writes] of Object.entries(saver.writes)) {
    if ((JSON.parse(key) as string[])[0] !== threadId) continue;
    for (const [, , value] of Object.values(writes)) n += value.length;
  }
  return n;
}

const checkpointsOf = (saver: MemorySaver, threadId: string) =>
  Object.fromEntries(Object.entries(saver.storage[threadId] ?? {}).map(([ns, held]) => [ns, Object.keys(held).length]));

/** One diagnostic question: a wave, a finding, an answer. */
function questionScript(n: number): Script {
  return {
    planner: Array.from({ length: n }, () => [
      plannerMsg({ next: 'dispatch', tasks: [{ specialist: 'diagnose', goal: 'why OFF-301 warm', zoneIds: [Z.off301], from: SINCE_9, to: NOW_LOCAL }] }),
      plannerMsg({ next: 'compose' }),
    ]).flat(),
    'diagnose:T1': Array.from({ length: n }, () => [
      message([toolUse('zone_conditions', { zoneId: Z.off301, from: SINCE_9, to: NOW_LOCAL })]),
      message([report()]),
    ]).flat(),
    compose: Array.from({ length: n }, () => composeMsg({ paragraphs: [{ segments: [{ kind: 'text', text: 'OFF-301 was looked at.' }] }], caveats: [] })),
  };
}

const clarify = (n: number): Script => ({
  planner: Array.from({ length: n }, () => plannerMsg({ next: 'finish', intent: 'clarify', message: 'Which zone?' })),
});

describe('the checkpointer is bounded', () => {
  it('a compound request keeps the root namespace only, at most two checkpoints, and still resumes', async () => {
    const h = harness(compoundScript(), { scenarios: 'ok' });
    const saver = saverOf(h);
    const { turn } = await h.send('t', 'why are the L3 offices warm, what if we raised them a kelvin, and do it');
    expect(turn.pendingPlan).not.toBeNull();

    // No specialist transcript survives its call: the subgraphs keep no checkpoints.
    expect(Object.keys(saver.storage.t ?? {})).toEqual(['']);
    expect(checkpointsOf(saver, 't')['']).toBeLessThanOrEqual(2);

    const done = await h.decide('t', turn, 'approved');
    expect(done.turn.outcomes).toHaveLength(2);
    expect(h.fake.issuer.issued).toHaveLength(2);
    expect(checkpointsOf(saver, 't')['']).toBeLessThanOrEqual(2);
  });

  it('what a thread holds stays flat across requests, rather than growing with each', async () => {
    const h = harness(questionScript(5));
    const saver = saverOf(h);
    const sizes: number[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const { turn } = await h.send('t', `question ${i}`);
      expect(turn.answer, `request ${i}`).not.toBeNull();
      sizes.push(heldBytes(saver, 't'));
    }
    // The dialogue grows by two entries a request, and nothing else does.
    expect(sizes[4]!).toBeLessThan(sizes[0]! * 1.5);
    // And the conversation is still there to be read.
    expect((await h.state('t')).dialogue).toHaveLength(10);
  });

  it('holds at most maxThreadsPerGraph threads, forgetting the least recently used', async () => {
    const h = harness(clarify(3), { limits: { maxThreadsPerGraph: 2 } });
    const saver = saverOf(h);
    await h.send('a', 'first');
    await h.send('b', 'second');
    await h.send('c', 'third');
    expect(saver.threadCount()).toBe(2);
    expect(saver.storage.a).toBeUndefined();
    expect((await h.state('a')).dialogue ?? []).toEqual([]);
    expect((await h.state('c')).dialogue).toHaveLength(2);
  });

  it('never forgets a thread with a plan waiting for approval', async () => {
    const script: Script = { ...fastPathScript(), planner: [...fastPathScript().planner!, ...clarify(3).planner!] };
    const h = harness(script, { limits: { maxThreadsPerGraph: 2 } });
    const saver = saverOf(h);
    const { turn } = await h.send('p', 'pre-cool the L3 offices');
    expect(turn.pendingPlan).not.toBeNull();
    for (const t of ['x', 'y', 'z']) await h.send(t, 'which one?');

    expect(saver.storage.p).toBeDefined();
    expect(saver.threadCount()).toBe(2);   // p, and the most recent of the rest
    const done = await h.decide('p', turn, 'approved');
    expect(done.turn.outcomes).toHaveLength(2);
  });
});
