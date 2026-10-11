import { z } from 'zod';

/**
 * The copilot's evidence vocabulary: what a tool result becomes, what an
 * answer is made of, and what the verifier can say about it.
 *
 * These types live here rather than in the graph's state module on purpose.
 * The verifier, the renderer and the unit table are pure functions over plain
 * data, and they must stay testable — and stay correct — without LangGraph in
 * the import graph. The state module imports this one, never the other way
 * round.
 *
 * Everything that can arrive from the model or from a checkpoint has a Zod
 * schema, per "parse at the boundary, never cast": a type is a promise the
 * compiler cannot keep about data that was serialised and read back.
 */

// ------------------------------------------------------------------ evidence

/**
 * Where a number came from, which is what the operator is entitled to know
 * before trusting it. A MEASURED value was read from telemetry, alerts or
 * command history; a SIMULATED one is model output; a CONFIGURED one is the
 * asset register, a designed setpoint or the control envelope.
 */
export const EVIDENCE_KINDS = ['measured', 'simulated', 'configured'] as const;
export const EvidenceKind = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

export const EVIDENCE_SOURCES = [
  'telemetry_5m', 'telemetry_1h', 'telemetry_t', 'alerts', 'control_commands', 'maintenance_logs',
  'equipment', 'weather_observations', 'simulation', 'ingest_control', 'directory',
] as const;
export const EvidenceSource = z.enum(EVIDENCE_SOURCES);
export type EvidenceSource = z.infer<typeof EvidenceSource>;

/**
 * Evidence ids are assigned by code, never chosen by the model: `C.1`–`C.3`
 * from orient, `T<n>.E<m>` from specialist task n, `K.E<m>` from the
 * controller. A model that cites an id this request did not produce is
 * caught by the verifier's scope rule, not by hoping it would not.
 */
export const EVIDENCE_ID_RE = /^(C\.[1-3]|T[1-8]\.E\d{1,2}|K\.E\d{1,2})$/;
export const EvidenceId = z.string().regex(EVIDENCE_ID_RE, 'not an evidence id');
export type EvidenceId = z.infer<typeof EvidenceId>;

/** `C` (orient), `K` (control) or `T1`…`T8` (specialist tasks). */
export const TASK_ID_RE = /^(C|K|T[1-8])$/;

/**
 * Caveats are CODES, rendered from fixed text by code (`caveats.ts`). The
 * model may choose which apply; it never writes one. That is what makes
 * "every caveat attached to cited evidence appears in the answer" checkable:
 * a code either is in the list or is not, where a paraphrase could drift.
 *
 * Catalogue order, which is also the order caveat lines are rendered in.
 */
export const CAVEAT_IDS = [
  'SIM_ANALYTICALLY_VERIFIED',
  'SIM_SYNTHETIC_WEATHER',
  'SIM_UNIFORM_DELTA',
  'SIM_UNMET_OWN_BAND',
  'SIM_CONSTANT_COP_NO_SETBACK',
  'SIM_PEAK_INTERVAL_MEAN',
  'SIM_PLANT_RESIZED_PER_RUN',
  'SIM_SUBSET',
  'PARTIAL_COVERAGE',
  'FLAGGED_EXCLUDED',
  'PLANT_NOT_ALLOCATED',
  'FLOORS_WITHIN_2PCT',
  'METER_SUSPECT_BUCKETS',
  'MAIN_VS_SUBMETERS_UNRECONCILED',
  'NO_STATUS_HISTORY',
  'NO_WEATHER_STORED',
  'NO_SCHEDULED_START',
] as const;
export const CaveatId = z.enum(CAVEAT_IDS);
export type CaveatId = z.infer<typeof CaveatId>;

/**
 * Units, as ids. The unit of a cited number is never taken from the model: it
 * is read off the SUFFIX of the key the number was cited from (`units.ts`),
 * which is the "units are part of every name" rule made mechanical. The model
 * states a unit only so the verifier has something to compare.
 */
export const UNIT_IDS = [
  'k_per_h', 'zone_h', 'kwh', 'kw', 'ppm', 'cmh', 'pct', 'm2', 'm3', 'min', 'count', 'kg',
  'c', 'k', 'h', 's',
] as const;
export const UnitId = z.enum(UNIT_IDS);
export type UnitId = z.infer<typeof UnitId>;

