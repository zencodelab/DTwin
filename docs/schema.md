# Schema reference

PostgreSQL 17 + TimescaleDB 2.30 + PostGIS 3.6. Canonical DDL is the numbered
SQL under `packages/db/migrations/`; this is the map.

🚧 **Migrations `007`/`008` add tenancy.** They are applied and isolation-tested,
but only `packages/db` and `apps/ingest` read/write through the tenant-scoped
path this section now describes; `apps/web` and `apps/sim` still call the
pre-tenancy signatures and do not yet build against it. See
[multi-tenancy.md](multi-tenancy.md) for the full model and what was measured
to arrive at it, and [decisions.md](decisions.md) §38–§44 for the reasoning
behind each specific choice below.

## Shape

```
tenants ──< tenant_members >── users
   │                              │
   │                              └──< sessions   (carries the ACTIVE tenant)
   ├──< api_keys           (device / service credentials)
   │
   └──< buildings ──< floors ──< zones ──< equipment ──< sensors ──< telemetry (hypertable)
                          │           │
                          │           └──< maintenance_logs
                          │
                          └── thermal_profiles / occupancy_schedules
                          │
                          └──< equipment_zone_service >── equipment   (many-to-many)

  (every table below `tenants` also carries its own `tenant_id`,
   composite-FK'd to its parent's — see "Tenancy" below)

buildings ──< weather_observations (hypertable)
buildings ──< simulation_runs ──< simulation_results (hypertable)

alert_rules ──< alerts        (scoped at building | floor | zone | equipment | sensor)
alerts ──< alert_notifications
```

## Tables

### Spatial (`001_spatial.sql`)

| Table | Rows (seed) | Purpose |
|---|---|---|
| `buildings` | 1 | Site root. WGS84 `location`, grid emission factor, GLTF asset path. |
| `floors` | 4 | Signed `level` (basements negative). `footprint` PolygonZ in local metres. |
| `zones` | 24 | The thermal/analytical unit. `boundary` PolygonZ, links to thermal + occupancy profile. |
| `equipment` | 40 | Assets. `building_id` required; `floor_id`/`zone_id` are *location*. `parent_equipment_id` is the serving tree. |
| `equipment_zone_service` | 48 | What an asset *serves*, with `load_fraction`. |
| `sensors` | 190 | Durable points/channels. `external_id` is the device-side tag, unique **per tenant** since `007` (was globally unique — two operators both running `AHU-01/SAT` used to be impossible). |
| `maintenance_logs` | 7 | Service history, `next_due_at` for the PPM view. |
| `thermal_profiles` | 5 | Construction + plant characteristics per zone archetype. |
| `occupancy_schedules` / `_days` | 3 / 12 | 24 hourly fractions per day type. |

Enums: `zone_type`, `equipment_type`, `equipment_status`, `metric_type`,
`service_role`, `maintenance_type`, `day_type`. Mirrored in
`packages/types/src/enums.ts` — **keep both sides in sync.**

### Tenancy and identity (`007_tenancy.sql`, `008_tenancy_timeseries.sql`)

| Table | Purpose |
|---|---|
| `tenants` | Customer organisation. `slug` (URL-safe handle) plus `status` (`active`/`suspended`). **Carries no row-level security policy** — see below. |
| `users` | Global, not tenant-scoped: one person can belong to more than one tenant. `email` unique case-insensitively via `users_email_uidx` on `lower(email)`, not a bare column constraint. |
| `tenant_members` | `(tenant_id, user_id)` → `role` (`owner`/`admin`/`operator`/`viewer`). |
| `sessions` | Browser login state. `token_hash` (SHA-256 of the cookie token, never the token itself) and the session's **active** tenant — switching tenant is a server-side write here, not a client-supplied parameter. FK'd to `tenant_members` so a session can never name a tenant its user does not belong to. |
| `api_keys` | Device/service credentials for `apps/ingest`. `key_hash` plus an 8-char `key_prefix` for display; `scopes` (`ingest:write`, `sim:notify`); `kind` (`device`/`service`) is an operator label, not something a route branches on. |

