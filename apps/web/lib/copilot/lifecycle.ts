import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { Logger } from '../log.ts';
import type { ApprovalLedger } from './ledger.ts';
import { notice, type Notice, type NoticeCode } from './notices.ts';
import type { RunRegistry } from './registry.ts';
import { answerPlainText, renderAnswer } from './render.ts';
import {
  RESET, threadIdOf, type CopilotStateType, type CopilotUpdate, type DialogueEntry,
} from './state.ts';
import { localStamp } from './time.ts';
import { verifyText } from './verify.ts';

/**
 * Where a request begins and ends: `intake`, `declined`, `finish`
 * (design §3.1).
 *
 * `intake` starts every NEW message — never a resume, which re-enters at
 * `confirm`. It resets every request channel, so nothing from the previous
 * question survives into this one, and it opens the request's budget in the
 * registry: v1 counted its turn ceiling per THREAD, so a long conversation
 * eventually refused every question; here each message gets its own.
 *
 * A new message while a plan is pending sets the plan aside. LangGraph drops
 * the pending interrupt when new input arrives on the thread (e9, e10) but
 * leaves `pendingPlan` in state, so intake clears it, revokes any grant, and
 * says so: "the previous plan was set aside; nothing was issued".
 *
 * `finish` is the only predecessor of END. It records what the copilot said
 * — the VERIFIED answer as plain text, or a verified clarifying question, or
 * nothing — and closes the request in the registry. It never renders model
 * text itself beyond that; the turn projection does (session.ts).
 */

export interface IntakeDeps {
  registry: RunRegistry;
  ledger: ApprovalLedger;
  clock: () => number;
  identity: { userId: string };
  log: Logger;
}

export function makeIntake(deps: IntakeDeps) {
  const { registry, ledger, clock, identity, log } = deps;

  return (s: CopilotStateType, config: LangGraphRunnableConfig): CopilotUpdate => {
    const inbox = s.inbox;
    if (inbox === null) {
      // A new run with nothing to answer is a caller's bug, not a question.
      throw new TypeError('copilot: a new message must arrive in `inbox`');
    }
    const threadId = threadIdOf(config);
    const now = clock();
    const seq = (s.request?.seq ?? 0) + 1;

    // Any grant from an earlier request is void, whatever state says.
    ledger.revoke(threadId);
    const superseded = s.pendingPlan !== null;
    registry.begin(threadId, inbox.requestId);
    log.info('copilot.request_started', { requestId: inbox.requestId, seq, superseded });

    // Stamped in UTC here — intake does no I/O and cannot know the building's
    // zone — and re-stamped at the same instant in the building's zone by
    // orient.
    const stamp = localStamp(now, 'UTC');
    const notices: Notice[] = superseded ? [notice('plan_superseded')] : [];

    return {
      inbox: null,
      request: {
        requestId: inbox.requestId, seq, text: inbox.text, ...stamp,
        userId: identity.userId, mayCommand: inbox.mayCommand,
      },
      dialogue: [{ role: 'operator', requestId: inbox.requestId, text: inbox.text }],
      context: null,
      scope: RESET,
      plannerRoute: null,
      waves: 0,
      taskSeq: 0,
      tasks: null,
      findings: null,
      evidence: null,
      simRuns: null,
      controlTask: null,
      proposal: null,
      answer: null,
      violations: [],
      drafts: 0,
      notices: { replace: notices },
      pendingPlan: null,
      decision: null,
      outcomes: [],
      usage: null,
    };
  };
}

/** `declined`: the operator said no, or the decision did not match, or it came too late. Issues nothing. */
export function declined(s: CopilotStateType): CopilotUpdate {
  const code: NoticeCode = s.decision === 'expired' ? 'plan_expired'
    : s.decision === 'declined' ? 'plan_declined' : 'plan_stale';
  return { pendingPlan: null, decision: null, notices: [notice(code)] };
}

export function makeFinish(deps: { registry: RunRegistry }) {
  const { registry } = deps;
  return (s: CopilotStateType, config: LangGraphRunnableConfig): CopilotUpdate => {
    const threadId = threadIdOf(config);
    // Only a draft the verify node passed, re-checked by the renderer.
    const rendered = s.violations.length === 0 ? renderAnswer(s.answer, s.evidence, s.context) : null;
    const message = s.plannerRoute?.message ?? null;
    const said = rendered !== null ? answerPlainText(rendered)
      : message !== null && verifyText(message, s.context).length === 0 ? message
        : null;
    const entry: DialogueEntry = {
      role: 'copilot',
      requestId: s.request?.requestId ?? '',
      text: said,
      notices: [...new Set(s.notices.map((n) => n.code))],
      outcomes: s.outcomes,
    };
    const usage = registry.end(threadId);
    return { dialogue: [entry], usage };
  };
}

/** After orient: nothing downstream can work without the directory. */
export function afterOrient(s: CopilotStateType): 'planner' | 'finish' {
  return s.context === null || s.notices.some((n) => n.code === 'context_unavailable') ? 'finish' : 'planner';
}