const Window = z.object({ from: z.string(), to: z.string() });

/**
 * One tool result, numbered by the server.
 *
 * `data` is the tool's own output, at most 8 KB serialised, whose numeric
 * leaves carry a unit suffix. Free text from the database sits under
 * `*_untrusted` keys and is data, never instructions. The rest is metadata
 * built by code for the evidence card: the label, the window, how much of it
 * was actually covered by good data, how many flagged samples were left out,
 * and whether a list stopped at its cap.
 */
export interface EvidenceRecord {
  id: EvidenceId;
  taskId: string;
  tool: string;
  kind: EvidenceKind;
  source: EvidenceSource;
  label: string;
  window: { from: string; to: string } | null;
  coverage: { good_count: number; expected_count: number } | null;
  flaggedExcluded_count: number | null;
  truncated: { total_count: number; limit_count: number } | null;
  caveats: CaveatId[];
  headline: Array<{ label: string; path: string }>;
  data: unknown;
  at: string;
}

export const EvidenceRecord: z.ZodType<EvidenceRecord, z.ZodTypeDef, unknown> = z.object({
  id: EvidenceId,
  taskId: z.string().regex(TASK_ID_RE),
  tool: z.string().min(1).max(64),
  kind: EvidenceKind,
  source: EvidenceSource,
  label: z.string().max(200),
  window: Window.nullable(),
  coverage: z.object({
    good_count: z.number().int().nonnegative(),
    expected_count: z.number().int().nonnegative(),
  }).nullable(),
  flaggedExcluded_count: z.number().int().nonnegative().nullable(),
  truncated: z.object({
    total_count: z.number().int().nonnegative(),
    limit_count: z.number().int().nonnegative(),
  }).nullable(),
  caveats: z.array(CaveatId),
  headline: z.array(z.object({ label: z.string().max(80), path: z.string().max(120) })).max(6),
  // z.unknown() would make the key optional; a record without data is not a
  // record, so its presence is required explicitly.
  data: z.custom<unknown>((v) => v !== undefined, 'data is required'),
  at: z.string(),
})
  // The id says which task produced it; a record filed under another task's
  // id would let one specialist's evidence pass as another's.
  .refine((r) => r.id.startsWith(`${r.taskId}.`), { message: 'id does not belong to taskId' })
  .transform((r) => r as EvidenceRecord);

// ------------------------------------------------------------------ findings

export const SPECIALIST_ROLES = ['diagnose', 'analyse', 'simulate', 'control'] as const;
export const FINDING_STATUSES = ['answered', 'partial', 'cannot_answer', 'failed', 'refused'] as const;
export const FINDING_REASONS = [
  'turn_limit', 'tool_limit', 'budget', 'deadline', 'stopped', 'no_report', 'model_error',
  'evidence_full',
] as const;

/**
 * What one specialist task concluded. Claims cite evidence ids so compose can
 * build on them, but a claim is never shown to the operator as it stands:
 * only compose's segments are, and only after verification.
 */
export const Finding = z.object({
  taskId: z.string().regex(TASK_ID_RE),
  specialist: z.enum(SPECIALIST_ROLES),
  status: z.enum(FINDING_STATUSES),
  reason: z.enum(FINDING_REASONS).nullable(),
  summary: z.string().max(800),
  claims: z.array(z.object({
    text: z.string().max(300),
    evidenceIds: z.array(EvidenceId).min(1),
  })).max(12),
  openQuestions: z.array(z.string().max(300)).max(5),
  caveats: z.array(CaveatId),
  evidenceIds: z.array(EvidenceId),
});
export type Finding = z.infer<typeof Finding>;

// ------------------------------------------------------------------ answers

/** A pointer at one number inside one evidence record's `data`. */
export const Ref = z.object({
  evidenceId: EvidenceId,
  // "metrics.temperature_c.mean_c", "rows[2].energy_kwh"
  path: z.string().min(1).max(120),
});
export type Ref = z.infer<typeof Ref>;

