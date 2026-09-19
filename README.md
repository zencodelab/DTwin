# DTwin

A web-based Digital Twin platform for a single commercial building: stored
spatial geometry, live IoT telemetry, thermal and energy simulation, and an
interactive 3D dashboard for facility managers. The current model is seeded;
an IFC/GLTF import pipeline is not implemented.

**Status: integrated prototype, multi-tenancy migration complete.** The
schema, shared types, telemetry pipeline, alert engine, webhook/log
notifications, thermal worker, and 3D dashboard are implemented, with container
definitions and smoke suites. **All four packages are tenant-scoped** —
tenant-scoped queries, row-level security, API-key and WebSocket-ticket
authentication in `packages/db` and `apps/ingest`; session-resolved tenancy in
`apps/web`; and a context-bound scope in the Python worker. The stack builds and
runs end to end, and the suites total **196 checks, 195 passing**.

**One known defect**, surfaced by the suite and left deliberately for a design
decision rather than a rushed fix: `Registry.maySubscribe` has no `sim:` branch,
so no client can subscribe to a `sim:<runId>` topic even though the docstring
says those are authorised separately. It does not affect the dashboard, which
receives run progress on the building topic the server also fans out to. See
[multi-tenancy.md](docs/multi-tenancy.md).

Email delivery and several reliability gaps also remain. See the dated
[CTO assessment](docs/cto-assessment.md) and
[verification record](docs/operations.md#verification-record) for what was
reviewed and tested.

## Documentation

Start with the [documentation index](docs/README.md). It includes the
[CTO assessment and proposed roadmap](docs/cto-assessment.md),
[architecture](docs/architecture.md), [operations guide](docs/operations.md),
and [API reference](docs/api.md), alongside the schema and design decisions.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js (App Router), Tailwind, TypeScript, @react-three/fiber |
| Ingest | Node WebSocket + HTTP service |
| Simulation | Python FastAPI worker — owns the physics and nothing else |
| Storage | PostgreSQL 17 + TimescaleDB 2.30 + PostGIS 3.6 |
| Contracts | Zod schemas in `@dtwin/types`, shared by every TypeScript service |

Backend topology: Next.js serves the dashboard, reads its data, and proxies
simulation requests. A standalone Node service owns WebSocket fan-out and
telemetry writes; Python owns the simulation. General asset CRUD is not yet
implemented. TypeScript services share Zod contracts.

## Quick start

```bash
cp .env.example .env # fresh checkout only; preserve an existing .env
npm ci
set -a
source .env
set +a
npm run db:up        # TimescaleDB-HA (bundles PostGIS + Toolkit)
npm run db:migrate   # applies 001..008 including seed, notifications, tenancy
npm run smoke -w @dtwin/db   # end-to-end check against the live database, incl. tenant isolation
```

`.env.example` now separates the **application** role (`DATABASE_URL`, subject
to row-level security) from the **schema owner** (`DATABASE_URL_OWNER`,
migrations only) and requires `AUTH_SECRET` — see
[credentials for a fresh database](docs/operations.md#credentials-for-a-fresh-database)
for provisioning a user and API keys, without which nothing in `apps/ingest`
can authenticate.

Local ingest and Python processes do not automatically load the root `.env`;
export it in each service terminal, following the
[environment instructions](docs/operations.md#start-a-development-environment).
Then start each service in a separate terminal:

```bash
npm run dev:ingest              # :8787 — WebSocket fan-out + device simulator; requires AUTH_SECRET
npm run sim:install             # one-off: Python 3.12 venv for the worker
npm run dev:sim                 # :8000 — FastAPI energy/thermal engine
npm run dev:web                 # :3000 — the dashboard; needs AUTH_SECRET and DTWIN_DEMO_TENANT_ID
```

Or, after database startup and migrations, run the applications in containers:

```bash
docker compose --profile app up -d --build
```

`npm run db:psql` opens a shell against the running database, `npm run smoke`
runs all four suites, and `npm run typecheck` covers every TypeScript package.
Smoke suites modify development data and have service prerequisites; see
[change verification](docs/operations.md#change-verification).

The seed creates **Corniche Tower**: 4 floors, 24 zones, 40 equipment items,
190 sensors, 5 thermal profiles, 3 occupancy schedules and 7 alert rules — a
building complete enough to exercise every join, the 3D picking path and the
simulator before any real GLTF or BMS data exists.

## Layout

```
apps/
  web/        Next.js dashboard + 3D view,
              built from the stored geometry       (built, tenant-scoped via session)
  ingest/     WebSocket fan-out, telemetry writer,
              quality gate, alert rule engine,
              device simulator                     (built, tenant-scoped + authenticated)
  sim/        FastAPI energy/thermal worker —
              the only Python, and it owns only
              the physics                          (built, tenant-scoped via context)
packages/
  types/      @dtwin/types — Zod schemas, inferred TS types, WS protocol, tenancy contracts
  db/         @dtwin/db — SQL migrations, pg client (app + owner roles),
              tenant-scoped queries, session/API-key auth, smoke test
docs/
  README.md         documentation index
  cto-assessment.md  capabilities, risks, proposed roadmap
  architecture.md   service boundaries and data flows
  operations.md     setup, configuration, verification, recovery limits
  api.md            HTTP and WebSocket reference
  schema.md         table-by-table reference
  decisions.md      design decisions and rationale
models/       GLTF/GLB building assets
```

## Things to know before changing anything

- **Geometry is in a local metre CRS, not WGS84.** Only `buildings.location` is
  geographic. Do not "fix" the rest to 4326 — it would break area maths and
  detach the data from the 3D scene. See [docs/decisions.md](docs/decisions.md) §1.
- **Enums are defined twice**, in SQL and in `packages/types/src/enums.ts`.
  Adding a value to one without the other fails at the parse boundary.
- **Migrations are raw SQL and append-only.** Add the next unused number
  (currently `007_*.sql`); do not edit an applied file (the runner warns on
  checksum drift but will not re-run it).
- **Cumulative meters need `counter_agg`, never `max - min`.** A meter reset
  otherwise invents a megawatt spike.
- **The database image must be `timescale/timescaledb-ha`.** The plain
  `timescale/timescaledb` image has no PostGIS, and this schema needs both
  extensions in one database.
- **Devices push over HTTP, browsers only subscribe over WebSocket.** That is
  why `ClientMessage` has no telemetry variant. A broker (MQTT, Kafka) slots in
  behind `POST /ingest` without touching anything downstream.
- **Under pressure the ingest service drops telemetry rather than queueing it** —
  both for slow WebSocket clients and for the write buffer during a database
  outage. Alerts bypass batching, but the current socket delivery method can
  also skip them for a slow client. This violates the intended no-shedding rule
  and is tracked in the [CTO assessment](docs/cto-assessment.md).
- **Alert debounce is symmetric** and quality-aware. See
  [docs/decisions.md](docs/decisions.md) §16–18 before changing how rules fire —
  each of those choices exists to stop the alert list becoming noise.
- **The simulation is dynamic, not a load sum**, and HVAC uses ideal-loads
  control. Reacting after the deadband is crossed makes results depend on the
  integration step — see §21–22. The model's stated limits (no latent load, no
  inter-zone transfer, no facade orientation) are at the end of that document
  and matter as much as its outputs.
- **The 3D view is generated from the stored PostGIS geometry**, not a model
  file, so it cannot disagree with the data. See §27–28.
- **React 19, R3F v9 and drei v10 must stay aligned.** Two React copies produce
  a minified error #31 that looks like anything but a dependency problem — the
  note at the end of [docs/decisions.md](docs/decisions.md) has the symptoms.
- **Alert notifications are off by default and the webhook guard is not
  optional.** Rule config is operator-edited input the service makes requests
  from — see §33–34.
- **`npm run smoke -w @dtwin/ingest` refuses to run alongside a live ingest
  service**, because two device simulators writing the same meters make its
  assertions meaningless.
