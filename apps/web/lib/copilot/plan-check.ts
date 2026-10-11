import { randomUUID } from 'node:crypto';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { z } from 'zod';
import type { Logger } from '../log.ts';
import type { ControlProbe, DryRunResult } from './deps.ts';
import type { EvidenceRecord } from './evidence.ts';
import { hashCommands } from './ledger.ts';
import type { Limits } from './limits.ts';
import { errorName } from './model.ts';
import { notice } from './notices.ts';
import { budgetNotice } from './planner.ts';
import type { BudgetReason } from './registry.ts';
import {
  threadIdOf, type CopilotStateType, type CopilotUpdate, type ReviewedCommand, type ReviewedPlan, type SimulationMatch,
} from './state.ts';
import { ProposedPlanWithBasis } from './tools/index.ts';
import { verifyText } from './verify.ts';

/**
 * `plan_check`: the last look before a person is asked (design §3.1, §5.5).
 *
 * The controller's `propose_plan` already dry-ran every command. This node
 * does it AGAIN, now, because what the operator approves must carry verdicts
 * from the moment they are shown — and because nothing a subgraph wrote is
 * trusted here: the proposal is re-parsed, bounded, checked against the
 * directory and the request's authority, and held to the verifier's wording
 * rules as if it had never been checked before.
 *
 * Any refusal ends the request with notice `plan_refused`, naming the zone
 * and the envelope's own message. The operator never sees a plan with a
 * command in it that cannot be applied.
 *
 * Nor one they asked to stop. The operator's Stop and the request's deadline
 * are read from the run registry BEFORE the dry runs and again AFTER them —
 * Stop can land while they are in flight, and a plan checked for a request
 * the operator abandoned must not then ask them to approve it. Either way the
 * request ends with notice `stopped` or `deadline`, and nothing reaches
 * `confirm`. (The controller drops its own proposal on Stop too; this is the
 * gap between its finish and this node.)
 *
 * A plan that passes gets an identity — a fresh `planId`, the hash of exactly
 * what would be sent (each duration included, the tenant default resolved to
 * the one shown), the time it was checked, and the time it expires. The
 * operator's decision must name both id and hash, and `confirm` re-hashes the
 * plan before granting it, so a plan that changed after it was shown cannot
 * be approved.
 */

export interface PlanCheckDeps {
  probe: ControlProbe;
  limits: Readonly<Limits>;
  clock: () => number;
  log: Logger;
  /** The registry's Stop-or-deadline for a thread (`RunRegistry.interrupted`); null while the request may go on. */
  interrupted: (threadId: string) => BudgetReason | null;
}

/** The slice of a simulate_scenarios record plan_check reads. Parse at the boundary. */
const SimulatedScenarios = z.object({
  zone_ids: z.array(z.string()),
  scenarios: z.array(z.object({ name: z.string(), setpoint_delta_k: z.number() })),
});

/** Designed setpoint + shift, within this tolerance, counts as the simulated setpoint. */
const SETPOINT_TOLERANCE_K = 0.05;

