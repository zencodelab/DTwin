# Operations and development

**Reviewed: 18 September 2026, updated for the multi-tenancy migration.** These
are development and controlled-pilot procedures. Production access control,
recovery automation, and service targets remain work items in the
[CTO assessment](cto-assessment.md).

🚧 **`apps/web` does not currently build.** Migrations `007`/`008` and
`packages/db`/`apps/ingest` are converted for tenancy; `apps/web` and `apps/sim`
are not. `npm run typecheck` fails in `@dtwin/web` until that conversion lands.
See [multi-tenancy.md](multi-tenancy.md) for exact status before running the
full stack.

## Start a development environment

Prerequisites: Node.js 20 or later (containers use Node 22), npm, Docker with
Compose, and `uv` for the local Python 3.12 worker. Run commands from the
repository root. Use a development database: migrations include a demonstration
building, and smoke suites modify fixture data.

```bash
# On a fresh checkout only; preserve an existing .env.
cp .env.example .env
npm ci
set -a
source .env
set +a
npm run db:up
npm run db:seed     # migrate, including the demonstration building
npm run bootstrap   # create the first user and the API keys
npm run sim:install
```

`db:seed` is `db:migrate` plus the demo data. **Use `db:migrate` alone for
anything real** — it skips `005_seed.sql` and records it as `skipped:`, so a
deployment does not quietly acquire Corniche Tower. The choice is made once per
database and cannot be reversed: `007_tenancy.sql` makes `tenant_id` NOT NULL,
so the seed only inserts cleanly in its own chain position. To change your mind,
`docker compose down -v` and start again. `npm run db:migrate --status` says
which of the two any database got.

