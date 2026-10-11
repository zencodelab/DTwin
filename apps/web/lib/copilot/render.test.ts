import { describe, expect, it } from 'vitest';
import { CAVEAT_TEXT } from './caveats.ts';
import type { AnswerDoc, EvidenceRecord } from './evidence.ts';
import { answerPlainText, renderAnswer, renderCard } from './render.ts';

function record(id: string, kind: EvidenceRecord['kind'], data: unknown, over: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id, taskId: id.split('.')[0]!, tool: 'zone_conditions', kind,
    source: kind === 'simulated' ? 'simulation' : kind === 'configured' ? 'directory' : 'telemetry_5m',
    label: `${id} label`, window: null, coverage: null, flaggedExcluded_count: null, truncated: null,
    caveats: [], headline: [], data, at: '2026-09-28T12:40:00+04:00', ...over,
  };
}

const EVIDENCE: Record<string, EvidenceRecord> = {
  'C.1': record('C.1', 'configured', { directory: [{ name: 'OFF-305', designed_setpoint_c: 23 }] }),
  'T1.E1': record('T1.E1', 'measured', {
    metrics: { temperature_c: { mean_c: 23.9712 }, damper_position_pct: { mean_pct: 95.1 } },
  }, { caveats: ['FLAGGED_EXCLUDED'] }),
  'T2.E1': record('T2.E1', 'simulated', {
    baseline: { total_kwh: 88.5 }, scenarios: [{ total_kwh: 79 }],
  }, { caveats: ['SIM_SYNTHETIC_WEATHER', 'SIM_ANALYTICALLY_VERIFIED'] }),
};

const CTX = { availability: { forecastWeather: false } };

const VERIFIED: AnswerDoc = {
  paragraphs: [
    {
      segments: [
        { kind: 'text', text: 'OFF-305 averaged ' },
        { kind: 'num', value: 23.97, decimals: 2, unit: 'c', basis: 'measured',
          ref: { evidenceId: 'T1.E1', path: 'metrics.temperature_c.mean_c' }, derive: null },
        { kind: 'text', text: ', ' },
        { kind: 'num', value: 0.97, decimals: 2, unit: 'k', basis: 'derived', ref: null,
          derive: { op: 'difference', refs: [
            { evidenceId: 'T1.E1', path: 'metrics.temperature_c.mean_c' },
            { evidenceId: 'C.1', path: 'directory[0].designed_setpoint_c' },
          ] } },
        { kind: 'text', text: ' above its design, with the damper near fully open.' },
        { kind: 'cite', evidenceIds: ['T1.E1'] },
      ],
    },
    {
      segments: [
        { kind: 'text', text: 'In the model, a warmer setpoint uses ' },
        { kind: 'num', value: -10.7, decimals: 1, unit: 'pct', basis: 'derived', ref: null,
          derive: { op: 'percent_change', refs: [
            { evidenceId: 'T2.E1', path: 'baseline.total_kwh' },
            { evidenceId: 'T2.E1', path: 'scenarios[0].total_kwh' },
          ] } },
        { kind: 'text', text: ' energy.' },
      ],
    },
  ],
  // Listed out of catalogue order and with a duplicate; rendered in order, once.
  caveats: ['FLAGGED_EXCLUDED', 'SIM_SYNTHETIC_WEATHER', 'SIM_ANALYTICALLY_VERIFIED', 'FLAGGED_EXCLUDED'],
};

