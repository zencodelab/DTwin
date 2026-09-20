import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, signWsTicket, tokenHash, verifyPassword, verifyWsTicket } from './auth.ts';

/**
 * Tickets are the browser's credential for the ingest socket, and they are
 * signed rather than stored — the TTL is the entire defence, so forgery and
 * expiry are the two things that must not be approximately right.
 *
 * The ingest smoke suite proves a valid ticket is accepted. What it cannot
 * cheaply show is the negative space: a tampered payload, a swapped signature,
 * a ticket that outlived its minute, a secret that changed between services.
 */
const SECRET = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

describe('WebSocket tickets', () => {
  beforeEach(() => { process.env.AUTH_SECRET = SECRET; });
  afterEach(() => { vi.useRealTimers(); delete process.env.AUTH_SECRET; });

  it('round-trips the payload', () => {
    const t = verifyWsTicket(signWsTicket({ tenantId: 'tenant-1', userId: 'user-1' }));
    expect(t).toMatchObject({ tenantId: 'tenant-1', userId: 'user-1' });
    expect(t!.exp).toBeGreaterThan(Date.now());
  });

  it('refuses a ticket signed with a different secret', () => {
    // The failure mode this guards: web and ingest disagreeing about
    // AUTH_SECRET, which must fail closed rather than fail open.
    const ticket = signWsTicket({ tenantId: 't', userId: 'u' });
    process.env.AUTH_SECRET = OTHER;
    expect(verifyWsTicket(ticket)).toBeNull();
  });

  it('refuses a tampered payload', () => {
    // Re-encoding the body for another tenant without re-signing is the
    // attack: the MAC covers the encoded payload, so it must not verify.
    const ticket = signWsTicket({ tenantId: 'tenant-a', userId: 'u' });
    const [, mac] = ticket.split('.');
    const forged = Buffer.from(
      JSON.stringify({ tenantId: 'tenant-b', userId: 'u', exp: Date.now() + 60_000 }),
    ).toString('base64url');
    expect(verifyWsTicket(`${forged}.${mac}`)).toBeNull();
  });

  it('refuses a truncated or malformed ticket', () => {
    const ticket = signWsTicket({ tenantId: 't', userId: 'u' });
    expect(verifyWsTicket(ticket.split('.')[0]!)).toBeNull();  // no signature
    expect(verifyWsTicket('')).toBeNull();
    expect(verifyWsTicket('.abc')).toBeNull();                 // empty payload
    expect(verifyWsTicket(`${ticket}extra`)).toBeNull();
  });

  it('expires, and the boundary is exclusive', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const ticket = signWsTicket({ tenantId: 't', userId: 'u' }, 60_000);

    vi.setSystemTime(new Date('2026-01-01T00:00:59Z'));
    expect(verifyWsTicket(ticket)).not.toBeNull();

    // exp is compared with `>`, so the instant of expiry is already too late.
    vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
    expect(verifyWsTicket(ticket)).toBeNull();
  });

  it('refuses to sign or verify without a long enough secret', () => {
    // No development fallback on purpose: a default signing key that works
    // locally is a default signing key that ships.
    delete process.env.AUTH_SECRET;
    expect(() => signWsTicket({ tenantId: 't', userId: 'u' })).toThrow(/AUTH_SECRET/);
    process.env.AUTH_SECRET = 'too-short';
    expect(() => signWsTicket({ tenantId: 't', userId: 'u' })).toThrow(/32 characters/);
  });
});

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('Correct horse battery staple', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  }, 20_000);

  it('salts, so the same password hashes differently each time', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same', a)).toBe(true);
    expect(await verifyPassword('same', b)).toBe(true);
  }, 20_000);

  it('encodes its parameters so they can be raised without invalidating hashes', async () => {
    const [scheme, n, r, p] = (await hashPassword('x')).split('$');
    expect(scheme).toBe('scrypt');
    expect(Number(n)).toBe(2 ** 15);
    expect([Number(r), Number(p)]).toEqual([8, 1]);
  }, 20_000);

  it('rejects a stored value it does not recognise, rather than throwing', async () => {
    // login() feeds this a dummy hash when no user matched; it must not throw.
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'argon2id$v=19$m=1$whatever$short')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  }, 20_000);
});

describe('tokenHash', () => {
  it('is stable and distinguishes inputs', () => {
    expect(tokenHash('abc')).toBe(tokenHash('abc'));
    expect(tokenHash('abc')).not.toBe(tokenHash('abd'));
    expect(tokenHash('abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});
