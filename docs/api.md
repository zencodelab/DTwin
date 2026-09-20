# API and event reference

**Implementation reference: 18 September 2026, updated for the multi-tenancy
migration.** This describes current routes, including limitations; it is not a
promise of a hardened public API.

🚧 **`apps/ingest` requires authentication on every route below except
`/healthz`, as described in this document. `apps/web` and `apps/sim` do NOT —
they are not yet converted; see [multi-tenancy.md](multi-tenancy.md) for exact
status. Do not read the "Browser-facing HTTP" and "Worker HTTP" sections below
as describing an authenticated, tenant-scoped surface: they still describe the
pre-tenancy behavior and are marked accordingly.**

## Addresses, validation, and identity

| Surface | Local address | Intended caller |
|---|---|---|
| Dashboard HTTP | `http://localhost:3000` | Browser |
| Ingest HTTP / WebSocket | `http://localhost:8787`, `ws://localhost:8787/ws` | Gateway / browser (via the web service) |
| Simulation HTTP | `http://localhost:8000` | Dashboard server / internal tools |

Send JSON request bodies with `Content-Type: application/json`. IDs are UUIDs.
Raw telemetry timestamps are integer **epoch milliseconds**; simulation periods
use ISO timestamps with a timezone. Units follow sensor metadata and named
fields; ingest does not convert units.

