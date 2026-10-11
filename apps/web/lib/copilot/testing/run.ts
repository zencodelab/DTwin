import type Anthropic from '@anthropic-ai/sdk';
import { memoryLogger } from '../../log.ts';
import { buildCopilotGraph, type CopilotGraph } from '../graph.ts';
import type { CopilotEvent, CopilotTurn } from '../protocol.ts';
import { decide, sendMessage } from '../session.ts';
import type { CopilotStateType } from '../state.ts';
import { fakeDeps, type FakeDeps, type FakeDepsOptions, type Script } from './fakes.ts';

/**
 * The copilot on the fakes, run through the REAL session: every turn goes
 * through `sendMessage` / `decide` → `runTurn` → `graph.stream`, and the
 * events the panel would receive are recorded beside the final turn. The
 * orchestration, safety, bounds and injection tests all start here.
 *
 * Excluded from the source scan (§10): nothing here is production code.
 */

export interface Run {
  turn: CopilotTurn;
  events: CopilotEvent[];
  /** The top-level nodes that finished, in order (the `step` events). */
  trail: string[];
}

export interface Harness {
  fake: FakeDeps;
  graph: CopilotGraph;
  logger: ReturnType<typeof memoryLogger>;
  send(threadId: string, text: string, opts?: { mayCommand?: boolean }): Promise<Run>;
  decide(threadId: string, turn: CopilotTurn, decision: 'approved' | 'declined'): Promise<Run>;
  /** The thread's graph state, as the checkpointer holds it. */
  state(threadId: string): Promise<CopilotStateType>;
}

export const trailOf = (events: readonly CopilotEvent[]): string[] =>
  events.flatMap((e) => (e.t === 'step' ? [e.node] : []));

export function harness(script: Script, opts: Omit<FakeDepsOptions, 'script'> = {}): Harness {
  const fake = fakeDeps({ script, ...opts });
  const logger = memoryLogger();
  const graph = buildCopilotGraph({ ...fake.deps, log: logger });
  const record = async (go: (onEvent: (e: CopilotEvent) => void) => Promise<CopilotTurn>): Promise<Run> => {
    const events: CopilotEvent[] = [];
    const turn = await go((e) => events.push(e));
    return { turn, events, trail: trailOf(events) };
  };
  return {
    fake, graph, logger,
    send: (threadId, text, o = {}) => record((onEvent) =>
      sendMessage(graph, threadId, text, { mayCommand: o.mayCommand ?? true, onEvent })),
    decide: (threadId, turn, decision) => record((onEvent) => decide(graph, threadId, {
      decision,
      interruptId: turn.pendingPlan!.interruptId,
      planId: turn.pendingPlan!.planId,
      planHash: turn.pendingPlan!.planHash,
    }, { onEvent })),
    state: async (threadId) => (await graph.getState({ configurable: { thread_id: threadId } })).values as CopilotStateType,
  };
}

/** A data message (first user message of a role) parsed back into the JSON the model received. */
export function dataOf(params: Anthropic.MessageCreateParamsNonStreaming, index = 0): Record<string, unknown> {
  const content = params.messages[index]!.content as Anthropic.TextBlockParam[];
  const body = content[0]!.text;
  return JSON.parse(body.slice(body.indexOf('\n') + 1)) as Record<string, unknown>;
}

/** The tool results a specialist call was sent, from its last user message. */
export function toolResultsOf(params: Anthropic.MessageCreateParamsNonStreaming): Anthropic.ToolResultBlockParam[] {
  const last = params.messages.at(-1)!;
  return (Array.isArray(last.content) ? last.content : [])
    .filter((b): b is Anthropic.ToolResultBlockParam => b.type === 'tool_result');
}
