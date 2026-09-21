import { describe, expect, it } from 'vitest';
import { effectiveSetpointC } from './index.ts';

describe('effectiveSetpointC', () => {
  const overrides = new Map([['zone-a', 24.5]]);

  it('obeys a supervisory override over the designed setpoint', () => {
    expect(effectiveSetpointC(overrides, 'zone-a', 23)).toBe(24.5);
  });

  it('leaves an uncommanded zone on its designed setpoint', () => {
    expect(effectiveSetpointC(overrides, 'zone-b', 21)).toBe(21);
  });

  it('returns to the designed setpoint when the override lapses', () => {
    // Expiry is the map being rebuilt without it — there is no revert step,
    // which is exactly why a dead optimiser cannot hold a building.
    expect(effectiveSetpointC(new Map(), 'zone-a', 23)).toBe(23);
  });

  it('handles a sensor on no zone, and a zone with no profile', () => {
    expect(effectiveSetpointC(overrides, null, 22)).toBe(22);
    expect(effectiveSetpointC(overrides, 'zone-b', undefined)).toBe(23);
  });
})