export const BASES = ['measured', 'simulated', 'configured', 'derived'] as const;
export type Basis = (typeof BASES)[number];

export const DERIVE_OPS = ['difference', 'sum', 'percent_change'] as const;
export type DeriveOp = (typeof DERIVE_OPS)[number];

/**
 * An answer is a list of segments, not a string. Prose goes in `text`, and
 * every quantity with a unit goes in a `num` that says where it came from —
 * one evidence path, or a declared derivation over several — so a pure
 * function can recompute it. That is the whole trick: the model is free to
 * explain, and not free to state a figure nobody can trace.
 */
export const Segment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().max(600) }),
  z.object({
    kind: z.literal('num'),
    value: z.number().finite(),
    decimals: z.number().int().min(0).max(3),
    unit: UnitId,
    basis: z.enum(BASES),
    ref: Ref.nullable(),
    derive: z.object({
      op: z.enum(DERIVE_OPS),
      refs: z.array(Ref).min(2).max(6),
    }).nullable(),
  }),
  z.object({ kind: z.literal('cite'), evidenceIds: z.array(EvidenceId).min(1).max(6) }),
]);
export type Segment = z.infer<typeof Segment>;
export type NumSegment = Extract<Segment, { kind: 'num' }>;

export const AnswerDoc = z.object({
  paragraphs: z.array(z.object({ segments: z.array(Segment).min(1) })).min(1).max(6),
  caveats: z.array(CaveatId).max(16),
});
export type AnswerDoc = z.infer<typeof AnswerDoc>;

// ------------------------------------------------------------------ verification

/**
 * Every way an answer can fail verification. A violation goes back to compose
 * as data on the retry, so each rule is named for what the model must fix.
 *
 * - `shape`: the document does not parse (it was not built by compose, or a
 *   checkpoint was edited).
 * - `ref`: a number has no source, or its path does not resolve to a number.
 * - `derive`: a derivation is malformed or not meaningful for its units.
 * - `unit`: the stated unit is not the unit the cited key names.
 * - `basis`: the stated basis is not the cited evidence's kind.
 * - `uncitable`: the cited key carries no unit suffix, so it cannot back a
 *   unit-bearing number.
 * - `value_mismatch`: the number as displayed is not the evidence value.
 * - `unit_number_in_text`: a quantity with a unit was written as prose.
 * - `glued_figure`: prose runs into a figure ("about 1" + "0.5 K" reads
 *   "about 10.5 K"), two figures sit side by side, or the text after a
 *   figure reads as more of its unit ("12.3 kW" + "h", a count + " kWh").
 * - `caveat_required`: cited evidence carries a caveat the answer omits.
 * - `caveat_unsupported`: the answer lists a caveat no evidence from this
 *   request carries — its fixed text would state a fact nobody found.
 * - `unpaired_total`: a meter's raw total, or its total without suspect
 *   periods, cited without the other where the meter has suspect periods.
 * - `invisible_character`: text holds a Unicode format character (a
 *   zero-width space, a soft hyphen, a bidirectional override), which can
 *   hide a quantity or a word from every other rule and reorder what is shown.
 * - `banned_word`: "validated" always; "forecast" without forecast evidence.
 * - `evidence_scope`: an id this request did not produce.
 * - `too_long`: past the paragraph, segment or text-length bound.
 */
export const VERIFY_RULES = [
  'shape', 'ref', 'derive', 'unit', 'basis', 'uncitable', 'value_mismatch',
  'unit_number_in_text', 'glued_figure', 'caveat_required', 'caveat_unsupported', 'unpaired_total',
  'banned_word', 'invisible_character', 'evidence_scope', 'too_long',
] as const;
export const VerifyRule = z.enum(VERIFY_RULES);
export type VerifyRule = z.infer<typeof VerifyRule>;

/**
 * `segment` is the index counting from 0 across ALL paragraphs, or null for a
 * document-level violation; `detail` also names the paragraph and position
 * (from 1) for the model's benefit.
 */
export const Violation = z.object({
  segment: z.number().int().nonnegative().nullable(),
  rule: VerifyRule,
  detail: z.string(),
});
export type Violation = z.infer<typeof Violation>;