**Ingest authenticates every route.** Every HTTP request except `GET /healthz`
must carry a bearer token — either `Authorization: Bearer <key>` or
`x-api-key: <key>` — that resolves to an active, unrevoked API key. The tenant
a request acts on is **always the key's own tenant**, never a value from the
request body or query string; there is no field anywhere in this API that lets
a caller name which tenant it wants to act as. A missing or unrecognised key
returns `401`; a key that authenticates but lacks the scope a route requires
returns `403`. Full detail, the crypto involved, and why: [multi-tenancy.md
§ Identity](multi-tenancy.md#identity) and
[apps/ingest/src/auth.ts](../apps/ingest/src/auth.ts).

Keys carry one of two scopes, checked per route: `ingest:write` (device and
dashboard-proxy calls) and `sim:notify` (the simulation worker's event relay).
A `device`-kind key and a `service`-kind key are otherwise the same mechanism —
`kind` is a label for the operator's own bookkeeping, not something a route
branches on.

Schemas exist in [shared types](../packages/types/src), but HTTP boundary
validation is incomplete outside `apps/ingest`. FastAPI validates its request
models; several Node/Next.js routes still use partial checks or casts and are
not yet tenant-scoped at all — see the warning above.

## Device ingest and operational endpoints

Source: [ingest server](../apps/ingest/src/server.ts).

| Method and path | Auth scope | Input | Current response |
|---|---|---|---|
| `GET /healthz` | none | — | 200 or 503; registry, writer, fan-out, alert/notification, simulator statistics. Reports process-level counters only, deliberately, so it can stay open with no key |
| `POST /ingest` | `ingest:write` | `RawTelemetryBatch` | 202 `{accepted, unknownIds, flagged}`; schema violations return 400. `unknownIds` also covers a real external id that belongs to **another tenant** — the key's own tenant genuinely does not have that point |
| `GET /alerts` | `ingest:write` | Optional `state=live` or `state=resolved` | `{alerts: [...]}` for the key's own tenant; missing/unrecognized filter means all states |
| `POST /alerts/ack` | `ingest:write` | `{alertId}` plus header `x-acting-user: <userId>` | 200 `{alert}`; missing fields 400; alert not open **or belonging to another tenant** 409 — the two cases are deliberately indistinguishable, so a caller cannot use this route to learn that an id exists elsewhere |
| `POST /simulator/fault` | `ingest:write` | `{sensorId}` or `{externalId}`, plus `kind`, optional `magnitude` | 200 with sensor/kind; missing sensor, or a sensor id belonging to another tenant, 404; missing kind 400 |
| `DELETE /simulator/fault` | `ingest:write` | Optional `sensorId` query parameter | Clears that sensor's fault (404 if it is another tenant's), or every fault **for the key's own tenant** when the parameter is omitted — never every fault on the process |
| `POST /internal/sim-event` | `sim:notify` | `SimEvent` | 202 `{forwarded: true}`; invalid event 400; the event's `buildingId` must belong to the key's tenant or the request is refused with 403 |

Every row above except `/healthz` returns `401` for a missing or unrecognised
key and `403` for a key that authenticates but does not carry the scope
column names. See [Addresses, validation, and identity](#addresses-validation-and-identity)
above for how a key is presented and what a key's tenant means for every field
in this table.

Fault kinds implemented by the synthetic generator are `drift`, `flatline`,
`spike`, and `offline`. This surface is for development fault injection; it
requires the same `ingest:write` key as every other write route, and every
fault is scoped to the key's own tenant.

The HTTP reader limits bodies to 8 MiB. Malformed JSON and body-limit exceptions
currently reach the generic 500 handler; clients should not assume every invalid
request yields 400/413. Error normalization is outstanding work. Authentication
runs **before** the body is read, so an unauthenticated caller is refused
without the service parsing its payload.

### Send a reading

Replace `REGISTERED_EXTERNAL_ID` with an active sensor's `external_id`, and
`DEVICE_API_KEY` with a key created for that sensor's tenant (`kind: 'device'`,
scope `ingest:write` — see [multi-tenancy.md](multi-tenancy.md)):

```bash
curl -i http://localhost:8787/ingest \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer DEVICE_API_KEY' \
  -d '{"readings":[{"externalId":"REGISTERED_EXTERNAL_ID","value":23.4,"quality":0}]}'
```

`x-api-key: DEVICE_API_KEY` is accepted in place of the `Authorization` header,
for gateways that cannot set it.

Expected response when the ID exists for that key's tenant and the value is
plausible:

```json
{"accepted":1,"unknownIds":[],"flagged":0}
```

Omitting `ts` stamps arrival time. For retries, supply and preserve the original
timestamp so the `(sensor_id, time)` uniqueness constraint can deduplicate the
reading. An unknown ID — including a real ID belonging to a different tenant —
is omitted and reported, not automatically provisioned. One request accepts
1–10,000 readings.

`202` acknowledges buffering only. It does not guarantee a database commit.
The optional `source` string is not authenticated device identity; the API key
is.

Quality codes: `0` good, `1` uncertain, `2` out of range, `3` stale,
`4` device fault. The quality gate can flag a value even if the gateway marks it
good. Full contract: [telemetry.ts](../packages/types/src/telemetry.ts).

## Browser-facing HTTP

🚧 **Not yet converted for tenancy.** These routes still call the old,
unscoped `@dtwin/db` query functions and currently fail `npm run typecheck`
against the tenancy-aware `packages/db`. Nothing below is tenant-scoped or
authenticated yet — the table describes pre-migration behavior, kept here as
the target contract this layer is converging toward, not what a build of this
branch currently does.

Sources: [Next.js routes](../apps/web/app/api).

| Method and path | Parameters | Response / purpose |
|---|---|---|
| `GET /api/heatmap` | Required `buildingId`; `metric=temperature_c`, `hours=1` defaults | `{zones}` with values, setpoints and deadbands; missing data is null |
| `GET /api/zones/{id}` | Zone UUID | `{readings, equipment, maintenance, profile}` |
| `GET /api/sensors/{id}/history` | `resolution=5m` and `hours=6` defaults | `{buckets}`; resolution allows `5m`, `1h`, `1d` |
| `GET /api/alerts` | None | At most 100 non-resolved alerts, ordered by severity then opening time |
| `POST /api/simulate` | Worker simulation request | Proxies worker response/status; connection failure returns 502 |
| `GET /api/simulate` | Required `runId` | `{run}` while unfinished; full summary after completion |

These read endpoints do not offer asset/rule CRUD. Pagination and time-window
limits are not generally implemented. UUID, metric, and numeric parameter
validation varies by route. The simulation GET proxy does not consistently
preserve upstream error status; inspect the body as well as the HTTP code.

The browser's standing alert list is read directly from the database through
Next.js, so it can load even when ingest is unavailable. That is separate from
the live event channel and its current reconciliation limitations.

## Worker HTTP

🚧 **Not yet converted for tenancy.** The Python worker has no tenant parameter
anywhere in this surface — `SimulationRequest`, the run tables, and every route
below still take only a `buildingId`. See
[multi-tenancy.md § Consequences elsewhere](multi-tenancy.md#consequences-elsewhere)
for what the conversion needs to add.

Source: [FastAPI routes](../apps/sim/app/main.py).
Interactive worker documentation is available at
[`http://localhost:8000/docs`](http://localhost:8000/docs) when running.

| Method and path | Input | Current response |
|---|---|---|
| `GET /healthz` | None | 200 `{status, substepS}` or 503 on database failure |
| `POST /simulate` | `SimulationRequest` | 202 `{runId, status: "queued", zonesWithoutProfile}`; unknown building 404 |
| `GET /runs/{id}` | Run UUID | Run lifecycle and progress; unknown run 404 |
| `GET /runs/{id}/summary` | Run UUID | `{run, building, byZone}`; 404 unknown, 409 unfinished/no results |
| `GET /runs/{id}/results` | Optional `zoneId`, `limit` (default 500; maximum 10,000) | `{results}` ordered by interval and zone; no pagination cursor |
| `POST /weather/generate` | Building, period, interval, synthetic-weather parameters | `{written}`; generated rows retain `source='synthetic'` |

Example simulation body; replace the placeholder building UUID before sending
to `/api/simulate` or `/simulate`:

```json
{
  "buildingId": "REPLACE_WITH_BUILDING_UUID",
  "scenarioName": "Setpoint +2 K",
  "periodStart": "2026-06-20T00:00:00+04:00",
  "periodEnd": "2026-06-23T00:00:00+04:00",
  "intervalS": 3600,
  "params": {"setpointDeltaK": 2},
  "weather": {
    "mode": "synthetic",
    "peakDryBulbC": 42,
    "minDryBulbC": 30,
    "peakGhiW_m2": 950
  }
}
```

Other weather modes are `observed` (the default) and `inline` with a supplied
series. No rows in observed mode fail the run; this does not guarantee that
existing rows are measured rather than synthetic. Optional `zoneIds` restricts
the calculation. See [simulation contracts](../packages/types/src/simulation.ts)
and [Pydantic models](../apps/sim/app/models.py) for the complete fields.

Poll the returned run ID until `completed` or `failed`; `queued` and `running`
are intermediate states. Stored results are authoritative. Live progress is
best-effort and is not replayed after reconnect. There is no cancellation or
resume endpoint.

## WebSocket protocol

Connect to `/ws`. **The connection starts unauthenticated and can do nothing
but authenticate.** Devices still cannot submit measurements through this
socket — `ClientMessage` has no telemetry variant, unchanged from before the
tenancy work.

### Handshake

The first frame a client sends must be `auth`, carrying a short-lived signed
ticket:

```json
{"type":"auth","ticket":"<base64url payload>.<base64url HMAC>"}
```

A ticket is minted server-side from an authenticated web session — **not** by
the browser and not from the API keys used elsewhere in this document — via
`signWsTicket({ tenantId, userId })` in
[`packages/db/src/auth.ts`](../packages/db/src/auth.ts). It is HMAC-signed with
`AUTH_SECRET` (identical value required on both the web and ingest services),
expires 60 seconds after minting by default, and is never put in the URL —
query strings end up in access logs and proxy traces.

`ping`/`pong` work before authentication, so a client can keep the socket alive
while it fetches a ticket. Every other message before a successful `auth` is
refused with `{"type":"error","code":"unauthenticated", ...}`. A connection that
sends no `auth` frame within 10 seconds is closed by the server. On success the
server replies:

```json
{"type":"authenticated","tenantId":"<uuid>"}
```

The client should assert the returned `tenantId` matches the tenant it expects
before trusting anything else on the socket, rather than assuming the ticket it
sent was honoured as written.

### Subscribing

```json
{"type":"subscribe","topics":["alerts:00000000-0000-0000-0000-000000000000","floor:00000000-0000-0000-0000-000000000001"]}
```

Replace the example UUIDs with real resource and tenant IDs. Each subscription
message accepts 1–64 topics; that is a per-message limit, not an overall
authorized subscription quota. Topic helpers cover `building`, `floor`, `zone`,
`sensor`, `sim`, and `tenantAlerts` (see below).

**`alerts:all` no longer exists and no longer parses.** It was a
cross-tenant broadcast of every alert on the service — any client that could
open the socket could subscribe to every tenant's alerts. It is replaced by
`alerts:<tenantId>`, minted via `topics.tenantAlerts(tenantId)`; the only valid
value for `<tenantId>` is the authenticated connection's own tenant.

Every subscribe is checked against the connection's tenant before it is
granted. A response now carries **two** possible messages:

```json
{"type":"subscribed","topics":["floor:00000000-0000-0000-0000-000000000001"]}
{"type":"subscribe.denied","topics":["floor:11111111-1111-1111-1111-111111111111"],"reason":"topic does not belong to this tenant, or is not known to this service"}
```

A denial is **always sent explicitly**, never silently dropped: a topic that is
quietly ignored looks identical, from the client's position, to a topic with
nothing happening on it, and a client would otherwise wait indefinitely for
data that is never coming. Treat `subscribe.denied` as an application error to
surface, not a condition to retry.

| Message | Main fields | Producer |
|---|---|---|
| `auth` (client → server) | `ticket` | First frame on every connection |
| `authenticated` | `tenantId` | Reply to a successful `auth` |
| `subscribe.denied` | `topics`, `reason` | A subscribe request naming a topic the connection's tenant may not read |
| `telemetry.batch` | `topic`, `readings` tuples, `sentAt` epoch ms | Ingest |
| `alert.raised`, `alert.acknowledged`, `alert.resolved` | `alert` with context | Alert engine |
| `sim.progress` | `runId`, `progressPct` | Worker via ingest |
| `sim.complete` | `summary` | Worker via ingest |
| `sim.failed` | `runId`, `error` | Worker via ingest |
| `subscribed` | `topics` | Subscription handling |
| `pong` | Echoed `ts` | Reply to `ping` |
| `error` | `code`, `message` | Invalid client message, failed/expired auth, or auth timeout — codes include `bad_message`, `unauthenticated`, `auth_failed`, `auth_timeout` |

The shared server schema also declares `equipment.status` and `sensor.offline`;
no emitter was found for those messages in the reviewed implementation.
Internal simulation events additionally carry `buildingId` for routing, and are
now refused at the HTTP boundary if that building does not belong to the
posting service key's tenant (see the ingest table above). Parse browser frames
with `parseServerMessage` and tuples with `expandReading`.

There is no durable event cursor, replay, or guaranteed delivery. Subscribe to
the relevant `sim:<buildingId>` or building topic for simulation events, and retain
HTTP recovery. See [architecture](architecture.md) for backpressure behavior.

## Webhook notifications

When enabled and a rule has a webhook target, the notifier posts:

```json
{"event":"alert.raised","alert":{"id":"ALERT_UUID","...":"full AlertWithContext fields"}}
```

This is a shape illustration, not a complete valid alert object. Only the
raised event triggers outbound notifications. Successful HTTP responses mark
the record delivered; non-success responses and timeouts record failures.
Redirects are not followed. Webhook retries require an unresolved alert and
remaining attempts. Design receivers to tolerate duplicates; no exactly-once
delivery or webhook signature is implemented.

See [notifier implementation](../apps/ingest/src/rules/notify.ts) and
[operations](operations.md) for enablement and diagnosis.
