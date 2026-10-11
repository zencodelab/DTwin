import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { TWIN_READER_METHODS, type ReaderMethod, type TwinReader } from './deps.ts';
import { unitOfKey } from './units.ts';
import {
  BUILDING_ID, COPILOT_PRECOOL_REASON, FAKE_NOW_ISO, TENANT_ID, USER_ID, Z, composeMsg, fakeDeps,
  fakeProbe, fakeReader, fakeScenarios, fakeSimRows, message, plannerMsg, scriptKey, scriptedModel,
  text, toolUse, zoneById,
} from './testing/fakes.ts';

/**
 * The fakes are what every later copilot test stands on, so what they
 * promise is pinned here: strictness, the §6 fixture figures, the routing of
 * the scripted model, the simulation rows the what-if tests reason about,
 * and a clock that only moves when told to.
 */

const NOW = Date.parse(FAKE_NOW_ISO);
const SINCE_9_LOCAL = new Date('2026-09-28T05:00:00Z');   // 09:00 in Asia/Dubai
const WEEK_AGO = new Date(NOW - 7 * 24 * 3_600_000);

/** Every query a fake reader answers, so the lint below sees every shape. */
const EVERY_READ: ReadonlyArray<readonly [ReaderMethod, (r: TwinReader) => Promise<unknown>]> = [
  ['orient', (r) => r.orient()],
  ['listZones', (r) => r.listZones()],
  ['zoneConditions', (r) => r.zoneConditions({ zoneId: Z.off305, from: SINCE_9_LOCAL, to: new Date(NOW) })],
  ['zoneHistory', (r) => r.zoneHistory({
    zoneId: Z.off305, metrics: ['temperature_c', 'damper_position_pct', 'airflow_cmh', 'occupancy_count'],
    resolution: '5m', from: new Date(NOW - 4 * 3_600_000), to: new Date(NOW),
  })],
  ['zoneTimeline', (r) => r.zoneTimeline({ zoneId: Z.off305, from: WEEK_AGO, to: new Date(NOW), limit: 50 })],
  ['equipmentStatus', (r) => r.equipmentStatus({ tag: null, zoneId: null, limit: 40, buildingId: BUILDING_ID })],
  ['listAlerts', (r) => r.listAlerts({ state: 'any', from: WEEK_AGO, to: new Date(NOW), zoneId: null, limit: 50, buildingId: BUILDING_ID })],
  ['controlHistory', (r) => r.controlHistory({ zoneId: null, from: WEEK_AGO, to: new Date(NOW), limit: 50, buildingId: BUILDING_ID })],
  ['energyByEndUse', (r) => r.energyByEndUse({ from: WEEK_AGO, to: new Date(NOW), groupBy: 'floor_end_use', timezone: 'Asia/Dubai', buildingId: BUILDING_ID })],
  ['meterConsumption', (r) => r.meterConsumption({
    meterTag: 'MTR-MAIN', from: new Date('2026-09-23T18:00:00Z'), to: new Date('2026-09-24T06:00:00Z'),
    bucket: 'hour', timezone: 'Asia/Dubai', buildingId: BUILDING_ID,
  })],
  ['compareZones', (r) => r.compareZones({
    metric: 'temperature_c', from: WEEK_AGO, to: new Date(NOW), floorLevel: null, orderBy: 'minutes_above_band', limit: 24,
    now: new Date(NOW), buildingId: BUILDING_ID,
  })],
];

describe('strict capabilities', () => {
  it('throw on any property their interface does not declare', () => {
    const d = fakeDeps({ scenarios: 'ok' });
    expect(() => (d.deps.reader as unknown as Record<string, unknown>).issue).toThrow(/TwinReader\.issue is not part/);
    expect(() => (d.deps.probe as unknown as Record<string, unknown>).issue).toThrow(/ControlProbe\.issue/);
    expect(() => (d.deps.scenarios as unknown as Record<string, unknown>).fetch).toThrow(/ScenarioRunner\.fetch/);
    expect(() => (d.deps.issuer as unknown as Record<string, unknown>).settings).toThrow(/Issuer\.settings/);
    expect(() => { (d.deps.reader as unknown as Record<string, unknown>).orient = null; }).toThrow(/not writable/);
  });

  it('stay ordinary values: awaitable, serialisable, and their own methods work', async () => {
    const { reader } = fakeReader();
    expect(await Promise.resolve(reader)).toBe(reader);
    expect(JSON.stringify(reader)).toBe('{}');
    expect((await reader.orient()).building?.name).toBe('Corniche Tower');
  });
});

