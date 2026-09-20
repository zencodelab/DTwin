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
 * A file named `*_seed.sql` carries demonstration data, not schema, and is
 * SKIPPED unless DTWIN_SEED_DEMO=true. Without that guard every production
 * deploy would apply the demo building, because the seed sits in the same
 * append-only chain as the schema. A skipped file is recorded as
 * `skipped:<checksum>` so the chain still advances and `--status` can say what
 * happened. It cannot be back-filled later: migration 007 makes `tenant_id`
 * NOT NULL, so the seed only inserts cleanly in its own chain position. To get
 * the demo data, recreate the database with `npm run db:seed`.
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

type Migration = {
  version: string; sql: string; checksum: string;
  noTransaction: boolean; isDemoSeed: boolean;
};

/** Marks a recorded-but-not-executed migration. See the note above. */
const SKIPPED = 'skipped:';

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
        // By filename, not by a directive inside the file: adding a directive
        // would change the checksum of an already-applied migration and make
        // every existing database report drift.
        isDemoSeed: /_seed$/.test(file.replace(/\.sql$/, '')),
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

/**
 * Errors worth retrying rather than failing the chain on.
 *
 * `tuple concurrently deleted/updated` is PostgreSQL saying two sessions
 * touched the same catalogue row. Here the other session is TimescaleDB's own
 * background scheduler: 002 registers continuous-aggregate refresh policies,
 * the worker can fire one seconds later, and 008 then drops and rebuilds those
 * same aggregates. On a long-lived database the two are hours apart and it
 * never happens; on a fresh one — a new deployment, or CI — they are seconds
 * apart, and `DROP MATERIALIZED VIEW telemetry_1h` loses the race.
 *
 * Retrying is safe because the statement did not take effect: the error is
 * raised precisely because the catalogue tuple was not the one the DDL locked.
 * Only `@no-transaction` files need this — everything else rolls back and the
 * whole file is re-runnable.
 *
 * This is a retry, not a fix. The fix is for the rebuild to suspend the jobs
 * first, and that belongs in the migration; 008 is applied and append-only, so
 * it stays as it is and the next aggregate rebuild should do it properly.
 */
const TRANSIENT = [
  'tuple concurrently deleted',
  'tuple concurrently updated',
  'deadlock detected',
  'could not serialize access',
];

function isTransient(err: unknown): boolean {
  const message = (err as Error)?.message ?? '';
  return TRANSIENT.some((t) => message.includes(t));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function applyOne(m: Migration): Promise<void> {
  const pool = getOwnerPool();

  if (m.noTransaction) {
    const statements = splitStatements(m.sql);
    for (const [idx, stmt] of statements.entries()) {
      try {
        for (let attempt = 1; ; attempt++) {
          try {
            await pool.query(stmt);
            break;
          } catch (err) {
            if (attempt >= 4 || !isTransient(err)) throw err;
            console.warn(
              `\n[migrate] ${m.version}: statement ${idx + 1} hit ` +
                `"${(err as Error).message.split('\n')[0]}", retrying ` +
                `(${attempt}/3)`,
            );
            await sleep(attempt * 500);
          }
        }
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

/** Advance the chain past a file we chose not to execute, visibly. */
async function recordSkipped(m: Migration): Promise<void> {
  await getOwnerPool().query(
    'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
    [m.version, `${SKIPPED}${m.checksum}`],
  );
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
        : seen.startsWith(SKIPPED)
          ? 'skipped (demo seed; DTWIN_SEED_DEMO was not set)'
          : seen === m.checksum
            ? 'applied'
            : `applied (CHECKSUM DRIFT — file edited since it ran; was ${seen}, now ${m.checksum})`;
      console.log(`  ${m.version.padEnd(20)} ${state}`);
    }
    return;
  }

  const seedDemo = process.env.DTWIN_SEED_DEMO === 'true';

  let count = 0;
  for (const m of migrations) {
    const seen = applied.get(m.version);
    if (seen !== undefined) {
      if (seen.startsWith(SKIPPED)) {
        if (seedDemo) {
          console.warn(
            `[migrate] ${m.version} was skipped on this database and cannot be ` +
              `applied now — 007 made tenant_id NOT NULL, so the seed only ` +
              `inserts in its own chain position. Recreate the database ` +
              `(docker compose down -v) and run npm run db:seed.`,
          );
        }
        continue;
      }
      if (seen !== m.checksum) {
        console.warn(
          `[migrate] ${m.version} was edited after being applied ` +
            `(${seen} -> ${m.checksum}). Not re-running; recreate the database ` +
            `if the change matters.`,
        );
      }
      continue;
    }
    if (m.isDemoSeed && !seedDemo) {
      await recordSkipped(m);
      console.log(`[migrate] skipping ${m.version} (demo data; set DTWIN_SEED_DEMO=true to apply)`);
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
