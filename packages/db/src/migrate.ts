/**
 * Numbered-file migration runner.
 *
 * Migrations are raw .sql on purpose. Hypertables, continuous aggregates,
 * compression and retention policies have no representation in an ORM schema
 * DSL, so an ORM-generated chain would need hand-written escape hatches for
 * most of this schema anyway. One canonical chain, applied in filename order.
 *
 * Migrations run as the SCHEMA OWNER (`DATABASE_URL_OWNER`), not as the
 * application role. DDL, role creation and the RLS policies in 007 all require
 * it, and the owner is deliberately the only identity that bypasses those
 * policies. Services must never use this connection — see client.ts.
 *
 * A file whose first lines contain `-- @no-transaction` is split into
 * statements and executed without a surrounding BEGIN. TimescaleDB refuses to
 * create a continuous aggregate inside a transaction block. Such a file can
 * therefore fail part-applied; it is only recorded once every statement
 * succeeds, and the error names the statement that failed.
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOwnerPool, closePool } from './client.ts';
import { splitStatements } from './sql-split.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

type Migration = { version: string; sql: string; checksum: string; noTransaction: boolean };

async function loadMigrations(): Promise<Migration[]> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return Promise.all(
    files.map(async (file) => {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      return {
        version: file.replace(/\.sql$/, ''),
        sql,
        checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16),
        // Only honour the directive in the file's leading comment block.
        noTransaction: /^\s*--\s*@no-transaction\s*$/m.test(sql.slice(0, 500)),
      };
    }),
  );
}

async function ensureRegistry(): Promise<void> {
  await getOwnerPool().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedVersions(): Promise<Map<string, string>> {
  const { rows } = await getOwnerPool().query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations',
  );
  return new Map(rows.map((r) => [r.version, r.checksum]));
}

async function applyOne(m: Migration): Promise<void> {
  const pool = getOwnerPool();

  if (m.noTransaction) {
    const statements = splitStatements(m.sql);
    for (const [idx, stmt] of statements.entries()) {
      try {
        await pool.query(stmt);
      } catch (err) {
        const preview = stmt.replace(/\s+/g, ' ').slice(0, 160);
        throw new Error(
          `${m.version}: statement ${idx + 1}/${statements.length} failed.\n` +
            `  SQL: ${preview}${stmt.length > 160 ? '…' : ''}\n` +
            `  ${(err as Error).message}\n` +
            `  NOTE: this file runs outside a transaction, so earlier statements ` +
            `are already applied. Drop the database and re-run rather than ` +
            `re-applying on top.`,
          { cause: err },
        );
      }
    }
    await pool.query(
      'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
      [m.version, m.checksum],
    );
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(m.sql);
    await client.query(
      'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
      [m.version, m.checksum],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`${m.version} failed: ${(err as Error).message}`, { cause: err });
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const statusOnly = process.argv.includes('--status');

  await ensureRegistry();
  const migrations = await loadMigrations();
  const applied = await appliedVersions();

  if (statusOnly) {
    for (const m of migrations) {
      const seen = applied.get(m.version);
      const state = seen === undefined
        ? 'pending'
        : seen === m.checksum
          ? 'applied'
          : `applied (CHECKSUM DRIFT — file edited since it ran; was ${seen}, now ${m.checksum})`;
      console.log(`  ${m.version.padEnd(20)} ${state}`);
    }
    return;
  }

  let count = 0;
  for (const m of migrations) {
    const seen = applied.get(m.version);
    if (seen !== undefined) {
      if (seen !== m.checksum) {
        console.warn(
          `[migrate] ${m.version} was edited after being applied ` +
            `(${seen} -> ${m.checksum}). Not re-running; recreate the database ` +
            `if the change matters.`,
        );
      }
      continue;
    }
    process.stdout.write(`[migrate] applying ${m.version}${m.noTransaction ? ' (no transaction)' : ''} … `);
    await applyOne(m);
    console.log('ok');
    count++;
  }

  console.log(count === 0 ? '[migrate] nothing to apply' : `[migrate] applied ${count} migration(s)`);
}

main()
  .catch((err: unknown) => {
    console.error(`[migrate] ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(closePool);
