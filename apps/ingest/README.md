# @dtwin/ingest

Telemetry ingest, WebSocket fan-out and the device simulator.

Devices push **in** over HTTP; browsers subscribe **out** over WebSocket. That
split is why `ClientMessage` has no telemetry variant — a browser is never a
data source.

## Run

```bash
npm run dev:ingest          # from the repo root; needs a migrated database
npm run smoke -w @dtwin/ingest
```

Listens on `:8787` — `http://localhost:8787` and `ws://localhost:8787/ws`.

## HTTP

| Route | Purpose |
|---|---|
| `GET /healthz` | Registry size, writer/fan-out stats, simulator state. Returns **503** when the write path is not draining — a service that accepts readings and silently fails to persist them must not look healthy. |
| `POST /ingest` | A `RawTelemetryBatch` keyed by device-side `externalId`. Returns **202**, not 200: readings are buffered, not yet durable. |
| `GET /alerts` | All alerts, or `?state=live` / `?state=resolved`. Each is joined to its zone, floor and equipment so a dashboard renders without a second round trip. |
| `POST /internal/sim-event` | Where the simulation worker posts run progress and results; ingest fans them out. Requires `x-internal-token` when `INGEST_INTERNAL_TOKEN` is set. |
| `POST /alerts/ack` | `{alertId, by}`. Returns **409** if the alert is no longer open — a different thing for a caller to handle than a bad id. |
| `POST /simulator/fault` | `{sensorId \| externalId, kind, magnitude}` — `drift`, `flatline`, `spike`, `offline`. |
| `DELETE /simulator/fault` | Clears one fault (`?sensorId=`) or all. |

## WebSocket

Client sends `subscribe` / `unsubscribe` / `ping`; server sends
`telemetry.batch`, `alert.raised` / `alert.resolved` / `alert.acknowledged`,
`subscribed`, `pong`, `error`. Topics are `building:` / `floor:` / `zone:` /
`sensor:` + UUID (plus `alerts:all`), so a view subscribes to the floor in frame
and drops the rest.

```js
ws.send(JSON.stringify({ type: 'subscribe', topics: ['floor:<uuid>'] }));
```

Readings arrive as compact tuples — `[sensorId, ts, value, quality]` — expanded
client-side with `expandReading` from `@dtwin/types`.

## How it behaves under stress

- **Writes are batched** and flush on row count or interval, whichever trips
  first. A 202 means buffered; `SIGTERM` flushes before exit.
- **The write buffer is capped.** If the database is unreachable the oldest
  readings are dropped and counted, rather than growing until the process is
  OOM-killed and the live stream dies with it.
- **Outbound frames are coalesced per topic per tick** and serialised once per
  topic, not once per subscriber.
- **A slow client is dropped, not queued.** Past `INGEST_CLIENT_BUFFER_MAX_BYTES`
  its next frame is skipped — newer telemetry supersedes it anyway.
- **Bad values are stored with a quality flag, never discarded.** A sensor
  reading −273 for six hours is a diagnosis; a gap is not.

## Simulator

Generates values consistent with the seeded model rather than plausible-looking
noise: zone temperature sits near the setpoint its thermal profile declares, CO2
tracks the zone's occupancy schedule, and `CH-02` — flagged `maintenance` in the
asset register — draws 0 kW. If the feed contradicted the model there would be
no way to tell a working pipeline from a broken one.

Timestamps are real wall-clock time; only the sampling rate is accelerated
(`SIM_SPEEDUP`), so the time axis stays honest.

## Alert rule engine

Two evaluation paths, because the conditions are genuinely different shapes.
`threshold_above`, `threshold_below`, `out_of_range` and
`deviation_from_setpoint` answer from the reading in hand and run in-stream.
`flatline`, `no_data` and `rate_of_change` describe a window of elapsed time —
and `no_data` is the *absence* of an event, so nothing will ever arrive to
trigger it — and run on a sweep.

- **Scopes expand to sensors** on each refresh, so a point added to a zone
  inherits that zone's rules with no new rule row.
- **Debounce is symmetric.** N consecutive breaches open an alert; N consecutive
  clears resolve it. Resolving on the first clear reading makes anything sitting
  near its threshold flap, and `cooldown_s` then bounds re-opening.
- **Flagged readings never drive value rules.** A thermistor reporting −273
  raises `out_of_range`, not "zone overheating".
- **`rate_of_change` fits a least-squares slope** over the window rather than
  differencing endpoints, which at realistic sensor noise would fire constantly
  on a steady zone.
- **Alerts bypass the coalescing path** and are sent immediately. Telemetry is
  safe to shed because the next tick carries the current value; an alert has no
  successor.
- **Live alerts are adopted at startup**, so a restart can resolve them instead
  of stranding them forever behind the one-open-alert-per-target index.

Drive it with the fault endpoint: `spike` and `drift` exercise the threshold and
rate rules, `flatline` and `offline` the stuck-sensor and dead-point rules.

## Notification delivery

`alert_rules.notify` drives webhook, email and log channels. Every destination
gets a row in `alert_notifications` — channel, target, status, attempts, last
error — because the first question after an incident is "was anyone actually
told?", and an in-memory counter cannot answer it after a restart.

- **Off by default** (`ALERT_NOTIFY_ENABLED`). Sending is outward-facing, and a
  dev database seeded with a real webhook must not start calling it on boot.
- **Destinations are resolved and checked**, not pattern-matched. A webhook URL
  is operator-edited config this service will request; unchecked it becomes a
  proxy onto the internal network. Private and loopback addresses are blocked,
  redirects are not followed, and non-HTTP schemes are rejected.
- **Email records why it was not sent** ("no email transport configured")
  rather than vanishing — the honest answer to the audit question.
- **Retries are bounded** by attempt count, and delivered destinations are never
  re-sent.

## Simulation relay

The worker holds no socket of its own — it is batch compute that may run
elsewhere, scale separately or restart mid-run, and fan-out belongs in one
service. It posts to `/internal/sim-event`; ingest broadcasts `sim.progress`,
`sim.complete` and `sim.failed` to the run's topic and its building's.

Best-effort by design: a run that produced correct results has succeeded whether
or not anyone was listening.

## Not yet built

An email transport. The channel is wired and audited; only the sender is
missing.
