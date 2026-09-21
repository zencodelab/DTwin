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
| `GET /healthz` | none | — | 200 or 503; registry, writer, fan-out, alert/notification, simulator statistics, and `limits` — tracked keys, refusals and overflows for each rate limiter. Reports process-level counters only, deliberately, so it can stay open with no key |
| `GET /livez` | none | — | Always 200 while the process is up. Never consults the database; this is the liveness probe ([§58](decisions.md#58-liveness-does-not-ask-the-database-metrics-carry-no-tenant)) |
| `GET /readyz` | none | — | 200 or 503 by the same judgement as `/healthz`, without the payload; the readiness probe |
| `GET /metrics` | none | — | Prometheus text exposition (`text/plain; version=0.0.4`) of the same counters. Process-level only: no tenant, sensor or key appears in any label, which is what lets it be served without a key |
| `POST /ingest` | `ingest:write` | `RawTelemetryBatch` | 202 `{accepted, unknownIds, flagged, futureDated}`; a malformed JSON body is 400 and an oversized one 413. `unknownIds` also covers a real external id that belongs to **another tenant** — the key's own tenant genuinely does not have that point. `futureDated` counts readings refused for a timestamp more than `INGEST_MAX_CLOCK_SKEW_MS` (default 60 s) ahead of the server clock: unlike every other bad reading, those are not stored with a quality flag, because one of them blinds the rollups for every tenant ([§46](decisions.md#46-a-future-dated-reading-blinds-the-5-minute-view-for-everyone)) |
| `GET /alerts` | `ingest:write` | Optional `state=live` or `state=resolved` | `{alerts, total, limit, truncated}` for the key's own tenant; missing/unrecognized filter means all states. `total` counts every matching alert, so a page at its `ALERT_LIST_LIMIT` (200) can never hide one silently ([§53](decisions.md#53-every-bound-says-what-it-does-when-it-is-reached)) |
| `POST /alerts/ack` | `ingest:write` | `{alertId}` plus header `x-acting-user: <userId>` | 200 `{alert}`; missing fields 400; alert not open **or belonging to another tenant** 409 — the two cases are deliberately indistinguishable, so a caller cannot use this route to learn that an id exists elsewhere |
| `POST /simulator/fault` | `ingest:write` | `{sensorId}` or `{externalId}`, plus `kind`, optional `magnitude` | 200 with sensor/kind; missing sensor, or a sensor id belonging to another tenant, 404; missing kind 400 |
| `DELETE /simulator/fault` | `ingest:write` | Optional `sensorId` query parameter | Clears that sensor's fault (404 if it is another tenant's), or every fault **for the key's own tenant** when the parameter is omitted — never every fault on the process |
| `POST /internal/notify-sweep` | `ingest:write` | none | 200 `{delivered}` — runs the notification sweep now instead of at the next interval, for when a webhook receiver has just been fixed. Safe to call concurrently: workers claim disjoint sets ([§51](decisions.md#51-the-delivery-record-commits-with-the-alert-and-one-worker-owns-each-row)) |
| `POST /internal/sim-event` | `sim:notify` | `SimEvent` | 202 `{forwarded: true}`; invalid event 400; the event's `buildingId` must belong to the key's tenant or the request is refused with 403 |

Every row above except `/healthz`, `/livez`, `/readyz` and `/metrics` returns `401` for a missing or unrecognised
key and `403` for a key that authenticates but does not carry the scope
column names. See [Addresses, validation, and identity](#addresses-validation-and-identity)
above for how a key is presented and what a key's tenant means for every field
in this table.

Fault kinds implemented by the synthetic generator are `drift`, `flatline`,
`spike`, and `offline`. This surface is for development fault injection; it
requires the same `ingest:write` key as every other write route, and every
fault is scoped to the key's own tenant.

The HTTP reader limits bodies to `INGEST_MAX_BODY_BYTES` (8 MiB by default).
Malformed JSON is 400 and an oversized body 413; an unhandled fault is a 500
whose body is `{"error":"internal error"}` and nothing more. Authentication
runs **before** the body is read, so an unauthenticated caller is refused
without the service parsing its payload.

### Rate limits

Every authenticated route can answer **429**, always with a `Retry-After`
header and the same number as `retryAfterS` in the body
([§54](decisions.md#54-rate-limits-are-per-resource-keyed-by-whoever-can-exhaust-it)).
A gateway should wait that long; retrying at once only spends the next token.

| Limit | Keyed by | Default | At the limit |
|---|---|---|---|
| Failed authentication | calling address | 20 burst, 30/min | 429 **before** the key is looked up — so a valid key from a locked-out address is refused too. Only failures are charged |
| Requests to `POST /ingest` | API key | 50/s, 100 burst | 429 before the body is read |
| Readings | **tenant** | 20,000/s, 40,000 burst | the whole batch is refused: a gateway can retry a batch, but cannot know which half of one was kept. Every key a tenant holds draws on the same budget |

The calling address is the socket's, unless `INGEST_TRUSTED_PROXY_HOPS` declares
proxies you operate; then it is read from `X-Forwarded-For` counting back from
the **right**. The first entry is whatever the caller typed and is never used.

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
{"accepted":1,"unknownIds":[],"flagged":0,"futureDated":0}
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

Every route below resolves its tenant from the `dtwin_session` cookie — never
from a parameter — and answers the one shared 401 when there is none. (With
`DTWIN_ALLOW_DEMO_TENANT=true` and `DTWIN_DEMO_TENANT_ID` set, an
unauthenticated request falls back to that tenant; it is a development
convenience and off by default.)

Sources: [Next.js routes](../apps/web/app/api).

| Method and path | Parameters | Response / purpose |
|---|---|---|
| `POST /api/auth/login` | `{email, password, tenantSlug?}` | 200 and an HttpOnly session cookie; **401** with one message for every kind of failure; **429** after repeated failures against the address typed (10 burst, refilling one a minute — a delay, never a lockout), keyed on what was typed and not on whether it matched a user, so it reveals nothing the 401 did not; **503** when three password verifications are already running. 429 and 503 carry `Retry-After` |
| `POST /api/auth/logout` | — | Deletes the session and clears the cookie |
| `POST /api/auth/tenant` | `{tenantId}` | Switches the session to another tenant the user belongs to |
| `GET /api/ws-ticket` | — | `{ticket}` — a 60-second signed ticket for the ingest socket |
| `GET /api/heatmap` | Required `buildingId`; `metric=temperature_c`, `hours=1` defaults | `{zones}` with values, setpoints and deadbands; missing data is null |
| `GET /api/zones/{id}` | Zone UUID | `{readings, equipment, maintenance, profile}` |
| `GET /api/sensors/{id}/history` | `resolution=5m` and `hours=6` defaults | `{buckets}`; resolution allows `5m`, `1h`, `1d` |
| `GET /api/alerts` | None | `{alerts, total, limit, truncated}` — at most 100 non-resolved alerts, ordered by severity then opening time, with the full count beside them |
| `POST /api/simulate` | Worker simulation request | Proxies worker response/status; connection failure returns 502 |
| `GET /api/simulate` | Required `runId` | `{run}` while unfinished; full summary after completion |

These read endpoints do not offer asset/rule CRUD. Ids are parsed as UUIDs,
metrics against the enum, and `hours` against a per-resolution ceiling; anything
else is a 400 that names the limit, never a silent clamp
([§53](decisions.md#53-every-bound-says-what-it-does-when-it-is-reached)).

The browser's alert list is read directly from the database through Next.js,
so it loads even when ingest is unavailable. The dashboard treats that response
as the truth about everything before it was **requested** and socket events as
the truth about everything after, refetching on every accepted subscription and
every five minutes
([§56](decisions.md#56-an-alert-frame-is-never-skipped-a-client-too-slow-for-one-is-disconnected)).
Any other client of the socket should reconcile the same way: there is no
replay, so a snapshot after each reconnect is the only thing that can report an
alert which resolved during the gap.

## Worker HTTP

🚧 **Not yet converted for tenancy.** The Python worker has no tenant parameter
anywhere in this surface — `SimulationRequest`, the run tables, and every route
below still take only a `buildingId`. See
[multi-tenancy.md § Consequences elsewhere](multi-tenancy.md#consequences-elsewhere)
for what the conversion needs to add.

Source: [FastAPI routes](../apps/sim/app/main.py).
Interactive worker documentation is available at
[`http://localhost:8000/docs`](http://localhost:8000/docs) when running.

Every route below except `/healthz` requires **both** an API key carrying the
`sim:run` scope and an `X-Tenant-Id` header. The key answers *who is calling*
and whether they may name a tenant at all; the header answers *for whom*. They
are separate because one web service serves every tenant and would otherwise
need a key per tenant — the same shape as ingest's `x-acting-user`, where a
header is trusted only once the credential beside it has been verified. A
missing, revoked or wrongly-scoped key is 401, all with one message.
`SIM_REQUIRE_API_KEY=false` disables the check for a worker on a closed
network; it defaults to on.

| Method and path | Input | Current response |
|---|---|---|
| `GET /healthz` | None | 200 `{status, substepS}` or 503 on database failure. Open, since a load balancer has no key |
| `POST /simulate` | `SimulationRequest` | 202 `{runId, status: "queued", zonesWithoutProfile}`; unknown building 404; **429** when `SIM_MAX_CONCURRENT_RUNS` are already executing — admission happens before the row is created, so a refusal strands nothing ([§47](decisions.md#47-a-run-is-admitted-cancellable-and-reaped--but-still-not-queued)) |
| `POST /runs/{id}/cancel` | Run UUID | 200 `{runId, status: "cancelled"}`; 404 unknown; **409** if it has already finished. The loop notices at its next progress step (every 2%), so cancellation is prompt rather than instant |
| `GET /runs/{id}` | Run UUID | Run lifecycle and progress; unknown run 404. A run left in flight by a restarted worker reads `failed` with `worker restarted while this run was in flight` |
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
sends no `auth` frame within 10 seconds is closed by the server. A connection
sending more than `WS_RATE_FRAMES_PER_S` frames a second (20, with a burst of
60) is sent `{"type":"error","code":"rate_limited"}` and **closed** with 1008 —
closed rather than throttled, because a silently dropped `subscribe` would leave
a real client waiting on data that is not coming. A tenant already holding
`WS_MAX_CONNECTIONS_PER_TENANT` sockets (200) gets `too_many_connections` and
close code 1013. On success the
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

There is no durable event cursor or replay. Delivery differs by message, on
purpose. A client whose send buffer is over `INGEST_CLIENT_BUFFER_MAX_BYTES` has
**telemetry and simulation-progress frames skipped** — each has a successor —
but is **closed with 1013 rather than skipped when an alert frame is due**,
because an alert is said once. Reconnect and refetch `/api/alerts`. Subscribe to
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