describe('fake reader', () => {
  it('answers OFF-305 since 09:00 with the §6 figures and full coverage', async () => {
    const { reader } = fakeReader();
    const c = await reader.zoneConditions({ zoneId: Z.off305, from: SINCE_9_LOCAL, to: new Date(NOW) });
    expect(c?.zone.name).toBe('OFF-305');
    expect(c?.metrics.temperature_c).toMatchObject({ mean_c: 23.9712, good_buckets_count: 44, expected_buckets_count: 44, flagged_samples_count: 0 });
    expect(c?.metrics.damper_position_pct).toMatchObject({ mean_pct: 95.2 });
    expect(c?.metrics.airflow_cmh).toMatchObject({ mean_cmh: 2862 });
    expect(c?.metrics.occupancy_count).toMatchObject({ mean_count: 18.2 });
    expect(c?.design).toMatchObject({ setpoint_c: 23, design_occupancy_count: 20, vav_rated_airflow_cmh: 3000 });
    expect(c?.comfort).toMatchObject({ occupied_min: 220, above_design_band_min: 220 });
    expect(await reader.zoneConditions({ zoneId: '00000000-0000-4000-8000-000000000999', from: SINCE_9_LOCAL, to: new Date(NOW) }))
      .toBeNull();
  });

  it('keeps the 24 Sep story: four copilot pre-cools, drift alerts 14 min after, and again 10 min after they lapse', async () => {
    const { reader } = fakeReader();
    const t = await reader.zoneTimeline({ zoneId: Z.off305, from: WEEK_AGO, to: new Date(NOW), limit: 50 });
    const kinds = t.items.map((i) => `${i.at.slice(11, 16)} ${i.kind}`);
    expect(kinds.slice(0, 7)).toEqual([
      '00:29 command_requested', '00:29 command_applied', '00:43 alert_opened', '01:15 alert_resolved',
      '04:29 override_lapsed', '04:39 alert_opened', '05:17 alert_resolved',
    ]);
    expect(t.items[0]!.detail).toMatchObject({ from_copilot: true, reason_untrusted: COPILOT_PRECOOL_REASON, setpoint_c: 21 });
    expect(t.items[2]!.detail).toMatchObject({ threshold_k_per_h: 2, condition: 'rate_of_change' });
    const history = await reader.controlHistory({ zoneId: null, from: WEEK_AGO, to: new Date(NOW), limit: 50, buildingId: BUILDING_ID });
    expect(history.items.filter((c) => c.from_copilot).map((c) => c.zone).sort()).toEqual(['OFF-300', 'OFF-301', 'OFF-303', 'OFF-305']);
    expect(history.items.every((c) => !c.active_now)).toBe(true);
    // "Since 9 today" holds none of it: windows are applied as the real queries apply them.
    const today = await reader.zoneTimeline({ zoneId: Z.off305, from: SINCE_9_LOCAL, to: new Date(NOW), limit: 50 });
    expect(today.total).toBe(0);
  });

  it('caps and says so, newest first', async () => {
    const { reader } = fakeReader();
    const alerts = await reader.listAlerts({ state: 'any', from: WEEK_AGO, to: new Date(NOW), zoneId: null, limit: 3, buildingId: BUILDING_ID });
    expect(alerts).toMatchObject({ total: 11, limit: 3, truncated: true });
    expect(alerts.items[0]!.opened_at > alerts.items[2]!.opened_at).toBe(true);
    const live = await reader.listAlerts({ state: 'live', from: WEEK_AGO, to: new Date(NOW), zoneId: null, limit: 50, buildingId: BUILDING_ID });
    expect(live.total).toBe(0);
    const t = await reader.zoneTimeline({ zoneId: Z.off305, from: WEEK_AGO, to: new Date(NOW), limit: 5 });
    expect(t).toMatchObject({ total: 10, limit: 5, truncated: true });
    expect(t.items.at(-1)!.kind).toBe('data_gap');   // the most recent five, oldest first
  });

  it('holds the smoke-contaminated meter and the indistinguishable floors', async () => {
    const { reader } = fakeReader();
    const meter = await reader.meterConsumption({
      meterTag: 'MTR-MAIN', from: new Date('2026-09-23T18:00:00Z'), to: new Date('2026-09-24T06:00:00Z'), bucket: 'hour', timezone: 'Asia/Dubai', buildingId: BUILDING_ID,
    });
    expect(meter).toMatchObject({ unit: 'kwh', total_kwh: 17944.35670586105, total_resets_count: 1 });
    const buckets = 'buckets' in meter ? meter.buckets as Array<Record<string, number | string>> : [];
    expect(buckets.find((b) => b.resets_count === 1)?.bucket_start).toBe('2026-09-23T22:00:00.000Z');
    expect(buckets.find((b) => (b.delta_kwh as number) > 15_000)?.delta_kwh).toBeCloseTo(15537.9, 1);
    expect(await reader.meterConsumption({
      meterTag: 'CH-01', from: WEEK_AGO, to: new Date(NOW), bucket: 'hour', timezone: 'Asia/Dubai', buildingId: BUILDING_ID,
    })).toEqual({ unknownMeter: true });

    const floors = await reader.energyByEndUse({ from: WEEK_AGO, to: new Date(NOW), groupBy: 'floor', timezone: 'Asia/Dubai', buildingId: BUILDING_ID });
    const perFloor = floors.rows.filter((r) => 'level' in r && r.level !== null).map((r) => r.energy_kwh!);
    expect(perFloor).toHaveLength(4);
    expect((Math.max(...perFloor) - Math.min(...perFloor)) / Math.min(...perFloor)).toBeLessThan(0.02);
    expect(floors.rows.at(-1)).toMatchObject({ floor: 'building plant', level: null });
  });

  it('spies, throws on request, delays on request, and hands out copies', async () => {
    const fake = fakeReader();
    fake.throwOn.add('zoneConditions');
    await expect(fake.reader.zoneConditions({ zoneId: Z.off305, from: SINCE_9_LOCAL, to: new Date(NOW) })).rejects.toThrow(/throwOn/);
    expect(fake.spy.calls.zoneConditions[0]?.zoneId).toBe(Z.off305);

    const first = await fake.reader.orient();
    first.directory.length = 0;
    expect((await fake.reader.orient()).directory).toHaveLength(24);

    fake.delayMs.set('listZones', 20);
    await Promise.all([fake.reader.listZones(), fake.reader.orient()]);
    expect(fake.spy.peakInFlight).toBe(2);
    expect(fake.spy.total()).toBe(5);
  });

  it('takes overrides without losing the spy or the strictness', async () => {
    const fake = fakeReader({ listZones: async () => [] });
    expect(await fake.reader.listZones()).toEqual([]);
    expect(fake.spy.calls.listZones).toHaveLength(1);
    expect(() => (fake.reader as unknown as Record<string, unknown>).spy).toThrow();
  });

  it('agrees with the probe about OFF-305 and SER-105', async () => {
    const { reader } = fakeReader();
    const [orient, zones] = [await reader.orient(), await reader.listZones()];
    expect(orient.directory.find((z) => z.id === Z.off305)?.serving).toEqual(['AHU-04 (operational)', 'VAV-305 (fault)']);
    expect(zones.find((z) => z.id === Z.ser105)?.temperatureC).toBeNull();
    const chain = await reader.equipmentStatus({ tag: null, zoneId: Z.off305, limit: 40, buildingId: BUILDING_ID });
    expect(chain.items.map((e) => `${e.tag} ${e.status}`)).toEqual([
      'AHU-04 operational', 'CH-01 operational', 'CT-01 operational', 'VAV-305 fault',
    ]);
  });

  /**
   * The unit-suffix lint the tools stage will run over tool outputs, run here
   * over the fixtures those outputs are built from. `list_zones` is exempt:
   * it is v1's camelCase control vocabulary, kept verbatim (§5.3).
   */
  it.each(EVERY_READ.filter(([m]) => m !== 'listZones'))('%s: every numeric key carries a unit, or is uncitable by design', async (_m, read) => {
    const UNCITABLE = new Set(['level', 'total', 'limit', 'grid_carbon_kg_per_kwh']);
    const bad: string[] = [];
    const walk = (v: unknown, key: string, path: string) => {
      if (typeof v === 'number') {
        const ok = unitOfKey(key) !== null || UNCITABLE.has(key) || /^slope_(pct|ppm|count|cmh)_per_h$/.test(key);
        if (!ok) bad.push(path);
      } else if (Array.isArray(v)) {
        v.forEach((x, i) => walk(x, key, `${path}[${i}]`));
      } else if (typeof v === 'object' && v !== null) {
        for (const [k, x] of Object.entries(v)) walk(x, k, `${path}.${k}`);
      }
    };
    walk(await read(fakeReader().reader), '', '$');
    expect(bad).toEqual([]);
  });

  it('answers every reader method', () => {
    expect(EVERY_READ.map(([m]) => m).sort()).toEqual([...TWIN_READER_METHODS].sort());
  });
});

