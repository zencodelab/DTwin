# CTO assessment

**Reviewed: 18 September 2026. Scope: the local DTwin source, configuration,
migrations, contracts, and selected development checks.**

## Executive judgment

DTwin is a substantial single-building prototype with an integrated data model,
live telemetry, spatial dashboard, alert engine, and thermal simulation. Its
strongest asset is the connection between physical context and operational
data: a measurement belongs to a sensor, a sensor relates to a room or asset,
and that room has geometry, a schedule, and thermal properties.

The current architecture is appropriate for that scope. Keep the three services
and shared database while closing correctness and operating gaps. The next
milestone should be a controlled, authenticated building pilot with measurable
data quality and recovery behavior. Public deployment, unattended operational
alerting, and quantified savings claims need additional evidence.

This is an advisory and monitoring system. No building-control command path is
implemented. The existing simulation is a simplified sensible-heat model, and
the repository does not establish calibration against a real building.

## Product and scope

The principal user is a facility manager who needs to locate an uncomfortable
zone, identify the equipment serving it, inspect telemetry and maintenance,
and compare an intervention with a baseline.

The demonstration building is Corniche Tower: **4 floors, 24 zones, 40 equipment
items, and 190 sensors**. It includes five thermal profiles, three occupancy
schedules, and seven seeded alert rules. These are fixture dimensions, not a
tested scale limit.

| Capability | Current implementation | Limit or next requirement |
|---|---|---|
| Spatial twin | PostGIS hierarchy and database-generated 3D zone volumes | No implemented IFC/GLTF import pipeline found; geometry is seeded |
| Live measurements | HTTP ingest, sensor resolution, quality flags, batched persistence, WebSocket subscriptions | Memory buffer is intentionally lossy during prolonged failure; no durable gateway acknowledgement |
| Historical analytics | 5-minute, hourly, daily aggregates; reset-aware hourly/daily meter deltas | Bad-quality samples still enter aggregate values; quality counts alone do not filter them |
| Alerts | Seven condition types; symmetric debounce, cooldown, persistent lifecycle, acknowledgement API | Browser state and slow-client delivery need correction before operational reliance |
| Notifications | Webhook and log delivery with persisted outcomes and bounded webhook retries | Disabled by default; email transport absent; no transactional notification outbox |
| Scenarios | Asynchronous thermal simulation and end-use, carbon, comfort outputs | In-process jobs; no durable scheduling or restart recovery |
| Live simulation status | Worker-to-ingest HTTP relay and browser event handling, with polling fallback | A floor-focused view does not subscribe to the building/run topics carrying these events |
| Asset administration | Schema and contextual read views | No general asset, geometry, or rule administration workflow found |
| Deployment | Dockerfiles, Compose, health endpoints, smoke suites | No checked-in CI pipeline, backup/restore automation, or production access-control setup found |

Sources: [architecture](architecture.md), [API](api.md),
[migrations](../packages/db/migrations), and the code references below.

## Engineering strengths to preserve

- **One spatial source of truth.** Database geometry drives both spatial queries
  and rendering. Local metres avoid mixing floor plans with geographic degrees.
- **Domain-aware telemetry.** Sensor metadata supplies units, plausible ranges,
  sampling cadence, and cumulative-meter semantics. Retry inserts cannot create
  duplicate `(sensor_id, time)` rows.
- **Clear service boundaries.** Node owns device ingestion and browser sockets;
  Python owns physics; Next.js owns the dashboard and its HTTP surface.
- **Explicit overload behavior.** The telemetry buffer and socket backlog policy
  favor service continuity, and counters expose data loss.
- **Explainable alerts and physics.** Rules use quality gates and symmetric
  debounce; simulation exposes heat-balance terms as well as totals.

The [decision log](decisions.md) captures the reasoning behind these choices.
Adding a broker, more services, or multi-building tenancy should follow a
measured requirement rather than precede the first dependable pilot.

## Risks and completion criteria

