import { describe, expect, it } from 'vitest';
import { CAVEAT_TEXT } from '../copilot/caveats.ts';
import {
  KIND_LABEL, MODEL_ESTIMATE, TIMING_NOTE, UNVERIFIED_FALLBACK, answerFallback, cardFacts, citationOrder, formatInstant,
  formatWindow, paragraphPieces, planBasis, type Answer,
} from './answer.ts';
import { card, planFixture } from './fixtures.ts';

/**
 * Laying out the verified answer: numbers keep their citation chips and a
 * simulated one says it is a model estimate; cards are numbered in the order
 * the answer leans on them; the card's small print is the record's own
 * counters; and the plan card claims a simulation only when plan_check found
 * the plan to be what was simulated.
 */

const answer: Answer = {
  paragraphs: [
    [
      { kind: 'text', text: 'OFF-305 averaged ' },
      { kind: 'num', text: '24.1 °C', basis: 'measured', evidenceIds: ['T1.E2'], simulated: false },
      { kind: 'text', text: ' since 09:00' },
      { kind: 'text', text: ', above its band.' },
      { kind: 'cite', evidenceIds: ['T1.E2', 'C.1'] },
    ],
    [
      { kind: 'text', text: 'A 1 K raise changes the day by ' },
      { kind: 'num', text: '-38.2 kWh', basis: 'simulated', evidenceIds: ['T2.E1'], simulated: true },
      { kind: 'num', text: '3.0 K', basis: 'derived', evidenceIds: ['T2.E1', 'T1.E2', 'NOCARD'], simulated: false },
    ],
  ],
  caveatLines: [CAVEAT_TEXT.SIM_ANALYTICALLY_VERIFIED],
};
const cards = [card('C.1'), card('T1.E1'), card('T1.E2'), card('T2.E1', { kind: 'simulated', source: 'simulation' })];

describe('citations', () => {
  it('numbers cards in the order the answer first cites them, then the rest as gathered', () => {
    const { cards: ordered, number } = citationOrder(answer, cards);
    expect(ordered.map((c) => c.id)).toEqual(['T1.E2', 'C.1', 'T2.E1', 'T1.E1']);
    expect([...number]).toEqual([['T1.E2', 1], ['C.1', 2], ['T2.E1', 3], ['T1.E1', 4]]);
    // No answer: gathered order.
    expect(citationOrder(null, cards).cards.map((c) => c.id)).toEqual(['C.1', 'T1.E1', 'T1.E2', 'T2.E1']);
  });

  it('pieces: text merged, each number with its own chips, a simulated one flagged, a chip only for a card that exists', () => {
    const { number } = citationOrder(answer, cards);
    expect(paragraphPieces(answer.paragraphs[0]!, number)).toEqual([
      { kind: 'text', text: 'OFF-305 averaged ' },
      { kind: 'num', text: '24.1 °C', simulated: false, basis: 'measured', cites: [{ n: 1, id: 'T1.E2' }] },
      { kind: 'text', text: ' since 09:00, above its band.' },
      { kind: 'cite', cites: [{ n: 1, id: 'T1.E2' }, { n: 2, id: 'C.1' }] },
    ]);
    const second = paragraphPieces(answer.paragraphs[1]!, number);
    expect(second[1]).toEqual({ kind: 'num', text: '-38.2 kWh', simulated: true, basis: 'simulated', cites: [{ n: 3, id: 'T2.E1' }] });
    // A derived figure cites every record it came from, in number order; the unknown id gets no chip.
    expect(second[2]).toMatchObject({ cites: [{ n: 1, id: 'T1.E2' }, { n: 3, id: 'T2.E1' }] });
    expect(paragraphPieces([{ kind: 'cite', evidenceIds: ['NOCARD'] }], number)).toEqual([]);
  });

  it('says so when the answer did not verify but evidence exists — and only then', () => {
    expect(answerFallback({ answer: null, cards })).toBe(UNVERIFIED_FALLBACK);
    expect(UNVERIFIED_FALLBACK).toBe("Couldn't verify a written answer; here is the evidence");
    expect(answerFallback({ answer, cards })).toBeNull();
    expect(answerFallback({ answer: null, cards: [] })).toBeNull();
  });

  it('a simulated card is labelled a model estimate', () => {
    expect(KIND_LABEL.simulated).toContain(MODEL_ESTIMATE);
  });
});

