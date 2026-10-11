import { CHECK_MODE_CAVEAT, SIMULATED_FIGURE_CAVEAT } from './caveats.ts';
import {
  AnswerDoc, type CaveatId, type DeriveOp, type EvidenceKind, type EvidenceRecord, type NumSegment,
  type Ref, type Segment, type UnitId, type VerifyRule, type Violation,
} from './evidence.ts';
import { DEFAULT_LIMITS, type Limits } from './limits.ts';
import { displayedValue, formatNumber, formatQuantity, unitOfKey } from './units.ts';

/**
 * The verifier: a pure function between the model's draft and the operator.
 *
 * It recomputes every unit-bearing number in an answer from this request's
 * evidence, reading the unit off the cited key's suffix and the basis off the
 * evidence's kind, and it checks the wording the codebase has rules about.
 * An answer with any violation is not shown — compose retries with the
 * violations as data, and after the last draft the operator gets evidence
 * cards instead (docs/decisions.md §64, P10–P13).
 *
 * What it checks is PROVENANCE, UNITS and WORDING. It does not check
 * reasoning: an answer can cite a true 23.97 °C and draw the wrong conclusion
 * from it, and nothing here will notice. That is stated in ADR 64 rather than
 * implied away.
 *
 * Deliberately NOT a rule: "no digits in prose". Zone names (OFF-305), floor
 * levels, times of day and counts of things are digits without units, and
 * forbidding them makes answers unreadable without making them safer. The
 * rule is narrower and mechanical — a number followed by a unit is a
 * quantity, and a quantity must be a `num` segment.
 */

/**
 * The slice of orient's context the verifier reads. Structural, so the full
 * OrientContext satisfies it without this module importing the graph.
 */
export interface VerifyContext {
  availability: { forecastWeather: boolean };
}

export type AnswerBounds = Pick<Limits, 'maxAnswerParagraphs' | 'maxAnswerSegments' | 'maxAnswerTextChars'>;

// ------------------------------------------------------------------ text

const SP = String.raw`[\s\u00a0\u202f\u2009]`;

const DIGITS = String.raw`[-+\u2212]?(?:\p{Nd}+(?:[.,]\p{Nd}+)*|[.,]\p{Nd}+)`;

/**
 * A number not glued to a word, an id or a clock time on its left: "OFF-305"
 * and "09:00" and "T1.E1" contribute no number here, "1 K" and ".5 K" do —
 * and so do "Δ1.5 K" and "x2 kWh": a delta sign or a multiplier is a prefix,
 * not a word the number belongs to (review, ADR 64).
 */
const NUMBER = String.raw`(?:(?<![\p{L}\p{N}_.,:/])|(?<=(?:^|[^\p{L}\p{N}_])[ΔδxX×]))${DIGITS}`;

/**
 * Units a quantity in prose could carry: every unit in the table, in the
 * spellings a model uses, plus the neighbours it could reach for instead
 * (°F, MW, watts). Days and weeks are NOT here: "the last 7 days" names a
 * window, which every evidence card also states, not a measured quantity.
 * Longer spellings come first so the quoted match reads naturally.
 *
 * The unit IDS are spellings too: compose is told `_pct` is `pct`, and a
 * model that has just read `mean_pct` writes "95 pct" as readily as "95%".
 * Every id in the unit table must be caught here in its bare form.
 */
