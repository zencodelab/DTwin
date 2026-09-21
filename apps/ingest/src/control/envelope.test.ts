import { describe, expect, it } from 'vitest';
import { Quality, type ControlSettings } from '@dtwin/types';
import { evaluate, type EnvelopeContext } from './envelope.ts';

const NOW = 1_800_000_000_000;

const SETTINGS: ControlSettings = {
  enabled: true,
  maxDeviationK: 3,
  maxStepK: 2,
  minIntervalS: 900,
  defaultDurationS: 3600,
  maxDurationS: 43_200,
  commandTtlS: 300,
};

function ctx(over: Partial<EnvelopeContext> = {}): EnvelopeContext {
  return {
    settings: SETTINGS,
    role: 'operator',
    baselineTempC: 23,
    activeOverrideTempC: null,
    equipment: [{ tag: 'VAV-101', status: 'operational' }],
    feedback: {
      value: 23.4, ts: NOW - 20_000, receivedAt: NOW - 19_000,
      quality: Quality.Good, sampleIntervalS: 60,
    },
    lastCommandAt: null,
    commandInFlight: false,
    now: NOW,
    ...over,
  };
}

const refusalOf = (v: ReturnType<typeof evaluate>) => (v.ok ? null : v.refusal);

describe('a command that should be allowed', () => {
  it('is allowed, and resolves both clocks', () => {
    const v = evaluate({ setpointTempC: 24.5 }, ctx());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.previousTempC).toBe(23);
    expect(v.durationS).toBe(3600);
    expect(v.expiresAt.getTime()).toBe(NOW + 300_000);
    expect(v.effectiveUntil.getTime()).toBe(NOW + 3_600_000);
  });

  it('measures the step from the active override, not from the baseline', () => {
    // Already overridden to 24.5; 25.5 is 1 K further and allowed, while the
    // same request from the baseline would be a 2.5 K step and refused.
    const v = evaluate({ setpointTempC: 25.5 }, ctx({ activeOverrideTempC: 24.5 }));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.previousTempC).toBe(24.5);
    expect(refusalOf(evaluate({ setpointTempC: 25.5 }, ctx()))).toBe('step_too_large');
  });

  it('lets a degraded unit be commanded — it is running, just less well', () => {
    expect(evaluate({ setpointTempC: 24.5 }, ctx({
      equipment: [{ tag: 'AHU-01', status: 'degraded' }],
    })).ok).toBe(true);
  });

  it('accepts a zone with no serving equipment recorded', () => {
    expect(evaluate({ setpointTempC: 24.5 }, ctx({ equipment: [] })).ok).toBe(true);
  });
});

describe('authority', () => {
  it.each(['owner', 'admin', 'operator'] as const)('%s may command', (role) => {
    expect(evaluate({ setpointTempC: 24.5 }, ctx({ role })).ok).toBe(true);
  });

  it('a viewer may not — a read-only role that moves setpoints is not read-only', () => {
    expect(refusalOf(evaluate({ setpointTempC: 24.5 }, ctx({ role: 'viewer' })))).toBe('forbidden_role');
  });

  it('is checked before anything else, so a viewer learns nothing about the zone', () => {
    const v = evaluate({ setpointTempC: 99 }, ctx({
      role: 'viewer', settings: { ...SETTINGS, enabled: false },
      equipment: [{ tag: 'AHU-01', status: 'fault' }],
    }));
    expect(refusalOf(v)).toBe('forbidden_role');
  });
});

describe('the kill switch', () => {
  it('refuses everything while it is off', () => {
    const v = evaluate({ setpointTempC: 23.5 }, ctx({ settings: { ...SETTINGS, enabled: false } }));
    expect(refusalOf(v)).toBe('control_disabled');
  });

  it('outranks every other reason except authority', () => {
    const v = evaluate({ setpointTempC: 99 }, ctx({
      settings: { ...SETTINGS, enabled: false },
      equipment: [{ tag: 'AHU-01', status: 'fault' }],
      feedback: null,
    }));
    expect(refusalOf(v)).toBe('control_disabled');
  });
});

