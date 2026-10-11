import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { CAVEAT_IDS, CaveatId, EvidenceId } from '../evidence.ts';
import { orderCaveats, refuse, zodIssues, type Refused, type ToolEnv } from './common.ts';

/**
 * report_finding: how every specialist ends (§5.3). A task's conclusion is a
 * TOOL CALL with a schema, not a final message to be parsed: strict decoding
 * holds its shape, and this function holds its references.
 *
 * Every claim cites evidence, and every cited id must be one this task
 * produced or was handed. An unknown id is refused BY NAME, so the model can
 * fix it within its remaining turns; a finding is never stored pointing at
 * evidence nobody can open. Claims are never shown to the operator as they
 * stand — compose builds the answer from them and the evidence, and the
 * verifier checks that — so the rules here are about references, not wording.
 */

export const FINDING_REPORT_STATUSES = ['answered', 'partial', 'cannot_answer'] as const;

export const ReportFindingInput = z.object({
  status: z.enum(FINDING_REPORT_STATUSES),
  summary: z.string().trim().min(1, 'a summary is not empty').max(800, 'a summary is at most 800 characters'),
  claims: z.array(z.object({
    text: z.string().trim().min(1, 'a claim is not empty').max(300, 'a claim is at most 300 characters'),
    evidenceIds: z.array(EvidenceId).min(1, 'every claim cites at least one evidence id').max(6, 'a claim cites at most 6 ids'),
  }).strict()).max(12, 'at most 12 claims'),
  openQuestions: z.array(z.string().trim().max(300, 'a question is at most 300 characters')).max(5, 'at most 5 open questions'),
  caveats: z.array(CaveatId),
}).strict();
export type ReportFindingInput = z.infer<typeof ReportFindingInput>;

export const reportFindingDefinition: Anthropic.Tool = {
  name: 'report_finding',
  description:
    'End this task with what you found. Every claim cites the evidence ids (from your tool results or ' +
    'the inputs you were given) it rests on; an id you did not receive is refused. status: answered, ' +
    'partial (some of the question), or cannot_answer (the data cannot say — say why in the summary). ' +
    'List the caveat codes your tool results carried that apply to what you claim. Summary at most 800 ' +
    'characters; at most 12 claims of 300 characters, each citing 1–6 ids; at most 5 open questions.',
  input_schema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: [...FINDING_REPORT_STATUSES] },
      summary: { type: 'string', description: 'What the task found, in plain words.' },
      claims: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            evidenceIds: { type: 'array', items: { type: 'string' }, description: 'e.g. T1.E2' },
          },
          required: ['text', 'evidenceIds'],
          additionalProperties: false,
        },
      },
      openQuestions: { type: 'array', items: { type: 'string' } },
      caveats: { type: 'array', items: { type: 'string', enum: [...CAVEAT_IDS] } },
    },
    required: ['status', 'summary', 'claims', 'openQuestions', 'caveats'],
    additionalProperties: false,
  },
  strict: true,
};

export type ReportOutcome = Refused | { content: string; report: ReportFindingInput };

export async function reportFinding(input: unknown, env: ToolEnv): Promise<ReportOutcome> {
  const parsed = ReportFindingInput.safeParse(input);
  if (!parsed.success) return refuse(`invalid finding: ${zodIssues(parsed.error)}`);
  const report = parsed.data;

  const known = new Set([...env.task.inputEvidenceIds, ...env.task.producedEvidenceIds]);
  const unknown = [...new Set(report.claims.flatMap((c) => c.evidenceIds))].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return refuse(`unknown evidence id(s): ${unknown.join(', ')} — cite only ids from your tool results or your inputs`);
  }
  return {
    content: 'finding recorded',
    report: { ...report, caveats: orderCaveats(report.caveats) },
  };
}
