import type Anthropic from '@anthropic-ai/sdk';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { z } from 'zod';
import type { Logger } from '../log.ts';
import { EvidenceId } from './evidence.ts';
import type { Limits } from './limits.ts';
import { errorName, parseReply, stableTextBlock, systemBlocks, transcriptCache, type Models } from './model.ts';
import { notice, type Notice } from './notices.ts';
import { DATA_PREAMBLE, PLANNER_SYSTEM, simulateTasks } from './prompts.ts';
import { BudgetError, type BudgetReason, type ModelCaller, type RunRegistry } from './registry.ts';
import {
  SPECIALIST_NODES, threadIdOf, type ControlTask, type CopilotStateType, type CopilotUpdate, type PlannerRoute,
  type Scope, type SpecialistNode, type TaskSpec,
} from './state.ts';
import { availableSpecialists } from './tools/index.ts';
import { verifyText } from './verify.ts';

/**
 * `planner`: decides how a question is answered, one wave at a time
 * (docs/decisions.md §64, design §3.1).
 *
 * It never answers and never sees a tool. Each execution reads the question,
 * the directory and what earlier waves found, and returns a DECISION — tasks
 * to fan out, compose, hand to the controller, or finish with a clarifying
 * question. The decision is structured output parsed by Zod, then held to
 * `validatePlan`'s rules; one repair call may fix a refused decision, after
 * which the fallback applies. Task ids (T1…T8) are assigned here, in code.
 *
 * AUTHORITY IS FIXED BEFORE DATA (P14). The first decision of a request —
 * made before any specialist has read anything — sets `scope`: whether this
 * request may control, whether it may simulate. The channel is write-once,
 * so a later decision, made after tool results that could carry injected
 * text, cannot widen it. A controlTask also needs the ROUTE's word that the
 * person may command (`request.mayCommand`); without it the task is dropped
 * with a notice, never an error the model could argue with.
 *
 * Bounds are checked BEFORE a call is spent: past MAX_WAVES, past the
 * request's budget or deadline, or after Stop, the planner makes no call and
 * moves on — to compose if anything was found, else to finish.
 */

export const PLANNER_INTENTS = ['diagnose', 'analyse', 'whatif', 'control', 'compound', 'clarify', 'out_of_scope'] as const;
export const PLANNER_NEXT = ['dispatch', 'compose', 'control', 'finish'] as const;

const Instant = z.string().datetime({ offset: true, message: 'a timestamp with its offset, e.g. 2026-09-28T09:00:00+04:00' });

/** The planner's decision. Bounds live here, not in the JSON schema below. */
export const PlannerDecision = z.object({
  intent: z.enum(PLANNER_INTENTS),
  interpretation: z.string().max(400),
  allowControl: z.boolean(),
  allowSimulation: z.boolean(),
  next: z.enum(PLANNER_NEXT),
  tasks: z.array(z.object({
    specialist: z.enum(SPECIALIST_NODES),
    goal: z.string().min(3).max(600),
    zoneIds: z.array(z.string().uuid()).max(24),
    from: Instant.nullable(),
    to: Instant.nullable(),
    inputEvidenceIds: z.array(EvidenceId).max(6),
  })).max(4),
  controlTask: z.object({
    mode: z.enum(['propose', 'check']),
    brief: z.string().min(3).max(600),
    inputEvidenceIds: z.array(EvidenceId).max(6),
  }).nullable(),
  message: z.string().max(600).nullable(),
});
export type PlannerDecision = z.infer<typeof PlannerDecision>;

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });
const stringArray = { type: 'array', items: { type: 'string' } };

/**
 * The structured-output twin of `PlannerDecision`. Only `type`, `enum`,
 * `anyOf`, `required`, `properties`, `items` and `additionalProperties:false`:
 * the API refuses minimum, maxLength and friends, so every bound is Zod's.
 */
