import type Anthropic from '@anthropic-ai/sdk';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { z } from 'zod';
import type { Logger } from '../log.ts';
import { CHECK_MODE_CAVEAT } from './caveats.ts';
import {
  BASES, CAVEAT_IDS, CaveatId, DERIVE_OPS, Ref, UNIT_IDS, UnitId, type AnswerDoc, type EvidenceRecord,
  type Violation,
} from './evidence.ts';
import type { Limits } from './limits.ts';
import { errorName, parseReply, systemBlocks, transcriptCache, type Models } from './model.ts';
import { notice, type Notice } from './notices.ts';
import { COMPOSE_SYSTEM, DATA_PREAMBLE } from './prompts.ts';
import { BudgetError, type ModelCaller, type RunRegistry } from './registry.ts';
import { threadIdOf, type CopilotStateType, type CopilotUpdate } from './state.ts';
import { utf8Bytes } from './tools/common.ts';
import { verifyAnswer } from './verify.ts';
import { budgetNotice } from './planner.ts';

/**
 * `compose` writes the answer; `verify` decides whether anyone sees it
 * (docs/decisions.md §64, design §3.1 and §7 P10–P13).
 *
 * The answer is a document of SEGMENTS, not a string: prose in `text`, every
 * quantity with a unit in a `num` that cites where it came from. `verify`
 * recomputes each figure from this request's evidence — reading the unit off
 * the cited key's suffix and the basis off the evidence's kind — and checks
 * the caveats and the wording. Any violation sends the draft back with the
 * violations as data, up to MAX_DRAFTS; after that the operator gets evidence
 * cards and notice `verify_failed`, never unverified prose.
 *
 * Compose never throws: an API error, the budget, a refusal or a reply that
 * does not parse leaves `answer` null with notice `compose_unavailable`, and
 * the cards stand in for it.
 */

// ================================================================== schema

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });
const REF_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['evidenceId', 'path'],
  properties: { evidenceId: { type: 'string' }, path: { type: 'string' } },
};

/**
 * The structured-output twin of `AnswerDoc`. Types, enums and `anyOf` only;
 * every bound (paragraph count, text length, decimals 0–3) is the verifier's,
 * which is what lets an over-long draft come back as `too_long` and be fixed
 * rather than fail the parse.
 */
export const ANSWER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['paragraphs', 'caveats'],
  properties: {
    paragraphs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['segments'],
        properties: {
          segments: {
            type: 'array',
            items: {
              anyOf: [
                {
                  type: 'object', additionalProperties: false, required: ['kind', 'text'],
                  properties: { kind: { type: 'string', enum: ['text'] }, text: { type: 'string' } },
                },
                {
                  type: 'object', additionalProperties: false,
                  required: ['kind', 'value', 'decimals', 'unit', 'basis', 'ref', 'derive'],
                  properties: {
                    kind: { type: 'string', enum: ['num'] },
                    value: { type: 'number' },
                    decimals: { type: 'integer' },
                    unit: { type: 'string', enum: [...UNIT_IDS] },
                    basis: { type: 'string', enum: [...BASES] },
                    ref: nullable(REF_SCHEMA),
                    derive: nullable({
                      type: 'object', additionalProperties: false, required: ['op', 'refs'],
                      properties: {
                        op: { type: 'string', enum: [...DERIVE_OPS] },
                        refs: { type: 'array', items: REF_SCHEMA },
                      },
                    }),
                  },
                },
                {
                  type: 'object', additionalProperties: false, required: ['kind', 'evidenceIds'],
                  properties: {
                    kind: { type: 'string', enum: ['cite'] },
                    evidenceIds: { type: 'array', items: { type: 'string' } },
                  },
                },
              ],
            },
          },
        },
      },
    },
    caveats: { type: 'array', items: { type: 'string', enum: [...CAVEAT_IDS] } },
  },
} as const;

/**
 * `AnswerDoc` without its size bounds: the shape compose accepts. Size is the
 * verifier's to judge (`shape` / `too_long`), so a draft that is merely too
 * long is retried with the violation named instead of being discarded. The
 * inferred type is `AnswerDoc`'s — only the runtime bounds differ.
 */
