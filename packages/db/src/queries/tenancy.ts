import type { TenantMembership, TenantRole } from '@dtwin/types';
import type { Db } from '../client.ts';
import { withoutTenant } from '../client.ts';
import { hashPassword, newToken, tokenHash, verifyPassword } from '../auth.ts';

/**
 * Identity and tenant administration.
 *
 * Everything here that touches `users`, `sessions`, `tenant_members` or
 * `api_keys` runs UNSCOPED, because those tables carry no tenant policy — they
 * cannot, since authentication has to work before a tenant is known. Each such
 * function is therefore responsible for its own filtering, and that is the one
 * place in this codebase where forgetting a predicate is not caught by the
 * database. Read them with that in mind.
 */

export interface LoginResult {
  token: string;
  expiresAt: Date;
  tenantId: string;
  userId: string;
  role: TenantRole;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Authenticate an email/password pair and open a session.
 *
 * Returns null for a bad address, a bad password, an inactive user and a
 * suspended tenant alike. Distinguishing them in the response would turn the
 * login form into an account-enumeration oracle, and the operator can tell the
 * difference from the audit trail.
 *
 * A password is verified even when no user matched, against a dummy hash, so
 * the response time does not reveal whether the address exists.
 */
const ABSENT_USER_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$' +
  'ZmFrZWhhc2hmb3J0aW1pbmdlcXVhbGl0eW9ubHlub3RhcmVhbA';

export async function login(
  email: string,
  password: string,
  tenantSlug?: string,
): Promise<LoginResult | null> {
  return withoutTenant(async (db) => {
    const { rows } = await db.query<{
      id: string; passwordHash: string | null; isActive: boolean;
    }>(
      `SELECT id, password_hash AS "passwordHash", is_active AS "isActive"
         FROM users WHERE lower(email) = lower($1)`,
      [email],
    );

    const user = rows[0];
    const ok = await verifyPassword(password, user?.passwordHash ?? ABSENT_USER_HASH);
    if (!user || !ok || !user.isActive) return null;

    // Which tenant this session activates. Named slug if given, otherwise the
    // membership the user has held longest — stable across logins, which an
    // arbitrary "first row" would not be.
    const { rows: memberships } = await db.query<{ tenantId: string; role: TenantRole }>(
      `SELECT m.tenant_id AS "tenantId", m.role
         FROM tenant_members m
         JOIN tenants t ON t.id = m.tenant_id
        WHERE m.user_id = $1
          AND t.status = 'active'
          AND ($2::text IS NULL OR t.slug = $2)
        ORDER BY m.created_at
        LIMIT 1`,
      [user.id, tenantSlug ?? null],
    );
    const membership = memberships[0];
    if (!membership) return null;

    const token = newToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db.query(
      `INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [tokenHash(token), user.id, membership.tenantId, expiresAt],
    );
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);

    return {
      token, expiresAt,
      tenantId: membership.tenantId,
      userId: user.id,
      role: membership.role,
    };
  });
}

/** Every active tenant this user belongs to — the tenant switcher's data. */
export async function listMemberships(userId: string): Promise<TenantMembership[]> {
  return withoutTenant(async (db) => {
    const { rows } = await db.query<TenantMembership>(
      `SELECT t.id AS "tenantId", t.slug, t.name, m.role
         FROM tenant_members m
         JOIN tenants t ON t.id = m.tenant_id
        WHERE m.user_id = $1 AND t.status = 'active'
        ORDER BY t.name`,
      [userId],
    );
    return rows;
  });
}

/**
 * Point an existing session at a different tenant.
 *
 * The membership check is in the UPDATE's WHERE clause rather than a separate
 * SELECT, so there is no window between checking and switching. A request for a
 * tenant the user does not belong to changes nothing and returns false.
 */
export async function switchTenant(
  sessionId: string,
  userId: string,
  tenantId: string,
): Promise<boolean> {
  return withoutTenant(async (db) => {
    const { rowCount } = await db.query(
      `UPDATE sessions s SET tenant_id = $3
        WHERE s.id = $1
          AND s.user_id = $2
          AND EXISTS (SELECT 1 FROM tenant_members m
                       JOIN tenants t ON t.id = m.tenant_id
                      WHERE m.tenant_id = $3 AND m.user_id = $2
                        AND t.status = 'active')`,
      [sessionId, userId, tenantId],
    );
    return (rowCount ?? 0) > 0;
  });
}

/** Buildings owned by the scoped tenant. Needs a scoped handle; RLS filters it. */
export async function listBuildings(
  db: Db,
): Promise<Array<{ id: string; name: string }>> {
  const { rows } = await db.query<{ id: string; name: string }>(
    'SELECT id, name FROM buildings ORDER BY name',
  );
  return rows;
}

/**
 * The scoped tenant's own row.
 *
 * The filter is explicit, and must be. `tenants` carries NO row-level security
 * policy and cannot: login has to read it to check a tenant is active, and that
 * happens before there is a tenant to scope to. So unlike every query in
 * spatial.ts and telemetry.ts, nothing here adds a predicate on your behalf —
 * a bare `SELECT * FROM tenants` as the application role returns every
 * customer's name and slug.
 *
 * This was not theoretical. The first version of this function omitted the
 * WHERE clause on the reasoning that the policy would handle it, and the smoke
 * test caught it returning another tenant's row. It is the same trap as
 * docs/decisions.md §42, one table further up.
 */
export async function getTenant(
  db: Db,
): Promise<{ id: string; slug: string; name: string; status: string } | null> {
  const { rows } = await db.query<{ id: string; slug: string; name: string; status: string }>(
    'SELECT id, slug, name, status FROM tenants WHERE id = current_tenant_id()',
  );
  return rows[0] ?? null;
}

/**
 * Every active tenant.
 *
 * For the multi-tenant background services — ingest builds its sensor registry
 * and loads alert rules by iterating this and scoping to each in turn. That is
 * one query per tenant per refresh, which is right for tens of tenants and
 * wrong for thousands; at that point the registry wants a single query run as a
 * role that can see across tenants, with the isolation moved into how the
 * result is partitioned. Worth knowing before this list gets long.
 *
 * Unscoped, necessarily — the caller is asking which tenants exist.
 */
export async function listActiveTenants(): Promise<Array<{ id: string; slug: string }>> {
  return withoutTenant(async (db) => {
    const { rows } = await db.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM tenants WHERE status = 'active' ORDER BY slug`,
    );
    return rows;
  });
}

// ------------------------------------------------------------ provisioning

export interface CreatedApiKey {
  id: string;
  /** The only time the secret exists in plaintext. Show it once, store never. */
  key: string;
  prefix: string;
}

export async function createTenant(slug: string, name: string): Promise<string> {
  return withoutTenant(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
      [slug, name],
    );
    return rows[0]!.id;
  });
}

export async function createUser(
  email: string,
  displayName: string,
  password: string,
): Promise<string> {
  const hash = await hashPassword(password);
  return withoutTenant(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash)
       VALUES ($1, $2, $3) RETURNING id`,
      [email, displayName, hash],
    );
    return rows[0]!.id;
  });
}

export async function addMember(
  tenantId: string,
  userId: string,
  role: TenantRole,
): Promise<void> {
  await withoutTenant(async (db) => {
    await db.query(
      `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [tenantId, userId, role],
    );
  });
}

export async function createApiKey(
  tenantId: string,
  kind: 'device' | 'service',
  name: string,
  scopes: string[],
): Promise<CreatedApiKey> {
  const key = newToken();
  const prefix = key.slice(0, 8);
  return withoutTenant(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO api_keys (tenant_id, kind, name, key_prefix, key_hash, scopes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, kind, name, prefix, tokenHash(key), scopes],
    );
    return { id: rows[0]!.id, key, prefix };
  });
}