describe('renderAnswer', () => {
  it('renders figures from verified segments, with their sources and basis', () => {
    const r = renderAnswer(VERIFIED, EVIDENCE, CTX)!;
    expect(r.paragraphs[0]).toEqual([
      { kind: 'text', text: 'OFF-305 averaged ' },
      { kind: 'num', text: '23.97 °C', basis: 'measured', evidenceIds: ['T1.E1'], simulated: false },
      { kind: 'text', text: ', ' },
      { kind: 'num', text: '0.97 K', basis: 'derived', evidenceIds: ['T1.E1', 'C.1'], simulated: false },
      { kind: 'text', text: ' above its design, with the damper near fully open.' },
      { kind: 'cite', evidenceIds: ['T1.E1'] },
    ]);
    expect(r.paragraphs[1]![1]).toEqual(
      { kind: 'num', text: '-10.7%', basis: 'derived', evidenceIds: ['T2.E1'], simulated: true });
  });

  it('renders caveat lines from the catalogue, in its order, once each', () => {
    expect(renderAnswer(VERIFIED, EVIDENCE, CTX)!.caveatLines).toEqual([
      CAVEAT_TEXT.SIM_ANALYTICALLY_VERIFIED,
      CAVEAT_TEXT.SIM_SYNTHETIC_WEATHER,
      CAVEAT_TEXT.FLAGGED_EXCLUDED,
    ]);
  });

  it('renders nothing it cannot verify', () => {
    expect(renderAnswer(null, EVIDENCE, CTX)).toBeNull();
    const wrong = structuredClone(VERIFIED);
    (wrong.paragraphs[0]!.segments[1] as { value: number }).value = 25;
    expect(renderAnswer(wrong, EVIDENCE, CTX)).toBeNull();
    const prose = structuredClone(VERIFIED);
    prose.paragraphs[0]!.segments[0] = { kind: 'text', text: 'OFF-305 is 1 K warm and averaged ' };
    expect(renderAnswer(prose, EVIDENCE, CTX)).toBeNull();
    const missingCaveat = { ...VERIFIED, caveats: ['FLAGGED_EXCLUDED', 'SIM_SYNTHETIC_WEATHER'] } as AnswerDoc;
    expect(renderAnswer(missingCaveat, EVIDENCE, CTX)).toBeNull();
  });

  it('flattens to plain text for the dialogue history', () => {
    const text = answerPlainText(renderAnswer(VERIFIED, EVIDENCE, CTX)!);
    // No evidence ids: they restart every request, so the next turn's T1.E1
    // is a different record (review).
    expect(text.split('\n\n')[0]).toBe(
      'OFF-305 averaged 23.97 °C, 0.97 K above its design, with the damper near fully open.');
    expect(text).not.toMatch(/\b[TC]\d*\.E?\d+\b/);
    expect(text.split('\n\n')[1]).toBe('In the model, a warmer setpoint uses -10.7% energy.');
    expect(text).toContain(CAVEAT_TEXT.SIM_ANALYTICALLY_VERIFIED);
  });
});

describe('renderCard', () => {
  it('formats headline values from the data with the unit their key names', () => {
    const r = record('T1.E1', 'measured', {
      zone: 'OFF-305',
      metrics: { temperature_c: { mean_c: 23.9712, stale: false }, occupancy_count: { mean_count: 18.2 } },
      design: { level: 3 },
    }, {
      window: { from: '2026-09-28T09:00:00+04:00', to: '2026-09-28T12:40:00+04:00' },
      coverage: { good_count: 44, expected_count: 44 },
      flaggedExcluded_count: 0,
      headline: [
        { label: 'Temperature mean', path: 'metrics.temperature_c.mean_c' },
        { label: 'Occupancy mean', path: 'metrics.occupancy_count.mean_count' },
        { label: 'Zone', path: 'zone' },
        { label: 'Stale', path: 'metrics.temperature_c.stale' },
        { label: 'Level', path: 'design.level' },
        { label: 'Missing', path: 'metrics.co2_ppm.mean_ppm' },
      ],
    });
    const card = renderCard(r);
    expect(card.headline).toEqual([
      { label: 'Temperature mean', text: '24.0 °C' },
      { label: 'Occupancy mean', text: '18.2' },
      { label: 'Zone', text: 'OFF-305' },
      { label: 'Stale', text: 'no' },
      { label: 'Level', text: '3' },
      { label: 'Missing', text: '—' },
    ]);
    expect(card).toMatchObject({
      id: 'T1.E1', label: 'T1.E1 label', source: 'telemetry_5m', kind: 'measured',
      coverage: { good_count: 44, expected_count: 44 }, flaggedExcluded_count: 0, truncated: null,
    });
    expect(card).not.toHaveProperty('data');
    expect(card.caveatLines).toEqual([]);
  });

  it('carries its caveats as fixed lines, so a card shown instead of an answer is not bare (review)', () => {
    const energy = renderCard(record('T1.E1', 'measured', {}, { caveats: ['PLANT_NOT_ALLOCATED', 'FLOORS_WITHIN_2PCT'] }));
    expect(energy.caveatLines).toEqual([CAVEAT_TEXT.PLANT_NOT_ALLOCATED, CAVEAT_TEXT.FLOORS_WITHIN_2PCT]);
    // A simulated record carries the model-estimate line whether or not the tool attached it.
    const sim = renderCard(record('T2.E1', 'simulated', {}, { caveats: ['SIM_SYNTHETIC_WEATHER', 'SIM_PLANT_RESIZED_PER_RUN'] }));
    expect(sim.caveatLines).toEqual([
      CAVEAT_TEXT.SIM_ANALYTICALLY_VERIFIED, CAVEAT_TEXT.SIM_SYNTHETIC_WEATHER, CAVEAT_TEXT.SIM_PLANT_RESIZED_PER_RUN,
    ]);
  });
});
