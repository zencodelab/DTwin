import { describe, expect, it } from 'vitest';
import {
  UNIT_IDS, type AnswerDoc, type CaveatId, type EvidenceRecord, type NumSegment, type Ref, type Segment,
  type VerifyRule,
} from './evidence.ts';
import { lookupPath, verifyAnswer, verifyText, type VerifyContext } from './verify.ts';

// ---------------------------------------------------------------- fixtures

function record(
  id: string, kind: EvidenceRecord['kind'], data: unknown, caveats: CaveatId[] = [],
): EvidenceRecord {
  return {
    id, taskId: id.split('.')[0]!, tool: 'test', kind,
    source: kind === 'simulated' ? 'simulation' : kind === 'configured' ? 'directory' : 'telemetry_5m',
    label: id, window: null, coverage: null, flaggedExcluded_count: null, truncated: null,
    caveats, headline: [], data, at: '2026-09-28T12:40:00+04:00',
  };
}

const EVIDENCE: Record<string, EvidenceRecord> = {
  'C.1': record('C.1', 'configured', {
    building: { name: 'Corniche Tower', gross_floor_area_m2: 4800 },
    directory: [{ name: 'OFF-305', level: 3, designed_setpoint_c: 23.0, deadband_k: 1.0 }],
  }),
  // OFF-305 since 09:00 local, as the zone_conditions prototype measured it.
  'T1.E1': record('T1.E1', 'measured', {
    metrics: {
      temperature_c: { mean_c: 23.9712, min_c: 23.67, max_c: 24.26, max_at: '2026-09-28T11:05:00+04:00' },
      damper_position_pct: { mean_pct: 95.1 },
    },
    comfort: { occupied_min: 220 },
    rows: [{ energy_kwh: 10 }, { energy_kwh: 12.5 }],
    threshold: 27,
    stale: false,
  }),
  // A main-meter window with a suspect bucket.
  'T2.E1': record('T2.E1', 'measured', {
    total_kwh: 42220.4,
    total_excluding_suspect_kwh: 26682.5,
    implied_m3_per_h: 3.2,
    grid_carbon_kg_per_kwh: 0.4,
    coverage_pct: 86,
    other_coverage_pct: 95,
  }, ['METER_SUSPECT_BUCKETS']),
  'T3.E1': record('T3.E1', 'simulated', {
    baseline: { total_kwh: 88.5, max_occupied_c: 23.4 },
    scenarios: [{ name: 'plus-1', total_kwh: 79, delta_total_pct: -10.7345, max_occupied_c: 24.8 }],
  }, ['SIM_ANALYTICALLY_VERIFIED', 'SIM_SYNTHETIC_WEATHER']),
};

const CTX: VerifyContext = { availability: { forecastWeather: false } };

const ref = (evidenceId: string, path: string): Ref => ({ evidenceId, path });
const text = (t: string): Segment => ({ kind: 'text', text: t });
const cite = (...evidenceIds: string[]): Segment => ({ kind: 'cite', evidenceIds });

function num(over: Partial<NumSegment>): NumSegment {
  return {
    kind: 'num', value: 23.97, decimals: 2, unit: 'c', basis: 'measured',
    ref: ref('T1.E1', 'metrics.temperature_c.mean_c'), derive: null, ...over,
  };
}

function doc(segments: Segment[], caveats: CaveatId[] = []): AnswerDoc {
  return { paragraphs: [{ segments }], caveats };
}

const rules = (answer: AnswerDoc, ctx: VerifyContext | null = CTX): VerifyRule[] =>
  verifyAnswer(answer, EVIDENCE, ctx).map((v) => v.rule);

// ---------------------------------------------------------------- §10 cases