const UNITS = [
  String.raw`°${SP}?[cfk]?`, '℃', '℉', '%', '‰',
  String.raw`percent(?:age)?(?:\s+points?)?\b`, String.raw`per\s?cent\b`, String.raw`pcts?\b`, String.raw`pp\b`,
  String.raw`kelvins?\b`, String.raw`celsius\b`, String.raw`fahrenheit\b`,
  // "degC" and "degF" too: `degs?\b` alone needed a boundary right after "deg".
  String.raw`degrees?\b`, String.raw`deg(?:s|[cfk])?\b`,
  String.raw`(?:kilo|mega|giga)?watt(?:[\s-]?hours?)?s?\b`, String.raw`[kmg]?wh?\b`,
  String.raw`m[³3](?:\s*\/\s*h(?:r|our)?)?(?![\p{L}\p{N}])`, String.raw`m[²2](?![\p{L}\p{N}])`,
  String.raw`cmh\b`, String.raw`(?:cubic|square)\s+met(?:re|er)s?\b`,
  String.raw`ppm\b`, String.raw`zone[\s_-]?h(?:ours?)?\b`, String.raw`k(?:\s*\/\s*|_per_)h\b`,
  String.raw`h(?:ours?|rs?)?\b`, String.raw`min(?:s|utes?)?\b`, String.raw`s(?:ecs?|econds?)?\b`,
  String.raw`kg\b`, String.raw`kilo(?:gram)?s?\b`, String.raw`tonnes?\b`,
  // The neighbours a building answer reaches for, none in the unit table:
  // tons (of CO2, or of cooling), refrigeration tons, BTU, joules, litres
  // per second, cubic feet a minute — and money, which no evidence holds.
  String.raw`tons?\b`, String.raw`t\b`, String.raw`(?:tr|rt)\b`, String.raw`btus?(?:\s*\/\s*h(?:r|our)?)?\b`,
  String.raw`[kmgt]?j\b`, String.raw`(?:joules?|litres?|liters?)\b`, String.raw`l\s*\/\s*s\b`, String.raw`cfm\b`,
  String.raw`(?:aed|usd|eur|gbp|dhs?|dirhams?|dollars?|euros?|pounds?|fils|cents?)\b`,
  // A magnitude ("5k", "2M") makes a bare count into a different number.
  String.raw`k\b`, String.raw`c\b`, String.raw`m\b`,
];

const QUANTITY_RE = new RegExp(`${NUMBER}${SP}*(?:-${SP}*)?(?:${UNITS.join('|')})`, 'giu');

/** Money written before its number: "AED 1,200", "$300". No evidence carries a price. */
const MONEY_FIRST_RE = new RegExp(
  String.raw`(?:(?<![\p{L}\p{N}_])(?:aed|usd|eur|gbp|dhs?)|[$€£¥₹])${SP}*${DIGITS}`, 'giu');

/** The same test anchored at the start: what a figure's rendered text reads as with the prose after it. */
const QUANTITY_AT_START = new RegExp(`^${NUMBER}${SP}*(?:-${SP}*)?(?:${UNITS.join('|')})`, 'iu');

/**
 * Unicode format characters — zero-width spaces and joiners, the soft
 * hyphen, bidirectional overrides — render as nothing, or reorder what is
 * around them. "1<ZWSP> K" reads as "1 K" and hides from the quantity test;
 * "valida<ZWSP>ted" hides from the banned-word test; U+202E shows "K 1" as
 * "1 K" (review, ADR 64). Refused wherever model prose reaches the operator.
 */
const FORMAT_CHAR_RE = /\p{Cf}/u;

/**
 * "validated", in any form, is never the word (CLAUDE.md: say "analytically
 * verified"). The simulator has closed-form checks and no comparison against
 * measurement, and the difference is the one an operator would act on.
 */
const VALIDATED_RE = /\bvalidat(?:e|ed|es|ing|ion|ions)\b/iu;

/** No forecast source exists in the schema; the word would imply one did. */
const FORECAST_RE = /\bforecast(?:s|ed|ing|er|ers)?\b/iu;

/**
 * The wording rules for any model-written prose that reaches the operator:
 * an answer's text segments, the planner's interpretation, a clarifying
 * question, a plan's summary and reasons. Returns violations with `segment`
 * null; `verifyAnswer` fills it in.
 */
/** Every figure-with-a-unit in a piece of prose, as written ("44 °C", "1 K"). */
export function quantitiesIn(text: string): string[] {
  const visible = text.replace(/\p{Cf}/gu, '');
  return [...visible.matchAll(QUANTITY_RE), ...visible.matchAll(MONEY_FIRST_RE)]
    .sort((a, b) => a.index - b.index)
    .map((m) => m[0].trim());
}

