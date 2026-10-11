import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { clockSkewMs, countdown, planHighlight } from './countdown.ts';

/**
 * The plan card's countdown: whole seconds to the SERVER's expiry, never
 * negative, an unparseable expiry treated as expired, and a wrong browser
 * clock corrected from the response's Date header.
 */

const EXPIRES = '2026-09-28T08:50:00.000Z';
const at = (iso: string) => Date.parse(iso);

describe('countdown', () => {
  it('counts whole seconds down to the expiry', () => {
    expect(countdown(EXPIRES, at('2026-09-28T08:40:00.000Z'))).toEqual({ secondsLeft: 600, expired: false, urgent: false, text: '10:00 left' });
    expect(countdown(EXPIRES, at('2026-09-28T08:49:05.400Z'))).toEqual({ secondsLeft: 54, expired: false, urgent: true, text: '0:54 left' });
    expect(countdown(EXPIRES, at('2026-09-28T08:48:59.999Z')).text).toBe('1:00 left');
  });

  it('is expired at and after the instant, and for an expiry it cannot read', () => {
    expect(countdown(EXPIRES, at(EXPIRES)).expired).toBe(true);
    expect(countdown(EXPIRES, at('2026-09-28T09:00:00Z'))).toEqual({ secondsLeft: 0, expired: true, urgent: true, text: 'expired' });
    expect(countdown('soon', at(EXPIRES)).expired).toBe(true);
  });

  it('corrects for a browser clock that is wrong', () => {
    // The browser runs five minutes slow: by its clock 08:40, by the server's 08:45.
    const receivedAt = at('2026-09-28T08:40:00.000Z');
    const skew = clockSkewMs('Mon, 28 Sep 2026 08:45:00 GMT', receivedAt);
    expect(skew).toBe(5 * 60_000);
    expect(countdown(EXPIRES, receivedAt, skew).text).toBe('5:00 left');
  });

  it('ignores the Date header\'s own one-second resolution, and a header it cannot read', () => {
    const receivedAt = at('2026-09-28T08:40:00.900Z');
    expect(clockSkewMs('Mon, 28 Sep 2026 08:40:00 GMT', receivedAt)).toBe(0);
    expect(clockSkewMs('garbage', receivedAt)).toBe(0);
    expect(clockSkewMs(null, receivedAt)).toBe(0);
  });
});

describe('planHighlight', () => {
  const plan = { expiresAt: EXPIRES, commands: [{ zoneId: 'z-301' }, { zoneId: 'z-303' }] };

  it('lights the plan\'s zones while it can be decided, and none once it has expired (review)', () => {
    expect(planHighlight(plan, at('2026-09-28T08:49:59.000Z'))).toEqual(['z-301', 'z-303']);
    expect(planHighlight(plan, at(EXPIRES))).toEqual([]);
    expect(planHighlight(plan, at('2026-09-28T09:10:00Z'))).toEqual([]);
    expect(planHighlight(null, at('2026-09-28T08:40:00Z'))).toEqual([]);
  });

  it('is what the panel lights the building with — not the plan\'s zones whatever the clock says', () => {
    const panel = readFileSync(new URL('../../components/panels/CopilotPanel.tsx', import.meta.url), 'utf8');
    expect(panel).toMatch(/const planZones = planHighlight\(plan, now, skewMs\)/);
    expect(panel).not.toMatch(/plan\.commands\.map\(\(c\) => c\.zoneId\)/);
  });

  it('judges expiry on the server\'s clock, as the card does', () => {
    // Five minutes slow: by this clock 08:46, by the server's 08:51 — expired.
    expect(planHighlight(plan, at('2026-09-28T08:46:00Z'), 5 * 60_000)).toEqual([]);
  });
});