describe('card facts', () => {
  it('shows a window in the building\'s own offset, never the browser\'s', () => {
    expect(formatWindow({ from: '2026-09-28T09:00:00+04:00', to: '2026-09-28T12:40:00+04:00' })).toBe('28 Sep 09:00–12:40 +04:00');
    expect(formatWindow({ from: '2026-09-21T00:00:00.000+04:00', to: '2026-09-28T00:00:00+04:00' })).toBe('21 Sep 00:00 – 28 Sep 00:00 +04:00');
    expect(formatWindow({ from: '2026-09-28T05:00:00Z', to: '2026-09-28T08:40:00Z' })).toBe('28 Sep 05:00–08:40 UTC');
    expect(formatWindow({ from: 'yesterday', to: 'now' })).toBe('yesterday → now');
    expect(formatWindow(null)).toBeNull();
  });

  it('shows an instant on its own clock', () => {
    expect(formatInstant('2026-09-28T08:40:00.000Z')).toBe('08:40:00 UTC');
    expect(formatInstant('2026-09-28T12:40:00+04:00')).toBe('12:40:00 +04:00');
    expect(formatInstant('later')).toBe('later');
  });

  it('lists coverage (floored), exclusions and truncation from the record\'s counters', () => {
    const facts = cardFacts(card('T1.E1', {
      window: { from: '2026-09-28T09:00:00+04:00', to: '2026-09-28T12:40:00+04:00' },
      coverage: { good_count: 2379, expected_count: 2388 },
      flaggedExcluded_count: 3,
      truncated: { total_count: 132, limit_count: 50 },
    }));
    expect(facts).toEqual([
      '28 Sep 09:00–12:40 +04:00', 'coverage 99% (2,379 of 2,388)', '3 flagged excluded', 'showing 50 of 132',
    ]);
    expect(cardFacts(card('C.1', { coverage: { good_count: 0, expected_count: 0 }, flaggedExcluded_count: 0 }))).toEqual([]);
  });
});

describe('plan basis', () => {
  const sim = (zonesMatch: boolean, setpointsMatch: boolean) => planFixture({
    simulation: { evidenceId: 'T2.E1', scenario: 'plus-1', zonesMatch, setpointsMatch, timing: 'whole_window_vs_override' },
  });

  it('"Simulated as" only when zones AND setpoints match, followed by the simulator\'s caveats and the timing difference', () => {
    const b = planBasis(sim(true, true));
    expect(b).toMatchObject({ kind: 'simulated', scenario: 'plus-1', evidenceId: 'T2.E1' });
    if (b.kind !== 'simulated') throw new Error('unreachable');
    expect(b.lines).toEqual([
      CAVEAT_TEXT.SIM_ANALYTICALLY_VERIFIED, CAVEAT_TEXT.SIM_SYNTHETIC_WEATHER, CAVEAT_TEXT.SIM_UNIFORM_DELTA,
      CAVEAT_TEXT.SIM_UNMET_OWN_BAND, CAVEAT_TEXT.SIM_CONSTANT_COP_NO_SETBACK, CAVEAT_TEXT.SIM_PEAK_INTERVAL_MEAN,
      CAVEAT_TEXT.SIM_PLANT_RESIZED_PER_RUN, TIMING_NOTE,
    ]);
  });

  it('no badge when either half fails, and none without a simulation', () => {
    expect(planBasis(sim(true, false))).toEqual({ kind: 'mismatch', scenario: 'plus-1', zonesMatch: true, setpointsMatch: false });
    expect(planBasis(sim(false, true)).kind).toBe('mismatch');
    expect(planBasis(sim(false, false)).kind).toBe('mismatch');
    expect(planBasis(planFixture())).toEqual({ kind: 'none' });
  });
});