export function verifyText(text: string, context: VerifyContext | null): Violation[] {
  const out: Violation[] = [];

  if (FORMAT_CHAR_RE.test(text)) {
    out.push({
      segment: null,
      rule: 'invisible_character',
      detail: 'the text holds an invisible formatting character (a zero-width space, soft hyphen or ' +
        'direction override); write plain text',
    });
  }
  // Every other rule reads the text as it is SHOWN, format characters gone.
  const visible = text.replace(/\p{Cf}/gu, '');

  const quantities = quantitiesIn(visible);
  if (quantities.length > 0) {
    const shown = quantities.slice(0, 3).map((q) => `"${q}"`).join(', ');
    const more = quantities.length > 3 ? ` and ${quantities.length - 3} more` : '';
    out.push({
      segment: null,
      rule: 'unit_number_in_text',
      detail: `${shown}${more} states a quantity in prose; put it in a num segment that cites ` +
        'evidence, or say it without the number',
    });
  }

  if (VALIDATED_RE.test(visible)) {
    out.push({
      segment: null,
      rule: 'banned_word',
      detail: '"validated" is never used: the simulator is analytically verified, not validated',
    });
  }

  if (FORECAST_RE.test(visible) && context?.availability.forecastWeather !== true) {
    out.push({
      segment: null,
      rule: 'banned_word',
      detail: '"forecast": no forecast weather is stored, so nothing here is a forecast',
    });
  }

  return out;
}

// ------------------------------------------------------------------ paths

const KEY = '[A-Za-z_][A-Za-z0-9_]*';
const INDEX = String.raw`\[\d{1,4}\]`;
const PATH_RE = new RegExp(`^${KEY}(?:${INDEX})*(?:\\.${KEY}(?:${INDEX})*)*$`);
const STEP_RE = new RegExp(`(${KEY})|\\[(\\d{1,4})\\]`, 'g');

export type PathLookup =
  | { found: true; value: unknown; key: string }
  | { found: false; detail: string };

/**
 * Follow a path like `rows[2].energy_kwh` into a record's data.
 *
 * Only OWN properties of plain objects and in-range array indexes are
 * followed — never a prototype, a getter's inheritance or a `length` — and
 * `key` is the last NAMED key on the path, which is the one whose suffix
 * gives the unit (`values_kwh[3]` is in kWh).
 */
export function lookupPath(data: unknown, path: string): PathLookup {
  if (!PATH_RE.test(path)) return { found: false, detail: `"${path}" is not a path (a.b[2].c_kwh)` };
  let current: unknown = data;
  let key = '';
  for (const m of path.matchAll(STEP_RE)) {
    if (m[1] !== undefined) {
      key = m[1];
      if (typeof current !== 'object' || current === null || Array.isArray(current)
        || !Object.hasOwn(current, key)) {
        return { found: false, detail: `"${path}" has no key "${key}"` };
      }
      current = (current as Record<string, unknown>)[key];
    } else {
      const i = Number(m[2]);
      if (!Array.isArray(current) || i >= current.length) {
        return { found: false, detail: `"${path}" has no element [${i}]` };
      }
      current = current[i];
    }
  }
  return { found: true, value: current, key };
}

interface Cited {
  evidenceId: string;
  path: string;
  value: number;
  unit: UnitId;
  kind: EvidenceKind;
}

type CiteResult = { ok: true; cited: Cited } | { ok: false; rule: VerifyRule; detail: string };