export const PLANNER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'interpretation', 'allowControl', 'allowSimulation', 'next', 'tasks', 'controlTask', 'message'],
  properties: {
    intent: { type: 'string', enum: [...PLANNER_INTENTS] },
    interpretation: { type: 'string' },
    allowControl: { type: 'boolean' },
    allowSimulation: { type: 'boolean' },
    next: { type: 'string', enum: [...PLANNER_NEXT] },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['specialist', 'goal', 'zoneIds', 'from', 'to', 'inputEvidenceIds'],
        properties: {
          specialist: { type: 'string', enum: [...SPECIALIST_NODES] },
          goal: { type: 'string' },
          zoneIds: stringArray,
          from: nullable({ type: 'string' }),
          to: nullable({ type: 'string' }),
          inputEvidenceIds: stringArray,
        },
      },
    },
    controlTask: nullable({
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'brief', 'inputEvidenceIds'],
      properties: {
        mode: { type: 'string', enum: ['propose', 'check'] },
        brief: { type: 'string' },
        inputEvidenceIds: stringArray,
      },
    }),
    message: nullable({ type: 'string' }),
  },
} as const;

// ================================================================ validation

export interface PlanValidation {
  /** Named errors; any one refuses the decision (one repair, then the fallback). */
  errors: string[];
  /** A controlTask this request may not have: dropped with notice `control_not_permitted`, not an error. */
  dropControl: boolean;
}

/**
 * Hold a parsed decision to the rules the schema cannot say (design §4).
 * `scope` is the request's EFFECTIVE authority: the held scope, or — on the
 * first execution, before it is written — the first decision's own flags.
 */
export function validatePlan(
  d: PlannerDecision,
  s: Pick<CopilotStateType, 'tasks' | 'taskSeq' | 'evidence' | 'context' | 'request' | 'controlTask'>,
  opts: { limits: Readonly<Limits>; scope: Pick<Scope, 'allowControl' | 'allowSimulation'> },
): PlanValidation {
  const { limits, scope } = opts;
  const errors: string[] = [];
  const directory = new Set((s.context?.directory ?? []).map((z) => z.id));
  const offered = new Set<string>(s.context ? availableSpecialists(s.context) : []);

  if (d.next === 'dispatch') {
    if (d.tasks.length < 1 || d.tasks.length > limits.maxTasksPerWave) {
      errors.push(`next "dispatch" needs 1 to ${limits.maxTasksPerWave} tasks, got ${d.tasks.length}`);
    }
  } else if (d.tasks.length > 0) {
    errors.push(`tasks are dispatched only with next "dispatch", not "${d.next}"; send an empty list`);
  }

  const soFar = Object.keys(s.tasks).length;
  if (soFar + d.tasks.length > limits.maxTasksPerRequest) {
    errors.push(`a request runs at most ${limits.maxTasksPerRequest} tasks; ${soFar} have run, so at most ` +
      `${Math.max(0, limits.maxTasksPerRequest - soFar)} more`);
  }

  const simulate = d.tasks.filter((t) => t.specialist === 'simulate').length;
  if (simulate > 0) {
    const simSoFar = Object.values(s.tasks).filter((t) => t.specialist === 'simulate').length;
    if (!offered.has('simulate')) {
      errors.push('simulate is not available for this request; use diagnose or analyse, or say it cannot be simulated');
    } else if (!scope.allowSimulation) {
      errors.push('this request did not ask for a simulation (allowSimulation was false on the first decision)');
    }
    if (simSoFar + simulate > limits.maxSimulateTasksPerRequest) {
      errors.push(`a request runs at most ${simulateTasks(limits.maxSimulateTasksPerRequest)} ` +
        '(its one simulation call runs the baseline and every scenario together; put them in one task)');
    }
  }

  d.tasks.forEach((t, i) => {
    for (const id of t.zoneIds) {
      if (!directory.has(id)) errors.push(`tasks[${i}]: zone ${JSON.stringify(id)} is not in the directory`);
    }
    for (const id of t.inputEvidenceIds) {
      if (!Object.hasOwn(s.evidence, id)) errors.push(`tasks[${i}]: evidence ${id} does not exist`);
    }
  });

  let dropControl = false;
  if (d.controlTask !== null) {
    if (!(scope.allowControl && s.request?.mayCommand === true)) {
      dropControl = true;
    } else if (s.controlTask !== null) {
      errors.push('a controlTask was already given for this request; send null');
    } else {
      for (const id of d.controlTask.inputEvidenceIds) {
        if (!Object.hasOwn(s.evidence, id)) errors.push(`controlTask: evidence ${id} does not exist`);
      }
    }
  }
  if (d.next === 'control' && d.controlTask === null && s.controlTask === null) {
    errors.push('next "control" needs a controlTask');
  }

  const talking = d.next === 'finish' && (d.intent === 'clarify' || d.intent === 'out_of_scope');
  if (talking && d.message === null) errors.push('next "finish" with clarify or out_of_scope needs a message');
  if (!talking && d.message !== null) errors.push('message is only for next "finish" with clarify or out_of_scope; send null');
  if (d.next === 'finish' && !talking) errors.push('next "finish" is only for clarify or out_of_scope; to answer, choose compose');

  return { errors, dropControl };
}

