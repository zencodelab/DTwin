# Multi-tenancy design

**Status, updated 19 September 2026: the migration is complete.** Migrations
`007`/`008` are applied and isolation-tested. All four packages are converted:
`@dtwin/db` and `apps/ingest` (tenant-scoped queries, RLS, API-key and
WebSocket-ticket authentication), `apps/web` (tenant resolved from the session
cookie, with a non-production `DTWIN_DEMO_TENANT_ID` fallback) and `apps/sim`
(a ContextVar bound per request from the `X-Tenant-Id` header the web proxy
sets). `docker-compose.yml` and `.env.example` carry the new variables
(`AUTH_SECRET`, `POSTGRES_APP_USER`/`POSTGRES_APP_PASSWORD`,
`DATABASE_URL_OWNER`, `INGEST_API_KEY`, `DTWIN_DEMO_TENANT_ID`), and every
service connects as the **app** role. The suites total 293 checks, all passing.

**Two things the conversion forced that are worth knowing before changing
anything:**

1. **`COPY FROM` does not work under row-level security.** PostgreSQL refuses
   it: `FeatureNotSupported: COPY FROM not supported with row-level security`.
   The simulation worker's bulk result write was COPY and is now chunked
   multi-row INSERT. That is materially slower and it is the price of the
   policy; connecting as a role that bypasses RLS would buy the speed back by
   discarding the guarantee.