describe('verify: ref', () => {
  it('passes a value that rounds to what the evidence holds at the stated decimals', () => {
    expect(rules(doc([text('OFF-305 averaged '), num({})]))).toEqual([]);
  });

  it('fails a value the evidence does not hold', () => {
    const v = verifyAnswer(doc([num({ value: 23.99 })]), EVIDENCE, CTX);
    expect(v.map((x) => x.rule)).toEqual(['value_mismatch']);
    expect(v[0]!.detail).toContain('23.971');
  });

  it('fails a path that does not resolve', () => {
    expect(rules(doc([num({ ref: ref('T1.E1', 'metrics.temperature_c.median_c') })]))).toEqual(['ref']);
    expect(rules(doc([num({ ref: ref('T1.E1', 'metrics[0].mean_c') })]))).toEqual(['ref']);
    expect(rules(doc([num({ ref: ref('T1.E1', 'not a path') })]))).toEqual(['ref']);
  });

  it('fails a path that resolves to something other than a number', () => {
    expect(rules(doc([num({ ref: ref('T1.E1', 'metrics.temperature_c') })]))).toEqual(['ref']);
    expect(rules(doc([num({ ref: ref('T1.E1', 'metrics.temperature_c.max_at') })]))).toEqual(['ref']);
  });

  it('never follows a prototype or an array property', () => {
    expect(lookupPath({ a: 1 }, 'constructor').found).toBe(false);
    expect(lookupPath({ a: 1 }, 'toString').found).toBe(false);
    expect(lookupPath({ rows: [1, 2] }, 'rows.length').found).toBe(false);
    expect(lookupPath({ rows: [1, 2] }, 'rows[2]').found).toBe(false);
    expect(lookupPath({ rows: [1, 2] }, 'rows[1]')).toEqual({ found: true, value: 2, key: 'rows' });
  });

  it('indexes into arrays and takes the unit from the last named key', () => {
    const seg = num({ value: 12.5, decimals: 1, unit: 'kwh', ref: ref('T1.E1', 'rows[1].energy_kwh') });
    expect(rules(doc([seg]))).toEqual([]);
  });

  it('refuses a figure with no source, and one with both a ref and a derive', () => {
    expect(rules(doc([num({ ref: null })]))).toEqual(['ref']);
    const both = num({
      derive: { op: 'sum', refs: [ref('T1.E1', 'rows[0].energy_kwh'), ref('T1.E1', 'rows[1].energy_kwh')] },
    });
    expect(rules(doc([both]))).toEqual(['ref']);
  });
});