These are source-review findings unless the verification section says otherwise.
Priorities are recommendations, not scheduled commitments. P0 means resolve
before exposing the service to untrusted clients or relying on its alerts.

| Priority | Finding and consequence | Evidence | Completion criterion |
|---|---|---|---|
| P0 (in progress) | Was: user/device authentication and authorization absent, `by` caller-supplied, subscriptions unscoped. **Now:** `apps/ingest` requires an API key on every HTTP route and a signed ticket on WebSocket connect before any subscription is accepted; `acknowledged_by` is a foreign key to `users`, resolved from the authenticated caller. `apps/web` is NOT yet updated — its routes still call the old unscoped query functions and do not build against the new `@dtwin/db` signatures. See [multi-tenancy.md](multi-tenancy.md) for what changed and what remains. | [ingest server](../apps/ingest/src/server.ts), [ingest auth](../apps/ingest/src/auth.ts), [web routes](../apps/web/app/api) (unconverted) | Web service converted and typechecking; Python worker carries a tenant on every call; Compose wired with the new required variables |
| P0 | Alert events bypass batching but use the same backlog-skipping delivery method as telemetry. An immediate send is not guaranteed delivery. | [Fanout.send / #deliver](../apps/ingest/src/fanout.ts) | Slow-client and reconnect tests show durable alert reconciliation without unbounded queues |
| P0 | Resolved events remove an alert from live state but leave the initial HTTP alert snapshot intact; an alert present at page load can remain visible as open. | [live hook](../apps/web/lib/ws.ts), [dashboard merge](../apps/web/components/Dashboard.tsx) | An alert loaded before connection disappears when resolved and remains correct after reconnect |
| P0 | Live UI state retains only sensor values, discarding quality/time; aggregate averages also include flagged values. A connected page can display stale or invalid measurements as current. | [live hook](../apps/web/lib/ws.ts), [rollups](../packages/db/migrations/002_timeseries.sql) | Bad and stale values are visibly distinguished and excluded from operational comfort summaries according to an explicit policy |
| P1 | Several HTTP routes use casts or partial checks instead of the shared boundary schemas. | [ingest routes](../apps/ingest/src/server.ts), [web routes](../apps/web/app/api) | Malformed IDs, timestamps, ranges, fault kinds, and payloads yield consistent bounded 4xx errors |
| P1 | Simulation jobs live in FastAPI background tasks; accepted jobs can remain queued/running after a crash. Request size and concurrency are not governed by a durable scheduler. | [worker](../apps/sim/app/main.py) | Admission limits, recoverable job ownership, cancellation, and restart tests exist |
| P1 | Notification records are created after alert insertion. A crash in between can leave an alert with no delivery record; concurrent retry workers can send duplicates. | [alert engine](../apps/ingest/src/rules/index.ts), [notifier](../apps/ingest/src/rules/notify.ts) | Transactional outbox or reconciliation closes the gap; retry ownership and receiver idempotency are tested |
| P1 | Webhook address checks and the subsequent fetch resolve separately; the checked address is not pinned to the connection. Existing checks should not be treated as complete SSRF protection. | [checkDestination / #deliverWebhook](../apps/ingest/src/rules/notify.ts) | Destination allowlisting or enforced egress policy, address validation at connection time, and adversarial tests |
| P1 | Email is recorded as failed; there is no sender. | [notifier](../apps/ingest/src/rules/notify.ts) | A chosen transport delivers to a controlled inbox with auditable failure handling, or email is removed from the supported product promise |
| P1 | Simulation events target building/run topics; floor-focused clients listen to neither. HTTP polling masks the missing progress channel. | [relay](../apps/ingest/src/server.ts), [subscriptions](../apps/web/components/Dashboard.tsx) | Progress and completion work for every floor selection and recover through HTTP after a disconnect |
| P1 | Operations lack demonstrated restores, availability targets, and automated release checks. DB smoke assertions print failures without setting a failing exit code. | [Compose](../docker-compose.yml), [DB smoke](../packages/db/src/smoke-test.ts) | CI fails on an injected failed assertion; restore drill and operator-owned recovery procedure pass |

Horizontal scaling is not yet a proven capability. The live-alert uniqueness
index limits duplicate database records; it does not share rule windows,
subscriber state, telemetry ownership, or retry leases between replicas.

## Simulation credibility

The engine models one thermal node per zone, with explicit solar, internal,
envelope, infiltration, ventilation, and HVAC terms. Ideal-loads control predicts
unconditioned temperature and applies conditioning within an auto-sized capacity.
HVAC energy is electrical input after COP, not simply thermal load.

Current limitations materially affect interpretation:

- No latent/dehumidification load, inter-zone heat transfer, or individual facade
  orientation; heating and cooling share one COP.
- Plant capacity is derived from zone design loads, not calibrated equipment
  curves or a full simulation of the asset serving network.
- `observed` means reading the weather table. The query does not filter by
  `source`, so synthetic and measured sources can mix. Missing all irradiance
  values triggers a clear-sky estimate even when temperature rows exist.
- Runs store scenario overrides but not a complete immutable snapshot of the
  weather, zone selection, model inputs, and engine version required for exact
  reproduction after the model changes.
- Arbitrary reporting intervals need validation: the integration loop uses
  integer division by the substep, so intervals that are not exact multiples
  need explicit handling and tests.
- Building `unmetHours` sums **zone-hours**; it is not elapsed building-wide
  time. `peakDemandKw` is the maximum interval-average demand, not an
  instantaneous electrical peak. EUI describes the selected period, not
  automatically an annual figure.

Sources: [engine](../apps/sim/app/engine.py),
[weather](../apps/sim/app/weather.py), [repository](../apps/sim/app/repository.py).
Use scenario outputs for comparative exploration. Establish measured baselines,
weather provenance, input snapshots, and validation tolerances before making
commercial savings or comfort guarantees.

## Proposed delivery sequence

| Phase | Outcome | Suggested accountable role | Exit evidence |
|---|---|---|---|
| First 30 days | Dependable internal pilot | Technical lead with platform and frontend owners | P0 items closed; notification and reconnect tests; fresh-install check; CI failure propagation; restore exercise |
| Days 31–60 | One real building connected | Integration lead with facilities engineer | Device identity and external-ID mapping; explicit unit mapping; synthetic generator disabled; measured quality/staleness dashboard; pilot performance baseline |
| Days 61–90 | Repeatable scenario evaluation | Simulation lead with building-energy specialist | Versioned inputs/weather; calibration report; fixed interval handling; recoverable jobs; saved scenario periods and comparisons |

This sequence assumes access to a pilot building, its operator, and a usable
measurement feed. Staffing, dates, and spending are not approved by this document.
Assign named owners and estimate the work after the pilot constraints are known.

Measure ingest acceptance-to-persistence lag, buffer drops, stale-point fraction,
alert delivery/reconciliation success, job failure/recovery rate, and restoration
time. Establish targets from the pilot's sampling rates and operator needs;
no SLO or throughput benchmark is demonstrated by the current repository.

## Verification record

- Read the root and service guides, decision log, SQL migrations, shared
  contracts, service entry points, persistence and notification paths, worker
  engine/weather/repository, and dashboard data flows.
- `npm run typecheck`: passed across types, database, ingest, and web packages.
- `npm run db:migrate`: completed; no pending migrations were applied.
- Database smoke results are recorded in [operations](operations.md#verification-record).
- Docker inspection found the local database container healthy; this is not an
  end-to-end application health result.
- Full ingest/simulation/web smoke suites, browser interaction, load tests,
  restore tests, and adversarial security tests were not run for this
  documentation pass. Existing historical full-suite counts were not re-certified.
- The supplied directory has no Git metadata available to this review, so the
  assessment is dated rather than tied to a commit.