const LooseSegment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({
    kind: z.literal('num'),
    value: z.number().finite(),
    decimals: z.number().int().min(0).max(3),
    unit: UnitId,
    basis: z.enum(BASES),
    ref: Ref.nullable(),
    derive: z.object({ op: z.enum(DERIVE_OPS), refs: z.array(Ref).min(2).max(6) }).nullable(),
  }),
  z.object({ kind: z.literal('cite'), evidenceIds: z.array(z.string()).min(1) }),
]);
const LooseAnswerDoc = z.object({
  paragraphs: z.array(z.object({ segments: z.array(LooseSegment).min(1) })).min(1),
  caveats: z.array(CaveatId),
});

// =================================================================== input

/**
 * Evidence for compose, within `maxComposeEvidenceBytes`. Full records first
 * for what the findings CITE, then orient's C.1–C.3 (the directory and
 * envelope an answer derives against), then the rest; past the bound a record
 * keeps its metadata and headlines and loses its `data`, and the input says
 * which ids were cut — uncited data goes first.
 */
export function composeEvidence(
  s: Pick<CopilotStateType, 'evidence' | 'findings'>, maxBytes: number,
): { records: unknown[]; dataDropped: string[] } {
  const cited = new Set(Object.values(s.findings).flatMap((f) => f.claims.flatMap((c) => c.evidenceIds)));
  const all = Object.values(s.evidence);
  const rank = (e: EvidenceRecord) => (cited.has(e.id) ? 0 : e.taskId === 'C' ? 1 : 2);
  const ordered = [...all].sort((a, b) => rank(a) - rank(b));
  const keep = new Set<string>();
  let bytes = 0;
  for (const e of ordered) {
    const size = utf8Bytes(JSON.stringify(e));
    if (bytes + size <= maxBytes) {
      keep.add(e.id);
      bytes += size;
    }
  }
  const dataDropped: string[] = [];
  const records = all.map((e) => {
    if (keep.has(e.id)) return e;
    dataDropped.push(e.id);
    const { data: _data, ...meta } = e;
    return meta;
  });
  return { records, dataDropped };
}

// ==================================================================== node

export interface ComposeDeps {
  registry: RunRegistry;
  callModel: ModelCaller;
  models: Models;
  limits: Readonly<Limits>;
  log: Logger;
}