describe('verify: derive', () => {
  const tempDifference = (over: Partial<NumSegment> = {}) => num({
    value: 0.97, decimals: 2, unit: 'k', basis: 'derived', ref: null,
    derive: {
      op: 'difference',
      refs: [ref('T1.E1', 'metrics.temperature_c.mean_c'), ref('C.1', 'directory[0].designed_setpoint_c')],
    },
    ...over,
  });

  it('°C minus °C is a difference in K, across measured and configured evidence', () => {
    expect(rules(doc([text('That is '), tempDifference(), text(' above the designed setpoint.')]))).toEqual([]);
  });

  it('fails a temperature difference stated in °C', () => {
    expect(rules(doc([tempDifference({ unit: 'c' })]))).toEqual(['unit']);
  });

  it('fails a derived value that does not match its derivation', () => {
    expect(rules(doc([tempDifference({ value: 1.2 })]))).toEqual(['value_mismatch']);
  });

  it('percent_change runs from refs[0] to refs[1]', () => {
    const seg = num({
      value: -10.7, decimals: 1, unit: 'pct', basis: 'derived', ref: null,
      derive: {
        op: 'percent_change',
        refs: [ref('T3.E1', 'baseline.total_kwh'), ref('T3.E1', 'scenarios[0].total_kwh')],
      },
    });
    expect(rules(doc([seg], ['SIM_ANALYTICALLY_VERIFIED', 'SIM_SYNTHETIC_WEATHER']))).toEqual([]);
    expect(rules(doc([{ ...seg, value: 10.7 }], ['SIM_ANALYTICALLY_VERIFIED', 'SIM_SYNTHETIC_WEATHER'])))
      .toEqual(['value_mismatch']);
  });

  it('°C minus K is a temperature', () => {
    const seg = num({
      value: 22.5, decimals: 1, unit: 'c', basis: 'derived', ref: null,
      derive: {
        op: 'difference',
        refs: [ref('C.1', 'directory[0].designed_setpoint_c'), ref('C.1', 'directory[0].deadband_k')],
      },
    });
    // 23.0 − 1.0 = 22.0, so 22.5 fails on value, not on unit.
    expect(rules(doc([seg]))).toEqual(['value_mismatch']);
    expect(rules(doc([{ ...seg, value: 22 }]))).toEqual([]);
  });

  it('refuses the same ref twice: a doubled sum, a difference of zero (review)', () => {
    const twice = (op: 'sum' | 'difference' | 'percent_change', value: number, unit: NumSegment['unit'], paths: [string, string]) => num({
      value, decimals: 1, unit, basis: 'derived', ref: null,
      derive: { op, refs: [ref('T1.E1', paths[0]), ref('T1.E1', paths[1])] },
    });
    expect(rules(doc([text('The two floors used '), twice('sum', 25, 'kwh', ['rows[1].energy_kwh', 'rows[1].energy_kwh'])]))).toEqual(['derive']);
    expect(rules(doc([twice('difference', 0, 'kwh', ['rows[1].energy_kwh', 'rows[1].energy_kwh'])]))).toEqual(['derive']);
    expect(rules(doc([twice('percent_change', 0, 'pct', ['rows[1].energy_kwh', 'rows[1].energy_kwh'])]))).toEqual(['derive']);
    // One place, two spellings.
    expect(rules(doc([twice('sum', 25, 'kwh', ['rows[1].energy_kwh', 'rows[01].energy_kwh'])]))).toEqual(['derive']);
    expect(rules(doc([twice('sum', 22.5, 'kwh', ['rows[0].energy_kwh', 'rows[1].energy_kwh'])]))).toEqual([]);
  });

  it('sums within one unit, and refuses what does not add', () => {
    const sum = num({
      value: 22.5, decimals: 1, unit: 'kwh', basis: 'derived', ref: null,
      derive: { op: 'sum', refs: [ref('T1.E1', 'rows[0].energy_kwh'), ref('T1.E1', 'rows[1].energy_kwh')] },
    });
    expect(rules(doc([sum]))).toEqual([]);
    const temps = num({
      value: 47.2, decimals: 1, unit: 'c', basis: 'derived', ref: null,
      derive: {
        op: 'sum',
        refs: [ref('T1.E1', 'metrics.temperature_c.min_c'), ref('T1.E1', 'metrics.temperature_c.max_c')],
      },
    });
    expect(rules(doc([temps]))).toEqual(['derive']);
    const mixed = num({
      value: 1, decimals: 0, unit: 'kwh', basis: 'derived', ref: null,
      derive: { op: 'sum', refs: [ref('T1.E1', 'rows[0].energy_kwh'), ref('T1.E1', 'comfort.occupied_min')] },
    });
    expect(rules(doc([mixed]))).toEqual(['derive']);
  });

  it('refuses a difference of percentages: it would be percentage points', () => {
    const seg = num({
      value: 9, decimals: 0, unit: 'pct', basis: 'derived', ref: null,
      derive: { op: 'difference', refs: [ref('T2.E1', 'other_coverage_pct'), ref('T2.E1', 'coverage_pct')] },
    });
    expect(rules(doc([seg], ['METER_SUSPECT_BUCKETS']))).toEqual(['derive']);
  });

  it('refuses a derivation that mixes model output with a measurement', () => {
    const seg = num({
      value: 0.83, decimals: 2, unit: 'k', basis: 'derived', ref: null,
      derive: {
        op: 'difference',
        refs: [ref('T3.E1', 'scenarios[0].max_occupied_c'), ref('T1.E1', 'metrics.temperature_c.mean_c')],
      },
    });
    expect(rules(doc([seg], ['SIM_ANALYTICALLY_VERIFIED', 'SIM_SYNTHETIC_WEATHER']))).toEqual(['basis']);
  });

  it('insists a derivation says basis "derived", and a single ref does not', () => {
    expect(rules(doc([tempDifference({ basis: 'measured' })]))).toEqual(['basis']);
    expect(rules(doc([num({ basis: 'derived' })]))).toEqual(['derive']);
  });
});

