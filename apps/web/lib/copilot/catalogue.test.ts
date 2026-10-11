import { describe, expect, it } from 'vitest';
import { CAVEAT_TEXT, caveatLines } from './caveats.ts';
import { CAVEAT_IDS, EvidenceRecord, Finding } from './evidence.ts';
import { DEFAULT_LIMITS, resolveLimits } from './limits.ts';
import { NOTICE_CODES, NOTICE_PARAMS, NOTICE_TEMPLATES, Notice, noticeText } from './notices.ts';

describe('caveat catalogue', () => {
  it('has text for every code, and says "analytically verified" for model output', () => {
    for (const id of CAVEAT_IDS) expect(CAVEAT_TEXT[id].length).toBeGreaterThan(20);
    expect(CAVEAT_TEXT.SIM_ANALYTICALLY_VERIFIED).toContain('analytically verified, not validated');
  });

  it('renders codes in catalogue order, once each', () => {
    expect(caveatLines(['NO_STATUS_HISTORY', 'SIM_SUBSET', 'NO_STATUS_HISTORY'])).toEqual([
      CAVEAT_TEXT.SIM_SUBSET, CAVEAT_TEXT.NO_STATUS_HISTORY,
    ]);
  });
});

describe('notices', () => {
  it('declares exactly the placeholders each template uses', () => {
    for (const code of NOTICE_CODES) {
      const used = [...NOTICE_TEMPLATES[code].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(used, code).toEqual([...NOTICE_PARAMS[code]].sort());
    }
  });

  it('fills parameters, and costs a word rather than the turn when one is missing', () => {
    expect(noticeText({ code: 'plan_refused', params: { zone: 'OFF-305', message: 'AHU-04 (fault)' } }))
      .toBe('No plan is shown: the safety envelope now refuses OFF-305 (AHU-04 (fault)). Nothing was issued.');
    expect(noticeText({ code: 'budget', params: {} })).toContain('limit of — model calls');
    expect(noticeText({ code: 'budget', params: { calls: 40 } })).toContain('limit of 40 model calls');
  });

  it('cuts a long parameter', () => {
    const text = noticeText({ code: 'plan_refused', params: { zone: 'OFF-305', message: 'x'.repeat(500) } });
    expect(text.length).toBeLessThan(300);
    expect(text).toContain('…');
  });

  it('parses at the boundary', () => {
    expect(Notice.safeParse({ code: 'plan_superseded', params: {} }).success).toBe(true);
    expect(Notice.safeParse({ code: 'made_up', params: {} }).success).toBe(false);
  });
});

describe('evidence schemas', () => {
  const base = {
    id: 'T1.E1', taskId: 'T1', tool: 'zone_conditions', kind: 'measured', source: 'telemetry_5m',
    label: 'OFF-305 conditions', window: null, coverage: null, flaggedExcluded_count: null,
    truncated: null, caveats: [], headline: [], data: { mean_c: 1 }, at: '2026-09-28T12:40:00+04:00',
  };

  it('accepts a well-formed record', () => {
    expect(EvidenceRecord.safeParse(base).success).toBe(true);
  });

  it('refuses a record filed under another task, or with no data', () => {
    expect(EvidenceRecord.safeParse({ ...base, taskId: 'T2' }).success).toBe(false);
    const { data: _data, ...noData } = base;
    expect(EvidenceRecord.safeParse(noData).success).toBe(false);
    expect(EvidenceRecord.safeParse({ ...base, id: 'T9.E1', taskId: 'T9' }).success).toBe(false);
    expect(EvidenceRecord.safeParse({ ...base, caveats: ['MADE_UP'] }).success).toBe(false);
  });

  it('parses a finding with the report_finding bounds', () => {
    const finding = {
      taskId: 'T1', specialist: 'diagnose', status: 'answered', reason: null, summary: 'VAV near capacity',
      claims: [{ text: 'damper near fully open', evidenceIds: ['T1.E1'] }], openQuestions: [],
      caveats: [], evidenceIds: ['T1.E1'],
    };
    expect(Finding.safeParse(finding).success).toBe(true);
    expect(Finding.safeParse({ ...finding, claims: [{ text: 'x', evidenceIds: [] }] }).success).toBe(false);
  });
});

describe('limits', () => {
  it('carries the §8 numbers', () => {
    // §8 said 2 simulate tasks; one request makes one simulate_scenarios
    // call, so a second task could only be refused (route stage, gate issue).
    // §8 said a 180 s deadline; the first real compound run reached it with
    // its plan ready and lost the plan (E2E stage, ADR 64), so it is 300 s.
    // §8 said 40 segments and 1,200 characters; four of the five first
    // drafts measured were over, two on length alone, so they are 48 and
    // 1,600 (ADR 64) — while compose is still asked for 900 and 30.
    expect(DEFAULT_LIMITS).toMatchObject({
      maxWaves: 3, maxTasksPerWave: 4, maxTasksPerRequest: 8, maxSimulateTasksPerRequest: 1,
      maxConcurrency: 3, maxModelCalls: 40, deadlineS: 300, maxTokens: 16_000,
      maxSpecialistTurns: 6, maxToolCallsPerTurn: 6, maxToolCallsPerTask: 12, maxPlannerRepairs: 1,
      maxDrafts: 3, maxEvidenceBytes: 8192, maxEvidencePerRequest: 60, maxComposeEvidenceBytes: 65_536,
      maxAnswerParagraphs: 6, maxAnswerSegments: 48, maxAnswerTextChars: 1600,
      zoneConditionsMaxWindowH: 168, zoneHistoryMaxWindowH: 48, energyByEndUseMaxWindowH: 744,
      meterHourMaxWindowH: 168, meterLocalDayMaxWindowH: 2208, simMaxWindowH: 72,
      simRunsPerRequest: 3, simRunsPerUserPerHour: 12, simMaxZoneH: 10_000, simRunDeadlineS: 45,
      maxPlanCommands: 12, planTtlS: 600, grantTtlS: 120, recursionLimit: 40,
      dialogueKept: 40, dialogueTail: 6, maxRequestTextChars: 2000, maxGraphs: 200,
    });
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
  });

  it('applies overrides and refuses ones that would disable a bound', () => {
    expect(resolveLimits({ maxModelCalls: 6 }).maxModelCalls).toBe(6);
    expect(resolveLimits({ maxModelCalls: undefined }).maxModelCalls).toBe(40);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveLimits({ maxModelCalls: bad }), String(bad)).toThrow(RangeError);
    }
    expect(() => resolveLimits({ madeUp: 1 } as never)).toThrow(RangeError);
  });
});