describe('fake probe and issuer', () => {
  it('keeps v1’s refusals and allows the rest from the designed setpoint', async () => {
    const { probe, dryRuns } = fakeProbe({ clock: () => NOW });
    expect(await probe.dryRun({ zoneId: Z.off305, setpointTempC: 22, reason: 'x' }))
      .toMatchObject({ allowed: false, refusal: 'equipment_unavailable' });
    expect(await probe.dryRun({ zoneId: Z.ser105, setpointTempC: 20, reason: 'x' }))
      .toMatchObject({ allowed: false, refusal: 'feedback_unusable' });
    expect(await probe.dryRun({ zoneId: '00000000-0000-4000-8000-000000000999', setpointTempC: 22, reason: 'x' }))
      .toMatchObject({ allowed: false, refusal: 'unknown_zone' });
    expect(await probe.dryRun({ zoneId: Z.off301, setpointTempC: 21, durationS: 7200, reason: 'x' })).toEqual({
      allowed: true, previousTempC: 23, durationS: 7200, effectiveUntil: '2026-09-28T10:40:00.000Z',
    });
    expect(dryRuns).toHaveLength(4);
  });

  it('can be switched off, or made to fail like a down ingest', async () => {
    const fake = fakeProbe({ settingsThrows: true });
    await expect(fake.probe.settings()).rejects.toThrow('control settings unavailable: 503');
    fake.throwOn.delete('settings');
    fake.settings.enabled = false;
    expect(await fake.probe.settings()).toMatchObject({ enabled: false });
    expect(await fake.probe.dryRun({ zoneId: Z.off301, setpointTempC: 21, reason: 'x' }))
      .toMatchObject({ allowed: false, refusal: 'control_disabled' });
    expect(fake.settingsCalls()).toBe(2);
  });

  it('records what the issuer issued', async () => {
    const d = fakeDeps();
    const r = await d.deps.issuer.issue({ zoneId: Z.off301, setpointTempC: 21, reason: 'copilot (operator-approved): x' });
    expect(r).toMatchObject({ ok: true, commandId: 'cmd-1' });
    expect(d.issuer.issued).toEqual([{ zoneId: Z.off301, setpointTempC: 21, reason: 'copilot (operator-approved): x' }]);
  });
});