describe('verify: unit', () => {
  it('fails kW over a key that names kWh', () => {
    const seg = num({ value: 42220, decimals: 0, unit: 'kw', ref: ref('T2.E1', 'total_kwh') });
    const clean = num({ value: 26682.5, decimals: 1, unit: 'kwh', ref: ref('T2.E1', 'total_excluding_suspect_kwh') });
    expect(rules(doc([seg, text(' raw, '), clean, text(' without suspects')], ['METER_SUSPECT_BUCKETS']))).toEqual(['unit']);
    expect(rules(doc([{ ...seg, unit: 'kwh' }, text(' raw, '), clean, text(' without suspects')], ['METER_SUSPECT_BUCKETS']))).toEqual([]);
  });

  it('fails a key with no unit suffix as uncitable', () => {
    const seg = num({ value: 27, decimals: 0, unit: 'c', ref: ref('T1.E1', 'threshold') });
    expect(rules(doc([seg]))).toEqual(['uncitable']);
  });

  it('does not read a compound "per" unit by its last token', () => {
    const flow = num({ value: 3.2, decimals: 1, unit: 'h', ref: ref('T2.E1', 'implied_m3_per_h') });
    const intensity = num({ value: 0.4, decimals: 1, unit: 'kwh', ref: ref('T2.E1', 'grid_carbon_kg_per_kwh') });
    expect(rules(doc([flow], ['METER_SUSPECT_BUCKETS']))).toEqual(['uncitable']);
    expect(rules(doc([intensity], ['METER_SUSPECT_BUCKETS']))).toEqual(['uncitable']);
  });
});

describe('verify: basis', () => {
  it('fails "measured" over simulated evidence', () => {
    const seg = num({ value: 79, decimals: 0, unit: 'kwh', basis: 'measured', ref: ref('T3.E1', 'scenarios[0].total_kwh') });
    expect(rules(doc([seg], ['SIM_ANALYTICALLY_VERIFIED', 'SIM_SYNTHETIC_WEATHER']))).toEqual(['basis']);
    expect(rules(doc([{ ...seg, basis: 'simulated' }], ['SIM_ANALYTICALLY_VERIFIED', 'SIM_SYNTHETIC_WEATHER'])))
      .toEqual([]);
  });

  it('passes "derived" across measured and configured evidence', () => {
    const seg = num({
      value: 0.97, decimals: 2, unit: 'k', basis: 'derived', ref: null,
      derive: {
        op: 'difference',
        refs: [ref('T1.E1', 'metrics.temperature_c.mean_c'), ref('C.1', 'directory[0].designed_setpoint_c')],
      },
    });
    expect(rules(doc([seg]))).toEqual([]);
  });

  it('fails "configured" over measured evidence', () => {
    expect(rules(doc([num({ basis: 'configured' })]))).toEqual(['basis']);
  });
});

describe('verify: text', () => {
  it('fails a quantity written as prose', () => {
    expect(rules(doc([text('OFF-305 is about 1 K warmer than it should be.')]))).toEqual(['unit_number_in_text']);
  });

  it('passes names, levels, clock times and ids', () => {
    expect(rules(doc([text('OFF-305 on Level 3 since 09:00')]))).toEqual([]);
  });

  const flagged = [
    '1 K', '1K', '.5 K', '23.97 °C', '23.97°C', '23 C', '1 degree', '2 degrees', '95%', '95 percent',
    '2,862 m³/h', '2862 m3/h', '15 kW', '1,172 kWh', '2 MW', '996 ppm', '200 m²', '5 m3', '4 kg',
    '2 h', '4 hours', 'a 2-hour override', '12 minutes', '30 s', '45 seconds', '3 zone-hours',
    '−2 K/h', '-2 K/h', '(23.97 °C)', '1 kelvin', '75 °F', '3 kilowatts',
  ];
  it.each(flagged)('flags %j', (s) => {
    expect(verifyText(`It was ${s} then.`, CTX).map((v) => v.rule)).toEqual(['unit_number_in_text']);
  });

  // Gate fix: compose is TOLD the unit ids (`_pct` is pct), so each id is a
  // spelling a model will use. "95 pct" and "3 zone_h" used to pass as prose.
  const bareIds = UNIT_IDS.filter((u) => u !== 'count');
  it.each(bareIds)('flags a figure followed by the bare unit id %j', (u) => {
    expect(verifyText(`It was 3 ${u} then.`, CTX).map((v) => v.rule)).toEqual(['unit_number_in_text']);
    expect(verifyText(`It was 3${u} then.`, CTX).map((v) => v.rule)).toEqual(['unit_number_in_text']);
  });

  const clean = [
    'OFF-305 on Level 3 since 09:00',
    'since 2026-09-28T09:00:00+04:00',
    'from 09:00 to 12:40 local time',
    '3 of 24 zones on 28 Sep',
    'the 4th floor and the 1st AHU',
    '2 chillers and 3 sensors were checked',
    'over the last 7 days',
    'T1.E1 and C.1 show it',
    'CO2 stayed under the alert threshold',
    'AHU-04 serves 6 zones',
    'at 3 pm on Monday',
    '5 to 10 people',
  ];
  it.each(clean)('passes %j', (s) => {
    expect(verifyText(s, CTX)).toEqual([]);
  });

  it('quotes the offending quantities, at most three', () => {
    const [v] = verifyText('1 K, 2 K, 3 K and 4 K', CTX);
    expect(v!.detail).toContain('"1 K"');
    expect(v!.detail).toContain('and 1 more');
  });
});