/** One ref, resolved to a number with a unit and a kind — or the reason it cannot be. */
export function resolveRef(ref: Ref, evidence: Readonly<Record<string, EvidenceRecord>>): CiteResult {
  const record = Object.hasOwn(evidence, ref.evidenceId) ? evidence[ref.evidenceId] : undefined;
  if (!record) {
    return { ok: false, rule: 'evidence_scope', detail: `${ref.evidenceId} is not evidence from this request` };
  }
  const found = lookupPath(record.data, ref.path);
  if (!found.found) return { ok: false, rule: 'ref', detail: `${ref.evidenceId}: ${found.detail}` };
  if (typeof found.value !== 'number' || !Number.isFinite(found.value)) {
    return { ok: false, rule: 'ref', detail: `${ref.evidenceId} ${ref.path} is not a number` };
  }
  const unit = unitOfKey(found.key);
  if (unit === null) {
    return {
      ok: false, rule: 'uncitable',
      detail: `${ref.evidenceId} ${ref.path}: "${found.key}" names no unit, so it cannot back a figure`,
    };
  }
  return {
    ok: true,
    cited: { evidenceId: ref.evidenceId, path: ref.path, value: found.value, unit, kind: record.kind },
  };
}

// ------------------------------------------------------------------ derivations

type Derived = { ok: true; value: number; unit: UnitId } | { ok: false; detail: string };

/**
 * The declared derivations, and which units each is meaningful for.
 *
 * - difference: two refs. °C − °C is a temperature DIFFERENCE, in K; °C − K
 *   is a temperature (a setpoint less half a deadband). A difference of
 *   percentages is refused: it is percentage points, which the unit table
 *   cannot say, and "fell 9%" would misstate it.
 * - sum: two to six refs in one unit; never °C (temperatures do not add) and
 *   never % (shares of different wholes do not add).
 * - percent_change: two refs, `(refs[1] − refs[0]) / |refs[0]|`, in one
 *   unit; never °C (an interval scale has no meaningful ratio) or %.
 */
export function evaluateDerive(op: DeriveOp, cited: readonly Cited[]): Derived {
  const units = cited.map((c) => c.unit);
  const named = units.join(', ');
  switch (op) {
    case 'difference': {
      if (cited.length !== 2) return { ok: false, detail: 'difference takes exactly two refs' };
      const [a, b] = cited as [Cited, Cited];
      let unit: UnitId | null = null;
      if (a.unit === 'c' && b.unit === 'c') unit = 'k';
      else if (a.unit === 'c' && b.unit === 'k') unit = 'c';
      else if (a.unit === b.unit && a.unit !== 'pct') unit = a.unit;
      if (unit === null) {
        return { ok: false, detail: `a difference of ${named} has no unit here; cite both values instead` };
      }
      return { ok: true, value: a.value - b.value, unit };
    }
    case 'sum': {
      const unit = units[0]!;
      if (units.some((u) => u !== unit)) return { ok: false, detail: `cannot sum ${named}` };
      if (unit === 'c' || unit === 'pct') return { ok: false, detail: `values in ${unit} do not add` };
      return { ok: true, value: cited.reduce((t, c) => t + c.value, 0), unit };
    }
    case 'percent_change': {
      if (cited.length !== 2) return { ok: false, detail: 'percent_change takes exactly two refs (from, to)' };
      const [from, to] = cited as [Cited, Cited];
      if (from.unit !== to.unit) return { ok: false, detail: `percent_change of ${named} mixes units` };
      if (from.unit === 'c' || from.unit === 'pct') {
        return { ok: false, detail: `a percent change of values in ${from.unit} is not meaningful` };
      }
      if (from.value === 0) return { ok: false, detail: 'percent_change from zero is undefined' };
      return { ok: true, value: ((to.value - from.value) / Math.abs(from.value)) * 100, unit: 'pct' };
    }
  }
}

/**
 * Does the number the operator will SEE agree with the evidence? The display
 * goes through the same formatter as the renderer, so a value that rounds to
 * the right digits passes and one that does not fails. Half a unit in the
 * last displayed place, plus a hair for binary floating point.
 */
function agrees(value: number, decimals: number, actual: number): boolean {
  const shown = displayedValue(value, decimals);
  const halfStep = 0.5 * 10 ** -decimals;
  return Math.abs(shown - actual) <= halfStep + 1e-9 * Math.max(1, Math.abs(actual));
}

function precise(actual: number): string {
  // Enough digits to show WHY a figure failed, not a 17-digit float.
  return formatNumber(actual, 3, false);
}

