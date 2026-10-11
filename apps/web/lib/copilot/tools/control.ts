import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { DryRunResult, ZoneSummary } from '../deps.ts';
import { EvidenceId } from '../evidence.ts';
import { DEFAULT_LIMITS } from '../limits.ts';
import { quantitiesIn, verifyText } from '../verify.ts';
import {
  callService, evidenceTool, isRefused, refuse, shapeData, zodIssues, zoneIn,
  type EvidenceDraft, type Refused, type ToolEnv,
} from './common.ts';

/**
 * The controller's vocabulary: v1's four tools (docs/decisions.md §63), kept
 * verbatim — same names, schemas, strictness and results — with two changes:
 *
 * - A backend throw is an is_error naming the service. In v1 it threw out of
 *   the graph and bricked the thread.
 * - `propose_plan` may name the simulation it follows (`basis`), and it
 *   refuses a summary or reason that states a setpoint or duration in prose:
 *   the plan card shows those from the commands themselves, so prose that
 *   restated them could only ever disagree with the card.
 *
 * What is NOT here matters more than what is. No tool switches control on,
 * changes the envelope, cancels a command, or applies anything. Issuing is
 * not a tool the model can call at all: it happens in the graph's `apply`
 * node, reachable only through a person's approval, and it is the only code
 * holding an `Issuer`. The controller gets a `ControlProbe`, which cannot
 * issue — by type, and by the fetch guard behind it.
 *
 * The four keep v1's camelCase results (`temperatureC`, `maxDeviationK`).
 * Those keys carry no unit SUFFIX, so no answer can cite them as a figure:
 * the controller's evidence backs a plan card, never a number in prose.
 */

/** Most commands one plan may carry. A plan is something a person reads. */
export const MAX_PLAN_COMMANDS = DEFAULT_LIMITS.maxPlanCommands;

export const ProposedCommand = z.object({
  zoneId: z.string().uuid(),
  setpointTempC: z.number().finite(),
  durationS: z.number().int().positive().max(86_400).optional(),
  reason: z.string().trim().min(3).max(300),
});
export type ProposedCommand = z.infer<typeof ProposedCommand>;

export const ProposedPlan = z.object({
  summary: z.string().trim().min(3).max(500),
  commands: z.array(ProposedCommand).min(1).max(MAX_PLAN_COMMANDS),
});
export type ProposedPlan = z.infer<typeof ProposedPlan>;

/**
 * The simulation a plan follows, by evidence id and scenario name. Only a
 * CLAIM: plan_check decides whether the plan matches what was simulated
 * (same zones, setpoints equal designed + shift) and the card shows the
 * "simulated" badge only when both hold.
 */
export const PlanBasis = z.object({
  evidenceId: EvidenceId,
  scenario: z.string().regex(/^[a-z0-9-]{1,40}$/, 'a scenario name as simulate_scenarios named it'),
}).strict();
export type PlanBasis = z.infer<typeof PlanBasis>;

const ProposePlanInput = ProposedPlan.extend({ basis: PlanBasis.optional() });

/** What control:finish emits as `proposal`: the plan, and its basis or null. */
export const ProposedPlanWithBasis = ProposedPlan.extend({ basis: PlanBasis.nullable() });
export type ProposedPlanWithBasis = z.infer<typeof ProposedPlanWithBasis>;

// ================================================================ v1's three

/** The model does not need ids of equipment or timestamps to the ms (v1). */
function compactZone(z: ZoneSummary) {
  return {
    id: z.id, name: z.name, floor: z.floorName, type: z.zoneType, areaM2: z.areaM2,
    temperatureC: z.temperatureC === null ? null : Math.round(z.temperatureC * 10) / 10,
    designedSetpointC: z.designedSetpointC,
    deadbandK: z.deadbandK,
    activeOverrideC: z.activeOverrideC,
    overrideUntil: z.overrideUntil,
    equipment: z.equipment.map((e) => `${e.tag} (${e.status})`),
  };
}

const NoInput = z.object({}).strict();