**Every other table in the schema gained a `tenant_id UUID NOT NULL` column**
in `007`/`008` — `thermal_profiles`, `occupancy_schedules` (and `_days`),
`buildings`, `floors`, `zones`, `equipment`, `equipment_zone_service`,
`sensors`, `maintenance_logs`, `alert_rules`, `alerts`, `alert_notifications`,
`simulation_runs`, `simulation_results`, `weather_observations`, and
`telemetry` itself. Each child's `tenant_id` is enforced to match its parent's
by a **composite foreign key** on `(tenant_id, parent_id)` — not just a
denormalised column trusted by convention — which is what makes cross-tenant
re-parenting a constraint violation rather than merely unusual.

Row-level security is enabled and **forced** (`FORCE ROW LEVEL SECURITY`, so
even the table owner is subject to it) on every one of those tables **except
`telemetry`**: TimescaleDB 2.30 refuses RLS on a compressed hypertable, and
`telemetry` is compressed. Its three continuous aggregates cannot carry RLS
either, because a continuous aggregate is a plain PostgreSQL view. Both are
covered instead by `security_barrier` views —
`telemetry_t`, `telemetry_5m_t`, `telemetry_1h_t`, `telemetry_1d_t` — that
filter explicitly on the caller's tenant; the application role has no grant on
the underlying relations at all. **Application code must read through the `_t`
views, never the bare table or aggregate names.**

`tenants`, `users`, `tenant_members`, `sessions`, and `api_keys` carry **no**
row-level security policy, and cannot: authenticating a session or an API key
has to work before a tenant is known. Every query against them is therefore
responsible for its own filtering rather than relying on a policy to add it —
see `getTenant` in
[`packages/db/src/queries/tenancy.ts`](../packages/db/src/queries/tenancy.ts)
for the one place this bit already, and the comment left there afterward.

A scoped connection reads and writes exclusively through
`withTenant({ tenantId }, fn)` in
[`packages/db/src/client.ts`](../packages/db/src/client.ts), which sets
`app.tenant_id` as a **transaction-local** Postgres setting (`set_config(...,
true)`) — never session-level, since a pooled connection handed to the next
request would otherwise carry the previous request's tenant forward. Full
reasoning, what was measured against TimescaleDB to arrive at this shape, and
what it does and does not protect against: [multi-tenancy.md](multi-tenancy.md).

### Time-series (`002_timeseries.sql`)

| Object | Kind | Notes |
|---|---|---|
| `telemetry` | hypertable, 1-day chunks | `(time, sensor_id, value, quality)`. Unique on `(sensor_id, time)` — also the upsert target. |
| `telemetry_5m` | continuous aggregate | avg/min/max/last/count + bad-quality count. |
| `telemetry_1h` | continuous aggregate | as above plus `counter_agg` for cumulative points. |
| `telemetry_1d` | continuous aggregate | as `_1h`. |
| `weather_observations` | hypertable, 7-day chunks | Boundary conditions for the simulator. |

Policies: compress after 7 days (`segmentby = sensor_id`), drop raw chunks after
2 years, refresh the three aggregates every 5 min / 30 min / 1 h. All three
aggregates have real-time aggregation on, so the newest bucket is live rather
than up to a refresh interval stale.

**Quality codes:** 0 good · 1 uncertain · 2 out of plausible range · 3 stale ·
4 device fault. Bad readings are stored with a flag, not dropped — "the sensor
reported −273 for six hours" is a diagnosis, and discarding it turns a visible
fault into an unexplained gap.

### Alerting (`003_alerting.sql`)

`alert_rules` is scoped at exactly one of building / floor / zone / equipment /
sensor, enforced by a CHECK. A zone- or building-scoped rule fans out to every
matching sensor at evaluation time, so a new point inherits its zone's rules
without a new rule row.

Conditions: `threshold_above`, `threshold_below`, `rate_of_change` (thermal
drift), `deviation_from_setpoint` (comfort breach), `flatline` (stuck sensor),
`no_data` (dead point), `out_of_range`.

`alerts` is a plain table, not a hypertable — alerts are low-volume and queried
by state, not by time range. A partial unique index enforces one live alert per
rule+target so a flapping sensor cannot stack duplicates.

### Simulation (`004_simulation.sql`)