// ------------------------------------------------------------------ answers

/** Every evidence id a segment points at, in order of appearance. */
export function segmentEvidenceIds(segment: Segment): string[] {
  switch (segment.kind) {
    case 'text': return [];
    case 'cite': return [...segment.evidenceIds];
    case 'num': {
      const ids = [
        ...(segment.ref ? [segment.ref.evidenceId] : []),
        ...(segment.derive ? segment.derive.refs.map((r) => r.evidenceId) : []),
      ];
      return [...new Set(ids)];
    }
  }
}

function checkNum(
  seg: NumSegment, evidence: Readonly<Record<string, EvidenceRecord>>,
): Array<{ rule: VerifyRule; detail: string }> {
  const out: Array<{ rule: VerifyRule; detail: string }> = [];

  if (seg.ref === null && seg.derive === null) {
    return [{ rule: 'ref', detail: 'a figure needs a ref or a derive; cite where it came from' }];
  }
  if (seg.ref !== null && seg.derive !== null) {
    return [{ rule: 'ref', detail: 'give a ref or a derive, not both' }];
  }

  if (seg.ref !== null) {
    if (seg.basis === 'derived') {
      return [{ rule: 'derive', detail: 'basis "derived" needs a derive, not a single ref' }];
    }
    const r = resolveRef(seg.ref, evidence);
    if (!r.ok) return [{ rule: r.rule, detail: r.detail }];
    const c = r.cited;
    if (seg.unit !== c.unit) {
      out.push({ rule: 'unit', detail: `${c.evidenceId} ${c.path} is in ${c.unit}, not ${seg.unit}` });
    }
    if (seg.basis !== c.kind) {
      out.push({ rule: 'basis', detail: `${c.evidenceId} is ${c.kind} evidence, not ${seg.basis}` });
    }
    if (!agrees(seg.value, seg.decimals, c.value)) {
      out.push({
        rule: 'value_mismatch',
        detail: `${c.evidenceId} ${c.path} is ${precise(c.value)}; ` +
          `${formatNumber(seg.value, seg.decimals, false)} does not match it at ${seg.decimals} decimals`,
      });
    }
    return out;
  }

  const derive = seg.derive!;
  if (seg.basis !== 'derived') {
    return [{ rule: 'basis', detail: `a derived figure has basis "derived", not "${seg.basis}"` }];
  }
  // One ref twice is never a derivation: a sum doubles a figure, a difference
  // or a change from itself is zero (review, ADR 64). Compared as the
  // location the path resolves to, so `rows[01]` is `rows[1]`.
  const places = derive.refs.map((r) => `${r.evidenceId}|${canonicalPath(r.path)}`);
  if (new Set(places).size !== places.length) {
    return [{ rule: 'derive', detail: 'each ref may appear once in a derivation; a repeated ref doubles or cancels a figure' }];
  }
  const cited: Cited[] = [];
  for (const ref of derive.refs) {
    const r = resolveRef(ref, evidence);
    if (r.ok) cited.push(r.cited);
    else out.push({ rule: r.rule, detail: r.detail });
  }
  if (out.length > 0) return out;

  // A model estimate minus a measurement is neither: it would read as a
  // measured fact with a model inside it. Configured values (a designed
  // setpoint) combine with either.
  const kinds = new Set(cited.map((c) => c.kind));
  if (kinds.has('simulated') && kinds.has('measured')) {
    return [{ rule: 'basis', detail: 'a derivation cannot combine simulated and measured evidence' }];
  }

  const d = evaluateDerive(derive.op, cited);
  if (!d.ok) return [{ rule: 'derive', detail: d.detail }];
  if (seg.unit !== d.unit) {
    out.push({ rule: 'unit', detail: `this ${derive.op} is in ${d.unit}, not ${seg.unit}` });
  }
  if (!agrees(seg.value, seg.decimals, d.value)) {
    out.push({
      rule: 'value_mismatch',
      detail: `this ${derive.op} is ${precise(d.value)}; ` +
        `${formatNumber(seg.value, seg.decimals, false)} does not match it at ${seg.decimals} decimals`,
    });
  }
  return out;
}

