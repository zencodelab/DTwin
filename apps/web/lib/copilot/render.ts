import { SIMULATED_FIGURE_CAVEAT, caveatLines } from './caveats.ts';
import type {
  AnswerDoc, Basis, EvidenceKind, EvidenceRecord, EvidenceSource,
} from './evidence.ts';
import { unitOfKey, defaultDecimals, formatQuantity } from './units.ts';
import {
  isSimulatedFigure, lookupPath, segmentEvidenceIds, verifyAnswer, type VerifyContext,
} from './verify.ts';

/**
 * Turning a verified answer into what the panel shows. Pure: no clock, no
 * I/O, no model — the same answer and evidence always render the same.
 *
 * The browser never receives a model message. It receives these segments,
 * whose text was either written by the model AND passed the verifier (prose)
 * or produced here from a number the verifier recomputed (figures), plus
 * caveat lines from the fixed catalogue.
 */

export type RenderedSegment =
  | { kind: 'text'; text: string }
  | {
    kind: 'num';
    /** "23.97 °C": the verified value at its stated decimals, with the unit's symbol. */
    text: string;
    basis: Basis;
    evidenceIds: string[];
    /** Depends on model output; the panel tints it and labels it "model estimate". */
    simulated: boolean;
  }
  | { kind: 'cite'; evidenceIds: string[] };

export interface RenderedAnswer {
  paragraphs: RenderedSegment[][];
  caveatLines: string[];
}

/**
 * Render an answer — ONLY if it verifies. The verifier runs again here
 * rather than trusting that the caller checked: this is the last function
 * between a model's draft and the operator's screen, and "unverified prose
 * never reaches the operator" should not depend on every caller remembering.
 * Null means show the evidence cards instead.
 */
export function renderAnswer(
  answer: AnswerDoc | null,
  evidence: Readonly<Record<string, EvidenceRecord>>,
  context: VerifyContext | null,
): RenderedAnswer | null {
  if (answer === null) return null;
  if (verifyAnswer(answer, evidence, context).length > 0) return null;

  const paragraphs = answer.paragraphs.map((p) => p.segments.map((s): RenderedSegment => {
    switch (s.kind) {
      case 'text':
        return { kind: 'text', text: s.text };
      case 'cite':
        return { kind: 'cite', evidenceIds: [...s.evidenceIds] };
      case 'num':
        return {
          kind: 'num',
          text: formatQuantity(s.value, s.decimals, s.unit),
          basis: s.basis,
          evidenceIds: segmentEvidenceIds(s),
          simulated: isSimulatedFigure(s, evidence),
        };
    }
  }));

  return { paragraphs, caveatLines: caveatLines(answer.caveats) };
}

/**
 * The answer as plain text — paragraphs, then caveat lines — for the dialogue
 * history the planner and compose read on later turns, and the panel shows.
 *
 * Citations are DROPPED. Evidence ids are numbered afresh for every request
 * (T1.E1 is the first record of whichever request is running), and a
 * request's evidence does not outlive it — so an id kept in the history named
 * a different record on the next turn: a compose citing it bound its chip to
 * that record and verified, and the panel labelled a new card with the id an
 * old sentence carried (review, ADR 64).
 */
export function answerPlainText(rendered: RenderedAnswer): string {
  const paragraphs = rendered.paragraphs.map((segments) => segments.map((s) => {
    switch (s.kind) {
      case 'text': return s.text;
      case 'num': return s.text;
      case 'cite': return '';
    }
  }).join('').trim());
  return [...paragraphs, ...rendered.caveatLines].join('\n\n');
}

// ------------------------------------------------------------------ evidence cards

export interface EvidenceCard {
  id: string;
  label: string;
  source: EvidenceSource;
  kind: EvidenceKind;
  window: { from: string; to: string } | null;
  coverage: { good_count: number; expected_count: number } | null;
  flaggedExcluded_count: number | null;
  truncated: { total_count: number; limit_count: number } | null;
  headline: Array<{ label: string; text: string }>;
  /**
   * The record's caveats as the catalogue's fixed lines — and the
   * model-estimate line on anything simulated. A figure the verifier would
   * not let an answer state without its caveats was shown bare on the card
   * the operator gets instead (review, ADR 64).
   */
  caveatLines: string[];
}

/** Longest headline value shown for a non-numeric leaf; cards are glanced at, not read. */
const MAX_HEADLINE_CHARS = 80;

/**
 * A record as a card: its metadata as built by the tool, and each headline
 * value formatted straight from the data with the unit its key names. This
 * is what the operator gets when no written answer verifies, so it must say
 * everything by itself — where the numbers came from, over what window, how
 * much of that window had good data, what was left out, and the caveats its
 * figures carry.
 */
export function renderCard(record: EvidenceRecord): EvidenceCard {
  return {
    id: record.id,
    label: record.label,
    source: record.source,
    kind: record.kind,
    window: record.window,
    coverage: record.coverage,
    flaggedExcluded_count: record.flaggedExcluded_count,
    truncated: record.truncated,
    headline: record.headline.map(({ label, path }) => ({ label, text: headlineText(record.data, path) })),
    caveatLines: caveatLines(record.kind === 'simulated' ? [...record.caveats, SIMULATED_FIGURE_CAVEAT] : record.caveats),
  };
}

function headlineText(data: unknown, path: string): string {
  const found = lookupPath(data, path);
  if (!found.found || found.value === null || found.value === undefined) return '—';
  const v = found.value;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '—';
    const unit = unitOfKey(found.key);
    return unit === null ? String(v) : formatQuantity(v, defaultDecimals(unit, v), unit);
  }
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') return v.length > MAX_HEADLINE_CHARS ? `${v.slice(0, MAX_HEADLINE_CHARS - 1)}…` : v;
  return '—';
}