`simulation_runs` holds the scenario (`params` jsonb overrides on top of each
zone's stored profile) and its lifecycle. `simulation_results` is a hypertable
on `interval_start`, one row per (run, zone, interval), with energy
**disaggregated** by end use plus the sensible heat-balance terms — the total is
recoverable from the parts but not the reverse, and the split is the point.

### Notification delivery (`006_notifications.sql`)

`alert_notifications` stores one row per `(alert_id, channel, target)`, enforced
by a unique index. Channels are `webhook`, `email`, and `log`; statuses are
`pending`, `delivered`, and `failed`. The record carries cumulative attempts,
the latest error, creation time, and delivery time. It is a destination record
updated across retries, not an immutable row for every individual attempt.
Gained `tenant_id` in `007`, under RLS like the rest of the alerting tables.

The notifier implements webhook/log delivery, while email records failure until
a transport exists. Delivery is disabled by default. Alert insertion and
notification-record creation are separate operations; the table does not by
itself provide a transactional outbox. See [operations](operations.md) and the
[notifier](../apps/ingest/src/rules/notify.ts).

## Query entry points

`packages/db/src/queries/` — hand-written SQL returning `@dtwin/types` shapes.
**Every function now takes a scoped `db: Db` handle as its first argument**,
obtained from `withTenant({ tenantId }, (db) => ...)`; none of the SQL below
carries its own tenant predicate, because the RLS policy (or, for telemetry,
the barrier view) supplies it. A caller that forgets to wrap a call in
`withTenant` gets a database-level error, not a silent cross-tenant read.

- `getSpatialTree(db, buildingId)` — the whole hierarchy in one round trip,
  geometry as GeoJSON in local-CRS coordinates, directly usable by Three.js. A
  `buildingId` belonging to another tenant returns `null`, identically to one
  that does not exist — the two cases are deliberately indistinguishable.
- `findZoneAtPoint(db, buildingId, x, y, z)` — 3D picking. 2D containment plus
  an elevation band, because zone boundaries are flat polygons at their floor's Z.
- `insertReadings(db, readings)` — one `unnest` INSERT per batch, `ON CONFLICT
  DO NOTHING` so gateway retries cannot double-count a meter. **`tenant_id` is
  derived from a join to `sensors`, not taken from `readings`**: `telemetry`
  itself carries no RLS policy (it is compressed, see above), so a reading
  naming a sensor belonging to a different tenant than the caller simply does
  not join and is silently dropped rather than written or erroring.
- `getLatestReadingsForZone(db, zoneId)` — `DISTINCT ON` over `telemetry_t`
  (the barrier view, not raw `telemetry`) from the last 24 hours; stale after
  three times the sensor's `sample_interval_s`. This is an implementation
  exception to the aggregate-only dashboard rule.
- `getSensorHistory(db, sensorId, '5m'|'1h'|'1d', from, to)` — reads the
  `_t`-suffixed barrier views, never the bare continuous aggregates (naming
  those directly is a `permission denied` error by design); `deltaValue` is
  reset-aware and null for gauges and all 5m buckets.
- `getZoneHeatmap(db, buildingId, metric, from, to)` — one weighted mean per
  zone for the 3D colour overlay, via `telemetry_1h_t`; zones with no data are
  null, not zero.

`packages/db/src/queries/tenancy.ts` adds the identity-side queries —
`login`, `listMemberships`, `switchTenant`, `listBuildings`, `getTenant`,
`listActiveTenants`, and the provisioning helpers `createTenant`, `createUser`,
`addMember`, `createApiKey`. These run through `withoutTenant(fn)` rather than
`withTenant`, because authenticating a session or key has to work before a
tenant is known — see the Tenancy table above for what that means for how they
must be written.

## Conventions

- **Units in names.** `_c`, `_kw`, `_kwh`, `_m2`, `_ppm`, `_pa`, `_cmh`.
- **Local metres for geometry**, WGS84 only on `buildings.location`. See
  [decisions.md](decisions.md) §1.
- **UUIDv7 from the app** (`uuidv7()` in `@dtwin/types`); the SQL default is a
  fallback for hand-written inserts.
- **NUMERIC stays a string** in TypeScript (`maintenance_logs.cost`) so money
  never round-trips through a float. `int8` is parsed to a number.
- **Nullable columns are `.nullable()`, not `.optional()`** — the database
  returns null explicitly, and collapsing that to undefined loses the difference
  between "no value" and "not selected".