describe('verify: prose is read as the operator reads it', () => {
  it('joins consecutive text segments, so a quantity cannot be split across them', () => {
    const v = verifyAnswer(doc([text('OFF-305 is about 1'), text(' K warmer.')]), EVIDENCE, CTX);
    expect(v).toMatchObject([{ segment: 0, rule: 'unit_number_in_text' }]);
    expect(v[0]!.detail).toMatch(/^paragraph 1, segments 1–2: /);
    expect(rules(doc([text('The model is valid'), text('ated.')]))).toEqual(['banned_word']);
  });

  it('reads straight through a citation chip', () => {
    expect(rules(doc([text('about 1'), cite('T1.E1'), text(' K warmer')]))).toEqual(['unit_number_in_text']);
  });

  it('does not join prose across a figure', () => {
    expect(rules(doc([text('OFF-305 on Level 3 averaged '), num({}), text(' since 09:00.')]))).toEqual([]);
  });

  it('refuses prose that runs into a figure and changes how it reads', () => {
    // "about 1" + 0.97 K would render "about 10.97 K".
    const diff = num({
      value: 0.97, decimals: 2, unit: 'k', basis: 'derived', ref: null,
      derive: {
        op: 'difference',
        refs: [ref('T1.E1', 'metrics.temperature_c.mean_c'), ref('C.1', 'directory[0].designed_setpoint_c')],
      },
    });
    expect(rules(doc([text('about 1'), diff]))).toEqual(['glued_figure']);
    expect(rules(doc([text('a change of -'), diff]))).toEqual(['glued_figure']);
    expect(rules(doc([text('a change of − '), diff]))).toEqual(['glued_figure']);
    expect(rules(doc([text('about 1'), cite('C.1'), diff]))).toEqual(['glued_figure']);
    const people = num({ value: 220, decimals: 0, unit: 'min', ref: ref('T1.E1', 'comfort.occupied_min') });
    expect(rules(doc([people, text('0 more')]))).toEqual(['glued_figure']);
    expect(rules(doc([text('It was '), num({}), people]))).toEqual(['glued_figure']);
    expect(rules(doc([text('Level 3, '), num({}), text(', and rising.')]))).toEqual([]);
  });

  it('catches digits and spaces that only look different', () => {
    for (const s of ['23.97\u00a0°C', '5\u202fkW', '\u0661 K', '\uff11 K']) {
      expect(verifyText(`It was ${s}.`, CTX).map((v) => v.rule), s).toEqual(['unit_number_in_text']);
    }
  });

  it('reads through an EMPTY text segment, which renders as nothing (review)', () => {
    // [text "about 1", text "", num 0.5 K] rendered "about 10.5 K" and verified.
    const diff = num({
      value: 0.97, decimals: 2, unit: 'k', basis: 'derived', ref: null,
      derive: {
        op: 'difference',
        refs: [ref('T1.E1', 'metrics.temperature_c.mean_c'), ref('C.1', 'directory[0].designed_setpoint_c')],
      },
    });
    expect(rules(doc([text('about 1'), text(''), diff]))).toEqual(['glued_figure']);
    expect(rules(doc([text('moved -'), text(''), diff]))).toEqual(['glued_figure']);
    expect(rules(doc([text('moved -'), text(' '), diff]))).toEqual(['glued_figure']);
    expect(rules(doc([text('about 1'), text(''), cite('C.1'), text(''), diff]))).toEqual(['glued_figure']);
    expect(rules(doc([diff, text(''), text('0 more')]))).toEqual(['glued_figure']);
    expect(rules(doc([diff, text(''), diff]))).toEqual(['glued_figure']);
    expect(rules(doc([text('It moved '), text(''), diff, text(''), text(' since 09:00.')]))).toEqual([]);
  });

  it('refuses text after a figure that reads as more of its unit (review)', () => {
    const count = num({ value: 220, decimals: 0, unit: 'count', ref: ref('T1.E1', 'comfort.occupied_count') });
    const counted = { ...EVIDENCE, 'T1.E1': { ...EVIDENCE['T1.E1']!, data: { ...(EVIDENCE['T1.E1']!.data as object), comfort: { occupied_count: 220 } } } };
    const r = (segments: Segment[]) => verifyAnswer(doc(segments), counted, CTX).map((v) => v.rule);
    expect(r([count, text('% above design.')])).toEqual(['glued_figure']);
    expect(r([count, text(' kWh more.')])).toEqual(['glued_figure']);
    expect(r([count, text(' minutes of good data.')])).toEqual(['glued_figure']);
    expect(r([count, text('k visitors.')])).toEqual(['glued_figure']);
    expect(r([count, cite('T1.E1'), text(' hours.')])).toEqual(['glued_figure']);
    const kw = num({ value: 12.5, decimals: 1, unit: 'kwh', ref: ref('T1.E1', 'rows[1].energy_kwh') });
    expect(rules(doc([kw, text('h over the day.')]))).toEqual(['glued_figure']);
    expect(rules(doc([num({}), text('F in OFF-305.')]))).toEqual(['glued_figure']);
    // Words, a space or punctuation after a figure are fine.
    expect(r([count, text(' people in the zone.')])).toEqual([]);
    expect(rules(doc([kw, text(' over the day.')]))).toEqual([]);
    expect(rules(doc([num({}), text(', in OFF-305.')]))).toEqual([]);
  });

  it('catches the units and money a building answer reaches for, and prefixes (review)', () => {
    for (const s of [
      '25 degC', '12 tons of CO2', '1.2 t CO2', '2 RT', '20 BTU', '12 GJ', '400 l/s', '20 cfm',
      'AED 1,200 a month', '300 AED', '$300', 'Δ1.5 K', 'x2 kWh', '5k visitors', '2M kWh',
    ]) {
      expect(verifyText(`It is ${s} now.`, CTX).map((v) => v.rule), s).toEqual(['unit_number_in_text']);
    }
    // Still not quantities: names, ids, clock times, levels, ordinals.
    for (const s of ['OFF-305', 'T1.E1', '09:00', 'Level 3', 'the 3rd floor', 'AHU-04', 'max2']) {
      expect(verifyText(`See ${s} now.`, CTX), s).toEqual([]);
    }
  });

  it('refuses invisible format characters, and reads the text as shown without them (review)', () => {
    const zwsp = '\u200b';
    expect(verifyText(`about 1${zwsp} K warmer`, CTX).map((v) => v.rule)).toEqual(['invisible_character', 'unit_number_in_text']);
    expect(verifyText(`the model is valida${zwsp}ted`, CTX).map((v) => v.rule)).toEqual(['invisible_character', 'banned_word']);
    expect(verifyText('valid\u00adated', CTX).map((v) => v.rule)).toEqual(['invisible_character', 'banned_word']);
    expect(verifyText('about \u202eK 1', CTX).map((v) => v.rule)).toContain('invisible_character');
    expect(rules(doc([text(`It rose${zwsp} `), num({})]))).toEqual(['invisible_character']);
  });
});

