import { Pool, type PoolClient, type PoolConfig, types } from 'pg';

/**
 * node-postgres hands back BIGINT (int8) and NUMERIC as strings to avoid silent
 * precision loss. That is the right default for money, but `count(*)` returning
 * "24" instead of 24 is a trap every caller then works around individually.
 *
 * int8 is parsed to a number here because nothing in this schema counts past
 * 2^53. NUMERIC is deliberately left as a string — `maintenance_logs.cost` is
 * money and must not become a float.
 */
types.setTypeParser(types.builtins.INT8, (v) => Number.parseInt(v, 10));

/**
 * TWO ROLES, AND THE DIFFERENCE MATTERS.
 *
 * `DATABASE_URL` is the application role (`dtwin_app`). It is an ordinary
 * LOGIN role, subject to every row-level security policy in 007_tenancy.sql.
 *
 * `DATABASE_URL_OWNER` is the schema owner, used by the migration runner and by
 * smoke fixtures that must set up more than one tenant. It is a superuser, and
 * **a superuser bypasses RLS unconditionally — FORCE included**. Pointing a
 * service at it does not produce a permissions error; it produces a system that
 * looks correct and silently serves every tenant's data to everyone. See
 * docs/decisions.md §41.
 */
/**
 * The development password is a convenience, and a convenience that works in
 * production is how a development password reaches production. So it is
 * refused there outright, the same way AUTH_SECRET has no fallback at all.
 *
 * `007_tenancy.sql` creates the role with this password and says to rotate it;
 * this is the other half of that instruction, enforced rather than written
 * down.
 */
const DEV_APP_PASSWORD = 'dtwin_app_dev_pwd';

function appPassword(): string {
  const supplied = process.env.POSTGRES_APP_PASSWORD;
  if (supplied) return supplied;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'POSTGRES_APP_PASSWORD (or DATABASE_URL) must be set in production. ' +
        'The development default is refused here on purpose — rotate the ' +
        'password 007_tenancy.sql created and supply it explicitly.',
    );
  }
  return DEV_APP_PASSWORD;
}

function connectionConfig(url: string | undefined): PoolConfig {
  if (url) return { connectionString: url };

  return {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    database: process.env.POSTGRES_DB ?? 'dtwin',
    user: process.env.POSTGRES_APP_USER ?? 'dtwin_app',
    password: appPassword(),
  };
}

function build(url: string | undefined, label: string): Pool {
  const pool = new Pool({
    ...connectionConfig(url),
    max: Number(process.env.PGPOOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    // Telemetry writes are batched; a slow connect should fail fast rather
    // than silently queue readings in memory.
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', (err) => {
    console.error(`[db:${label}] idle client error`, err);
  });
  return pool;
}

let pool: Pool | undefined;
let ownerPool: Pool | undefined;

/** The application pool. Subject to RLS; use it for everything user-facing. */
export function getPool(): Pool {
  pool ??= build(process.env.DATABASE_URL, 'app');
  return pool;
}

/**
 * The schema-owner pool. Migrations and test fixtures only.
 *
 * Every call site is a place where tenant isolation is off, so there should be
 * few of them and each should be obvious on sight.
 */
export function getOwnerPool(): Pool {
  ownerPool ??= build(
    process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL,
    'owner',
  );
  return ownerPool;
}

export async function closePool(): Promise<void> {
  await Promise.all([pool?.end(), ownerPool?.end()]);
  pool = undefined;
  ownerPool = undefined;
}

/**
 * The narrow surface a tenant-scoped query needs.
 *
 * Deliberately not pg's own `QueryResult`. pg constrains its row generic to
 * `QueryResultRow`, an index-signature type, so a plain named interface cannot
 * be used as a row type without adding `[k: string]: unknown` to it — which
 * then defeats excess-property checking on every result shape in the codebase.
 * Declaring the two fields actually used keeps row types honest and keeps this
 * module free of a pg type in its public surface.
 */
export interface QueryRows<R> {
  rows: R[];
  rowCount: number | null;
}

export interface Db {
  query<R = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<QueryRows<R>>;
}

/** Who the work is being done for. Produced by authentication, never by a request. */
export interface TenantContext {
  tenantId: string;
  /** Present for a human principal; absent for a device or service key. */
  userId?: string;
}

/**
 * Run `fn` scoped to one tenant.
 *
 * Everything that reads or writes tenant data goes through here. The scoping is
 * a transaction-local GUC that the RLS policies read:
 *
 *   set_config('app.tenant_id', <id>, true)
 *                                    ^^^^ LOCAL to the transaction
 *
 * `true` is the load-bearing argument. A session-level setting outlives the
 * request that set it, and the next request handed that pooled connection
 * inherits it — a cross-tenant read that appears only under concurrency and
 * only in production. Transaction-local is discarded on COMMIT or ROLLBACK, so
 * there is no path, including a thrown error, that leaks the scope forward.
 *
 * This is also why it is a transaction rather than a bare connection checkout:
 * the transaction boundary IS the scope boundary.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  if (!ctx.tenantId) {
    // Not a defensive nicety. An empty GUC means current_tenant_id() is NULL,
    // every policy matches nothing, and the caller gets a confusing empty
    // result instead of an error naming the real problem.
    throw new Error('withTenant requires a tenantId');
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true),
              set_config('app.user_id',   $2, true)`,
      [ctx.tenantId, ctx.userId ?? ''],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` with NO tenant scope.
 *
 * Authentication legitimately needs this: resolving a session cookie or an API
 * key happens before there is a tenant to scope to. That is the only sanctioned
 * use. Under RLS an unscoped connection sees no tenant rows at all, so this is
 * not a back door into tenant data — but it is the one place where the database
 * is not doing the thinking, so the queries inside it must be read carefully.
 */
export async function withoutTenant<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
