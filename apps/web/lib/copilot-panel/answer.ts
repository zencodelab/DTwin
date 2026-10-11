import { CAVEAT_IDS, type CaveatId } from '../copilot/evidence.ts';
import { CAVEAT_TEXT } from '../copilot/caveats.ts';
import type { CopilotTurn, PendingPlan } from '../copilot/protocol.ts';

/**
 * How the verified answer, its evidence and a plan's provenance are laid
 * out for reading (design §9.3–9.4). Pure: the turn in, display pieces out.
 *
 * Nothing here writes a figure. Every number an operator reads in the answer
 * is a `num` segment the server rendered after the verifier recomputed it
 * from a cited record; this module only decides where it goes, which
 * citation chip sits beside it, and whether it is tinted as a model
 * estimate. Card lines are the evidence record's own metadata, formatted.
 */

export type Answer = NonNullable<CopilotTurn['answer']>;
export type Card = CopilotTurn['cards'][number];
export type RenderedSegment = Answer['paragraphs'][number][number];

/** Written beside every simulated number, so a model estimate never reads as a measurement. */
export const MODEL_ESTIMATE = 'model estimate';

export const UNVERIFIED_FALLBACK = "Couldn't verify a written answer; here is the evidence";

// ============================================================== citations

/**
 * Cards numbered in the order the answer first cites them, then the rest in
 * the order they were gathered — so chip 1 is the first thing the answer
 * leans on. An id the answer cites that has no card is not numbered: a chip
 * that opens nothing would be a promise the panel cannot keep.
 */
export function citationOrder(answer: Answer | null, cards: readonly Card[]): { cards: Card[]; number: Map<string, number> } {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const cited: string[] = [];
  for (const p of answer?.paragraphs ?? []) {
    for (const s of p) {
      if (s.kind === 'text') continue;
      for (const id of s.evidenceIds) if (byId.has(id) && !cited.includes(id)) cited.push(id);
    }
  }
  const ordered = [...cited.map((id) => byId.get(id)!), ...cards.filter((c) => !cited.includes(c.id))];
  return { cards: ordered, number: new Map(ordered.map((c, i) => [c.id, i + 1])) };
}

/** A superscript chip: the card's number and its id (to open it). */
export interface Cite { n: number; id: string }

export type Piece =
  | { kind: 'text'; text: string }
  | { kind: 'num'; text: string; simulated: boolean; basis: string; cites: Cite[] }
  | { kind: 'cite'; cites: Cite[] };

/**
 * One paragraph as pieces to draw. A `num` keeps its own chips (a derived
 * figure cites every record it was computed from); a `cite` is chips alone;
 * adjacent text is merged. Chips are de-duplicated and in number order.
 */
export function paragraphPieces(segments: readonly RenderedSegment[], number: ReadonlyMap<string, number>): Piece[] {
  const cites = (ids: readonly string[]): Cite[] => [...new Set(ids)]
    .filter((id) => number.has(id))
    .map((id) => ({ n: number.get(id)!, id }))
    .sort((a, b) => a.n - b.n);
  const out: Piece[] = [];
  for (const s of segments) {
    if (s.kind === 'text') {
      const last = out[out.length - 1];
      if (last?.kind === 'text') last.text += s.text;
      else out.push({ kind: 'text', text: s.text });
    } else if (s.kind === 'num') {
      out.push({ kind: 'num', text: s.text, simulated: s.simulated, basis: s.basis, cites: cites(s.evidenceIds) });
    } else {
      const c = cites(s.evidenceIds);
      if (c.length > 0) out.push({ kind: 'cite', cites: c });
    }
  }
  return out;
}

/** What to say where the answer would be; null when the answer stands (or there is nothing to say). */
export function answerFallback(turn: Pick<CopilotTurn, 'answer' | 'cards'>): string | null {
  return turn.answer === null && turn.cards.length > 0 ? UNVERIFIED_FALLBACK : null;
}

// ================================================================== cards

const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A window as the building's clock reads it. The server writes instants in
 * the building's offset; they are shown AS WRITTEN — re-reading them in the
 * browser's zone would put "since 09:00" at 05:00 for someone reading in
 * London. Anything that is not such an instant is shown raw.
 */