export const listZones = evidenceTool<null>({
  name: 'list_zones',
  service: 'database',
  definition: {
    name: 'list_zones',
    description:
      'Every zone in the building with its floor, type, current temperature (good and recent ' +
      'readings only — null means the sensor is stale or flagged and the zone must not be ' +
      'commanded), designed setpoint, deadband, any active override, and the status of the ' +
      'equipment serving it. Call this before proposing anything.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    strict: true,
  },
  prepare(input) {
    const p = NoInput.safeParse(input ?? {});
    return p.success ? null : refuse(`invalid input: ${zodIssues(p.error)}`);
  },
  async execute(_p, env): Promise<EvidenceDraft | Refused> {
    const zones = await callService('database', () => env.ctx.deps.reader.listZones());
    if (isRefused(zones)) return zones;
    return {
      tool: 'list_zones',
      kind: 'measured',
      source: 'telemetry_t',
      label: 'Zones: latest good temperature, designed setpoints, active overrides',
      window: null,
      coverage: null,
      flaggedExcluded_count: null,
      truncated: null,
      caveats: [],
      headline: [],
      data: shapeData(zones.map(compactZone), env),
    };
  },
  // Refused whole, never cut to the zones that fit: a zone missing from this
  // list is one the controller would believe has no reading. The directory in
  // its first message still names every zone, and dry_run_setpoint judges
  // each one it would command (a stale sensor is refused there).
  tooLarge: () => 'the building has more zones than one result can carry; work from the directory ' +
    'in your first message and dry-run each zone you would command',
});

export const controlEnvelope = evidenceTool<null>({
  name: 'control_envelope',
  service: 'control service',
  definition: {
    name: 'control_envelope',
    description:
      "The tenant's supervisory-control limits: whether control is enabled, how far from the " +
      'designed setpoint a command may go, the largest single step, the minimum interval ' +
      'between commands to one zone, and the default and maximum override durations.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    strict: true,
  },
  prepare(input) {
    const p = NoInput.safeParse(input ?? {});
    return p.success ? null : refuse(`invalid input: ${zodIssues(p.error)}`);
  },
  async execute(_p, env): Promise<EvidenceDraft | Refused> {
    const probe = env.ctx.deps.probe;
    if (!probe) return refuse('control service unreachable');
    const settings = await callService('control service', () => probe.settings());
    if (isRefused(settings)) return settings;
    return {
      tool: 'control_envelope',
      kind: 'configured',
      source: 'ingest_control',
      label: 'Control envelope',
      window: null,
      coverage: null,
      flaggedExcluded_count: null,
      truncated: null,
      caveats: [],
      headline: [],
      data: shapeData(settings, env),
    };
  },
});

export const dryRunSetpoint = evidenceTool<ProposedCommand>({
  name: 'dry_run_setpoint',
  service: 'control service',
  definition: {
    name: 'dry_run_setpoint',
    description:
      'Ask the safety envelope whether ONE setpoint override would be allowed, without ' +
      'queueing anything. Returns allowed with the resolved window, or a refusal naming the ' +
      'rule. Dry-run every command you intend to propose; never propose one that was refused.',
    input_schema: {
      type: 'object',
      properties: {
        zoneId: { type: 'string', description: 'Zone id from list_zones' },
        setpointTempC: { type: 'number', description: 'Target setpoint, °C' },
        durationS: { type: 'integer', description: 'How long the override should hold, seconds. Omit for the tenant default.' },
        reason: { type: 'string', description: 'Why, in one sentence. Recorded on the command.' },
      },
      required: ['zoneId', 'setpointTempC', 'reason'],
      additionalProperties: false,
    },
    strict: false,
  },
  prepare(input) {
    const p = ProposedCommand.safeParse(input);
    return p.success ? p.data : refuse(`invalid input: ${zodIssues(p.error)}`);
  },
  async execute(command, env): Promise<EvidenceDraft | Refused> {
    const probe = env.ctx.deps.probe;
    if (!probe) return refuse('control service unreachable');
    const verdict = await callService('control service', () => probe.dryRun(command));
    if (isRefused(verdict)) return verdict;
    const zone = zoneIn(env, command.zoneId);
    return {
      tool: 'dry_run_setpoint',
      kind: 'configured',
      source: 'ingest_control',
      label: `Dry run for ${zone?.name ?? 'a zone not in the directory'}`,
      window: null,
      coverage: null,
      flaggedExcluded_count: null,
      truncated: null,
      caveats: [],
      headline: [],
      data: shapeData(verdict, env),
    };
  },
});

// =============================================================== propose_plan

export const proposePlanDefinition: Anthropic.Tool = {
  name: 'propose_plan',
  description:
    'Put a set of setpoint overrides in front of the operator for approval. Nothing is ' +
    'applied by this call: the operator sees each command with its dry-run verdict and ' +
    'chooses to approve or decline. Only include commands whose dry run was allowed. ' +
    `At most ${MAX_PLAN_COMMANDS} commands. The card shows each setpoint and duration, so do not ` +
    'restate them in the summary or reasons. If the plan follows a simulation, name it in basis.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One or two sentences the operator reads first: what and why.' },
      commands: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            zoneId: { type: 'string' },
            setpointTempC: { type: 'number' },
            durationS: { type: 'integer' },
            reason: { type: 'string' },
          },
          required: ['zoneId', 'setpointTempC', 'reason'],
          additionalProperties: false,
        },
      },
      basis: {
        type: 'object',
        description: 'Optional: the simulate_scenarios evidence id and scenario name this plan follows.',
        properties: { evidenceId: { type: 'string' }, scenario: { type: 'string' } },
        required: ['evidenceId', 'scenario'],
        additionalProperties: false,
      },
    },
    required: ['summary', 'commands'],
    additionalProperties: false,
  },
  strict: false,
};

