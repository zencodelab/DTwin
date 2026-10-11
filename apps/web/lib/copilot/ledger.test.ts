import { describe, expect, it } from 'vitest';
import { ApprovalLedger, canonicalJson, hashCommands, type GrantablePlan } from './ledger.ts';

const T0 = Date.parse('2026-09-28T08:40:00Z');
const OFF301 = '00000000-0000-4000-8000-000000000301';
const OFF303 = '00000000-0000-4000-8000-000000000303';
/** A second plan's id: a plan id is granted once, so a test that grants twice needs two plans. */
const OTHER = '9d6e2f1a-3b4c-4d5e-8f60-718293a4b5c6';

function clock(start = T0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function plan(over: Partial<GrantablePlan> = {}): GrantablePlan {
  const commands = over.commands ?? [
    { zoneId: OFF301, zoneName: 'OFF-301', setpointTempC: 22, durationS: 7200, reason: 'pre-cool' },
    { zoneId: OFF303, zoneName: 'OFF-303', setpointTempC: 22, reason: 'pre-cool' },
  ];
  return {
    planId: '4b0c3c1e-7c1a-4a8e-9d1f-2a7f3a4c5d6e',
    planHash: hashCommands(commands),
    ...over,
    commands,
  };
}

describe('ApprovalLedger', () => {
  it('take is delete-on-read: a second take — a double Approve — finds nothing', () => {
    const ledger = new ApprovalLedger({ clock: clock().now });
    expect(ledger.grant('t1', plan())).toBe(true);
    const grant = ledger.take('t1');
    expect(grant?.planId).toBe(plan().planId);
    expect(grant?.commands.map((c) => c.zoneName)).toEqual(['OFF-301', 'OFF-303']);
    expect(ledger.take('t1')).toBeNull();
    expect(ledger.has('t1')).toBe(false);
  });

  it('refuses a grant at GRANT_TTL_S and after, and consumes it anyway', () => {
    const c = clock();
    const ledger = new ApprovalLedger({ clock: c.now });
    ledger.grant('t1', plan());
    c.advance(119_999);
    expect(ledger.take('t1')).not.toBeNull();

    expect(ledger.grant('t1', plan({ planId: OTHER }))).toBe(true);
    c.advance(120_000);
    expect(ledger.take('t1')).toBeNull();
    expect(ledger.has('t1')).toBe(false);
  });

  it('refuses a grant stamped in the future (a clock stepped back)', () => {
    const c = clock();
    const ledger = new ApprovalLedger({ clock: c.now });
    ledger.grant('t1', plan());
    c.advance(-1_000);
    expect(ledger.take('t1')).toBeNull();
  });

  it('holds a deep-frozen copy, untouched by later changes to the plan it came from', () => {
    const ledger = new ApprovalLedger({ clock: clock().now });
    const source = plan();
    ledger.grant('t1', source);
    (source.commands[0] as { setpointTempC: number }).setpointTempC = 18;
    (source.commands as unknown[]).push({ zoneId: OFF303, zoneName: 'X', setpointTempC: 16, reason: 'r' });

    const grant = ledger.take('t1')!;
    expect(grant.commands).toHaveLength(2);
    expect(grant.commands[0]!.setpointTempC).toBe(22);
    expect(Object.isFrozen(grant)).toBe(true);
    expect(Object.isFrozen(grant.commands)).toBe(true);
    expect(Object.isFrozen(grant.commands[0])).toBe(true);
    expect(() => { (grant.commands[0] as { setpointTempC: number }).setpointTempC = 16; }).toThrow(TypeError);
  });

  it('keeps only what is issued, with a missing duration as null', () => {
    const ledger = new ApprovalLedger({ clock: clock().now });
    const withExtras = plan();
    (withExtras.commands[0] as Record<string, unknown>).verdict = { allowed: true };
    ledger.grant('t1', withExtras);
    const grant = ledger.take('t1')!;
    expect(grant.commands[0]).toEqual({
      zoneId: OFF301, zoneName: 'OFF-301', setpointTempC: 22, durationS: 7200, reason: 'pre-cool',
    });
    expect(grant.commands[1]!.durationS).toBeNull();
  });

  it('refuses a plan whose commands do not hash to its planHash, and drops any earlier grant', () => {
    const ledger = new ApprovalLedger({ clock: clock().now });
    expect(ledger.grant('t1', plan())).toBe(true);
    const tampered = plan();
    (tampered.commands[0] as { setpointTempC: number }).setpointTempC = 16;
    expect(ledger.grant('t1', tampered)).toBe(false);
    expect(ledger.has('t1')).toBe(false);
    expect(ledger.take('t1')).toBeNull();
  });

  it('refuses a malformed plan', () => {
    const ledger = new ApprovalLedger({ clock: clock().now });
    expect(ledger.grant('t1', plan({ planHash: 'nope' }))).toBe(false);
    expect(ledger.grant('t1', plan({ planId: '' }))).toBe(false);
    expect(ledger.grant('t1', plan({ commands: [] }))).toBe(false);
    const thirteen = Array.from({ length: 13 }, (_, i) => ({
      zoneId: `z${i}`, zoneName: `Z${i}`, setpointTempC: 22, reason: 'r',
    }));
    expect(ledger.grant('t1', plan({ commands: thirteen }))).toBe(false);
    const nan = [{ zoneId: OFF301, zoneName: 'OFF-301', setpointTempC: Number.NaN, reason: 'r' }];
    expect(ledger.grant('t1', plan({ commands: nan }))).toBe(false);
  });

  it('refuses a plan whose fields throw when read', () => {
    const ledger = new ApprovalLedger({ clock: clock().now });
    const hostile = new Proxy(plan(), {
      get(target, prop) {
        if (prop === 'commands') throw new Error('boom');
        return Reflect.get(target, prop);
      },
    });
    expect(ledger.grant('t1', hostile)).toBe(false);
  });

  it('keeps threads apart, and revoke sets one aside', () => {
    const ledger = new ApprovalLedger({ clock: clock().now });
    ledger.grant('t1', plan());
    ledger.grant('t2', plan({ planId: OTHER }));
    ledger.revoke('t1');
    expect(ledger.take('t1')).toBeNull();
    expect(ledger.take('t2')).not.toBeNull();
  });

  it('drops grants past their TTL when the next one is made', () => {
    const c = clock();
    const ledger = new ApprovalLedger({ clock: c.now });
    ledger.grant('old', plan());
    c.advance(120_000);
    ledger.grant('new', plan({ planId: OTHER }));
    expect(ledger.has('old')).toBe(false);
    expect(ledger.has('new')).toBe(true);
  });

  it('grants a plan once: a second approval of it is refused and leaves the first grant alone', () => {
    const ledger = new ApprovalLedger({ clock: clock().now });
    expect(ledger.grant('t1', plan())).toBe(true);
    // Before the first grant is taken: it stays, to be issued once.
    expect(ledger.grant('t1', plan())).toBe(false);
    expect(ledger.has('t1')).toBe(true);
    expect(ledger.take('t1')?.planId).toBe(plan().planId);
    // After it is taken — the interleaving take-once alone cannot stop: no fresh grant appears.
    expect(ledger.grant('t1', plan())).toBe(false);
    expect(ledger.take('t1')).toBeNull();
    // Not on another thread either: a plan id names one plan.
    expect(ledger.grant('t2', plan())).toBe(false);
  });

  it('remembers a granted plan for a plan TTL, then forgets it (it has expired and cannot be approved)', () => {
    const c = clock();
    const ledger = new ApprovalLedger({ clock: c.now, planTtlS: 600 });
    ledger.grant('t1', plan());
    ledger.take('t1');
    c.advance(599_999);
    expect(ledger.grant('t1', plan())).toBe(false);
    c.advance(1);
    expect(ledger.grant('t1', plan())).toBe(true);
  });
});

describe('plan identity', () => {
  it('hashes what is sent, whatever the key order, and not the zone name', () => {
    const a = [{ zoneId: OFF301, zoneName: 'OFF-301', setpointTempC: 22, durationS: 3600, reason: 'r' }];
    const b = [{ reason: 'r', durationS: 3600, setpointTempC: 22, zoneName: 'renamed', zoneId: OFF301 }];
    expect(hashCommands(a)).toBe(hashCommands(b));
    expect(hashCommands(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats an absent duration as null, and any sent field as identity', () => {
    const base = { zoneId: OFF301, zoneName: 'OFF-301', setpointTempC: 22, reason: 'r' };
    expect(hashCommands([base])).toBe(hashCommands([{ ...base, durationS: null }]));
    expect(hashCommands([base])).not.toBe(hashCommands([{ ...base, durationS: 3600 }]));
    expect(hashCommands([base])).not.toBe(hashCommands([{ ...base, setpointTempC: 22.5 }]));
    expect(hashCommands([base])).not.toBe(hashCommands([{ ...base, reason: 'r.' }]));
  });

  it('serialises canonically', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: 'x' }] })).toBe('{"a":[2,{"c":"x","d":null}],"b":1}');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});
