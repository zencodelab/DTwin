import {
  COPILOT_NODES, CopilotEvent, type CopilotNode,
} from './protocol.ts';
import { TOOL_CLASS } from './tools/index.ts';
import { verifyText } from './verify.ts';

/**
 * From LangGraph's stream to the panel's events (docs/decisions.md §64,
 * design §9.2). Pure: one chunk in, zero or more events out, no clock, no I/O.
 *
 * A WHITELIST, not a filter. The graph's stream carries everything a node
 * wrote — whole state updates, a specialist's transcript inside its
 * namespace, tool bodies, the full plan in an interrupt, and, if a node ever
 * threw, an error whose message can name a key prefix or a request id. None
 * of that is forwarded. Each event is BUILT here, field by field, from the
 * few values the panel may see, and then parsed through its protocol schema;
 * a value the schema refuses drops the event. An unknown mode, an unknown
 * event name, an inner node's update: nothing comes out.
 *
 * What does come out:
 *
 * - `step` when a top-level node finishes (the `updates` chunk at the root
 *   namespace; inner specialist steps are not shown);
 * - `plan` from the interrupt, carrying only what a decision must name;
 * - `task`, `activity`, `evidence` and `sim` from the nodes' custom writer
 *   events, each rebuilt from its own fields. A task's goal is planner text,
 *   so it is shown only if it passes the verifier's wording rules — the
 *   strictest reading, since the projector has no context to relax them.
 */

/** `[namespace, mode, payload]`, as `graph.stream(…, {subgraphs: true, streamMode: [...]})` yields. */
export type StreamChunk = readonly [namespace: readonly string[], mode: string, payload: unknown];

const NODES: ReadonlySet<string> = new Set(COPILOT_NODES);
const TOOLS: ReadonlySet<string> = new Set(Object.keys(TOOL_CLASS));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An event only if it parses. The schema is the whitelist; this is where it is applied. */
function event(candidate: unknown): CopilotEvent[] {
  const parsed = CopilotEvent.safeParse(candidate);
  return parsed.success ? [parsed.data] : [];
}

/** Planner text shown only when it states no unverified figure and no banned word. */
function cleanGoal(goal: unknown): string | null {
  return typeof goal === 'string' && goal.trim() !== '' && verifyText(goal, null).length === 0 ? goal : null;
}

const clip = (v: unknown, max: number): unknown => (typeof v === 'string' && v.length > max ? `${v.slice(0, max - 1)}…` : v);

export function projectChunk(chunk: unknown): CopilotEvent[] {
  if (!Array.isArray(chunk) || chunk.length !== 3) return [];
  const [namespace, mode, payload] = chunk as [unknown, unknown, unknown];
  if (!Array.isArray(namespace) || !isRecord(payload)) return [];

  if (mode === 'updates') {
    // Only the root graph's steps. Inside a specialist's namespace the
    // updates are its private transcript.
    if (namespace.length !== 0) return [];
    const out: CopilotEvent[] = [];
    for (const key of Object.keys(payload)) {
      if (key === '__interrupt__') out.push(...planEvents(payload[key]));
      else if (NODES.has(key)) out.push(...event({ t: 'step', node: key as CopilotNode }));
    }
    return out;
  }

  if (mode === 'custom') return customEvent(payload);
  return [];
}

/** The pending plan's identity, never its commands: the turn carries the reviewed plan. */
function planEvents(interrupts: unknown): CopilotEvent[] {
  if (!Array.isArray(interrupts)) return [];
  return interrupts.flatMap((i: unknown) => {
    if (!isRecord(i) || !isRecord(i.value)) return [];
    const v = i.value;
    return event({ t: 'plan', interruptId: i.id, planId: v.planId, planHash: v.planHash, expiresAt: v.expiresAt });
  });
}

function customEvent(p: Record<string, unknown>): CopilotEvent[] {
  switch (p.event) {
    case 'copilot.task':
      return event({
        t: 'task', taskId: p.taskId, specialist: p.specialist,
        goal: p.status === 'running' ? cleanGoal(p.goal) : null, status: p.status,
      });
    case 'copilot.activity':
      return event({
        t: 'activity', taskId: p.taskId,
        // The name is the model's; only a name the tools module knows is repeated.
        tool: typeof p.tool === 'string' && TOOLS.has(p.tool) ? p.tool : 'unknown',
        label: clip(p.label, 200),
      });
    case 'copilot.evidence':
      return event({
        t: 'evidence', id: p.id, taskId: p.taskId, tool: p.tool, source: p.source, kind: p.kind,
        label: clip(p.label, 300), window: p.window, coverage: p.coverage,
        flaggedExcluded_count: p.flaggedExcluded_count, truncated: p.truncated,
      });
    case 'copilot.sim':
      return event({
        t: 'sim', taskId: p.taskId, runId: p.runId, role: p.role, scenario: p.scenario,
        status: p.status, progressPct: p.progressPct,
      });
    default:
      return [];
  }
}
