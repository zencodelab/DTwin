import { Send } from '@langchain/langgraph';
import type { EvidenceRecord } from './evidence.ts';
import {
  SPECIALIST_NODES, type CopilotStateType, type CopilotUpdate, type SpecialistNode, type SpecialistTask,
  type TaskSpec,
} from './state.ts';

/**
 * The fan-out after the planner, and the fan-in after the specialists
 * (docs/decisions.md §64, design §3.3).
 *
 * THE ONLY `new Send(` IN THE COPILOT (a source-scan test holds it here). A
 * Send is the one way a router can reach a node its path list does not
 * draw — verified in e2b — so keeping every Send in one function, whose
 * targets are typed to the three specialists (none of which can write to the
 * building), is what lets the drawn edge list stay the whole truth about the
 * graph.
 *
 * `afterPlanner` NEVER returns an empty array. An empty Send list is not "no
 * work": LangGraph skips the join and ends the run silently (fact 3), which
 * would drop the operator's question on the floor. So an empty dispatch
 * becomes `compose` when anything was found, else `finish`.
 */

export { SPECIALIST_NODES, type SpecialistNode };

export type AfterPlanner = Send<SpecialistNode, { task: SpecialistTask }>[] | 'compose' | 'control' | 'finish';

/** The planner's path list, verbatim: what `getGraphAsync()` draws out of it. */
export const PLANNER_TARGETS = ['diagnose', 'analyse', 'simulate', 'compose', 'control', 'finish'] as const;

const isSpecialist = (n: unknown): n is SpecialistNode =>
  typeof n === 'string' && (SPECIALIST_NODES as readonly string[]).includes(n);

export function afterPlanner(s: CopilotStateType): AfterPlanner {
  const hasFindings = Object.keys(s.findings ?? {}).length > 0;
  const onward = hasFindings ? 'compose' : 'finish';
  const route = s.plannerRoute;
  if (!route) return onward;

  switch (route.next) {
    case 'dispatch': {
      if (s.context === null || s.request === null) return onward;
      const sends: Send<SpecialistNode, { task: SpecialistTask }>[] = [];
      for (const taskId of route.taskIds ?? []) {
        const t = s.tasks?.[taskId];
        if (!t || t.status !== 'running' || !isSpecialist(t.specialist)) continue;
        sends.push(new Send(t.specialist, { task: specialistTask(s, t) }));
      }
      return sends.length > 0 ? sends : onward;
    }
    case 'control': {
      // The controller runs FIRST only when nothing has been found: once there
      // are findings, the answer is composed and the controller follows it.
      if (hasFindings) return 'compose';
      const allowed = s.controlTask?.status === 'pending' && s.scope?.allowControl === true
        && s.request?.mayCommand === true;
      return allowed ? 'control' : onward;
    }
    case 'compose':
      return 'compose';
    default:
      return 'finish';
  }
}

/**
 * Everything a specialist starts from — and all it will see, since a Send
 * worker gets its payload and not the graph state. `inputs` are copies of
 * the earlier evidence the planner named, at most 6.
 */
export function specialistTask(s: CopilotStateType, t: TaskSpec): SpecialistTask {
  const context = s.context!;
  const inputs: EvidenceRecord[] = t.inputEvidenceIds
    .filter((id) => Object.hasOwn(s.evidence ?? {}, id))
    .slice(0, 6)
    .map((id) => s.evidence[id]!);
  return {
    taskId: t.taskId,
    specialist: t.specialist,
    goal: t.goal,
    zoneIds: t.zoneIds,
    from: t.from,
    to: t.to,
    inputs,
    request: s.request!,
    building: { id: context.building.id, name: context.building.name, timezone: context.building.timezone },
    directory: context.directory,
    availability: context.availability,
    envelope: context.envelope,
    simAvailable: context.sim.available,
  };
}

/**
 * `join` ({defer: true}): runs once per wave, after every specialist of the
 * wave has finished, however long each took (fact 2). It folds each finished
 * task's status into `tasks`; the planner then reads the wave's findings.
 */
export function join(s: CopilotStateType): CopilotUpdate {
  const done: Record<string, TaskSpec> = {};
  for (const [taskId, t] of Object.entries(s.tasks)) {
    if (t.status === 'running' && Object.hasOwn(s.findings, taskId)) done[taskId] = { ...t, status: 'done' };
  }
  return { tasks: done };
}
