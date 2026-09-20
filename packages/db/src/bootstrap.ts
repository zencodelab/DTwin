/**
 * One-command provisioning for a freshly migrated database.
 *
 * Migration 007 creates the `corniche` tenant but **no user and no API key** —
 * deliberately, because a migration that ships credentials ships them to
 * production too. The consequence was that a fresh clone could not authenticate
 * at all: every ingest route except `/healthz` wants a key, the WebSocket wants
 * a ticket minted from a session, and the dashboard wants a session cookie. The
 * documented remedy was to hand-write a TypeScript script. This is that script,
 * checked in.
 *
 * Idempotent by design, because the first thing anyone does with a bootstrap
 * command is run it twice. An existing user is reused rather than re-created,
 * and its password is left alone; an existing API key is reported rather than
 * replaced, because `api_keys` stores only a hash and a second key with the
 * same name would collide on `UNIQUE (tenant_id, name)` anyway. Pass --rotate
 * to revoke and reissue.
 *
 * Runs UNSCOPED throughout — every function it calls is provisioning, and there
 * is no tenant context until it has decided which tenant it is provisioning.
 *
 *   npm run bootstrap -w @dtwin/db
 *   npm run bootstrap -w @dtwin/db -- --email me@example.com --rotate
 */
import { randomBytes } from 'node:crypto';
import {
  addMember, createApiKey, createTenant, createUser,
  findUserByEmail, listActiveTenants, listApiKeys, rotateApiKey,
} from './queries/tenancy.ts';
import { closePool } from './client.ts';

/** The tenant migration 007 seeds. Reused unless --tenant names another. */
const DEFAULT_TENANT_SLUG = 'corniche';

/**
 * The two keys the stack cannot run without.
 *
 * Only the worker's key is process configuration. The gateway key is a
 * credential you hand to a device — `.env.example` is explicit that it gets no
 * variable, because a key is tenant-scoped data rather than a setting of this
 * process. It is printed here so there is something to POST /ingest with.
 */
const KEYS = [
  {
    kind: 'service', name: 'sim-worker', scopes: ['sim:notify'],
    // apps/sim/app/notify.py reads INGEST_API_KEY for POST /internal/sim-event.
    env: 'INGEST_API_KEY',
    note: 'the Python worker\'s credential for POST /internal/sim-event',
  },
  {
    kind: 'device', name: 'dev-gateway', scopes: ['ingest:write'],
    env: null,
    note: 'present this as `authorization: Bearer …` to POST /ingest',
  },
] as const;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(`--${flag}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * A generated password beats a default one. A default that works locally is a
 * default that ships — the same reasoning that leaves AUTH_SECRET with no
 * fallback. Printed once; nothing stores the plaintext.
 */
function generatedPassword(): string {
  return randomBytes(12).toString('base64url');
}

async function main(): Promise<void> {
  const slug = arg('tenant') ?? DEFAULT_TENANT_SLUG;
  const email = arg('email') ?? 'admin@dtwin.local';
  const name = arg('name') ?? 'DTwin Admin';
  const rotate = process.argv.includes('--rotate');
  // Machine-readable: KEY=value lines only, nothing else on stdout, so the
  // output can be appended to .env or read by CI. Progress still goes to
  // stderr, which keeps a failed run legible.
  const envOnly = process.argv.includes('--env');
  const say = envOnly
    ? (msg: string) => console.error(msg)
    : (msg: string) => console.log(msg);

  const supplied = arg('password') ?? process.env.DTWIN_BOOTSTRAP_PASSWORD;
  const password = supplied ?? generatedPassword();

  // ---------------------------------------------------------------- tenant
  const tenants = await listActiveTenants();
  let tenant = tenants.find((t) => t.slug === slug);
  if (!tenant) {
    const id = await createTenant(slug, arg('tenant-name') ?? slug);
    tenant = { id, slug };
    say(`[bootstrap] created tenant ${slug}`);
  } else {
    say(`[bootstrap] using existing tenant ${slug}`);
  }

  // ------------------------------------------------------------------ user
  const existing = await findUserByEmail(email);
  let userId: string;
  let passwordToShow: string | null = null;

  if (existing) {
    userId = existing.id;
    say(`[bootstrap] using existing user ${email} (password unchanged)`);
    if (!existing.isActive) {
      console.warn('[bootstrap] WARNING: that user is inactive and cannot sign in.');
    }
  } else {
    userId = await createUser(email, name, password);
    passwordToShow = password;
    say(`[bootstrap] created user ${email}`);
  }
  // Already an upsert on (tenant_id, user_id), so safe to repeat.
  await addMember(tenant.id, userId, 'owner');

  // -------------------------------------------------------------- api keys
  const present = await listApiKeys(tenant.id);
  const issued: Array<{ env: string | null; key: string; note: string }> = [];

  for (const spec of KEYS) {
    const live = present.find((k) => k.name === spec.name && k.revokedAt === null);
    if (live && !rotate) {
      say(
        `[bootstrap] api key ${spec.name} already exists (${live.prefix}…) — ` +
          're-run with --rotate to replace it',
      );
      continue;
    }
    const created = live
      ? await rotateApiKey(tenant.id, spec.kind, spec.name, [...spec.scopes])
      : await createApiKey(tenant.id, spec.kind, spec.name, [...spec.scopes]);
    issued.push({ env: spec.env, key: created.key, note: spec.note });
    say(`[bootstrap] ${live ? 'rotated' : 'created'} api key ${spec.name}`);
  }

  // ----------------------------------------------------------------- report
  if (envOnly) {
    console.log(`DTWIN_DEMO_TENANT_ID=${tenant.id}`);
    for (const { env, key } of issued) if (env) console.log(`${env}=${key}`);
    if (passwordToShow) console.log(`DTWIN_BOOTSTRAP_PASSWORD=${passwordToShow}`);
    return;
  }

  console.log('\n--- shown once; only hashes are stored ---\n');
  console.log('# .env');
  console.log(`DTWIN_DEMO_TENANT_ID=${tenant.id}`);
  for (const { env, key, note } of issued.filter((i) => i.env)) {
    console.log(`${env}=${key}   # ${note}`);
  }
  for (const { key, note } of issued.filter((i) => !i.env)) {
    console.log(`\n# not an env var — ${note}:\n${key}`);
  }
  if (passwordToShow) {
    console.log(`\nSign in at http://localhost:3000 as  ${email}`);
    console.log(`Password: ${passwordToShow}${supplied ? '' : '   (generated — change it)'}`);
  }
  if (!issued.length && !passwordToShow) {
    console.log('(nothing new to show — everything was already provisioned)');
  }
  console.log('');
}

main()
  .catch((err: unknown) => {
    console.error(`[bootstrap] ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(closePool);
