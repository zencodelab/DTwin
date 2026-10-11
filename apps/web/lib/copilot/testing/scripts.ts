import type Anthropic from '@anthropic-ai/sdk';
import type { CaveatId, EvidenceRecord } from '../evidence.ts';
import { Z, composeMsg, message, plannerMsg, toolUse, type Script } from './fakes.ts';
import { dataOf } from './run.ts';

/**
 * Model scripts more than one test file runs. Excluded from the source scan.
 */

export const SINCE_9 = '2026-09-28T09:00:00+04:00';
export const NOW_LOCAL = '2026-09-28T12:40:00+04:00';
/** Tomorrow's working day, for what-ifs. */
export const SIM_FROM = '2026-09-29T08:00:00+04:00';
export const SIM_TO = '2026-09-29T20:00:00+04:00';

export const report = (
  claims: Array<{ text: string; evidenceIds: string[] }> = [], status = 'answered', caveats: CaveatId[] = [],
) => toolUse('report_finding', { status, summary: 'done', claims, openQuestions: [], caveats });

/**
 * The control fast path (v1's behaviour): the planner hands a setpoint
 * request straight to the controller, which proposes two commands and
 * reports in the same turn. Stops at confirm.
 */
export const fastPathScript = (): Script => ({
  planner: [plannerMsg({ intent: 'control', next: 'control', allowControl: true, controlTask: { mode: 'propose', brief: 'pre-cool L3 offices' } })],
  control: [message([
    toolUse('propose_plan', {
      summary: 'Raise OFF-301 and OFF-303 ahead of the afternoon peak.',
      commands: [
        { zoneId: Z.off301, setpointTempC: 24.5, durationS: 7200, reason: 'pre-cool for the afternoon peak' },
        { zoneId: Z.off303, setpointTempC: 24.5, durationS: 7200, reason: 'pre-cool for the afternoon peak' },
      ],
    }),
    report(),
  ])],
});

/**
 * The compound question (Q3): wave 1 diagnoses the Level 3 offices, wave 2
 * simulates a uniform +1 K against baseline, compose answers from the
 * simulation (citing it as a model estimate, with its caveats), then the
 * controller proposes exactly the simulated shift — basis T2.E1 / plus-1.
 * Needs `scenarios: 'ok'`. Stops at confirm.
 */
export function compoundScript(): Script {
  const zones = [Z.off301, Z.off303];
  const composeStep = (params: Anthropic.MessageCreateParamsNonStreaming) => {
    const evidence = dataOf(params).evidence as EvidenceRecord[];
    const sim = evidence.find((e) => e.id === 'T2.E1')! as EvidenceRecord & { data: { scenarios: Array<{ delta_total_kwh: number }> } };
    const delta = Math.round(sim.data.scenarios[0]!.delta_total_kwh * 10) / 10;
    return composeMsg({
      paragraphs: [{
        segments: [
          { kind: 'text', text: 'In the model, raising both offices changes the energy used by ' },
          { kind: 'num', value: delta, decimals: 1, unit: 'kwh', basis: 'simulated', ref: { evidenceId: 'T2.E1', path: 'scenarios[0].delta_total_kwh' }, derive: null },
          { kind: 'text', text: ' over the day, a model estimate.' },
          { kind: 'cite', evidenceIds: ['T2.E1'] },
        ],
      }],
      caveats: [...new Set(evidence.filter((e) => e.id === 'T2.E1').flatMap((e) => e.caveats))],
    });
  };
  return {
    planner: [
      plannerMsg({
        intent: 'compound', allowControl: true, allowSimulation: true, next: 'dispatch',
        tasks: [{ specialist: 'diagnose', goal: 'check the Level 3 offices', zoneIds: zones, from: SINCE_9, to: NOW_LOCAL }],
      }),
      plannerMsg({
        next: 'dispatch',
        tasks: [{ specialist: 'simulate', goal: 'simulate a uniform shift against baseline', zoneIds: zones, from: SIM_FROM, to: SIM_TO }],
      }),
      plannerMsg({
        next: 'compose',
        controlTask: { mode: 'propose', brief: 'propose the shift that was simulated', inputEvidenceIds: ['T2.E1'] },
      }),
    ],
    'diagnose:T1': [message([toolUse('zone_conditions', { zoneId: Z.off301, from: SINCE_9, to: NOW_LOCAL })]), message([report()])],
    'simulate:T2': [
      message([toolUse('simulate_scenarios', {
        zoneIds: zones, from: SIM_FROM, to: SIM_TO, peakDryBulbC: 46, minDryBulbC: 32, peakGhiWM2: 950,
        scenarios: [{ name: 'plus-1', setpointDeltaK: 1 }],
      })]),
      message([report([{ text: 'a uniform shift saves energy in the model', evidenceIds: ['T2.E1'] }])]),
    ],
    compose: [composeStep],
    control: [
      message([toolUse('list_zones', {})]),
      message([
        toolUse('propose_plan', {
          summary: 'Raise both Level 3 offices, as simulated.',
          commands: zones.map((zoneId) => ({ zoneId, setpointTempC: 24, durationS: 7200, reason: 'follow the simulated shift' })),
          basis: { evidenceId: 'T2.E1', scenario: 'plus-1' },
        }),
        report(),
      ]),
    ],
  };
}
