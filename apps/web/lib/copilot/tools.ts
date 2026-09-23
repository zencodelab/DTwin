import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { CommandSpec, CopilotBackend, DryRunResult, ZoneSummary } from './backend.ts';

/**
 * The copilot's whole vocabulary: four tools, three of which only read.
 *
 * What is NOT here matters more than what is. There is no tool to switch
 * control on, change the envelope, cancel a command, or apply anything. The
 * one write — actually issuing commands — is not a tool the model can call at
 * all: it happens in a graph node the model cannot reach except by way of a
 * human pressing Approve (docs/decisions.md §63). The model's job is to look,
 * check, and propose. The person's job is to decide.
 *
 * Tool RESULTS are data, never instructions. Zone names and equipment tags
 * come from the database and could in principle be typed by anyone with
 * write access to it; the system prompt says so and this module never
 * interpolates them into anything the model is told to obey.
 */

/** Most commands one plan may carry. A plan is something a person reads. */
export const MAX_PLAN_COMMANDS = 12;

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

/** A plan as shown to the operator: each command with its dry-run verdict. */
export interface PlanForReview {
  summary: string;
  commands: Array<ProposedCommand & {
    zoneName: string;
    verdict: DryRunResult;
  }>;
}

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_zones',
    description:
      'Every zone in the building with its floor, type, current temperature (good and recent ' +
      'readings only — null means the sensor is stale or flagged and the zone must not be ' +
      'commanded), designed setpoint, deadband, any active override, and the status of the ' +
      'equipment serving it. Call this before proposing anything.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: 'control_envelope',
    description:
      "The tenant's supervisory-control limits: whether control is enabled, how far from the " +
      'designed setpoint a command may go, the largest single step, the minimum interval ' +
      'between commands to one zone, and the default and maximum override durations.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    strict: true,
  },
  {
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
  {
    name: 'propose_plan',
    description:
      'Put a set of setpoint overrides in front of the operator for approval. Nothing is ' +
      'applied by this call: the operator sees each command with its dry-run verdict and ' +
      'chooses to approve or decline. Only include commands whose dry run was allowed. ' +
      `At most ${MAX_PLAN_COMMANDS} commands.`,
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
      },
      required: ['summary', 'commands'],
      additionalProperties: false,
    },
    strict: false,
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

export interface ToolOutcome {
  /** What goes back to the model. */
  content: string;
  isError?: boolean;
  /** Set only by propose_plan, once validated and dry-run. */
  plan?: PlanForReview;
}

/**
 * Run one tool call against the backend.
 *
 * `propose_plan` re-dry-runs every command server-side here rather than
 * trusting the model's earlier dry runs: the model may have skipped one, the
 * world may have moved, and the plan the operator sees must carry verdicts
 * from now, not from a minute ago. A plan containing any refused command is
 * returned to the model as an error, so an operator is never shown a plan
 * with a command in it that cannot be applied.
 */
export async function runTool(
  name: string, input: unknown, backend: CopilotBackend,
): Promise<ToolOutcome> {
  switch (name) {
    case 'list_zones': {
      const zones = await backend.listZones();
      return { content: JSON.stringify(zones.map(compactZone)) };
    }
    case 'control_envelope': {
      return { content: JSON.stringify(await backend.settings()) };
    }
    case 'dry_run_setpoint': {
      const parsed = ProposedCommand.safeParse(input);
      if (!parsed.success) return { content: `invalid input: ${issues(parsed)}`, isError: true };
      return { content: JSON.stringify(await backend.dryRun(parsed.data)) };
    }
    case 'propose_plan': {
      const parsed = ProposedPlan.safeParse(input);
      if (!parsed.success) return { content: `invalid plan: ${issues(parsed)}`, isError: true };

      const seen = new Set<string>();
      for (const c of parsed.data.commands) {
        if (seen.has(c.zoneId)) {
          return { content: `invalid plan: zone ${c.zoneId} appears twice`, isError: true };
        }
        seen.add(c.zoneId);
      }

      const zones = new Map((await backend.listZones()).map((z) => [z.id, z]));
      const reviewed: PlanForReview['commands'] = [];
      for (const c of parsed.data.commands) {
        const zone = zones.get(c.zoneId);
        if (!zone) return { content: `invalid plan: unknown zone ${c.zoneId}`, isError: true };
        reviewed.push({ ...c, zoneName: zone.name, verdict: await backend.dryRun(c) });
      }
      const refused = reviewed.filter((c) => !c.verdict.allowed);
      if (refused.length > 0) {
        const named = refused
          .map((c) => `${c.zoneName}: ${(c.verdict as { message: string }).message}`)
          .join('; ');
        return {
          content: `plan not shown to the operator — ${refused.length} command(s) refused by the ` +
            `envelope: ${named}. Remove or change them and propose again.`,
          isError: true,
        };
      }
      return {
        content: `plan with ${reviewed.length} command(s) is in front of the operator for approval`,
        plan: { summary: parsed.data.summary, commands: reviewed },
      };
    }
    default:
      return { content: `unknown tool ${name}`, isError: true };
  }
}

function issues(parsed: { error: z.ZodError }): string {
  return parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
}

/** The model does not need ids of equipment or timestamps to the ms. */
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

export type { CommandSpec };