export function formatWindow(window: Card['window']): string | null {
  if (!window) return null;
  const a = STAMP.exec(window.from);
  const b = STAMP.exec(window.to);
  if (!a || !b) return `${window.from} → ${window.to}`;
  const day = (m: RegExpExecArray) => `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}`;
  const time = (m: RegExpExecArray) => `${m[4]}:${m[5]}`;
  const zone = a[6] === b[6] && a[6] ? ` ${a[6] === 'Z' ? 'UTC' : a[6]}` : '';
  const sameDay = a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
  return sameDay
    ? `${day(a)} ${time(a)}–${time(b)}${zone}`
    : `${day(a)} ${time(a)} – ${day(b)} ${time(b)}${zone}`;
}

/** An instant as its own clock reads it — "08:40:00 UTC", "12:40:00 +04:00" — or raw if it is not one. */
export function formatInstant(iso: string): string {
  const m = /T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(iso);
  if (!m) return iso;
  return `${m[1]}${m[2] === 'Z' ? ' UTC' : m[2] ? ` ${m[2]}` : ''}`;
}

const count = (n: number) => n.toLocaleString('en-GB');

/**
 * The card's small print: window, coverage, exclusions, truncation. These
 * are the record's own counters — how much of the window had good data, how
 * many flagged samples were kept out — not figures anyone wrote about it.
 */
export function cardFacts(card: Card): string[] {
  const out: string[] = [];
  const w = formatWindow(card.window);
  if (w) out.push(w);
  if (card.coverage && card.coverage.expected_count > 0) {
    const { good_count: good, expected_count: expected } = card.coverage;
    // Floored: 99.6% is not "100%", and a gap is what this line is for.
    out.push(`coverage ${Math.floor((good / expected) * 100)}% (${count(good)} of ${count(expected)})`);
  }
  if (card.flaggedExcluded_count) out.push(`${count(card.flaggedExcluded_count)} flagged excluded`);
  if (card.truncated) out.push(`showing ${count(card.truncated.limit_count)} of ${count(card.truncated.total_count)}`);
  return out;
}

export const KIND_LABEL: Readonly<Record<Card['kind'], string>> = {
  measured: 'measured',
  simulated: `simulated · ${MODEL_ESTIMATE}`,
  configured: 'configured',
};

// ============================================================ plan basis

/**
 * The simulator's standing caveats, as the simulate tool attaches them to
 * every run it returns (SIM_SUBSET only when zones were left out, which a
 * matching plan cannot tell from here, so it is not claimed).
 */
const PLAN_SIM_CAVEATS: readonly CaveatId[] = CAVEAT_IDS.filter((id) => id.startsWith('SIM_') && id !== 'SIM_SUBSET');

/**
 * The named difference plan_check always records between a simulation and
 * an override: the run shifted the setpoint for its whole window, the
 * override lapses when its duration ends.
 */
export const TIMING_NOTE = 'The simulation held the shifted setpoint for its whole window; this override lapses when its duration ends.';

export type PlanBasis =
  | { kind: 'none' }
  | { kind: 'simulated'; scenario: string; evidenceId: string; lines: string[] }
  | { kind: 'mismatch'; scenario: string; zonesMatch: boolean; setpointsMatch: boolean };

/**
 * Whether the plan card may say "Simulated as <scenario>". Only when the plan
 * changes zones the run simulated AND sets exactly the setpoints it
 * simulated (plan_check computed both); then the simulator's caveats follow
 * the badge. A plan that cites a simulation it does not match says so
 * instead — a badge there would lend it the run's credibility for a
 * different action.
 */
export function planBasis(plan: Pick<PendingPlan, 'simulation'>): PlanBasis {
  const s = plan.simulation;
  if (!s) return { kind: 'none' };
  if (s.zonesMatch && s.setpointsMatch) {
    return {
      kind: 'simulated', scenario: s.scenario, evidenceId: s.evidenceId,
      lines: [...PLAN_SIM_CAVEATS.map((id) => CAVEAT_TEXT[id]), TIMING_NOTE],
    };
  }
  return { kind: 'mismatch', scenario: s.scenario, zonesMatch: s.zonesMatch, setpointsMatch: s.setpointsMatch };
}