/** A path in one spelling: `rows[01].x` and `rows[1].x` name the same place. */
function canonicalPath(path: string): string {
  return path.replace(/\[0*(\d+)\]/g, (_, n: string) => `[${Number(n)}]`);
}

/**
 * The prose the operator reads on one side of a figure, up to the next
 * figure: every text segment joined, reading straight through citation chips
 * (which render as no text) — and through EMPTY text segments, which render
 * as nothing too. Judged one neighbouring segment at a time, an empty one
 * hid "about 1" from the glue rule (review, ADR 64). `figure` says whether
 * another figure ends it.
 */
function adjacentProse(segments: readonly Segment[], si: number, step: -1 | 1): { text: string; figure: boolean } {
  let text = '';
  for (let i = si + step; i >= 0 && i < segments.length; i += step) {
    const s = segments[i]!;
    if (s.kind === 'num') return { text, figure: true };
    if (s.kind === 'text') text = step === -1 ? s.text + text : text + s.text;
  }
  return { text, figure: false };
}

const GLUED_BEFORE = /(?:[\p{N}.,]|[+\-\u2212]\s*)$/u;
const GLUED_AFTER = /^(?:\p{N}|[.,]\p{N})/u;

/**
 * A verified figure can still be MISREAD if the prose around it runs into
 * it: "about 1" before a verified 0.5 K renders as "about 10.5 K", a "-"
 * before it flips its sign, and a bare count followed by "0 people" gains a
 * digit. The renderer cannot know which was meant, so the verifier refuses
 * any of them.
 *
 * So is prose that runs on as more of the figure's UNIT. A count is shown
 * bare, so "3" + "% above design" reads 3%, and "288" + " minutes of good
 * data" reads 288 minutes when the key counted five-minute buckets; "12.3 kW"
 * + "h" reads 12.3 kWh. Each is a unit nobody compared with the cited key
 * (review, ADR 64). The figure is rendered as the panel will render it,
 * joined to the text after it, and read by the same quantity test as prose:
 * a quantity longer than the figure alone means the text supplied unit.
 */
function checkGlue(segments: readonly Segment[], si: number): Array<{ rule: VerifyRule; detail: string }> {
  const out: Array<{ rule: VerifyRule; detail: string }> = [];
  const seg = segments[si] as NumSegment;
  const prev = adjacentProse(segments, si, -1);
  const next = adjacentProse(segments, si, 1);
  if (prev.figure && prev.text === '') {
    out.push({ rule: 'glued_figure', detail: 'two figures side by side read as one; separate them with words' });
  }
  if (GLUED_BEFORE.test(prev.text)) {
    out.push({
      rule: 'glued_figure',
      detail: 'the text before this figure ends in a digit, separator or sign that runs into it; end it with a space or a word',
    });
  }
  if (GLUED_AFTER.test(next.text)) {
    out.push({ rule: 'glued_figure', detail: 'the text after this figure starts with a digit that runs into it' });
  } else if (next.text !== '') {
    const shown = formatQuantity(seg.value, seg.decimals, seg.unit);
    const read = QUANTITY_AT_START.exec(shown + next.text.replace(/\p{Cf}/gu, ''))?.[0].trimEnd();
    const joins = /[^\p{N}]$/u.test(shown) && /^[\p{L}\p{N}°%]/u.test(next.text);
    if ((read !== undefined && read.length > shown.length) || joins) {
      out.push({
        rule: 'glued_figure',
        detail: `the text after this figure reads as more of its unit ("${read ?? shown + next.text.slice(0, 3)}"); ` +
          'a figure\'s unit is shown with it — start the text after it with a space and a word that is not a unit',
      });
    }
  }
  return out;
}

/** True when a figure depends on simulated evidence — directly or through a derivation. */
export function isSimulatedFigure(seg: NumSegment, evidence: Readonly<Record<string, EvidenceRecord>>): boolean {
  if (seg.basis === 'simulated') return true;
  return segmentEvidenceIds(seg).some((id) => Object.hasOwn(evidence, id) && evidence[id]!.kind === 'simulated');
}