export function makePlanCheck(deps: PlanCheckDeps) {
  const { probe, limits, clock, log, interrupted } = deps;

  return async (s: CopilotStateType, config: LangGraphRunnableConfig): Promise<CopilotUpdate> => {
    const refuse = (zone: string, message: string): CopilotUpdate => ({
      pendingPlan: null,
      notices: [notice('plan_refused', { zone, message })],
    });
    const threadId = threadIdOf(config);
    const halted = (): CopilotUpdate | null => {
      const why = interrupted(threadId);
      return why === null ? null : { pendingPlan: null, notices: [budgetNotice(why, limits)] };
    };

    const before = halted();
    if (before) return before;

    // Authority first: the scope fixed before any data, and the route's word
    // that this person may command. Neither is a model's to give.
    if (!(s.scope?.allowControl === true && s.request?.mayCommand === true)) {
      return { pendingPlan: null, notices: [notice('control_not_permitted')] };
    }

    const parsed = ProposedPlanWithBasis.safeParse(s.proposal);
    if (!parsed.success) return refuse('the plan', 'it is not a well-formed plan');
    const plan = parsed.data;
    if (plan.commands.length > limits.maxPlanCommands) {
      return refuse('the plan', `it has more than ${limits.maxPlanCommands} commands`);
    }

    const directory = new Map((s.context?.directory ?? []).map((z) => [z.id, z]));
    const seen = new Set<string>();
    for (const c of plan.commands) {
      const zone = directory.get(c.zoneId);
      if (!zone) return refuse('the plan', 'it names a zone that is not in the directory');
      if (seen.has(c.zoneId)) return refuse(zone.name, 'the zone appears twice');
      seen.add(c.zoneId);
    }

    if (verifyText(plan.summary, s.context).length > 0) {
      return refuse('the plan', 'its summary states a figure or a word the copilot may not use');
    }
    for (const c of plan.commands) {
      if (verifyText(c.reason, s.context).length > 0) {
        return refuse(directory.get(c.zoneId)!.name, 'its reason states a figure or a word the copilot may not use');
      }
    }

    // Every command, dry-run again, now. Sequential: the envelope's interval
    // rule reads recent commands, and these are asked in the order they would
    // be issued.
    const commands: ReviewedCommand[] = [];
    for (const c of plan.commands) {
      const zoneName = directory.get(c.zoneId)!.name;
      let verdict: DryRunResult;
      try {
        verdict = await probe.dryRun(c);
      } catch (err) {
        log.warn('copilot.plan_check_unreachable', { error: errorName(err) });
        return { pendingPlan: null, notices: [notice('control_unavailable')] };
      }
      if (!verdict.allowed) return refuse(zoneName, verdict.message);
      // A command that left its duration to the tenant default is pinned to
      // the default the envelope resolved NOW — the minutes on the card. Left
      // open, the plan's hash bound "no duration", and ingest resolved the
      // default again at issue time: an admin who changed it in between gave
      // the building a duration nobody approved (review, ADR 64). Pinned, the
      // hash, the grant and the issued command all carry what was shown, and
      // the envelope judges that duration again when it is issued.
      commands.push({ ...c, durationS: c.durationS ?? verdict.durationS, zoneName, verdict });
    }

    // Stop pressed, or the deadline passed, while the dry runs were out.
    const after = halted();
    if (after) return after;

    const now = clock();
    const pendingPlan: ReviewedPlan = {
      planId: randomUUID(),
      planHash: hashCommands(commands),
      checkedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + limits.planTtlS * 1000).toISOString(),
      summary: plan.summary,
      commands,
      simulation: plan.basis === null ? null : simulationMatch(plan.basis, commands, s),
    };
    return { pendingPlan };
  };
}

/**
 * How the plan relates to the simulation it names (§5.5): its zones among
 * the simulated ones, and each setpoint equal to the zone's designed setpoint
 * plus the scenario's shift. Null when the basis does not name a simulated
 * record and a scenario in it — then there is no badge, and no claim.
 */
export function simulationMatch(
  basis: { evidenceId: string; scenario: string },
  commands: ReadonlyArray<{ zoneId: string; setpointTempC: number }>,
  s: Pick<CopilotStateType, 'evidence' | 'context'>,
): SimulationMatch | null {
  const record: EvidenceRecord | undefined = s.evidence[basis.evidenceId];
  if (!record || record.kind !== 'simulated' || record.tool !== 'simulate_scenarios') return null;
  const data = SimulatedScenarios.safeParse(record.data);
  if (!data.success) return null;
  const scenario = data.data.scenarios.find((x) => x.name === basis.scenario);
  if (!scenario) return null;

  const simulated = new Set(data.data.zone_ids);
  const designed = new Map((s.context?.directory ?? []).map((z) => [z.id, z.designed_setpoint_c]));
  return {
    evidenceId: basis.evidenceId,
    scenario: basis.scenario,
    zonesMatch: commands.every((c) => simulated.has(c.zoneId)),
    setpointsMatch: commands.every((c) => {
      const d = designed.get(c.zoneId);
      return d !== null && d !== undefined
        && Math.abs(c.setpointTempC - (d + scenario.setpoint_delta_k)) <= SETPOINT_TOLERANCE_K;
    }),
    timing: 'whole_window_vs_override',
  };
}