2. ~~**`sim:<runId>` topics cannot be subscribed to at all.**~~ **Fixed** —
   simulation topics are now keyed by building rather than by run, so they
   resolve through the same owner map as every other scope and need no lookup.
   `maySubscribe` gained no branch; the change was deleting a docstring that
   described code nobody had written. The reasoning, including why the three
   obvious run-keyed fixes are each worse than the bug — one of them a
   cross-tenant leak — is [decision 45](decisions.md#45-simulation-topics-are-keyed-by-building-not-by-run).

DTwin is single-tenant today in the strongest sense: there is no tenant concept,
no authentication, and no authorization. `buildingId` arrives as an unvalidated
query parameter, any client that can open the WebSocket may subscribe to any
topic by guessing a UUID, and `POST /alerts/ack` records whatever `by` string
the caller supplies. Adding tenancy is therefore two coupled pieces of work, and
they cannot be separated: **tenant isolation is meaningless without an identity
to scope it to.**

This document states the model, what was measured against TimescaleDB 2.30.1 to
arrive at it, and what remains. The decisions themselves are recorded in
[decisions.md](decisions.md) §38–§44.

## The tenant model

A **tenant** is a customer organisation — a facilities operator, a landlord, a
managing agent. A tenant owns one or more buildings. A **user** is a person, and
a person may belong to more than one tenant, so users are global and membership
is a join table carrying a role.

```
tenants ──< tenant_members >── users
   │                              │
   │                              └──< sessions (carry the ACTIVE tenant)
   ├──< api_keys          (devices and services authenticate with these)
   └──< buildings ──< floors ──< zones ──< …
```

"Tenant" here never means a *building* tenant, the commercial occupier of a
floor. That concept does not exist in this schema and should not be given the
same name if it is ever added; call it `occupier`.

Four roles, coarse on purpose:

| Role | May |
|---|---|
| `owner` | everything, including managing members and API keys |
| `admin` | everything except deleting the tenant |
| `operator` | acknowledge alerts, edit rules, request simulations |
| `viewer` | read only |

## How isolation is enforced

Three mechanisms, used in different places because TimescaleDB forces the split.

### 1. `tenant_id` on every row, guaranteed by composite foreign key

Every tenant-owned table carries `tenant_id UUID NOT NULL`, denormalised down
the whole hierarchy rather than reached by joining up to `buildings`.

This is a deliberate reversal of the schema's usual preference for narrow
tables. The reason is that a row-level security policy is evaluated per row: a
policy written as `EXISTS (SELECT 1 FROM floors JOIN buildings …)` becomes a
correlated subquery on every row and destroys index use, while a policy on a
local column stays a cheap filter. Measured on the probe database, the local
predicate left chunk exclusion and `SkipScan` fully intact:

```
 Unique
   ->  Custom Scan (SkipScan) on _hyper_1_1_chunk
         ->  Index Scan using _hyper_1_1_chunk_tel_uidx on _hyper_1_1_chunk
               Index Cond: ("time" > (now() - '24:00:00'::interval))
               Filter: (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
```

Denormalisation normally invites drift — a zone whose `tenant_id` disagrees with
its floor's. That is prevented structurally, not by convention: each parent gets
a `UNIQUE (tenant_id, id)` and each child a **composite foreign key** on
`(tenant_id, parent_id)`. A mismatched `tenant_id` is then rejected by the
database, and re-parenting a row across tenants is impossible rather than merely
discouraged.

### 2. Row-level security, for every table that can have it

`ENABLE`/`FORCE ROW LEVEL SECURITY` with one policy per table:

```sql
CREATE POLICY <t>_tenant ON <t>
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
```

`current_tenant_id()` reads the `app.tenant_id` GUC and returns `NULL` when it
is unset, so an unscoped connection sees **no rows at all** rather than
everything — verified, including on the write path, where an insert naming
another tenant is rejected with `new row violates row-level security policy`.

`WITH CHECK` is not decoration. A `USING`-only policy does not apply to
`INSERT`; the probe inserted a foreign tenant's row successfully until the check
clause was added.

The GUC is set transaction-locally, never on the session:

```ts
await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
```

`true` means local to the transaction, so the setting is discarded at COMMIT or
ROLLBACK and cannot survive a pooled connection being handed to the next
request. A session-level `set_config` in a pooled service is a cross-tenant leak
waiting for the first error path that skips the reset.

### 3. Barrier views, for `telemetry` and its aggregates

Two TimescaleDB limitations, both measured on 2.30.1, shape the rest:

**RLS and compression are mutually exclusive.** In both directions:

```
ALTER TABLE tel SET (timescaledb.compress, …)
  ERROR:  columnstore cannot be used on table with row security
ALTER TABLE tel2 ENABLE ROW LEVEL SECURITY
  ERROR:  operation not supported on hypertables that have columnstore enabled
```

`telemetry` is compressed after 7 days and retained for 2 years. Trading that
compression away for RLS on the single highest-volume table in the schema is not
a good exchange, so `telemetry` keeps compression and gets no policy.

**A continuous aggregate is a view, and cannot carry RLS.** `pg_class.relkind`
is `v`; `ALTER TABLE … ENABLE ROW LEVEL SECURITY` is refused for views, and both
`ALTER VIEW … SET (security_invoker)` and the `ALTER MATERIALIZED VIEW` form are
rejected by TimescaleDB.

So for `telemetry`, `telemetry_5m`, `telemetry_1h` and `telemetry_1d`:
the application role is granted no direct access, and reads go through
`security_barrier` views that filter explicitly:

```sql
CREATE VIEW telemetry_1h_t WITH (security_barrier = true) AS
  SELECT * FROM telemetry_1h WHERE tenant_id = current_tenant_id();
```

Verified: correct tenant's rows only, and **zero rows when no tenant is set.**

An earlier draft tried to avoid adding `tenant_id` to the aggregates altogether
by letting the join to the RLS-protected `sensors` table do the filtering. It
**leaks**, and the probe caught it: a view body executes with the privileges of
the view's owner, the owner here is a superuser, and superusers bypass RLS
unconditionally — including `FORCE`. The query returned both tenants' rows and
did not fail closed. Two rules follow, and they are the sharpest edges in this
whole design:

- **The application must not connect as a superuser.** Migration `007` creates
  `dtwin_app`, a plain `LOGIN` role, and every service connects as it. `dtwin`
  remains the DDL owner and is used only by the migration runner.
- **A barrier view must filter on `current_tenant_id()` itself.** Never rely on
  RLS propagating through a view from a table it joins.

### Writes to `telemetry`

The insert derives `tenant_id` from `sensors` rather than trusting the caller:

```sql
INSERT INTO telemetry (time, tenant_id, sensor_id, value, quality)
SELECT to_timestamp(t.ts / 1000.0), s.tenant_id, t.sensor_id, t.value, t.quality
  FROM unnest($1::bigint[], $2::uuid[], $3::float8[], $4::smallint[])
         AS t(ts, sensor_id, value, quality)
  JOIN sensors s ON s.id = t.sensor_id
ON CONFLICT (sensor_id, time) DO NOTHING;
```

`sensors` is under RLS, so a reading naming another tenant's sensor does not
join and is silently dropped. Verified: a two-row batch naming one sensor from
each of two tenants inserted exactly one row. This keeps the hot path a single
statement — no per-row trigger — and means a compromised or buggy caller cannot
write into a tenant it cannot already read.

The cost is that cross-tenant readings vanish without a distinct error. Ingest
already reports unresolvable points as `unknownIds`, and this must join that
count rather than being silently discarded.

## What the enforcement does and does not protect against

Worth stating plainly, because it is easy to oversell RLS.

It **does** protect against the realistic failure: a query that forgets its
tenant predicate. That is the bug this system will actually produce, repeatedly,
across dozens of hand-written SQL strings, and the database now refuses to serve
it.

It **does not** make a compromised service harmless. `dtwin_app` may set
`app.tenant_id` to any value — no privilege is required to set a custom GUC. An
attacker executing arbitrary SQL as `dtwin_app` can read every tenant. Closing
that requires either one database role per tenant, or `SET ROLE` driven by a
trusted proxy, and neither is justified at this stage. The honest claim is
*defence in depth against application bugs*, not *a security boundary between
tenants*.

## Identity

Users and sessions are deliberately boring.

- `users` is global, keyed on email, with an `argon2id` hash. It is **not**
  tenant-scoped, because one person can work for two operators.
- `sessions` holds a SHA-256 hash of a 256-bit random token, never the token.
  The cookie is `HttpOnly; Secure; SameSite=Lax`. The row carries the **active
  tenant**, so switching tenant is a server-side state change, not a
  client-supplied parameter.
- `api_keys` authenticate devices to `POST /ingest` and the simulation worker to
  `POST /internal/sim-event`, replacing `INGEST_INTERNAL_TOKEN`. Stored as a
  hash plus an 8-character prefix for display, scoped to one tenant, with
  `scopes`, `expires_at` and `revoked_at`.

An external OIDC provider can later replace the password half without touching
membership, sessions or any of the scoping above.

## Consequences elsewhere

**WebSocket topics become a tenant boundary.** `building:<uuid>` is guessable,
and `alerts:all` is a cross-tenant broadcast by construction. Under tenancy:
the socket authenticates at connect, `alerts:all` becomes `alerts:<tenantId>`,
and every `subscribe` is checked against a topic→tenant map the registry already
has the data to build. An unauthorised topic is refused, not silently ignored —
silence looks identical to a quiet building.

**Uniqueness that was global becomes per-tenant.** `sensors.external_id` is
`UNIQUE` today; two operators will both have an `AHU-03/SAT`. It becomes
`UNIQUE (tenant_id, external_id)`, as do `thermal_profiles.name` and
`occupancy_schedules.name`.

**`acknowledged_by` stops being caller-supplied.** It becomes a `user_id` FK
resolved from the session — the P0 in the [CTO assessment](cto-assessment.md).

**The dashboard stops picking a building with `ORDER BY name LIMIT 1`.**
`apps/web/app/page.tsx` does that today; it becomes the session's tenant and an
explicit building selection.

**The simulation worker needs a tenant on every call.** `SimulationRequest`
gains a tenant, the worker sets the GUC per connection exactly as the TypeScript
services do, and `apps/sim/app/models.py` must move in step with
`packages/types/src/simulation.ts` as always.

## Migration path

`007_tenancy.sql` (transactional) — tenants, users, members, sessions, api_keys;
`tenant_id` columns with composite FKs; per-tenant uniqueness; RLS policies;
the `dtwin_app` role; backfill of the seeded building into a `demo` tenant.

`008_tenancy_timeseries.sql` (`@no-transaction`) — `telemetry.tenant_id`, the
rebuild of the three continuous aggregates with `tenant_id` in the grouping,
and the barrier views.

`008` is marked `@no-transaction` because TimescaleDB refuses to create a
continuous aggregate inside a transaction block, which means it can fail
part-applied. The bulk of the work is in `007` for exactly that reason.

**Dropping and recreating the aggregates discards their materialised history.**
`008` calls `refresh_continuous_aggregate(…, NULL, NULL)` to rebuild from raw
telemetry, but raw telemetry is retained for 2 years while the rollups were not
dropped — so on a long-lived database, rollups older than the raw retention
window cannot be reconstructed and are lost. On the seeded development database
this is free. On anything with real history, dump the three aggregates first.

`compress_segmentby` is deliberately left as `sensor_id` alone. `tenant_id` is
functionally dependent on `sensor_id`, so segments already never span tenants;
adding it would buy nothing and would require decompressing every chunk.

## Not in this design

- Per-tenant data residency, encryption keys, or separate databases.
- Tenant-level quotas, rate limiting, or usage metering.
- Cross-tenant benchmarking ("how does my building compare"), which needs an
  explicit aggregation path that deliberately escapes these policies and should
  not be bolted onto the query layer described here.
- Invitations, password reset, and MFA. `007` creates the storage; the flows are
  application work.