/**
 * A figure with a unit in the summary or a reason, refused BY NAME. The
 * summary and reasons are shown beside the plan unverified, so they carry no
 * such figure at all — not only no setpoint. The first real compound run was
 * told only "do not restate setpoints", for "the 44 °C design-day what-if",
 * which is no setpoint, and sent the same figure back twice (ADR 64).
 */
function restated(where: string, text: string): Refused {
  const figures = quantitiesIn(text).slice(0, 3).map((q) => `"${q}"`).join(', ');
  return refuse(`${where} states ${figures}: the summary and reasons are shown unverified, so they carry no ` +
    'figure with a unit (the card shows every setpoint and duration); say it in words');
}

export type ProposeOutcome = Refused | { content: string; proposal: ProposedPlanWithBasis };

/**
 * v1's server-side checks, then two of v2's: the wording of what the
 * operator will read, and the basis. Every command is dry-run AGAIN here
 * rather than trusting the model's earlier dry runs — the model may have
 * skipped one and the world may have moved — and a plan with any refused
 * command is returned to the model as an error, so the operator never sees
 * a plan with a command in it that cannot be applied. (plan_check dry-runs
 * the lot once more before the card is shown.)
 */
export async function proposePlan(input: unknown, env: ToolEnv): Promise<ProposeOutcome> {
  const parsed = ProposePlanInput.safeParse(input);
  if (!parsed.success) return refuse(`invalid plan: ${zodIssues(parsed.error)}`);
  const plan = parsed.data;

  const seen = new Set<string>();
  for (const c of plan.commands) {
    if (seen.has(c.zoneId)) return refuse(`invalid plan: zone ${c.zoneId} appears twice`);
    seen.add(c.zoneId);
  }

  const context = env.ctx.orient;
  const zoneNames = new Map<string, string>();
  for (const c of plan.commands) {
    const zone = zoneIn(env, c.zoneId);
    if (!zone) return refuse(`invalid plan: unknown zone ${c.zoneId}`);
    zoneNames.set(c.zoneId, zone.name);
  }

  // What the operator reads is held to the verifier's wording rules.
  const summaryIssues = verifyText(plan.summary, context);
  if (summaryIssues.some((v) => v.rule === 'unit_number_in_text')) return restated('the summary', plan.summary);
  if (summaryIssues.length > 0) return refuse(`summary: ${summaryIssues[0]!.detail}`);
  for (const c of plan.commands) {
    const issues = verifyText(c.reason, context);
    if (issues.some((v) => v.rule === 'unit_number_in_text')) return restated(`the reason for ${zoneNames.get(c.zoneId)}`, c.reason);
    if (issues.length > 0) return refuse(`reason for ${zoneNames.get(c.zoneId)}: ${issues[0]!.detail}`);
  }

  if (plan.basis) {
    const known = new Set([...env.task.inputEvidenceIds, ...env.task.producedEvidenceIds]);
    if (!known.has(plan.basis.evidenceId)) {
      return refuse(`basis names ${plan.basis.evidenceId}, which this task was not given; name the simulation evidence you were handed`);
    }
  }

  const probe = env.ctx.deps.probe;
  if (!probe) return refuse('control service unreachable');
  const verdicts: Array<{ zoneName: string; verdict: DryRunResult }> = [];
  for (const c of plan.commands) {
    try {
      verdicts.push({ zoneName: zoneNames.get(c.zoneId)!, verdict: await probe.dryRun(c) });
    } catch {
      return refuse('control service unreachable');
    }
  }
  const refused = verdicts.filter((v) => !v.verdict.allowed);
  if (refused.length > 0) {
    const named = refused
      .map((v) => `${v.zoneName}: ${(v.verdict as { message: string }).message}`)
      .join('; ');
    return refuse(
      `plan not shown to the operator — ${refused.length} command(s) refused by the envelope: ${named}. ` +
      'Remove or change them and propose again.',
    );
  }

  return {
    content: `plan with ${plan.commands.length} command(s) accepted for review: it is dry-run again and put in ` +
      'front of the operator, who approves or declines it. Nothing has been applied. Call report_finding next.',
    proposal: { summary: plan.summary, commands: plan.commands, basis: plan.basis ?? null },
  };
}

export const CONTROL_TOOL_SET = [listZones, controlEnvelope, dryRunSetpoint] as const;