describe('fake scenarios', () => {
  const request = (setpointDeltaK?: number) => ({
    buildingId: BUILDING_ID, scenarioName: 'copilot: x', periodStart: new Date('2026-09-27T05:00:00Z'),
    periodEnd: new Date('2026-09-28T09:00:00Z'), intervalS: 3600,
    params: setpointDeltaK === undefined ? {} : { setpointDeltaK },
    zoneIds: [Z.off301, Z.off303, '00000000-0000-4000-8000-000000000999'],
    weather: { mode: 'synthetic' as const, peakDryBulbC: 46, minDryBulbC: 32, peakGhiW_m2: 950 },
  }) as Parameters<ReturnType<typeof fakeScenarios>['scenarios']['start']>[0];

  it('ok: completes on the first poll; +1 K is 1 K warmer and 5% cheaper on HVAC', async () => {
    const fake = fakeScenarios('ok');
    const a = await fake.scenarios.start(request());
    expect(a.ok && (await fake.scenarios.getRun(a.runId)).status).toBe('completed');
    const b = await fake.scenarios.start(request(1));
    expect(b.ok && (await fake.scenarios.getRun(b.runId)).status).toBe('completed');
    expect(fake.peakInFlight).toBe(1);

    const base = await fake.scenarios.getResults(a.ok ? a.runId : '', 10_000);
    const plus = await fake.scenarios.getResults(b.ok ? b.runId : '', 10_000);
    expect(base).toHaveLength(28 * 2);   // 28 hours × 2 known zones; the unknown id is dropped
    expect(plus[10]!.indoorTempC! - base[10]!.indoorTempC!).toBeCloseTo(1, 9);
    expect(plus[10]!.hvacLoadKwh / base[10]!.hvacLoadKwh).toBeCloseTo(0.95, 9);
    expect(plus.every((r) => r.unmetHours === 0)).toBe(true);
    expect(base.slice(0, 2).map((r) => r.zoneId)).toEqual([Z.off301, Z.off303]);
  });

  it('short, hang and busy429 fail the ways the tool must handle', async () => {
    const short = fakeScenarios('short');
    const s = await short.scenarios.start(request());
    await short.scenarios.getRun(s.ok ? s.runId : '');
    expect(await short.scenarios.getResults(s.ok ? s.runId : '', 10_000)).toHaveLength(28 * 2 - 1);

    const hang = fakeScenarios('hang');
    const h = await hang.scenarios.start(request());
    const runId = h.ok ? h.runId : '';
    expect((await hang.scenarios.getRun(runId)).status).toBe('running');
    expect((await hang.scenarios.getRun(runId)).status).toBe('running');
    await hang.scenarios.cancel(runId);
    expect(hang.cancelled).toEqual([runId]);
    expect((await hang.scenarios.getRun(runId)).status).toBe('cancelled');
    expect(hang.inFlight).toBe(0);

    const busy = fakeScenarios('busy429');
    expect(await busy.scenarios.start(request())).toMatchObject({ ok: false, reason: 'busy', status: 429 });
    expect(busy.requests).toHaveLength(1);
  });

  it('rows are a pure function of the request', () => {
    expect(fakeSimRows(request(1))).toEqual(fakeSimRows(request(1)));
    const occupied = fakeSimRows(request()).filter((r) => (r.occupancyCount ?? 0) > 0);
    expect(occupied[0]!.occupancyCount).toBe(16);   // 80% of OFF-301's design 20
    expect(zoneById(occupied[0]!.zoneId)?.name).toBe('OFF-301');
  });
});

