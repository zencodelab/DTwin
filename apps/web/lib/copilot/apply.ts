import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { Logger } from '../log.ts';
import type { IssueResult, Issuer } from './deps.ts';
import type { ApprovalLedger } from './ledger.ts';
import { notice } from './notices.ts';
import { threadIdOf, type CopilotStateType, type CopilotUpdate, type Outcome } from './state.ts';

/**
 * `apply`: the ONE write to the building (docs/decisions.md §63, §64).
 *
 * The only code in the copilot that holds an `Issuer`, and the only file that
 * calls `.issue(` (a source-scan test holds both). `buildCopilotGraph` passes
 * the issuer here and nowhere else.
 *
 * It does not trust graph state. Its FIRST STATEMENT takes the grant `confirm`
 * recorded after a person's resume named this plan's id and hash — consumed on
 * read, refused past its TTL — and it issues exactly the grant's frozen
 * commands, never `state.pendingPlan`'s. So:
 *
 * - a forged route into this node (a Command goto, a stray Send, an error
 *   handler) finds no grant and issues nothing;
 * - forged state (a different plan under the same id) changes nothing the
 *   grant holds;
 * - a second Approve finds the grant already taken.
 *
 * The drawn edge list (apply's only in-edge is confirm) and the source scan
 * are the first two locks; this is the one that still holds if either is
 * ever wrong.
 */

/** What a command the operator's Stop kept back is recorded as. */
const STOPPED: IssueResult = { ok: false, refusal: 'stopped', message: 'not issued: stopped by the operator' };

/**
 * `stopped` is the operator's Stop for the thread, and only that (the
 * registry's `stopRequested`): it is read before EVERY command, because the
 * commands go out one at a time — each may take the issue timeout — and a
 * Stop pressed after the first must keep the rest back, as the panel says it
 * will (review, ADR 64). Every command it keeps back is still listed, as not
 * issued.
 */
export function makeApply(issuer: Issuer, ledger: ApprovalLedger, log: Logger, stopped: (threadId: string) => boolean) {
  return async (s: CopilotStateType, config: LangGraphRunnableConfig): Promise<CopilotUpdate> => {
    const grant = ledger.take(threadIdOf(config));
    if (!grant || grant.planId !== s.pendingPlan?.planId) {
      log.error('copilot.apply_refused', { hasGrant: Boolean(grant) });
      return { pendingPlan: null, decision: null, notices: [notice('apply_refused')] };
    }

    const threadId = threadIdOf(config);
    const outcomes: Outcome[] = [];
    let halted = false;
    // Sequential, in plan order, and ONLY the frozen copy.
    for (const c of grant.commands) {
      halted ||= stopped(threadId);
      if (halted) {
        outcomes.push({ zoneName: c.zoneName, setpointTempC: c.setpointTempC, result: STOPPED });
        continue;
      }
      let result: IssueResult;
      try {
        result = await issuer.issue({
          zoneId: c.zoneId,
          setpointTempC: c.setpointTempC,
          durationS: c.durationS ?? undefined,
          // Attributed to the person who approved it (ingest records the
          // acting user) and marked as copilot-proposed, so the audit trail
          // says both.
          reason: `copilot (operator-approved): ${c.reason}`,
        });
      } catch {
        result = { ok: false, refusal: 'transport', message: 'control service unreachable' };
      }
      outcomes.push({ zoneName: c.zoneName, setpointTempC: c.setpointTempC, result });
    }

    const ok = outcomes.filter((o) => o.result.ok).length;
    log.info('copilot.apply_issued', { commands: outcomes.length, ok, refused: outcomes.length - ok, stopped: halted });
    return { outcomes, pendingPlan: null, decision: null, ...(halted ? { notices: [notice('stopped')] } : {}) };
  };
}
