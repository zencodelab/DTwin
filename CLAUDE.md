# CLAUDE.md / AGENTS.md

Guidance for coding agents working in DTwin. **`AGENTS.md` is a symlink to this
file** — edit either path, it is the same document.

## What this is

A Digital Twin platform for one commercial building. npm-workspaces monorepo,
not a monorepo build system — three apps, two shared packages, no Turborepo.

Read [docs/decisions.md](docs/decisions.md) before changing the data model. It
records ten decisions where the obvious choice is wrong for building analytics,
each with the reasoning and, where it was checked, the evidence.

## Current state

**The multi-tenancy migration is complete and the stack runs end to end.** All
four packages are tenant-scoped:

- `packages/db` — `withTenant` binds a transaction-local `app.tenant_id` that
  the RLS policies read; API-key, session and WebSocket-ticket authentication.
- `apps/ingest` — every route and the WebSocket handshake authenticate; topics
  are authorised per tenant on subscribe.
- `apps/web` — the tenant comes from the session cookie (`lib/tenant.ts`), never
  from a request parameter. With no session it falls back to
  `DTWIN_DEMO_TENANT_ID`, which is **ignored when `NODE_ENV=production`**; an
  unauthenticated request then redirects to `/login`. Routes return the one
  shared `unauthorized()` 401 rather than hand-writing the body.
- `apps/sim` — a ContextVar bound by `tenant_scope()`, read by `connection()`,
  which refuses to open when nothing is bound. The tenant arrives as the
  `X-Tenant-Id` header the web proxy sets from the session.

Suites total **199 checks, all passing** (`db` 58, `ingest` 86, `sim` 37,
`web` 18), plus **83 unit tests** (57 vitest, 26 pytest). CI runs types,
lint and unit tests in one job and the four smoke suites against a real
timescaledb-ha:pg17 in another, and is green.

**`sim:` topics are keyed by BUILDING, not by run** (`docs/decisions.md` §45).
A run-keyed topic could never be authorised — the owner map is built from
spatial ids — and every run-keyed fix is worse than the bug: an async predicate
needs per-connection frame serialisation including for `ping`, an on-demand
lookup lets a client force a query per unknown UUID against a shared ten-
connection pool, and a relay-fed cache is a **cross-tenant leak** because the
relay checks `buildingId` against the key's tenant but nothing ties `runId` to
`buildingId`. Every event still carries `runId`; a client following one run
filters on it.

**Open item, pre-existing:** an email transport. The channel is wired and
audited in `alert_notifications`; only the sender is missing, so email
destinations record `failed` with "no email transport configured".

⚠️ **`COPY FROM` is not available on any table with row-level security.**
PostgreSQL refuses it outright. `apps/sim` writes results with chunked
multi-row INSERT instead — slower than COPY, and a real cost of the isolation.
Do not "optimise" it back to COPY.

## Hard rules

- **Geometry lives in a local metre CRS (SRID 0)**, origin at the building datum
  corner, axes aligned to the GLTF scene graph. `buildings.location` is the only
  WGS84 column. Never reproject floor plans into 4326.
- **Units are part of every name** — `_c`, `_kw`, `_kwh`, `_m2`, `_ppm`, `_cmh`.
  There is no conversion layer; data is stored in the unit its column names.
- **Migrations are append-only raw SQL.** Add a new numbered file; never edit an
  applied one. Mark a file `-- @no-transaction` if it creates a continuous
  aggregate or calls `create_hypertable` — TimescaleDB rejects those inside a
  transaction block. A file named `*_seed.sql` is demo data: `db:migrate` skips
  it and records `skipped:`, `db:seed` applies it, and the choice is one-way
  per database.
- **SQL enums and `packages/types/src/enums.ts` must stay in sync.**
- **Never call `refresh_continuous_aggregate` with a NULL end,** and **never
  write a future-dated reading.** Both leave the materialisation watermark
  ahead of `now()`, and real-time aggregation only covers buckets at or after
  it — so every row written afterwards sits in the hypertable and is invisible
  in the rollup, for **every tenant on it**, until a policy refresh heals it.
  Name an end in the past and leave the tail to real-time aggregation.
  `docs/decisions.md` §46; both instances were found by CI blanking an
  unrelated suite's history.
- **Never average a cumulative meter.** `sensors.is_cumulative` marks them; use
  `delta(counter_agg)` from the hourly/daily aggregates.
- **Parse at the boundary, never cast.** Everything arriving over HTTP or a
  WebSocket goes through its Zod schema in `@dtwin/types`.
- **Dashboard reads go to `telemetry_5m`/`_1h`/`_1d`,** not raw `telemetry`.
- **Devices push over `POST /ingest`; the WebSocket is subscribe-only.** Do not
  add a telemetry variant to `ClientMessage` — the asymmetry is deliberate.
- **Shed load, never queue it unboundedly.** Slow WebSocket clients get frames
  skipped; the write buffer drops oldest on overflow. Both are counted and
  surfaced on `/healthz`.
- **The simulator must agree with the asset register.** If a value would
  contradict the seeded model, the generator is wrong, not the model.
- **Alert rules: keep debounce symmetric, keep flagged readings out of value
  conditions, and keep `rate_of_change` on a least-squares fit.** Each guards
  against a specific way the alert list turns into ignorable noise — see
  `docs/decisions.md` §16–18.