`bootstrap` prints the tenant id and the API keys **once**, as a `# .env` block
— put them in `.env`: `DTWIN_DEMO_TENANT_ID`, `INGEST_API_KEY` (the worker's
`sim-worker` key), `SIM_API_KEY` (the web service's `web-proxy` key) and
`COPILOT_SIM_API_KEY` (the copilot's sim-only `copilot-sim` key; without it
the copilot runs no simulations). The device gateway's `dev-gateway` key is
printed apart, as it is not an environment variable of any service. It is
idempotent: re-running reuses the existing tenant and user and leaves the
password alone. `--rotate` replaces the keys (atomically, keeping the revoked
rows as an audit trail); `--email`, `--name`, `--password` and `--tenant`
override the defaults. Without `--password` it generates one and prints it,
because a default password that works locally is a default password that ships.

There are currently nine migrations, `001_spatial` through
`009_api_key_rotation`. `007_tenancy.sql` also creates the `dtwin_app`
database role that every service other than the migration runner must connect
as — see the credentials section below, and set `DATABASE_URL` /
`DATABASE_URL_OWNER` correctly in `.env` **before** running `db:migrate`, or
the migration itself still works (it runs as the owner regardless) but every
service you start afterward will silently run as the owner too if
`DATABASE_URL` was left pointing there. Compose does not run migrations for
you. The `timescaledb-ha:pg17` image is needed for TimescaleDB, PostGIS, and
Toolkit in one database; the image name does not make this single-container
deployment highly available.

For local processes, export the trusted local environment file in **each
terminal** before starting a service. The Node ingest and Python entry points
read the process environment; they do not automatically load the root `.env`.

```bash
set -a
source .env
set +a
```

Then use separate terminals:

```bash
npm run dev:ingest    # HTTP / WebSocket :8787; synthetic feed enabled by default
npm run dev:sim       # FastAPI :8000
npm run dev:web       # Dashboard :3000
```

Open [the local dashboard](http://localhost:3000). The shared DB client prefers
`DATABASE_URL` over its `POSTGRES_*` fallback fields.

For a containerized application, first complete database startup and migrations,
then run:

```bash
docker compose --profile app up -d --build
docker compose --profile app ps
```

Do not run host services on the same ports at the same time. Compose's `.env`
substitution does not inject every variable into a container: only the values
listed under each service's `environment` are passed. Add explicit environment
entries or a Compose override for additional tuning, including `SIM_ENABLED=false`
when replacing the demo feed with a real gateway.

The current Compose configuration sends worker events to `http://ingest:8787`
and simulation requests to `http://sim:8000`. The browser uses
`ws://localhost:8787/ws`; for a remote browser that address refers to the
browser's machine. Set the public socket endpoint for the intended deployment
and verify it in the delivered page. Check HTTPS/WSS and access control as part
of the pilot deployment work.

## Credentials for a fresh database

`npm run bootstrap` (above) does this. What follows is what it does and why,
for when you need something it does not offer.

Migration `007` seeds the `corniche` tenant **only if a building already
exists** — that is, only on a seeded database — and creates **no user and no
API key** on any database. Nothing shipped in a migration can authenticate,
deliberately: a migration that carries credentials carries them to production.

Every HTTP route on `apps/ingest` except `/healthz`, `/livez`, `/readyz` and
`/metrics` requires a key, and its
WebSocket requires a signed ticket minted from a logged-in session, so
`apps/ingest`'s own smoke suite (and any manual exercise of it) needs both
provisioned first. The building blocks are in
[`packages/db/src/queries/tenancy.ts`](../packages/db/src/queries/tenancy.ts)
and are what `bootstrap.ts` calls:

```ts
import {
  createTenant, createUser, addMember, createApiKey, rotateApiKey,
} from '@dtwin/db/queries';

const tenantId = await createTenant('acme', 'Acme Facilities');
const userId = await createUser('you@example.com', 'Your Name', 'a real password');
await addMember(tenantId, userId, 'owner');

// For a device or gateway posting to POST /ingest:
const device = await createApiKey(tenantId, 'device', 'dev-gateway', ['ingest:write']);
console.log(device.key); // shown once — nothing stores the plaintext

// For the simulation worker's POST /internal/sim-event relay:
const service = await createApiKey(tenantId, 'service', 'sim-worker', ['sim:notify']);
console.log(service.key);
```

`createApiKey`'s return value is the only time the plaintext key exists;
`api_keys.key_hash` is all that is stored. Losing it means creating a new key,
not recovering the old one — use `rotateApiKey`, which revokes and reissues in
one transaction so the name is never left without a live key.

`AUTH_SECRET` must also be set (see `.env.example`) before `apps/ingest` will
start at all — it fails fast on boot rather than running with an insecure
default; there is none to fall back to. `POSTGRES_APP_PASSWORD` behaves the
same way when `NODE_ENV=production`: the `dtwin_app_dev_pwd` that
`007_tenancy.sql` creates the role with is refused there, so the rotation that
migration asks for is enforced rather than merely recommended.

## Configuration that changes behavior

Authoritative definitions are in [ingest config](../apps/ingest/src/config.ts),
[worker config](../apps/sim/app/config.py),
[worker event relay](../apps/sim/app/notify.py), and
[Compose](../docker-compose.yml). Defaults below apply at process startup.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | Local development connection | **The application role.** Every TypeScript service connects as this; Python uses it too rather than `POSTGRES_*` parts. Subject to every row-level security policy |
| `DATABASE_URL_OWNER` | Falls back to `DATABASE_URL` | **The schema owner.** Migration runner and multi-tenant test fixtures only — bypasses row-level security unconditionally. Never point a running service at it. See `.env.example` and [decisions.md](decisions.md) §41 |
| `POSTGRES_APP_USER` / `POSTGRES_APP_PASSWORD` | `dtwin_app` / `dtwin_app_dev_pwd` | Fallback connection parts for the app role when `DATABASE_URL` is unset; created by migration `007` |
| `AUTH_SECRET` | **None — required, ≥32 chars** | Signs WebSocket tickets. Must be identical on web and ingest. The process refuses to start without it |
| `PGPOOL_MAX` | `10` | Maximum connections per TypeScript pool; worker pool maximum is 8 |
| `INGEST_PORT` | `8787` | Device HTTP and browser WebSocket server |
| `INGEST_FLUSH_INTERVAL_MS` / `INGEST_FLUSH_MAX_ROWS` | `1000` / `5000` | Either condition triggers a write flush |
| `INGEST_BUFFER_MAX_ROWS` | `100000` | Oldest readings drop above the cap |
| `INGEST_FANOUT_INTERVAL_MS` | `250` | Telemetry frame batching window |
| `INGEST_CLIENT_BUFFER_MAX_BYTES` | `1000000` | Skip sends above this socket backlog |
| `INGEST_REGISTRY_REFRESH_MS` | `60000` | Refresh provisioned sensors |
| `ALERT_ENABLED` | `true` | Run alert rules |
| `ALERT_SWEEP_INTERVAL_MS` / `ALERT_REFRESH_MS` | `5000` / `60000` | Window-rule evaluation / rule refresh |
| `ALERT_NOTIFY_ENABLED` | `false` | Enable outbound notification attempts |
| `ALERT_NOTIFY_RETRY_MS` | `60000` | Webhook retry sweep |
| `ALERT_WEBHOOK_TIMEOUT_MS` / `ALERT_WEBHOOK_MAX_ATTEMPTS` | `5000` / `3` | Bound webhook calls and retries |
| `ALERT_WEBHOOK_ALLOW_PRIVATE` | `false` | Local receiver testing only |
| `SIM_ENABLED` / `SIM_TICK_MS` / `SIM_SPEEDUP` | `true` / `1000` / `10` | Ingest's synthetic device generator, not the Python engine |
| `SIM_BASE_URL` | `http://localhost:8000` | Next.js-to-worker connection: the scenario proxy and the copilot's what-if runs |
| `INGEST_BASE_URL` | `http://localhost:8787` | Worker-to-ingest (run progress) and web-to-ingest (the control proxy, and the copilot's dry runs and approved commands) |
| `SIM_API_KEY` | unset | Web's key for the worker and for ingest's `/control` routes (bootstrap `web-proxy`: `sim:run`, `control:write`) |
| `ANTHROPIC_API_KEY` | unset | The copilot's model credential, on the web service. Without it the copilot answers 503 and says so; nothing else is affected. `ANTHROPIC_AUTH_TOKEN` also works for a web process started by hand (Compose passes only `ANTHROPIC_API_KEY`). An `ant auth login` profile does NOT: the route asks for one of the two variables before it builds a client |
| `COPILOT_MODEL` | `claude-opus-5` | The copilot's lead model: planner, compose and the controller. Blank means unset |
| `COPILOT_SPECIALIST_MODEL` | the lead model | The diagnose, analyse and simulate specialists. Blank means unset; nothing defaults to a cheaper model |
| `COPILOT_SIM_API_KEY` | unset | The copilot's sim-only key (bootstrap `copilot-sim`, scope `sim:run` only). Unset, the copilot runs no simulations — it never borrows `SIM_API_KEY`, which can also command |
| `INGEST_NOTIFY_TIMEOUT_S` | `3.0` | Timeout per worker event post |
| `SIM_SUBSTEP_S` | `300` | Physics integration step |
| `SIM_GROUND_REFLECTANCE` / `SIM_CAPACITY_FACTOR` | `0.2` / `1.25` | Solar reflection and auto-sizing margin |
| `NEXT_PUBLIC_WS_URL` | `ws://localhost:8787/ws` | Browser socket endpoint |

`INGEST_INTERNAL_TOKEN` no longer exists. The worker now authenticates to
`POST /internal/sim-event` with a `service`-kind API key (scope `sim:notify`),
the same mechanism as every other caller of `apps/ingest` — see
[Credentials for a fresh database](#credentials-for-a-fresh-database) above and
the ingest table in [api.md](api.md).

Configure notification destinations in `alert_rules.notify`; enabling the flag
alone does not create destinations. For example, `{"log": true}` enables a log
target for a rule, while `{"webhook": "https://receiver.example/alerts"}` defines
a webhook. Email is delivered when `ALERT_SMTP_URL` and `ALERT_EMAIL_FROM` are
set, and records `failed` with "no email transport configured" when they are not.
There is no rule-administration API in the current application.

## Health and diagnosis

```bash
curl --fail http://localhost:8787/healthz     # readiness, with the full stats tree
curl --fail http://localhost:8787/readyz      # readiness, one boolean
curl --fail http://localhost:8787/livez       # liveness — never asks the database
curl        http://localhost:8787/metrics     # Prometheus text
curl --fail http://localhost:8000/healthz
docker compose logs --tail=100 ingest sim web
```

Supervisory control is **off until a tenant switches it on**, and an owner or
admin must do it — `POST /control/settings {"enabled": true}`. Overrides lapse
on their own (`effective_until`); nothing reverts them, so the way to stop one
early is `POST /control/commands/cancel` if it has not been applied, or to wait.
To stop everything at once, set `enabled` false: it is read on every gateway
claim and never cached, queued commands then lapse untouched, and applied
overrides run out on their own clocks
([§62](decisions.md#62-the-twin-is-allowed-to-act-and-every-part-of-that-is-a-refusal)).

The **copilot** needs `ANTHROPIC_API_KEY` on the web service (or
`ANTHROPIC_AUTH_TOKEN`, for a web process started by hand — Compose passes
only the key). An `ant auth login` profile is not enough, although the SDK
would read one: the route checks for one of the two variables before it builds
a client (`hasModelCredential`). Without one, the panel says so and nothing
else is affected. It
proposes and never applies: every command it issues went through the operator's
Approve and is recorded against that person with a `copilot (operator-approved):`
reason prefix, so `GET /control/commands` distinguishes them
([§63](decisions.md#63-the-copilot-proposes-a-person-approves-the-graph-makes-that-structural),
[§64](decisions.md#64-the-copilot-investigates-in-parallel-answers-from-evidence-and-reaches-the-building-through-one-door)).

- **A restart drops pending plans.** Suspended runs, the approval ledger and
  each request's budget live in web-process memory. A restart forgets a plan
  awaiting approval and nothing is issued for it — the operator asks again —
  and a second web replica would not share any of it. That memory is bounded:
  each conversation keeps only its latest checkpoint, a person at most 16
  conversations, and the process at most 200 people. Past 200, the least
  recently used person with nothing running or pending is let go; if everyone
  is busy, a new person gets 503 with `Retry-After` and `copilot.graphs_busy`
  is logged, and nobody's plan is dropped.
- **Simulation is off until `COPILOT_SIM_API_KEY` is set** (`npm run
  bootstrap` mints `copilot-sim`). With it, the copilot starts what-if runs on
  its own, bounded: one copilot run at a time per web process, a baseline and
  at most two scenarios per request, twelve runs per person per hour, 45 s
  each before it cancels one.
- **It shares the worker's slots with people.** The worker admits
  `SIM_MAX_CONCURRENT_RUNS` runs (default 2) across every tenant, without
  regard to whose they are. A copilot run holds one of those two for its
  duration, leaving every person's scenario panel one between them — a second
  run meets a 429. The copilot itself surfaces a 429 as a refusal and never
  retries. Its process
  slot is leased for 60 s, so a run whose cancel never reached the worker
  cannot hold it for the life of the process.
- **Deleting its runs.** Copilot runs are named `copilot: <scenario>` and
  described `copilot run; user <id>; request <id>`. Delete their
  `simulation_runs` rows — the results go with them (`ON DELETE CASCADE`) —
  and never with
  `drop_chunks`: `simulation_results` is chunked by *simulated* time, so
  dropping a chunk deletes every run's results for those dates, the scenario
  panel's included.

```sql
-- As the owner, or scoped to the tenant (set app.tenant_id first).
DELETE FROM simulation_runs
 WHERE scenario_name LIKE 'copilot: %' AND requested_at < now() - INTERVAL '7 days';
```

Copilot log events are `copilot.*` (§64 lists them). A failed turn is logged
by the error's name and HTTP status only, never its message.

Logs are JSON, one object per line, with a stable `event` and named fields
([§61](decisions.md#61-one-request-id-three-services-and-an-event-name-that-is-not-prose)).
`LOG_FORMAT=text` is for a terminal. Every request carries an `x-request-id`,
taken from the caller when usable and returned on the response; the web proxy
forwards it to the worker and the worker forwards it to ingest, so one id
covers a browser click end to end:

```bash
docker compose logs --no-log-prefix ingest sim | grep '"requestId":"<id>"'
docker compose logs --no-log-prefix ingest | python3 -c 'import sys,json;
[print(r["event"], r.get("error","")) for r in map(json.loads, sys.stdin) if r["level"]=="error"]'
```

Under an orchestrator, liveness is `/livez` and readiness is `/readyz`. **Do not
point a liveness probe at `/healthz` or `/readyz`**: both go 503 during a
database outage, and restarting ingest then discards the write buffer that
exists to ride the outage out
([§58](decisions.md#58-liveness-does-not-ask-the-database-metrics-carry-no-tenant)).

Worth alerting on from `/metrics`: any increase in
`dtwin_ingest_readings_dropped_total` (data was lost),
`dtwin_ingest_writer_failed_flushes_total`, sustained growth in
`dtwin_ingest_writer_buffered_readings` (it precedes drops),
`dtwin_ingest_ws_backlogged_closed_total` (clients are being made to
reconcile), and `dtwin_ingest_rate_limit_refused_total` by `limiter`. Metrics
carry no tenant labels by design; per-tenant figures come from the database.

Ingest returns 200 when its registry is nonempty, buffered rows are below the
cap, and the last writer error is null; otherwise 503. This is not a fresh DB
probe on every request or proof of notification delivery. The worker probes
the database and returns 503 if it is unreachable. There is no dedicated web
health endpoint. Inspect the page and its API/socket behavior separately.

| Symptom | Inspect | Response |
|---|---|---|
| Live values move but history does not | `writer.lastError`, `failedFlushes`, `buffered`, `dropped` | Restore DB connectivity; check recovery of writes and quantify the lost interval |
| Missing gateway readings | Ingest `unknownIds`, registry contents, active sensors | Correct external-ID mapping; wait for refresh and resend with the original timestamps |
| A zone is grey with "no reading · N min" or "reading flagged" | That zone's sensors: `last_seen_at`, and `quality` on recent rows in `telemetry` | The map is reporting a real condition, not failing: only good readings under three sample intervals old colour a zone ([§55](decisions.md#55-the-live-map-judges-a-reading-before-it-draws-one)). Fix the point; colour returns on its next good reading |
| Clients reconnect whenever an alert fires | `fanout.backloggedClosed` on `/healthz` | Those clients were too backlogged to take an alert frame, which is never skipped ([§56](decisions.md#56-an-alert-frame-is-never-skipped-a-client-too-slow-for-one-is-disconnected)). Look at their link, or at `INGEST_CLIENT_BUFFER_MAX_BYTES` |
| A command sits `pending` and is never applied | `GET /control/commands`; `withheld` from the gateway's claim | The gateway is not polling, or the envelope is refusing it at dispatch — equipment in fault/maintenance, or the zone's own sensor stale or flagged. `outcome_detail` on the row names which |
| Setpoints revert on their own | `effective_until` on the applied command | Working as designed: an override expires so a dead optimiser cannot hold a building. Re-issue, or change the thermal profile if it should be permanent |
| Gateways receive 429 | `limits` on `/healthz`; the `Retry-After` header | A tenant is over its reading budget, or an address is failing authentication. Raise `INGEST_RATE_*` only after confirming the traffic is legitimate ([§54](decisions.md#54-rate-limits-are-per-resource-keyed-by-whoever-can-exhaust-it)) |
| Alert appears resolved in DB but open on screen | Fresh `/api/alerts` versus browser state | Reload to refresh the snapshot; track the browser reconciliation defect |
| No notification arrives | `ALERT_NOTIFY_ENABLED`, rule config, `alert_notifications`, `alerts.notify` health counters | Inspect status and last error; exhausted attempts and resolved alerts are not automatically retried |
| Scenario completes without progress | Worker relay address/token and current browser topics | Compare HTTP run status; floor-focused subscriptions currently miss simulation events |
| Run stays queued/running after restart | `simulation_runs` and worker logs | Investigate abandoned work; no automatic resume exists. Submit a new run only after resolving ownership of the old one |
| Weather run fails | Weather rows for the requested building and period | Supply weather or explicitly select synthetic mode; verify source provenance |
| Chunk errors after build/dev switch | `apps/web/.next` | Stop the web process, clear its generated `.next` cache, then start the intended mode |

Inspect delivery history using `npm run db:psql`:

```sql
SELECT alert_id, channel, status, attempts, last_error, delivered_at
FROM alert_notifications
ORDER BY created_at DESC
LIMIT 20;
```

## Change verification

`npm run typecheck` covers all four TypeScript workspaces, web included, and
`npx vitest run` the unit tests; both need no database (checked 28 Sep 2026,
when `next build` also succeeded). After changing the copilot's graph, run
`npm run copilot:graph -- --write`: the diagrams in README and ADR 64 are
generated, and a unit test fails until they match.

For repository changes touching the database or ingest, the baseline is:

```bash
npm run db:migrate
npm run smoke -w @dtwin/db
```

Use an isolated seeded development database, and set `DATABASE_URL` /
`DATABASE_URL_OWNER` correctly first — see
[Credentials for a fresh database](#credentials-for-a-fresh-database). The DB
suite replaces recent telemetry for two fixture sensors, and additionally
creates and deletes a second tenant with its own building to assert cross-
tenant isolation (§[8] Tenant isolation in its output) — **it now sets a
failing process exit code on any FAIL line**, so a red DB smoke run correctly
fails CI rather than logging failures and exiting 0 as it used to.

The ingest suite provisions its own credentials — a tenant, a device key, and a
service key, all cleaned up at the end — so it needs no manual setup beyond
`AUTH_SECRET` being derivable (it sets its own for the child process it spawns).
It deletes alerts and adds temporary rules; it refuses to run alongside a
default-port ingest service because concurrent synthetic feeds invalidate meter
assertions, and it now also asserts that an unauthenticated request, a garbage
key, and a second tenant's key are all correctly refused (§[9] Authentication
and tenant isolation).

```bash
npm run smoke -w @dtwin/ingest  # starts its test server on :8899
```

`npm run smoke:sim` spawns its own worker on :8912 against `DATABASE_URL` and
needs `DTWIN_DEMO_TENANT_ID`; it passed on a migrated, seeded database on
28 Sep 2026. `npm run smoke -w @dtwin/web` drives a running web service at
`WEB_BASE_URL` (default `http://localhost:3000`, so point it elsewhere unless
that stack's data may change), with ingest and the worker behind it. Its
copilot decision check signs in as `WEB_SMOKE_EMAIL` / `WEB_SMOKE_PASSWORD` —
an operator of the tenant under test — and needs a model credential on the web
service; without either it prints SKIP and why, never a pass. The model itself
is never called. Smoke success does not substitute for browser, overload,
failure-recovery, or physical calibration tests.

Migrations are append-only. Add the next unused numbered SQL file; never modify
an applied file. Nontransactional migrations can partially apply. On failure,
inspect the failed statement and database state before choosing recovery; never
apply the runner's disposable-database reset advice to a valuable database.
There is no automated down-migration path.

## Shutdown and recovery boundaries

Ingest attempts a final writer flush on SIGTERM/SIGINT. This is not a durable
drain guarantee: shutdown can overlap an existing flush or encounter a DB
failure. Preserve upstream data until an appropriate durability design exists.
Worker restarts do not resume in-process simulations.

`docker compose --profile app down` stops the stack while preserving the named
database volume. Removing volumes destroys local data. A named volume is not a
backup. Before a real pilot, assign a backup owner, define retention and
recovery objectives, and demonstrate restore into a separate environment with
compatible database extensions. That procedure is not implemented here.

## Verification record

On 18 September 2026, for the documentation pass preceding the multi-tenancy
migration:

| Check | Result |
|---|---|
| TypeScript checks, all four TS workspaces | Passed |
| Migration runner on local development DB | Passed; nothing to apply |
| Database smoke suite | All 44 printed checks passed; no FAIL lines |
| Docker status inspection | Local DB running and healthy |
| Full app smoke suites, browser checks, load/restore tests | Not run in this pass |

Only documentation was changed by that pass; no feature fixes were claimed.

**Superseded record, same day, after migrations `007`/`008` landed:**

| Check | Result |
|---|---|
| `npm run typecheck -w @dtwin/types` | Passed |
| `npm run typecheck -w @dtwin/db` | Passed |
| `npm run typecheck -w @dtwin/ingest` | Passed |
| `npm run typecheck -w @dtwin/web` | **Failed** — not yet converted for the new `@dtwin/db` query signatures |
| Migration runner, fresh database, `001` through `008` | Passed, in order, no checksum drift |
| `npm run smoke -w @dtwin/db` | All checks including tenant isolation (§[8]) passed; exit code now correctly reflects failures |
| `npm run smoke -w @dtwin/ingest` | Passed, including the added auth/tenancy assertions (§[9]) |
| Python worker (`apps/sim`), web app smoke, full-stack browser checks | Not run — both are pre-tenancy and were not exercised against the new schema |

The database was isolation-tested directly with `psql`, independent of the TS
smoke suites, before any application code was written against it: two tenants,
RLS enabled with `FORCE`, cross-tenant reads returning zero rows, cross-tenant
writes rejected by policy, cross-tenant re-parenting rejected by the composite
foreign keys, and a continuous-aggregate refresh confirmed to run outside RLS
(the mechanism the rebuild in `008` depends on). See
[multi-tenancy.md](multi-tenancy.md) for what was measured and why each
finding shaped the design.