describe('scripted model', () => {
  const params = (role: string, firstUser: string | Anthropic.ContentBlockParam[]): Anthropic.MessageCreateParamsNonStreaming => ({
    model: 'claude-opus-5', max_tokens: 16_000,
    system: [{ type: 'text', text: `ROLE=${role}\nYou are…` }],
    messages: [{ role: 'user', content: firstUser }],
  });
  const task = (taskId: string) => `[system] Task and context follow as JSON data. ${JSON.stringify({ taskId, goal: 'g' })}`;

  it('routes by ROLE and, for specialists, by task id', async () => {
    const m = scriptedModel({
      planner: [plannerMsg({ next: 'compose' })],
      'diagnose:T1': [message([text('t1')])],
      'diagnose:T2': [message([text('t2')])],
      control: [message([text('c')])],
    });
    expect(scriptKey(params('diagnose', task('T2')))).toBe('diagnose:T2');
    expect(scriptKey(params('diagnose', [{ type: 'text', text: task('T1') }]))).toBe('diagnose:T1');
    expect(scriptKey(params('control', '{"brief":"b","mode":"check"}'))).toBe('control');
    const t2 = await m.call(params('diagnose', task('T2')));
    const t1 = await m.call(params('diagnose', task('T1')));
    expect([t1.content[0], t2.content[0]].map((b) => (b as Anthropic.TextBlock).text)).toEqual(['t1', 't2']);
    await m.call(params('planner', 'hello'));
    expect(m.order).toEqual(['diagnose:T2', 'diagnose:T1', 'planner']);
    expect(m.calls['diagnose:T1']?.[0]?.max_tokens).toBe(16_000);
    expect(m.count()).toBe(3);
    expect(m.remaining('control')).toBe(1);
  });

  it('throws when a script runs out, replays errors, and refuses a request with no ROLE line', async () => {
    const boom = new Error('529 overloaded');
    const m = scriptedModel({ compose: [boom] });
    await expect(m.call(params('compose', 'x'))).rejects.toBe(boom);
    await expect(m.call(params('compose', 'x'))).rejects.toThrow('script exhausted for compose');
    await expect(m.call(params('analyse', 'no json here'))).rejects.toThrow(/taskId/);
    await expect(m.call({ ...params('planner', 'x'), system: 'You are a planner' })).rejects.toThrow(/ROLE=/);
    await expect(m.call(params('janitor', 'x'))).rejects.toThrow(/ROLE=/);
  });

  it('builds the messages the graph parses', () => {
    const p = plannerMsg({ tasks: [{ specialist: 'diagnose', goal: 'why OFF-305 warm', zoneIds: [Z.off305] }] });
    expect(JSON.parse((p.content[0] as Anthropic.TextBlock).text)).toEqual({
      intent: 'diagnose', interpretation: '', allowControl: false, allowSimulation: false, next: 'dispatch',
      tasks: [{ specialist: 'diagnose', goal: 'why OFF-305 warm', zoneIds: [Z.off305], from: null, to: null, inputEvidenceIds: [] }],
      controlTask: null, message: null,
    });
    expect(JSON.parse((plannerMsg({ controlTask: { mode: 'check', brief: 'b' } }).content[0] as Anthropic.TextBlock).text))
      .toMatchObject({ next: 'control', intent: 'control', controlTask: { mode: 'check', brief: 'b', inputEvidenceIds: [] } });
    expect(message([toolUse('zone_conditions', {})]).stop_reason).toBe('tool_use');
    expect(message([text('done')]).stop_reason).toBe('end_turn');
    expect(message([], 'refusal').stop_reason).toBe('refusal');
    const doc = { paragraphs: [{ segments: [{ kind: 'text' as const, text: 'OFF-305 is warm.' }] }], caveats: [] };
    expect(JSON.parse((composeMsg(doc).content[0] as Anthropic.TextBlock).text)).toEqual(doc);
  });
});