- **Alerts are never coalesced or shed.** Telemetry has a successor; an alert
  does not.
- **Notification delivery is recorded in `alert_notifications`,** never
  fire-and-forget, and is dispatched off the alert path.
- **Never relax the webhook destination check.** It resolves the hostname and
  blocks private addresses because rule config is operator-edited input that
  this service makes requests to. `ALERT_WEBHOOK_ALLOW_PRIVATE` is for testing a
  local receiver, not for production.
- **The simulation worker must not open its own socket.** It posts to
  `/internal/sim-event`; ingest owns every subscription.
- **The worker authenticates its caller.** Every route but `/healthz` wants an
  API key with the `sim:run` scope *and* an `X-Tenant-Id` header. The key says
  the caller may name a tenant; the header says which one. They are separate
  because one web service serves every tenant — do not collapse them.

## Python — `apps/sim` only

Python exists in exactly one place and owns exactly one thing: the physics. Do
not move CRUD, auth or streaming into it, and do not add a second Python
service.

- `app/models.py` mirrors `packages/types/src/simulation.ts` field for field in
  camelCase. Change one, change the other; the smoke test round-trips a request
  to catch drift.
- **HVAC uses ideal-loads control** — predict the unconditioned float, correct to
  the setpoint boundary. Never react after the deadband is crossed; that makes
  results depend on the integration step (`docs/decisions.md` §22).
- **Solar gain uses real sun geometry.** Vertical-facade irradiance dips at solar
  noon at this latitude — that is correct, not a bug.
- **Plant is auto-sized per zone** from its design load, so unmet hours mean the
  plant is insufficient rather than the default being wrong.
- **`observed` weather fails loudly** when no rows exist. Never silently fall back
  to a synthetic day.
- **Optional and nullable are different, and Pydantic writes both as null.**
  `SimulationParams` fields are optional (omit them); `startedAt`/`peakDemandKw`
  are nullable (send null). `notify.summary_payload` is where that distinction
  lives — see `docs/decisions.md` §36.
- **Broadcasting progress is best-effort.** A run must complete with ingest
  unreachable.
- **Runs are admitted, cancellable and reaped, not queued** (`docs/decisions.md`
  §47). Past `SIM_MAX_CONCURRENT_RUNS` the answer is 429, and admission happens
  **before** the row is created so a refusal cannot strand a `queued` row.
  Cancellation is noticed at the progress hook. Startup fails runs a previous
  process left in flight, iterating tenants because `simulation_runs` is under
  RLS and an unscoped connection would update nothing.
- Its venv is `apps/sim/.venv` (Python 3.12 via uv), matching the container.

## Web — `apps/web`

- **There is a login screen** (`app/login`, `app/api/auth/*`), built on the
  session machinery that already existed in `packages/db`. Before it, the
  Compose stack was unusable: `next start` sets `NODE_ENV=production`, which
  disables the demo-tenant fallback, and with no way to sign in the dashboard
  rendered "Not signed in" and nothing else.
- **The session cookie's `Secure` flag comes from the request protocol, not from
  `NODE_ENV`.** Compose runs production over plain HTTP; a `Secure` cookie there
  is dropped by every host except localhost.

- **The 3D view is generated from the stored PostGIS geometry.** Do not
  introduce a GLB into the render path; it would be a second source of truth.
- **One scene rotation** (−90° about X) reconciles the +Z-up CRS with three.js.
  Never swap axes at a call site.
- **Temperature is diverging about setpoint, minus the zone's deadband.**
  Occupancy and CO₂ are sequential. Never a rainbow, never hot-is-red on
  absolute temperature.
- **The canvas is client-only** and must stay that way.
- **React 19 / R3F v9 / drei v10 stay aligned**, react pinned `>=19 <19.3`. A
  minified React error #31 means two React copies — regenerate the lockfile.
- Clear `.next` when switching between `next build` and `next dev`.

## Conventions

- TypeScript packages are consumed as source (`main` → `src/index.ts`), so
  imports carry the `.ts` extension and tsconfigs set
  `allowImportingTsExtensions` with `noEmit`.
- No TS `enum` — `as const` arrays plus Zod enums, so the code survives
  `--erasableSyntaxOnly`.
- Nullable database columns are `.nullable()` in Zod, not `.optional()`.
- NUMERIC stays a string in TypeScript; `int8` is parsed to a number
  (`packages/db/src/client.ts`).
- Following the workspace convention, every app gets a Dockerfile when it is
  built out. Compose app services sit behind the `app` profile so
  `npm run db:up` works without them.

## Verifying a change

```bash
npm run typecheck
npm run db:migrate          # or db:seed, on a fresh database you want demo data in
npm run bootstrap           # only needed once per database
npm run smoke -w @dtwin/db
```

`npm run smoke -w @dtwin/ingest` refuses to run while a dev ingest holds :8787 —
its device simulator writes the same meters, so the results would be
meaningless. Stop `dev:ingest` first.

The smoke test writes synthetic telemetry into the seeded building and checks
the spatial tree, 3D picking, batch insert idempotency, reset-aware counter
aggregation, the heatmap rollup and the Zod parse boundary. It is a development
check — never point it at production.