describe('verify: caveats and banned words', () => {
  const simulated = num({
    value: 79, decimals: 0, unit: 'kwh', basis: 'simulated', ref: ref('T3.E1', 'scenarios[0].total_kwh'),
  });

  it('fails a simulated citation without SIM_ANALYTICALLY_VERIFIED', () => {
    const v = verifyAnswer(doc([simulated], ['SIM_SYNTHETIC_WEATHER']), EVIDENCE, CTX);
    expect(v.map((x) => x.rule)).toEqual(['caveat_required']);
    expect(v[0]!.detail).toContain('SIM_ANALYTICALLY_VERIFIED');
  });

  it('requires SIM_ANALYTICALLY_VERIFIED even when the tool forgot to attach it', () => {
    const forgetful = { ...EVIDENCE, 'T3.E1': { ...EVIDENCE['T3.E1']!, caveats: [] } };
    expect(verifyAnswer(doc([simulated]), forgetful, CTX).map((x) => x.rule)).toEqual(['caveat_required']);
    expect(verifyAnswer(doc([simulated], ['SIM_ANALYTICALLY_VERIFIED']), forgetful, CTX)).toEqual([]);
  });

  it('never allows "validated"', () => {
    expect(rules(doc([text('The model is validated.')]))).toEqual(['banned_word']);
    expect(rules(doc([text('Validation shows a saving.')]))).toEqual(['banned_word']);
    expect(verifyText('the model is validated', { availability: { forecastWeather: true } })
      .map((v) => v.rule)).toEqual(['banned_word']);
  });

  it('refuses "forecast" unless forecast weather exists', () => {
    expect(rules(doc([text('Tomorrow\'s forecast is hot.')]))).toEqual(['banned_word']);
    expect(rules(doc([text('Tomorrow\'s forecast is hot.')]), null)).toEqual(['banned_word']);
    expect(rules(doc([text('Tomorrow\'s forecast is hot.')]), { availability: { forecastWeather: true } }))
      .toEqual([]);
  });
});