describe('fakeDeps', () => {
  it('shares one fixed clock that moves only when the graph sleeps', async () => {
    const seen: number[] = [];
    const d = fakeDeps({ limits: { maxModelCalls: 6 }, onSleep: () => { seen.push(d.clock.now()); } });
    expect(d.deps.clock!()).toBe(NOW);
    expect(d.clock.iso()).toBe('2026-09-28T08:40:00.000Z');
    await d.deps.sleep!(500);
    await d.deps.sleep!(500);
    expect(d.deps.clock!()).toBe(NOW + 1000);
    expect(seen).toEqual([NOW + 500, NOW + 1000]);
    expect(d.sleeps).toEqual([500, 500]);
    expect(d.deps.limits).toEqual({ maxModelCalls: 6 });
    // The probe and reader read the same clock.
    const v = await d.deps.probe.dryRun({ zoneId: Z.off301, setpointTempC: 22, reason: 'x' });
    expect(v.allowed && v.effectiveUntil).toBe(new Date(NOW + 1000 + 3_600_000).toISOString());
  });

  it('defaults: no simulator, claude-opus-5 for both roles, the fixture identity', () => {
    const d = fakeDeps();
    expect(d.deps.scenarios).toBeNull();
    expect(d.scenarios).toBeNull();
    expect(d.deps.models).toEqual({ lead: 'claude-opus-5', specialist: 'claude-opus-5' });
    expect(d.deps.identity).toEqual({ tenantId: TENANT_ID, userId: USER_ID });
    expect(fakeDeps({ scenarios: 'hang' }).scenarios?.mode).toBe('hang');
  });
});
