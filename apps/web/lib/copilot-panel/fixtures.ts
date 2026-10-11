import type { CopilotTurn, PendingPlan } from '../copilot/protocol.ts';

/**
 * Hand-built turns for the panel's unit tests. Test-only: nothing in the app
 * imports this. The integration test folds turns and events from a REAL run
 * on the core's fakes instead (`panel.test.ts`); these exist for the edge
 * cases a scripted run does not reach cheaply.
 */

export const PLAN_ID = '6f1c2b8e-4c1d-4a8e-9a57-2f7d9b0c1e11';
export const PLAN_HASH = 'a'.repeat(64);
export const ZONE_A = '11111111-1111-4111-8111-111111111111';

export function turnFixture(over: Partial<CopilotTurn> = {}): CopilotTurn {
  return {
    requestId: 'req-1',
    running: false,
    dialogue: [{ role: 'operator', text: 'why is OFF-305 warm?' }],
    answer: null,
    interpretation: null,
    message: null,
    cards: [],
    tasks: [],
    pendingPlan: null,
    outcomes: [],
    notices: [],
    usage: null,
    models: { lead: 'claude-opus-5', specialist: 'claude-opus-5' },
    ...over,
  };
}

export function planFixture(over: Partial<PendingPlan> = {}): PendingPlan {
  return {
    interruptId: 'int-1',
    planId: PLAN_ID,
    planHash: PLAN_HASH,
    checkedAt: '2026-09-28T08:40:00.000Z',
    expiresAt: '2026-09-28T08:50:00.000Z',
    summary: 'Raise OFF-301 ahead of the afternoon peak.',
    commands: [{
      zoneId: ZONE_A, zoneName: 'OFF-301', setpointTempC: 24, durationS: 7200, reason: 'pre-cool',
      verdict: { allowed: true, previousTempC: 23, durationS: 7200, effectiveUntil: '2026-09-28T10:40:00.000Z' },
    }],
    simulation: null,
    ...over,
  };
}

export const card = (id: string, over: Partial<CopilotTurn['cards'][number]> = {}): CopilotTurn['cards'][number] => ({
  id, label: `record ${id}`, source: 'telemetry_5m', kind: 'measured', window: null, coverage: null,
  flaggedExcluded_count: null, truncated: null, headline: [], caveatLines: [], ...over,
});