describe('interlocks', () => {
  it.each(['fault', 'offline', 'maintenance'] as const)(
    'refuses when serving equipment is %s', (status) => {
      const v = evaluate({ setpointTempC: 24.5 }, ctx({ equipment: [{ tag: 'AHU-01', status }] }));
      expect(refusalOf(v)).toBe('equipment_unavailable');
      if (!v.ok) expect(v.message).toContain('AHU-01');
    });

  it('names every blocked unit, not just the first', () => {
    const v = evaluate({ setpointTempC: 24.5 }, ctx({
      equipment: [
        { tag: 'AHU-01', status: 'fault' },
        { tag: 'VAV-101', status: 'operational' },
        { tag: 'CH-02', status: 'maintenance' },
      ],
    }));
    if (v.ok) throw new Error('expected a refusal');
    expect(v.message).toContain('AHU-01');
    expect(v.message).toContain('CH-02');
    expect(v.message).not.toContain('VAV-101');
  });

  describe('the feedback gate — §55 applied to acting instead of drawing', () => {
    it('refuses a zone with no reading at all', () => {
      expect(refusalOf(evaluate({ setpointTempC: 24.5 }, ctx({ feedback: null }))))
        .toBe('feedback_unusable');
    });

    it('refuses a quality-flagged reading, exactly as the map refuses to paint one', () => {
      for (const quality of [Quality.Uncertain, Quality.OutOfRange, Quality.DeviceFault] as const) {
        const v = evaluate({ setpointTempC: 24.5 }, ctx({
          feedback: { ...ctx().feedback!, quality },
        }));
        expect(refusalOf(v)).toBe('feedback_unusable');
      }
    });

    it('refuses a stale reading, and says how stale', () => {
      const v = evaluate({ setpointTempC: 24.5 }, ctx({
        feedback: { ...ctx().feedback!, ts: NOW - 400_000, receivedAt: NOW - 400_000 },
      }));
      expect(refusalOf(v)).toBe('feedback_unusable');
      if (!v.ok) expect(v.message).toMatch(/400s old/);
    });

    it('uses the same three-interval rule as the display, not a control-only one', () => {
      const at = (ageS: number) => ctx({
        feedback: { ...ctx().feedback!, ts: NOW - ageS * 1000, receivedAt: NOW - ageS * 1000 },
      });
      expect(evaluate({ setpointTempC: 24.5 }, at(180)).ok).toBe(true);
      expect(refusalOf(evaluate({ setpointTempC: 24.5 }, at(181)))).toBe('feedback_unusable');
    });

    it('is not fooled by a device clock running ahead', () => {
      // Stamped in the future, but it arrived 10 minutes ago and a 60 s point
      // is long overdue. The freshest defensible moment is its arrival.
      const v = evaluate({ setpointTempC: 24.5 }, ctx({
        feedback: { ...ctx().feedback!, ts: NOW + 600_000, receivedAt: NOW - 600_000 },
      }));
      expect(refusalOf(v)).toBe('feedback_unusable');
    });
  });
});

describe('the value', () => {
  it('refuses a setpoint further from the designed one than the envelope allows', () => {
    const v = evaluate({ setpointTempC: 27 }, ctx());
    expect(refusalOf(v)).toBe('outside_envelope');
    if (!v.ok) expect(v.message).toContain('23.0 °C');
  });

  it('allows one exactly at the envelope edge', () => {
    expect(evaluate({ setpointTempC: 26 }, ctx({ settings: { ...SETTINGS, maxStepK: 5 } })).ok)
      .toBe(true);
    expect(evaluate({ setpointTempC: 20 }, ctx({ settings: { ...SETTINGS, maxStepK: 5 } })).ok)
      .toBe(true);
  });

  it('measures the envelope against this zone, not a global range', () => {
    // A server room at 18 °C: 19 °C is fine for it and would be far outside
    // the envelope of an office at 23 °C.
    expect(evaluate({ setpointTempC: 19 }, ctx({ baselineTempC: 18 })).ok).toBe(true);
    expect(refusalOf(evaluate({ setpointTempC: 19 }, ctx({ baselineTempC: 23 }))))
      .toBe('outside_envelope');
  });

  it('refuses a step larger than one move allows, even inside the envelope', () => {
    const v = evaluate({ setpointTempC: 25.5 }, ctx());
    expect(refusalOf(v)).toBe('step_too_large');
  });

  it('refuses a command that changes nothing', () => {
    expect(refusalOf(evaluate({ setpointTempC: 23 }, ctx()))).toBe('no_change');
    expect(refusalOf(evaluate({ setpointTempC: 23.02 }, ctx()))).toBe('no_change');
    expect(refusalOf(evaluate({ setpointTempC: 24 }, ctx({ activeOverrideTempC: 24 }))))
      .toBe('no_change');
  });

  it('refuses a zone with no designed setpoint rather than inventing one', () => {
    expect(refusalOf(evaluate({ setpointTempC: 24 }, ctx({ baselineTempC: null }))))
      .toBe('no_baseline');
  });
});

describe('rate', () => {
  it('refuses while another command for the zone is in flight', () => {
    expect(refusalOf(evaluate({ setpointTempC: 24.5 }, ctx({ commandInFlight: true }))))
      .toBe('command_in_flight');
  });

  it('refuses a second command inside the minimum interval, and says how long to wait', () => {
    const v = evaluate({ setpointTempC: 24.5 }, ctx({ lastCommandAt: NOW - 300_000 }));
    expect(refusalOf(v)).toBe('too_soon');
    if (!v.ok) expect(v.message).toContain('600s to wait');
  });

  it('allows one once the interval has passed', () => {
    expect(evaluate({ setpointTempC: 24.5 }, ctx({ lastCommandAt: NOW - 900_001 })).ok).toBe(true);
  });

  it('refuses an override longer than the maximum', () => {
    const v = evaluate({ setpointTempC: 24.5, durationS: 86_400 }, ctx());
    expect(refusalOf(v)).toBe('duration_too_long');
    if (!v.ok) expect(v.message).toContain('change the profile');
  });

  it('honours a shorter requested duration', () => {
    const v = evaluate({ setpointTempC: 24.5, durationS: 600 }, ctx());
    if (!v.ok) throw new Error('expected approval');
    expect(v.durationS).toBe(600);
    expect(v.effectiveUntil.getTime()).toBe(NOW + 600_000);
  });

  it('keeps the two clocks apart: the intent expires long before the effect', () => {
    const v = evaluate({ setpointTempC: 24.5 }, ctx());
    if (!v.ok) throw new Error('expected approval');
    expect(v.expiresAt.getTime()).toBeLessThan(v.effectiveUntil.getTime());
  });
});