// ===================================================================== node

export interface PlannerDeps {
  registry: RunRegistry;
  callModel: ModelCaller;
  models: Models;
  limits: Readonly<Limits>;
  log: Logger;
}

const REASON_NOTICE: Readonly<Record<BudgetReason, (l: Readonly<Limits>) => Notice>> = {
  budget: (l) => notice('budget', { calls: l.maxModelCalls }),
  deadline: (l) => notice('deadline', { seconds: l.deadlineS }),
  stopped: () => notice('stopped'),
};

/** The notice for a request that ran out: its budget, its deadline, or the operator's Stop. */
export function budgetNotice(reason: BudgetReason, limits: Readonly<Limits>): Notice {
  return REASON_NOTICE[reason](limits);
}

export function makePlanner(deps: PlannerDeps) {
  const { registry, callModel, models, limits, log } = deps;

  return async (s: CopilotStateType, config: LangGraphRunnableConfig): Promise<CopilotUpdate> => {
    const threadId = threadIdOf(config);
    const hasFindings = Object.keys(s.findings).length > 0;
    const onward: PlannerRoute['next'] = hasFindings ? 'compose' : 'finish';
    const moveOn = (notices: Notice[]): CopilotUpdate => ({
      plannerRoute: { next: onward, taskIds: [], interpretation: s.plannerRoute?.interpretation ?? null, message: null },
      notices,
    });

    if (s.context === null || s.request === null) return moveOn([]);
    if (s.waves >= limits.maxWaves) return moveOn([notice('wave_limit', { waves: s.waves })]);
    const refusal = registry.refusal(threadId);
    if (refusal !== null) {
      if (refusal === 'budget') log.warn('copilot.budget_exhausted', { role: 'planner' });
      return moveOn([budgetNotice(refusal, limits)]);
    }

    const fallback = (reason: string, first: FirstFlags | null): CopilotUpdate => {
      // v1 behaviour when the planner cannot plan: the operator's words go to
      // the controller as they stand — but only as the request's first step,
      // only for someone who may command, and never against a first decision
      // that said this request does not control.
      const control = s.request!.mayCommand && s.waves === 0 && !hasFindings && s.controlTask === null
        && (s.scope === null ? first?.allowControl !== false : s.scope.allowControl);
      log.warn('copilot.planner_fallback', { reason, route: control ? 'control' : onward });
      if (control) {
        return {
          scope: { allowControl: true, allowSimulation: false, source: 'fallback' },
          controlTask: { mode: 'propose', brief: s.request!.text, inputEvidenceIds: [], status: 'pending' },
          plannerRoute: { next: 'control', taskIds: [], interpretation: null, message: null },
        };
      }
      return moveOn([notice('planner_unavailable')]);
    };

    let first: FirstFlags | null = null;
    let repair: Repair | null = null;
    for (let attempt = 0; attempt <= limits.maxPlannerRepairs; attempt += 1) {
      let reply: Anthropic.Message;
      try {
        reply = await registry.call(threadId, 'planner', callModel, plannerParams(s, models, limits, repair));
      } catch (err) {
        if (err instanceof BudgetError) {
          if (err.reason === 'budget') log.warn('copilot.budget_exhausted', { role: 'planner' });
          return moveOn([budgetNotice(err.reason, limits)]);
        }
        return fallback(`model_error:${errorName(err)}`, first);
      }
      if (reply.stop_reason === 'refusal') {
        // Nothing in a refused reply is acted on (§63).
        return {
          plannerRoute: { next: 'finish', taskIds: [], interpretation: null, message: null },
          notices: [notice('model_refused')],
        };
      }

      const parsed = parseReply(reply, PlannerDecision);
      if (!parsed.ok) {
        repair = { previous: parsed.text, issues: parsed.issues };
        continue;
      }
      const d = parsed.value;
      if (s.scope === null && first === null) first = { allowControl: d.allowControl, allowSimulation: d.allowSimulation };
      const scope = s.scope ?? first!;
      const v = validatePlan(d, s, { limits, scope });
      if (v.errors.length > 0) {
        repair = { previous: parsed.text, issues: v.errors };
        continue;
      }
      return accept(s, d, v, first, config, onward);
    }
    return fallback('invalid_decision', first);
  };
}