/**
 * Verify a composed answer against this request's evidence. An empty array
 * means every figure was recomputed, every cited caveat is present and the
 * wording is clean; anything else means the answer is not shown.
 *
 * The document is re-parsed first. It arrives typed, but it has been through
 * a checkpoint, and a type is not a runtime fact.
 */
export function verifyAnswer(
  answer: AnswerDoc,
  evidence: Readonly<Record<string, EvidenceRecord>>,
  context: VerifyContext | null,
  bounds: AnswerBounds = DEFAULT_LIMITS,
): Violation[] {
  const parsed = AnswerDoc.safeParse(answer);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return [{
      segment: null, rule: 'shape',
      detail: `the answer does not parse: ${first ? `${first.path.join('.')}: ${first.message}` : 'invalid'}`,
    }];
  }
  const doc = parsed.data;
  const out: Violation[] = [];

  const segments = doc.paragraphs.flatMap((p) => p.segments);
  const textChars = segments.reduce((n, s) => n + (s.kind === 'text' ? s.text.length : 0), 0);
  if (doc.paragraphs.length > bounds.maxAnswerParagraphs) {
    out.push({ segment: null, rule: 'too_long',
      detail: `${doc.paragraphs.length} paragraphs; at most ${bounds.maxAnswerParagraphs}` });
  }
  if (segments.length > bounds.maxAnswerSegments) {
    out.push({ segment: null, rule: 'too_long',
      detail: `${segments.length} segments; at most ${bounds.maxAnswerSegments}` });
  }
  if (textChars > bounds.maxAnswerTextChars) {
    out.push({ segment: null, rule: 'too_long',
      detail: `${textChars} characters of text; at most ${bounds.maxAnswerTextChars}` });
  }

  const cited = new Set<string>();
  let simulatedFigure = false;

  let first = 0;
  doc.paragraphs.forEach((p, pi) => {
    const base = first;
    first += p.segments.length;
    const where = (si: number, last = si) => (last === si
      ? `paragraph ${pi + 1}, segment ${si + 1}: `
      : `paragraph ${pi + 1}, segments ${si + 1}–${last + 1}: `);
    const add = (si: number, v: { rule: VerifyRule; detail: string }, last = si) =>
      out.push({ segment: base + si, rule: v.rule, detail: where(si, last) + v.detail });

    // Prose is checked as the operator reads it: consecutive text segments
    // joined, reading straight through citation chips. Checked one segment at
    // a time, "about 1" and " K warmer" would each pass.
    let run: { from: number; to: number; text: string } | null = null;
    const flush = () => {
      if (run) for (const v of verifyText(run.text, context)) add(run.from, v, run.to);
      run = null;
    };

    const refs: Ref[] = [];
    p.segments.forEach((s, si) => {
      for (const id of segmentEvidenceIds(s)) if (Object.hasOwn(evidence, id)) cited.add(id);
      if (s.kind === 'num') refs.push(...(s.ref ? [s.ref] : []), ...(s.derive?.refs ?? []));
      switch (s.kind) {
        case 'text':
          run = run ? { ...run, to: si, text: run.text + s.text } : { from: si, to: si, text: s.text };
          break;
        case 'cite':
          for (const id of s.evidenceIds) {
            if (!Object.hasOwn(evidence, id)) {
              add(si, { rule: 'evidence_scope', detail: `${id} is not evidence from this request` });
            }
          }
          break;
        case 'num':
          flush();
          for (const v of checkNum(s, evidence)) add(si, v);
          for (const v of checkGlue(p.segments, si)) add(si, v);
          if (isSimulatedFigure(s, evidence)) simulatedFigure = true;
          break;
      }
    });
    flush();
    for (const v of unpairedTotals(refs, evidence)) out.push({ segment: null, rule: v.rule, detail: `paragraph ${pi + 1}: ${v.detail}` });
  });

  // Every caveat the cited evidence carries, plus the model-estimate caveat
  // for any simulated figure or citation, whether or not a tool attached it.
  const required = new Map<CaveatId, string[]>();
  const need = (caveat: CaveatId, by: string) => required.set(caveat, [...(required.get(caveat) ?? []), by]);
  for (const id of cited) {
    const record = evidence[id]!;
    for (const caveat of record.caveats) need(caveat, id);
    if (record.kind === 'simulated') need(SIMULATED_FIGURE_CAVEAT, id);
  }
  if (simulatedFigure && !required.has(SIMULATED_FIGURE_CAVEAT)) need(SIMULATED_FIGURE_CAVEAT, 'a simulated figure');

  const present = new Set(doc.caveats);
  for (const [caveat, by] of required) {
    if (!present.has(caveat)) {
      out.push({
        segment: null, rule: 'caveat_required',
        detail: `${[...new Set(by)].join(', ')} requires caveat ${caveat}; add it to caveats`,
      });
    }
  }

  // And the other way: a caveat is a FACT about this request's data — floors
  // alike, suspect meter periods, gaps in coverage — decided in code from the
  // rows and attached to the evidence that has it. Listed with no evidence
  // carrying it, its fixed text would tell the operator something nobody
  // found (review, ADR 64). Two are the verifier's own: the model-estimate
  // caveat wherever anything simulated is in play, and the check-mode caveat,
  // a standing fact about control that the verify node requires of a check.
  const carried = new Set<CaveatId>();
  let anySimulated = simulatedFigure;
  for (const record of Object.values(evidence)) {
    for (const caveat of record.caveats) carried.add(caveat);
    if (record.kind === 'simulated') anySimulated = true;
  }
  for (const caveat of present) {
    if (carried.has(caveat) || caveat === CHECK_MODE_CAVEAT) continue;
    if (caveat === SIMULATED_FIGURE_CAVEAT && anySimulated) continue;
    out.push({
      segment: null, rule: 'caveat_unsupported',
      detail: `no evidence from this request carries ${caveat}, so its fixed text would state what was not found; remove it`,
    });
  }

  return out;
}