describe('verify: required caveats', () => {
  it('fails an answer citing evidence with METER_SUSPECT_BUCKETS but omitting it', () => {
    const seg = num({ value: 42220.4, decimals: 1, unit: 'kwh', ref: ref('T2.E1', 'total_kwh') });
    const clean = num({ value: 26682.5, decimals: 1, unit: 'kwh', ref: ref('T2.E1', 'total_excluding_suspect_kwh') });
    const both = [seg, text(' raw, '), clean, text(' without suspects')];
    expect(rules(doc(both))).toEqual(['caveat_required']);
    expect(rules(doc(both, ['METER_SUSPECT_BUCKETS']))).toEqual([]);
  });

  it('counts a bare citation as citing', () => {
    expect(rules(doc([text('See the meter.'), cite('T2.E1')]))).toEqual(['caveat_required']);
    expect(rules(doc([text('See the meter.'), cite('T2.E1')], ['METER_SUSPECT_BUCKETS']))).toEqual([]);
  });

  it('allows a caveat carried by evidence from this request, cited or not', () => {
    expect(rules(doc([num({})], ['METER_SUSPECT_BUCKETS']))).toEqual([]);
  });

  it('refuses a caveat no evidence from this request carries: its fixed text would be false (review)', () => {
    // Floors 1,000 against 1,400 kWh, and "FLOORS_WITHIN_2PCT" beside them.
    const v = verifyAnswer(doc([num({})], ['FLOORS_WITHIN_2PCT', 'NO_WEATHER_STORED']), EVIDENCE, CTX);
    expect(v.map((x) => x.rule)).toEqual(['caveat_unsupported', 'caveat_unsupported']);
    expect(v[0]!.detail).toMatch(/FLOORS_WITHIN_2PCT/);
    // The model-estimate caveat needs something simulated in the request; the check-mode one is a standing fact.
    const measuredOnly = { 'T1.E1': EVIDENCE['T1.E1']! };
    expect(verifyAnswer(doc([num({})], ['SIM_ANALYTICALLY_VERIFIED']), measuredOnly, CTX).map((x) => x.rule))
      .toEqual(['caveat_unsupported']);
    expect(verifyAnswer(doc([num({})], ['NO_SCHEDULED_START']), measuredOnly, CTX)).toEqual([]);
  });

  it('gives a meter\'s two totals together, never one alone, when it has suspect periods (review)', () => {
    const raw = num({ value: 42220.4, decimals: 1, unit: 'kwh', ref: ref('T2.E1', 'total_kwh') });
    const clean = num({ value: 26682.5, decimals: 1, unit: 'kwh', ref: ref('T2.E1', 'total_excluding_suspect_kwh') });
    const caveats: CaveatId[] = ['METER_SUSPECT_BUCKETS'];
    expect(rules(doc([text('The main meter recorded '), clean, text('.')], caveats))).toEqual(['unpaired_total']);
    expect(rules(doc([text('The main meter recorded '), raw, text('.')], caveats))).toEqual(['unpaired_total']);
    expect(rules(doc([text('Raw '), raw, text(', or '), clean, text(' without suspect periods.')], caveats))).toEqual([]);
    // Not across paragraphs: the pair is read together.
    expect(rules({ paragraphs: [{ segments: [text('Raw '), raw] }, { segments: [text('Clean '), clean] }], caveats }))
      .toEqual(['unpaired_total', 'unpaired_total']);
    // No clean period at all: there is no second total to give.
    const none = { ...EVIDENCE, 'T2.E1': { ...EVIDENCE['T2.E1']!, data: { ...(EVIDENCE['T2.E1']!.data as object), total_excluding_suspect_kwh: null } } };
    expect(verifyAnswer(doc([text('Raw '), raw, text('.')], caveats), none, CTX)).toEqual([]);
  });
});