type FirstFlags = Pick<Scope, 'allowControl' | 'allowSimulation'>;
interface Repair { previous: string; issues: string[] }

function accept(
  s: CopilotStateType,
  d: PlannerDecision,
  v: PlanValidation,
  first: FirstFlags | null,
  config: LangGraphRunnableConfig,
  onward: PlannerRoute['next'],
): CopilotUpdate {
  const notices: Notice[] = [];
  const update: CopilotUpdate = {};
  if (s.scope === null && first !== null) update.scope = { ...first, source: 'planner' };

  let next: PlannerRoute['next'] = d.next;
  if (d.controlTask !== null) {
    if (v.dropControl) {
      notices.push(notice('control_not_permitted'));
      if (next === 'control' && s.controlTask === null) next = onward;
    } else {
      update.controlTask = {
        mode: d.controlTask.mode, brief: d.controlTask.brief,
        inputEvidenceIds: d.controlTask.inputEvidenceIds, status: 'pending',
      } satisfies ControlTask;
    }
  }

  // What the operator will read is held to the verifier's wording rules. A
  // clarifying question that states a figure is not shown; the notice says so.
  let message = d.message;
  if (message !== null && verifyText(message, s.context).length > 0) {
    message = null;
    notices.push(notice('message_unverified'));
  }

  const taskIds: string[] = [];
  if (next === 'dispatch') {
    const wave = s.waves + 1;
    const tasks: Record<string, TaskSpec> = {};
    d.tasks.forEach((t, i) => {
      const taskId = `T${s.taskSeq + i + 1}`;
      taskIds.push(taskId);
      tasks[taskId] = {
        taskId, specialist: t.specialist as SpecialistNode, goal: t.goal, zoneIds: t.zoneIds,
        from: t.from, to: t.to, inputEvidenceIds: t.inputEvidenceIds, wave, status: 'running',
      };
      config.writer?.({ event: 'copilot.task', taskId, specialist: t.specialist, goal: t.goal, status: 'running' });
    });
    update.tasks = tasks;
    update.waves = wave;
    update.taskSeq = s.taskSeq + d.tasks.length;
  }

  update.plannerRoute = {
    next, taskIds, interpretation: d.interpretation.trim() === '' ? null : d.interpretation, message,
  };
  if (notices.length > 0) update.notices = notices;
  return update;
}