export function makeCompose(deps: ComposeDeps) {
  const { registry, callModel, models, limits, log } = deps;

  return async (s: CopilotStateType, config: LangGraphRunnableConfig): Promise<CopilotUpdate> => {
    const threadId = threadIdOf(config);
    const drafts = s.drafts + 1;
    // A specialist whose model declined its task wrote a `refused` finding;
    // the operator is told in the fixed words, whatever the answer says.
    const said: Notice[] = Object.values(s.findings).some((f) => f.status === 'refused')
      && !s.notices.some((n) => n.code === 'model_refused') ? [notice('model_refused')] : [];
    const unavailable = (extra: Notice[] = []): CopilotUpdate => ({
      answer: null, drafts, notices: [...said, ...extra, notice('compose_unavailable')],
    });

    // Every draft this request is allowed has been written. What was verified
    // before stays; nothing new is asked for.
    if (s.drafts >= limits.maxDrafts) return said.length > 0 ? { notices: said } : {};

    const retry = s.answer !== null && s.violations.length > 0;
    const { records, dataDropped } = composeEvidence(s, limits.maxComposeEvidenceBytes);
    const request = s.request;
    const input = {
      request: request === null ? null : {
        text: request.text, nowIso: request.nowIso, timezone: request.timezone,
        localDate: request.localDate, weekday: request.weekday,
      },
      interpretation: s.plannerRoute?.interpretation ?? null,
      earlierConversation: s.dialogue.filter((e) => e.requestId !== request?.requestId).slice(-limits.dialogueTail),
      findings: Object.values(s.findings),
      evidence: records,
      ...(dataDropped.length > 0 ? {
        evidenceDataDropped: {
          ids: dataDropped,
          why: `the evidence exceeded ${Math.round(limits.maxComposeEvidenceBytes / 1024)} KB; these records keep their metadata only and cannot be cited by path`,
        },
      } : {}),
    };
    const content: Anthropic.TextBlockParam[] = [{ type: 'text', text: `${DATA_PREAMBLE}\n${JSON.stringify(input)}` }];
    // A redraft's previous draft and violations travel in a block of their
    // own, AFTER the evidence. The redraft then re-sends the first draft's
    // request byte for byte, and automatic caching reads that rather than
    // writing it again. In the first real runs four of the five captured
    // first drafts were redrafted, each redraft re-sending the 12,000–21,000
    // input tokens of its first draft uncached. Inside the one block, the
    // retry changed that block's bytes and nothing could have been read.
    if (retry) {
      content.push({ type: 'text', text: `${DATA_PREAMBLE}\n${JSON.stringify({ previousDraft: s.answer, violations: s.violations })}` });
    }

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: models.lead,
      max_tokens: limits.maxTokens,
      system: systemBlocks(COMPOSE_SYSTEM),
      messages: [{ role: 'user', content }],
      cache_control: transcriptCache(),
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: ANSWER_JSON_SCHEMA as unknown as Record<string, unknown> },
      },
    };

    let reply: Anthropic.Message;
    try {
      reply = await registry.call(threadId, 'compose', callModel, params);
    } catch (err) {
      if (err instanceof BudgetError) {
        if (err.reason === 'budget') log.warn('copilot.budget_exhausted', { role: 'compose' });
        const already = s.notices.some((n) => n.code === err.reason);
        return unavailable(already ? [] : [budgetNotice(err.reason, limits)]);
      }
      log.warn('copilot.compose_failed', { error: errorName(err) });
      return unavailable();
    }
    if (reply.stop_reason === 'refusal') return unavailable();

    const parsed = parseReply(reply, LooseAnswerDoc);
    if (!parsed.ok) {
      log.warn('copilot.compose_failed', { error: 'unparseable', stop: reply.stop_reason ?? 'none' });
      return unavailable();
    }
    const answer: AnswerDoc = parsed.value;
    return { answer, drafts, ...(said.length > 0 ? { notices: said } : {}) };
  };
}

/**
 * Caveats the answer owes because of what a TASK was, not what it cited: a
 * check-mode controller could not propose, and the answer must say why
 * (`CHECK_MODE_CAVEAT`). The verifier proper judges an answer against its
 * evidence; this is the one rule that needs the request's findings.
 */
export function findingCaveatViolations(s: Pick<CopilotStateType, 'answer' | 'findings' | 'controlTask'>): Violation[] {
  if (s.answer === null || s.controlTask?.mode !== 'check' || !Object.hasOwn(s.findings, 'K')) return [];
  if (s.answer.caveats.includes(CHECK_MODE_CAVEAT)) return [];
  return [{
    segment: null, rule: 'caveat_required',
    detail: `the controller only checked (finding K) and requires caveat ${CHECK_MODE_CAVEAT}; add it to caveats`,
  }];
}

/**
 * `verify`: pure. The violations decide the route — another draft, or on to
 * the controller or finish. When the last draft still fails, the notice says
 * the evidence is shown instead.
 */
export function makeVerify(deps: { limits: Readonly<Limits>; log: Logger }) {
  const { limits, log } = deps;
  return (s: CopilotStateType): CopilotUpdate => {
    if (s.answer === null) return { violations: [] };
    const violations = [...verifyAnswer(s.answer, s.evidence, s.context, limits), ...findingCaveatViolations(s)];
    if (violations.length > 0 && s.drafts >= limits.maxDrafts) {
      log.warn('copilot.verify_failed', {
        drafts: s.drafts, violations: violations.length,
        rules: [...new Set(violations.map((v) => v.rule))].join(','),
      });
      return { violations, notices: [notice('verify_failed')] };
    }
    return { violations };
  };
}
