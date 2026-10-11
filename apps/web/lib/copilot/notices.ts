import { z } from 'zod';

/**
 * What the graph itself has to tell the operator, as codes with fixed text.
 *
 * A notice is the copilot saying something about ITSELF — it stopped, it
 * could not verify, it set a plan aside — rather than about the building.
 * Those are exactly the sentences that must never be paraphrased by a model:
 * "nothing was issued" has to read "nothing was issued" every time. So nodes
 * append `{code, params}`, and this module is the only place text is made.
 *
 * Parameters are filled in by code from values code produced (a zone name
 * from the directory, an ingest refusal message, a configured limit). They
 * are never model text.
 */

export const NOTICE_CODES = [
  'plan_superseded',
  'context_unavailable',
  'control_unavailable',
  'multiple_buildings',
  'wave_limit',
  'budget',
  'deadline',
  'stopped',
  'model_refused',
  'planner_unavailable',
  'control_not_permitted',
  'compose_unavailable',
  'verify_failed',
  'message_unverified',
  'plan_refused',
  'plan_declined',
  'plan_stale',
  'plan_expired',
  'apply_refused',
] as const;
export const NoticeCode = z.enum(NOTICE_CODES);
export type NoticeCode = z.infer<typeof NoticeCode>;

export const Notice = z.object({
  code: NoticeCode,
  params: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type Notice = z.infer<typeof Notice>;

/**
 * `{name}` placeholders are filled from `params`. Every placeholder a template
 * uses is listed in NOTICE_PARAMS, and a test holds the two together.
 */
export const NOTICE_TEMPLATES: Readonly<Record<NoticeCode, string>> = Object.freeze({
  plan_superseded: 'The previous plan was set aside; nothing was issued.',
  context_unavailable:
    "The building's data could not be read just now, so this question was not answered. Try again shortly.",
  control_unavailable:
    'The control service is unreachable, so no setpoint change can be checked or proposed right now. Readings are unaffected.',
  multiple_buildings: 'More than one building is visible; this answer covers {building} only.',
  wave_limit:
    'Stopped investigating after {waves} rounds; the answer uses what was found by then.',
  budget:
    'Stopped at the limit of {calls} model calls for one request; the answer uses what was found by then.',
  deadline:
    'Stopped at the {seconds}-second limit for one request; the answer uses what was found by then.',
  stopped: 'Stopped at your request.',
  model_refused: 'The model declined this request; nothing was acted on.',
  planner_unavailable: 'The copilot could not plan an answer to this request. Try rephrasing it.',
  control_not_permitted:
    'Changing setpoints needs an operator or admin role, so no change was proposed.',
  compose_unavailable:
    'A written answer could not be produced; the evidence gathered is shown instead.',
  verify_failed:
    'A written answer could not be checked against the evidence, so the evidence is shown instead.',
  message_unverified:
    "The copilot's reply stated figures that could not be checked, so it is not shown.",
  plan_refused:
    'No plan is shown: the safety envelope now refuses {zone} ({message}). Nothing was issued.',
  plan_declined: 'Plan declined; nothing was issued.',
  plan_stale: 'That decision did not match the plan on screen, so nothing was issued.',
  plan_expired:
    'The plan expired before it was approved, so nothing was issued. Ask again for a fresh check.',
  apply_refused:
    'The approval could not be matched to a checked plan, so nothing was issued.',
});

export const NOTICE_PARAMS: Readonly<Record<NoticeCode, readonly string[]>> = Object.freeze({
  plan_superseded: [],
  context_unavailable: [],
  control_unavailable: [],
  multiple_buildings: ['building'],
  wave_limit: ['waves'],
  budget: ['calls'],
  deadline: ['seconds'],
  stopped: [],
  model_refused: [],
  planner_unavailable: [],
  control_not_permitted: [],
  compose_unavailable: [],
  verify_failed: [],
  message_unverified: [],
  plan_refused: ['zone', 'message'],
  plan_declined: [],
  plan_stale: [],
  plan_expired: [],
  apply_refused: [],
});

/** A parameter is a short value, not a paragraph; an ingest message is cut here. */
const MAX_PARAM_CHARS = 200;

/**
 * The text for one notice. Never throws: this runs while a turn is being
 * handed back, and a missing parameter should cost a word, not the turn.
 */
export function noticeText(notice: Notice): string {
  return NOTICE_TEMPLATES[notice.code].replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = Object.hasOwn(notice.params, name) ? notice.params[name] : undefined;
    if (v === undefined) return '—';
    const s = String(v);
    return s.length > MAX_PARAM_CHARS ? `${s.slice(0, MAX_PARAM_CHARS - 1)}…` : s;
  });
}

export function notice(code: NoticeCode, params: Notice['params'] = {}): Notice {
  return { code, params };
}