/** A meter's two totals, as the tool names them. */
const METER_TOTAL = /^total(_excluding_suspect)?_(kwh|m3)$/;

/**
 * A meter with suspect periods has two totals, and neither is "the" total:
 * the raw one counts a counter jump as energy, the other leaves periods out.
 * So one is never cited without the other in the same paragraph (ADR 64 data
 * realities: "never one cleaned number"). The caveat's fixed text says they
 * are shown side by side; before this rule nothing made that true (review).
 * Waived when the other is null — no clean period, so there is no second
 * total to give.
 */
function unpairedTotals(
  refs: readonly Ref[], evidence: Readonly<Record<string, EvidenceRecord>>,
): Array<{ rule: VerifyRule; detail: string }> {
  const out: Array<{ rule: VerifyRule; detail: string }> = [];
  const here = new Set(refs.map((r) => `${r.evidenceId}|${r.path}`));
  const seen = new Set<string>();
  for (const r of refs) {
    const m = METER_TOTAL.exec(r.path);
    if (!m || !Object.hasOwn(evidence, r.evidenceId)) continue;
    const record = evidence[r.evidenceId]!;
    if (!record.caveats.includes('METER_SUSPECT_BUCKETS')) continue;
    const other = m[1] ? `total_${m[2]}` : `total_excluding_suspect_${m[2]}`;
    if (here.has(`${r.evidenceId}|${other}`) || seen.has(`${r.evidenceId}|${other}`)) continue;
    const found = lookupPath(record.data, other);
    if (!found.found || typeof found.value !== 'number' || !Number.isFinite(found.value)) continue;
    seen.add(`${r.evidenceId}|${r.path}`);
    out.push({
      rule: 'unpaired_total',
      detail: `${r.evidenceId} ${r.path} is cited without ${other}: this meter has suspect periods, so its raw ` +
        'total and its total without them are given together, never one alone',
    });
  }
  return out;
}
