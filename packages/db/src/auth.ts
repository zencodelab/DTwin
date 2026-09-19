import {
  createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import type { Principal, TenantRole } from '@dtwin/types';
import { withoutTenant } from './client.ts';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer, salt: string | Buffer, keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing uses scrypt from node:crypto.
 *
 * argon2id would be the first choice on a greenfield service, but every Node
 * binding for it is a native module, and this repository has so far needed no
 * compiler in any image. scrypt is memory-hard, is in the standard library, is
 * specified in RFC 7914, and OWASP lists it as an acceptable alternative where
 * argon2id is unavailable. The cost parameters matter far more than the choice
 * between the two.
 *
 * N=2^15, r=8, p=1 is roughly 32 MB and ~100 ms per verification on this class
 * of machine. maxmem must be raised explicitly: the node default is 32 MB and
 * this configuration needs slightly more than that, so the call throws without
 * it — and it throws at verification time, meaning a service that hashed fine
 * at signup fails at login.
 *
 * The parameters are stored in the encoded string, not assumed, so raising them
 * later does not invalidate existing hashes.
 */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEYLEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, SCRYPT);
  return [
    'scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString('base64url'), hash.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const salt = Buffer.from(saltB64, 'base64url');
  const expected = Buffer.from(hashB64, 'base64url');

  const actual = await scrypt(password, salt, expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  // Length-checked first because timingSafeEqual throws on a mismatch rather
  // than returning false.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Tokens are random, and only their SHA-256 is stored.
 *
 * A database leak must not hand the attacker live sessions and working device
 * keys. Hashing is unsalted and uses a plain digest on purpose: the input is
 * 256 bits of entropy, so there is nothing to brute-force and no reason to pay
 * a KDF's cost on every request.
 */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token: string): string {
  return sha256(token);
}

// ---------------------------------------------------------------- sessions

export interface SessionRecord {
  sessionId: string;
  userId: string;
  tenantId: string;
  role: TenantRole;
  displayName: string;
  email: string;
}

/**
 * Resolve a session cookie to a principal.
 *
 * Runs unscoped, necessarily: there is no tenant until this query answers what
 * it is. That is the whole reason `withoutTenant` exists, and why the identity
 * tables carry no tenant policy.
 *
 * Expiry is filtered in SQL rather than compared in JS so there is exactly one
 * clock involved — the database's — and a service with a skewed clock cannot
 * extend or shorten sessions.
 */
export async function resolveSession(token: string): Promise<SessionRecord | null> {
  return withoutTenant(async (db) => {
    const { rows } = await db.query<SessionRecord>(
      `SELECT s.id       AS "sessionId",
              s.user_id  AS "userId",
              s.tenant_id AS "tenantId",
              m.role,
              u.display_name AS "displayName",
              u.email
         FROM sessions s
         JOIN users u          ON u.id = s.user_id
         JOIN tenant_members m ON m.tenant_id = s.tenant_id AND m.user_id = s.user_id
         JOIN tenants t        ON t.id = s.tenant_id
        WHERE s.token_hash = $1
          AND s.expires_at > now()
          AND u.is_active
          AND t.status = 'active'`,
      [tokenHash(token)],
    );
    return rows[0] ?? null;
  });
}

export async function touchSession(sessionId: string): Promise<void> {
  await withoutTenant(async (db) => {
    await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [sessionId]);
  });
}

export async function deleteSession(token: string): Promise<void> {
  await withoutTenant(async (db) => {
    await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
  });
}

/** Housekeeping. Expired rows are dead weight and a needless disclosure risk. */
export async function purgeExpiredSessions(): Promise<number> {
  return withoutTenant(async (db) => {
    const { rowCount } = await db.query('DELETE FROM sessions WHERE expires_at < now()');
    return rowCount ?? 0;
  });
}

// ---------------------------------------------------------------- api keys

/**
 * Resolve an API key to a principal.
 *
 * `key_prefix` narrows the index scan; `key_hash` is what actually
 * authenticates. Looking up by prefix alone and comparing in JS would turn a
 * unique-index probe into a scan and invite a timing comparison in application
 * code.
 */
export async function resolveApiKey(key: string): Promise<Principal | null> {
  const prefix = key.slice(0, 8);
  return withoutTenant(async (db) => {
    const { rows } = await db.query<{
      id: string; tenantId: string; kind: 'device' | 'service'; scopes: string[];
    }>(
      `SELECT k.id, k.tenant_id AS "tenantId", k.kind, k.scopes
         FROM api_keys k
         JOIN tenants t ON t.id = k.tenant_id
        WHERE k.key_prefix = $1
          AND k.key_hash = $2
          AND k.revoked_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > now())
          AND t.status = 'active'`,
      [prefix, tokenHash(key)],
    );
    const row = rows[0];
    if (!row) return null;

    // Best-effort, and deliberately not awaited on the ingest hot path: a
    // last-used timestamp is operational nicety, not authentication.
    void db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id])
      .catch(() => {});

    return {
      kind: 'api_key',
      tenantId: row.tenantId as Principal['tenantId'],
      apiKeyId: row.id as never,
      keyKind: row.kind,
      scopes: row.scopes,
    } as Principal;
  });
}

// ------------------------------------------------------------- ws tickets

/**
 * Short-lived WebSocket tickets.
 *
 * The dashboard and ingest are different origins, so ingest never sees the
 * session cookie, and the cookie is HttpOnly so the page cannot read it to
 * forward one. The dashboard mints a ticket from its own authenticated session
 * and the browser presents that on the socket.
 *
 * Signed rather than stored: a table would need a write per page load and a
 * sweep, to protect a credential that is valid for one minute. The trade is
 * that a ticket cannot be made single-use, so the TTL is the whole defence —
 * keep it short, and never put one in a URL where it would reach an access log.
 *
 * The secret must match between web and ingest. There is no development
 * fallback on purpose: a default signing key that works locally is a default
 * signing key that ships.
 */
export interface WsTicket {
  tenantId: string;
  userId: string;
  exp: number;
}

function ticketSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'AUTH_SECRET must be set to at least 32 characters. It signs WebSocket ' +
        'tickets and must be identical for the web and ingest services.',
    );
  }
  return secret;
}

export function signWsTicket(payload: Omit<WsTicket, 'exp'>, ttlMs = 60_000): string {
  const body = JSON.stringify({ ...payload, exp: Date.now() + ttlMs } satisfies WsTicket);
  const encoded = Buffer.from(body).toString('base64url');
  const mac = createHmac('sha256', ticketSecret()).update(encoded).digest('base64url');
  return `${encoded}.${mac}`;
}

export function verifyWsTicket(ticket: string): WsTicket | null {
  const dot = ticket.indexOf('.');
  if (dot <= 0) return null;

  const encoded = ticket.slice(0, dot);
  const mac = Buffer.from(ticket.slice(dot + 1), 'base64url');
  const expected = createHmac('sha256', ticketSecret()).update(encoded).digest();
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as WsTicket;
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}
