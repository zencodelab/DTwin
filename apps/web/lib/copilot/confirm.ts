import { interrupt, type LangGraphRunnableConfig } from '@langchain/langgraph';
import { z } from 'zod';
import { hashCommands, type ApprovalLedger } from './ledger.ts';
import { threadIdOf, type CopilotStateType, type CopilotUpdate, type ReviewedPlan } from './state.ts';

/**
 * `confirm`: the person, as a node (docs/decisions.md §63, §64).
 *
 * THE ONLY `interrupt(` IN THE COPILOT, and it is this function's FIRST
 * STATEMENT. A node whose first statement is `interrupt()` pauses however it
 * is entered — by its drawn edge, or by any route the edge list cannot show
 * (fact 9) — so there is no way through this node that does not stop for a
 * person. On resume the node runs again from the top and `interrupt()`
 * returns the resume value instead of pausing.
 *
 * What comes back is judged strictly. The resume must parse, and must name
 * THIS plan's id and hash; the plan's commands must still hash to that hash;
 * and the plan must not have expired. Only then, and only for `approved`, is
 * the plan GRANTED into the ledger — a frozen copy held outside graph state,
 * which is the one thing `apply` will issue. Anything else is `stale` or
 * `expired`, and nothing is granted.
 */

export const ResumeValue = z.object({
  decision: z.enum(['approved', 'declined']),
  planId: z.string().uuid(),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type ResumeValue = z.infer<typeof ResumeValue>;

export function makeConfirm(ledger: ApprovalLedger, clock: () => number) {
  return (s: CopilotStateType, config: LangGraphRunnableConfig): CopilotUpdate => {
    const resume = interrupt<ReviewedPlan | null, unknown>(s.pendingPlan);
    const plan = s.pendingPlan;
    const v = ResumeValue.safeParse(resume);
    if (!plan || !v.success || v.data.planId !== plan.planId || v.data.planHash !== plan.planHash
      || hashCommands(plan.commands) !== plan.planHash) {
      return { decision: 'stale' };
    }
    if (Date.parse(plan.expiresAt) <= clock()) return { decision: 'expired' };
    if (v.data.decision === 'approved') {
      // The ledger re-hashes what it keeps and refuses a mismatch, so what it
      // holds is provably the plan whose hash the person approved.
      if (!ledger.grant(threadIdOf(config), plan)) return { decision: 'stale' };
    }
    return { decision: v.data.decision };
  };
}