// ================================================================== request

function plannerParams(
  s: CopilotStateType, models: Models, limits: Readonly<Limits>, repair: Repair | null,
): Anthropic.MessageCreateParamsNonStreaming {
  const { context, progress } = plannerInput(s, limits);
  // The request's context ends in a breakpoint of its own: every decision of
  // the request re-sends it unchanged, ahead of a progress block that each
  // wave changes, so the second and third decisions read it (model.ts).
  const opening: Anthropic.TextBlockParam[] = [
    stableTextBlock(`${DATA_PREAMBLE}\n${JSON.stringify(context)}`),
    { type: 'text', text: `${DATA_PREAMBLE}\n${JSON.stringify(progress)}` },
  ];
  const refused: Anthropic.TextBlockParam = {
    type: 'text',
    text: `[system] That decision was not accepted. The issues follow as JSON data; answer again with a ` +
      `corrected decision.\n${JSON.stringify({ issues: repair?.issues ?? [] })}`,
  };
  // A repair re-sends the refused call's request unchanged and appends to it,
  // so automatic caching reads the whole of it.
  const messages: Anthropic.MessageParam[] = repair === null
    ? [{ role: 'user', content: opening }]
    : repair.previous.trim() !== ''
      ? [
        { role: 'user', content: opening },
        { role: 'assistant', content: [{ type: 'text', text: repair.previous }] },
        { role: 'user', content: [refused] },
      ]
      : [{ role: 'user', content: [...opening, refused] }];
  return {
    model: models.lead,
    max_tokens: limits.maxTokens,
    system: systemBlocks(PLANNER_SYSTEM),
    messages,
    cache_control: transcriptCache(),
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: PLANNER_JSON_SCHEMA as unknown as Record<string, unknown> } },
  };
}

/**
 * What the planner reads, in two parts. CONTEXT is fixed for the whole
 * request — the question, the building, what exists here and what may be
 * run — and PROGRESS is what the request has done so far, which every wave
 * changes. They are two blocks so that the context is a prefix the request's
 * later decisions can read from the cache; keep anything that changes
 * between decisions out of it, or no later decision reads it.
 */
function plannerInput(s: CopilotStateType, limits: Readonly<Limits>) {
  const request = s.request!;
  const context = s.context!;
  const tasksSoFar = Object.keys(s.tasks).length;
  const simSoFar = Object.values(s.tasks).filter((t) => t.specialist === 'simulate').length;
  return {
    context: {
      request: {
        text: request.text, nowIso: request.nowIso, timezone: request.timezone, localDate: request.localDate,
        weekday: request.weekday, mayCommand: request.mayCommand,
      },
      earlierConversation: s.dialogue.filter((e) => e.requestId !== request.requestId).slice(-limits.dialogueTail),
      building: { name: context.building.name, timezone: context.building.timezone },
      directory: context.directory,
      availability: context.availability,
      envelope: context.envelope,
      specialists: availableSpecialists(context),
      simulation: context.sim,
    },
    progress: {
      scope: s.scope === null ? null : { allowControl: s.scope.allowControl, allowSimulation: s.scope.allowSimulation },
      remaining: {
        waves: limits.maxWaves - s.waves,
        tasksThisWave: limits.maxTasksPerWave,
        tasksThisRequest: Math.max(0, limits.maxTasksPerRequest - tasksSoFar),
        simulateTasks: Math.max(0, limits.maxSimulateTasksPerRequest - simSoFar),
      },
      tasks: Object.values(s.tasks).map((t) => ({ taskId: t.taskId, specialist: t.specialist, goal: t.goal, wave: t.wave, status: t.status })),
      findings: Object.values(s.findings),
      evidence: Object.values(s.evidence).map((e) => ({ id: e.id, tool: e.tool, kind: e.kind, label: e.label, caveats: e.caveats })),
      controlTask: s.controlTask,
    },
  };
}