describe('verify: evidence scope and size', () => {
  it('fails an id this request did not produce', () => {
    expect(rules(doc([cite('T5.E1')]))).toEqual(['evidence_scope']);
    expect(rules(doc([num({ ref: ref('T5.E1', 'metrics.temperature_c.mean_c') })]))).toEqual(['evidence_scope']);
  });

  it('fails too_long at 49 segments and passes at 48', () => {
    const most = Array.from({ length: 48 }, () => text('x'));
    expect(rules(doc(most))).toEqual([]);
    expect(rules(doc([...most, text('x')]))).toEqual(['too_long']);
  });

  it('passes 1,600 characters of text and fails past them', () => {
    const most = Array.from({ length: 4 }, () => text('a'.repeat(400)));
    expect(rules(doc(most))).toEqual([]);
    expect(rules(doc([...most, text('a')]))).toEqual(['too_long']);
  });

  it('passes the drafts the first real runs refused on length alone (E2E)', () => {
    // Q2's first draft (41 segments, 1,232 characters) and Q4r's (1,335
    // characters) were refused whole for length and nothing else, and each
    // redraft cost 20–40 s. The longest, Q4's 1,551, is inside the bound too.
    for (const [segments, chars] of [[41, 1_232], [40, 1_335], [41, 1_551]] as const) {
      const each = Math.floor(chars / segments);
      const draft = Array.from({ length: segments }, (_, i) => text('a'.repeat(i === 0 ? chars - each * (segments - 1) : each)));
      expect(draft.reduce((n, s) => n + (s.kind === 'text' ? s.text.length : 0), 0)).toBe(chars);
      expect(rules(doc(draft)), `${segments} segments, ${chars} characters`).toEqual([]);
    }
  });

  it('reports a malformed document as shape, not as a crash', () => {
    const bad = { paragraphs: [{ segments: [{ ...num({}), decimals: 7 }] }], caveats: [] } as unknown as AnswerDoc;
    expect(rules(bad)).toEqual(['shape']);
    expect(rules({ paragraphs: [], caveats: [] })).toEqual(['shape']);
  });

  it('numbers segments across paragraphs and names them for the model', () => {
    const answer: AnswerDoc = {
      paragraphs: [
        { segments: [text('fine')] },
        { segments: [text('also fine '), num({ value: 25 })] },
      ],
      caveats: [],
    };
    const [v] = verifyAnswer(answer, EVIDENCE, CTX);
    expect(v).toMatchObject({ segment: 2, rule: 'value_mismatch' });
    expect(v!.detail).toMatch(/^paragraph 2, segment 2: /);
  });
});

describe('verify: rounding agrees with what the operator sees', () => {
  it('accepts either neighbour of an exact half, and nothing further', () => {
    const e = { 'T1.E1': record('T1.E1', 'measured', { v_c: 23.965 }) };
    const at = (value: number) => verifyAnswer(
      doc([num({ value, ref: ref('T1.E1', 'v_c') })]), e, CTX).map((v) => v.rule);
    expect(at(23.97)).toEqual([]);
    expect(at(23.96)).toEqual([]);
    expect(at(23.95)).toEqual(['value_mismatch']);
    expect(at(23.98)).toEqual(['value_mismatch']);
  });

  it('judges the displayed value, not the raw one the model sent', () => {
    // 23.9749 displays as 23.97, which is within half a step of 23.9712.
    expect(rules(doc([num({ value: 23.9749 })]))).toEqual([]);
    // 23.9761 displays as 23.98, which is not.
    expect(rules(doc([num({ value: 23.9761 })]))).toEqual(['value_mismatch']);
  });
});
