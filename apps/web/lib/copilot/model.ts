import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import type { ModelCaller } from './registry.ts';

/**
 * Which model each role calls, and the one production caller.
 *
 * Per role, not per graph (docs/decisions.md §64): the planner, compose and
 * the controller use the LEAD model, the diagnose, analyse and simulate
 * specialists the SPECIALIST model. Both default to the same model, and
 * nothing defaults a role to a cheaper one — moving a role down is a decision
 * to make with usage figures in hand, not a default to discover later.
 *
 * The call is the Anthropic SDK's `messages.create`, directly. LangGraph is
 * here for the shape of the run, not the shape of the request, and a chat
 * wrapper would sit between this code and the request surface (structured
 * output, strict tools, refusal stop reasons) for no gain. The SDK's own
 * `maxRetries` is the only retry layer: no node sets a LangGraph retryPolicy,
 * so a 429 is not retried twice over.
 */

export const DEFAULT_MODEL = 'claude-opus-5';

export interface Models {
  lead: string;
  specialist: string;
}

/**
 * The models to call, from the environment.
 *
 * `||`, not `??`. An `.env` file with `COPILOT_MODEL=` and nothing after the
 * equals sign yields an EMPTY STRING, which `??` passes straight through —
 * and the API then refuses `model: ""`. That is precisely how the first real
 * request against v1 failed. Blank means unset here, for both variables.
 */
export function resolveModels(env: Record<string, string | undefined> = process.env): Models {
  const lead = env.COPILOT_MODEL?.trim() || DEFAULT_MODEL;
  const specialist = env.COPILOT_SPECIALIST_MODEL?.trim() || lead;
  return { lead, specialist };
}

export function hasModelCredential(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim());
}

/**
 * The production model caller. One client per process. The registry's signal
 * and timeout go to the SDK as request options, so Stop and the request's
 * deadline end the HTTP request itself — not only the wait for it.
 */
let client: Anthropic | null = null;
export function realModelCaller(): ModelCaller {
  client ??= new Anthropic();
  return (params, options) => client!.messages.create(params, options);
}

// ============================================================ structured output

/**
 * The text of a structured-output reply: every text block joined. With
 * `output_config.format` the reply is one JSON text block; thinking blocks,
 * if any, are skipped.
 */
export function replyText(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export type JsonParse<T> =
  | { ok: true; value: T; text: string }
  | { ok: false; issues: string[]; text: string };

/**
 * Parse a structured-output reply: JSON first, then the Zod schema, which is
 * where the bounds live (the JSON schema sent to the API carries types and
 * enums only — the API does not accept minimum, maxLength and the like).
 * Never throws; a reply cut off at max_tokens is simply JSON that does not
 * parse.
 */
export function parseReply<S extends z.ZodTypeAny>(message: Anthropic.Message, schema: S): JsonParse<z.infer<S>> {
  const text = replyText(message);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: false, text,
      issues: [message.stop_reason === 'max_tokens'
        ? 'the reply was cut off before its JSON was complete'
        : 'the reply is not JSON'],
    };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data as z.infer<S>, text };
  return {
    ok: false, text,
    issues: parsed.error.issues.slice(0, 8).map((i) => {
      const path = i.path.join('.');
      return path === '' ? i.message : `${path}: ${i.message}`;
    }),
  };
}

// ============================================================ prompt caching

/**
 * Prompt caching (docs/decisions.md §64, "Models and cost").
 *
 * The first real runs cached the system prompts and nothing else, and paid
 * for it: every specialist turn re-sends its whole transcript, and every
 * compose redraft its whole evidence, so the compound question sent 216,648
 * uncached input tokens — $1.08 of its $1.63. A cache write costs 1.25× the
 * input price and a read 0.1×, so a breakpoint pays wherever the bytes before
 * it are sent again, and is a surcharge wherever they are not. Three kinds,
 * never more than `MAX_CACHE_BREAKPOINTS` (registry.ts) in one request:
 *
 * - The system prompt's own (`systemBlocks`). Byte-constant per role
 *   (prompts.ts), so it is read on every call of that role, across requests.
 * - AUTOMATIC caching: `cache_control` at the top of every request
 *   (`transcriptCache`). The API puts that breakpoint on the last cacheable
 *   block and moves it forward as the transcript grows, so a specialist's or
 *   the controller's next turn reads everything the previous turn sent and
 *   pays only for the reply and the tool results since. Compose and the
 *   planner carry it too; each is arranged so that its repeat — a redraft, a
 *   repair — re-sends the earlier request byte for byte (compose.ts,
 *   planner.ts).
 * - One on a STABLE BLOCK (`stableTextBlock`) where a request's prefix
 *   repeats across calls that each end differently: the planner's context,
 *   which every wave's decision re-sends ahead of a progress block that
 *   changes.
 *
 * Nothing stored is marked. Automatic caching is a request parameter, not a
 * content block, so the transcript in graph state never carries a
 * `cache_control`, and nothing has to be copied to put one there.
 *
 * Every marker is the default five-minute ephemeral one: the API refuses a
 * longer TTL after a shorter one, and a request's whole life — its deadline
 * is 300 s — fits inside five minutes of reuse.
 */
export function transcriptCache(): Anthropic.CacheControlEphemeral {
  return { type: 'ephemeral' };
}

/** A text block that ends a stable part of a request, with a breakpoint of its own. */
export function stableTextBlock(text: string): Anthropic.TextBlockParam {
  return { type: 'text', text, cache_control: { type: 'ephemeral' } };
}

/**
 * A system prompt as a cacheable block. The prompts are byte-constant
 * (prompts.ts), so the breakpoint after them is hit on every call of a role.
 */
export function systemBlocks(text: string): Anthropic.TextBlockParam[] {
  return [stableTextBlock(text)];
}

/** The name of an error, for a log line. Never its message: an SDK error's message can carry a key prefix. */
export function errorName(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `${err.name}:${err.status ?? 'none'}`;
  return err instanceof Error ? err.name : typeof err;
}
