# Design decisions

Short ADRs for the calls that shape everything downstream. Each is a place where
the obvious choice is wrong for building analytics.

## 1. Two coordinate systems, deliberately

`buildings.location` is `GEOGRAPHY(Point, 4326)` — a real lat/long, used for
weather lookup and map placement. Every other geometry column is
`GEOMETRY(..., 0)` in a **local site CRS in metres**: origin at the building
datum corner, +X east, +Y north, +Z up, aligned to the GLTF scene graph.

Putting floor plans in EPSG:4326 is the classic mistake. Degrees are not metres,
so `ST_Area` returns square degrees, distance and containment maths silently go
wrong, and the geometry no longer lines up with the 3D model. Keeping them
separate means `ST_Contains(zone.boundary, point)` works directly against
Three.js world coordinates with no reprojection anywhere in the path.

*Verified:* `ST_Area(boundary)` equals the stored `area_m2` for all 24 seeded
zones to within 1e-6.

## 2. Units live in column and field names

`temp_c`, `power_kw`, `energy_kwh`, `area_m2`, `co2_ppm`, `airflow_cmh`.

kW vs kWh and L/s vs CFM are the largest source of wrong numbers in building
analytics. There is no unit-conversion layer by design: data is stored in the
unit its column names, or it is wrong. `METRIC_UNITS` in `@dtwin/types` exists
for axis labels, not conversion.

## 3. The hypertable stays narrow

`telemetry` is `(time, sensor_id, value, quality)` — no denormalized `zone_id`
or `metric`.

Denormalizing saves a join, but at ~500 points on a one-second tick it
multiplies storage and hurts the compression ratio, because every row then
repeats low-cardinality text. Timescale joins a narrow hypertable to the small
`sensors` dimension table cheaply, and the dashboard reads continuous
aggregates rather than raw rows anyway.

## 4. Sensor (point) is separate from reading

A `sensors` row is the durable *channel*: device tag, metric, unit, plausible
band, sample interval, and what it hangs off. Readings reference it by id.

This is what lets a point be recalibrated, re-pointed or decommissioned without
rewriting history, and it is where `is_cumulative` and the plausible range live
so ingest can flag bad data without a second lookup.

## 5. Equipment-to-zone is many-to-many

One AHU serves many zones; a VAV serves one. A single `equipment.zone_id` FK
cannot express that and breaks the moment a real air-side system is entered.

`equipment_zone_service` carries the mapping with a `load_fraction` so a zone
split between two units does not double-count energy.
`equipment.parent_equipment_id` carries the serving tree (chiller → AHU → VAV),
which is what drives fault-impact propagation: a tripped chiller can be resolved
to the zones that will drift.

## 6. Zod schemas are the single source of truth for types

Telemetry crosses an untrusted boundary. Static TypeScript types validate
nothing at runtime, and a cast on socket input is a type-level lie.

Every payload type is a Zod schema with the TS type produced by `z.infer`. One
definition, checked at the WebSocket edge and typed in the editor. Branded IDs
(`ZoneId`, `FloorId`, …) come from `.brand<>()` for the same reason — schema and
type cannot drift apart.

## 7. Compact wire format for telemetry

Readings travel as `[sensorId, ts, value, quality]` tuples under a typed
envelope, expanded once on arrival by `expandReading`.

JSON objects spend most of each frame on repeated key names. Measured on the
seeded data: 10,968 B → 7,568 B for 100 readings, a 31% saving for identical
information, and the gap widens with batch size.

## 8. UUIDv7 with a monotonic counter, generated in the application

Time-ordered ids give the B-tree index locality that v4 destroys. Generated in
TypeScript rather than by a database function so we are not pinned to a Postgres
version; the SQL `DEFAULT gen_random_uuid()` exists only so hand-written inserts
work.

The 12-bit monotonic counter (RFC 9562 method 2) is not decoration. Plain
timestamp-plus-random v7 only orders *between* milliseconds, and a 5,000-row
telemetry batch is written well inside one tick — without the counter those ids
sort randomly and reintroduce exactly the fragmentation v7 is here to avoid.

*Verified:* 10,000 ids generated in a tight loop are unique and sort in
generation order.

## 9. Raw SQL migrations, not an ORM schema DSL

Hypertables, continuous aggregates, compression and retention policies have no
representation in Drizzle or Prisma schema languages, so an ORM chain would need
hand-written escape hatches for most of this schema anyway.

Numbered `.sql` files applied in filename order by `packages/db/src/migrate.ts`,
with a `schema_migrations` registry that records a checksum and warns on drift.
Files needing `-- @no-transaction` are split statement-by-statement, because
TimescaleDB refuses to create a continuous aggregate inside a transaction block.

## 10. Cumulative meters use `counter_agg`, never `max - min`

Energy and water meters report a monotonic counter. A plain average is
meaningless and a naive last-minus-first invents a huge spike the moment a meter
rolls over or is replaced.

The hourly and daily aggregates carry a Timescale Toolkit `counter_agg` summary;
consumption is `delta(counter)`, which is reset-aware. `sensors.is_cumulative`
marks which points this applies to.

*Verified:* across a simulated meter reset, `counter_agg` reports 1,017 kWh
where naive max-minus-min reports 1,000,720.

---

# Ingest service

## 11. Devices push over HTTP; browsers subscribe over WebSocket

The two directions are deliberately asymmetric. A browser is never a data
source, so `ClientMessage` has no telemetry variant — the inbound surface is one
HTTP route that can be authenticated and rate-limited on its own terms, rather
than a socket open to the dashboard where every message kind would need
policing.

It also means the WebSocket protocol shipped in `@dtwin/types` did not need to
change to accommodate ingest, which is a sign the split falls on a real seam.

An MQTT or Kafka front end slots in behind `POST /ingest` without touching
anything downstream, which is the extension point the original plan reserved.

## 12. A slow client is dropped, not queued

Past `INGEST_CLIENT_BUFFER_MAX_BYTES` of unacknowledged data, a subscriber's
next frame is skipped rather than appended.

Queueing for a client that has stopped reading converts its problem into the
server's memory problem, and the queued telemetry is worthless by the time it
drains — newer values have already superseded it. Telemetry is precisely the
right thing to shed under pressure, because the next tick carries the current
state anyway. Alerts are not, which is why they are sent immediately rather than
through the coalescing path.

The same reasoning caps the write buffer: on a database outage the oldest
readings are dropped and counted, rather than growing until the process is
OOM-killed and takes the live stream with it.

## 13. `POST /ingest` returns 202, not 200

Readings are buffered, not yet durable. Returning 200 would assert a guarantee
the writer cannot back up, and a gateway that trusted it would discard its own
copy of data that is still only in memory.

For the same reason `/healthz` returns 503 when the write path has stopped
draining. A service that accepts readings and silently fails to persist them
passes a naive liveness check while losing everything.

## 14. The simulator must agree with the asset register

Synthetic values are derived from the seeded model, not invented: zone
temperature sits near the setpoint its thermal profile declares, CO2 follows the
zone's occupancy schedule, and `CH-02` — flagged `maintenance` — draws 0 kW.

Plausible-looking noise would be easier to write and useless: with the feed free
to contradict the model there is no way to tell a working pipeline from a broken
one, because every value looks equally reasonable.

Cumulative counters resume from their last stored reading on start, since a real
meter does not rewind because a process restarted. Seeding from a constant made
every restart look like a meter reset to `counter_agg` downstream — manufacturing
the exact event the aggregate exists to absorb, and masking whether it handles
genuine ones.

---

# Alert rule engine

## 15. Two evaluation paths, because the conditions are different shapes

`threshold_above`, `threshold_below`, `out_of_range` and
`deviation_from_setpoint` answer from the reading in hand, so they run in-stream
as telemetry arrives. `flatline`, `no_data` and `rate_of_change` are statements
about a window of elapsed time — and `no_data` is by definition the *absence* of
an event, so nothing will ever arrive to trigger it. Those need a timer sweep.

Trying to force both into one path gets it wrong in one direction or the other:
sweeping the instantaneous rules adds latency to the alarms that matter most,
and event-driving the windowed ones makes a dead sensor undetectable.

## 16. Debounce is symmetric, though the schema only specifies one side

`alert_rules.consecutive_breaches` says how many breaching evaluations open an
alert. Nothing says how many clear ones resolve it, and the obvious reading —
resolve on the first non-breach — makes any value hovering near its threshold
flap open and shut every few seconds.

The engine therefore requires the same count of consecutive clears to resolve.
`cooldown_s` then bounds how quickly the same target may re-open afterwards. An
alert list that flaps is an alert list facility managers learn to ignore, which
costs more than a slightly slow resolve.

## 17. A flagged reading must not drive a value rule

Readings the quality gate marked bad are skipped by every value-based condition.
A thermistor reporting −273 should raise a *sensor fault*, not "zone
overheating" — and `out_of_range` is the rule that catches it.

Without this, one failing sensor raises alarms on every rule that watches its
metric, and the resulting noise is exactly what trains people to stop reading
alerts. Verified both ways: an implausible reading opens the `out_of_range`
alert and does not open the co-located `threshold_above` one.

## 18. `rate_of_change` uses a least-squares slope, not an endpoint difference

Two adjacent samples are the obvious implementation and are unusable here. With
±0.18 K of simulated sensor noise, two readings 60 s apart imply a rate above
20 K/h, so the seeded 2 K/h drift rule would fire permanently on a perfectly
steady zone.

A regression across the whole window averages the noise out and measures the
trend the threshold actually describes. The engine also returns no result until
the samples span at least half the window, because a slope computed from a
sliver of it is not the quantity the rule means.

Verified in both directions: a genuine trend fires, and an identical rule on a
steady-but-noisy sensor does not.

## 19. Rule scopes are expanded in memory, against the registry

A rule scoped at a building, floor, zone or item of equipment is expanded to the
concrete sensors it watches — filtered by metric — on every refresh.

This is what makes scope inheritance real: a sensor added to a zone picks up
that zone's rules without anyone writing a new rule row. Doing it in memory
rather than in SQL is a readability choice — the equivalent query is a five-way
outer join over five nullable scope columns — and at 7 rules × 190 sensors the
cost is a few thousand comparisons.

## 20. Live alerts are adopted at startup

On boot the engine loads alerts still open in the database and keys them as its
own state.

Without this a restart strands them permanently: the partial unique index
forbids re-opening, and the engine has no record to resolve, so every deploy
would leave a layer of ghosts on the alert list. The same index is what makes a
second ingest replica safe — the database, not per-process state, decides
whether an alert is already live.

---

# Simulation worker

## 21. A dynamic heat balance, not a steady-state load sum

Each zone is a lumped thermal node with a heat capacity, stepped forward in
time:

```
C dT/dt = Q_solar + Q_internal + Q_envelope + Q_infiltration + Q_ventilation + Q_hvac
```

Summing design loads per zone would be far less code and would answer a
different question. Thermal mass is the reason a building does not track outdoor
temperature and the reason cooling demand lags the solar peak by hours. A
steady-state calculation cannot produce overnight free-float, a morning
pull-down after setback, or unmet hours — which are the outputs a facility
manager acts on. `thermal_mass_kj_per_k` is in the schema precisely for this.

## 22. Ideal-loads control, not bang-bang

HVAC predicts where the node would float to with no conditioning, then applies
exactly the power needed to land on the nearest setpoint boundary, capped by
installed plant. This is what EnergyPlus calls ideal air loads.

The obvious alternative — react once the measured temperature has crossed the
deadband — overshoots by one step's worth of gain. That is invisible in an
office (0.07 K per 300 s step) and dominant in the seeded server room, where
90 kW into a small thermal mass moves the node 1.5 K per step. It reported
**36 unmet hours that described the integration step, not the building**.

Predicting the float removes the overshoot entirely. Measured: unmet hours fell
to zero, and HVAC energy now differs by **0.011% across a 5× finer step**, where
before the answer moved with the step size.

## 23. Solar gain gets real geometry

Sun position from Duffie & Beckman, with beam, sky-diffuse and ground-reflected
components resolved separately onto each facade; the Erbs correlation splits GHI
where a weather record has no DNI.

In a Gulf climate, gain through glazing is the largest term in the cooling
balance, so approximating it as a fraction of GHI would put the dominant term on
a guess. Beam and diffuse also strike a vertical facade completely differently —
beam depends on incidence angle, diffuse barely does — so they cannot share one
coefficient.

This produces a result worth knowing: at 24°N in summer, vertical-facade
irradiance has **twin peaks morning and afternoon with a dip at solar noon**,
because the overhead sun grazes the glass while the beam strikes east and west
facades near-perpendicular. It is why east/west glazing, not south, is the
problem in the tropics. A model showing a noon peak on vertical glass has its
geometry wrong, and the smoke test asserts the dip for that reason.

`pvlib` implements all of this more accurately (NREL SPA) and is a drop-in
replacement for `solar_position` if the extra precision is ever worth the
dependency. At a building-energy timestep these correlations are within a
fraction of a degree.

## 24. Plant is auto-sized from each zone's design load

Capacity comes from the zone's own design load plus a safety factor, not a flat
W/m².

A flat rule cripples the server room, whose equipment density is an order of
magnitude above an office: it would report enormous unmet hours describing the
rule of thumb rather than the building. Sizing from the design load is what an
engineer would do, and it is what makes unmet hours mean "the plant is
insufficient" rather than "the default was wrong".

## 25. `observed` weather fails loudly rather than substituting a design day

Asking to replay measured weather where none exists raises an error that names
the fix. Quietly falling back to a synthetic day would return a plausible number
answering a question nobody asked, and nothing downstream would reveal the
substitution.

`POST /weather/generate` exists so that path can be populated deliberately;
generated rows are tagged `source='synthetic'` so they are never mistaken for
measurements.

## 26. Pydantic mirrors Zod, in one file

`apps/sim/app/models.py` restates `packages/types/src/simulation.ts` field for
field, in camelCase. This duplication is the real cost of the two-language
split. It is confined to one file, the names match exactly so drift is visible
by eye, and the smoke test round-trips a request through the live service.

## What the model does NOT do

Stated plainly, because a simulation's limits matter as much as its outputs:

- **No latent load.** Sensible heat only. In a humid coastal climate this
  understates HVAC energy — dehumidification is a substantial share of it.
- **No inter-zone heat transfer.** Each zone couples only to outdoors, so a core
  zone with no exterior wall has no envelope path at all.
- **No facade orientation.** Not in the schema, so irradiance is averaged over
  the four cardinal aspects — right for a zone with facades all round, wrong for
  a single-aspect perimeter zone. Recording orientation per zone is the fix, and
  it belongs in the model rather than the engine.
- **One COP for heating and cooling.** Reasonable for a heat pump, and heating
  is nearly irrelevant at this latitude.

---

# 3D dashboard

## 27. The 3D view renders the database, not a model file

Zone volumes are extruded at runtime from the PostGIS polygons the schema
already holds. There is no GLB in the render path.

A model file would be a second source of truth and the first thing to go stale
after a fit-out: move a partition in the BIM export and the twin still colours
the old room. Extruding the stored geometry means what is on screen cannot
disagree with what the data says. `gltf_node_id` stays on every row for the day
a real BIM export is loaded alongside this, and the two are reconciled by node
id rather than by replacing one with the other.

This is also what makes decision §1 pay off: because the geometry is already in
a local metre CRS, the stored coordinates are usable as three.js world
coordinates with no reprojection anywhere in the path.

## 28. One rotation reconciles the two coordinate conventions

The local CRS is +X east, +Y north, +Z up; three.js is Y-up. The entire scene
sits in a group rotated −90° about X, which maps (x, y, z) → (x, z, −y).

Geometry is therefore built in raw database coordinates and never transformed by
hand. The alternative — swapping axes at each call site — puts a conversion in
dozens of places, and the bug it eventually produces looks like bad data rather
than bad code.

## 29. The temperature overlay is diverging, not a hot-is-red gradient

What a facility manager needs is deviation from setpoint — too cold, on target,
too hot — which is polarity, so it gets a diverging scale with a neutral
midpoint at the setpoint. Occupancy and CO2 are magnitude, so they get a
sequential single-hue ramp. Never a rainbow: hue has no natural order, so a
rainbow forces a legend lookup for every zone.

A hot-is-red gradient would encode *absolute* temperature, which answers a
question nobody asks — 21 °C is a fault in a lobby and correct in a server room.

The zone's own deadband is subtracted before scaling: inside it the zone **is**
on target, and that is what a deadband means. Without that, a first pass painted
every zone in the building a strong red for being 0.9 K off setpoint — i.e. for
being normally, correctly controlled — and the overlay distinguished nothing.

## 30. The 3D viewport is its own surface

In light mode the canvas is painted a mid-tone, not the page colour.

A diverging midpoint is deliberately built to recede toward the surface it sits
on. That is right for a heatmap cell inside a bordered grid and fatal here,
where the zone body *is* the mark on an open canvas: painted at the page colour,
every zone near setpoint rendered at `#f0efec` against a `#f9f9f7` background
and the building became invisible — geometry present, raycasts hitting, nothing
to see. Giving the viewport its own backdrop keeps the validated ramp unchanged
and gives its neutral end something to sit against in both directions.

## 31. The view subscribes to the floor in frame

Not to the building. The ingest service fans out per topic, so a building-wide
subscription would ship all 190 points to a view showing 45 of them — measured:
a floor subscription streams 45 distinct sensors, not 190.

## 32. The canvas is excluded from server rendering

There is no WebGL context on a server, so a 3D view has nothing to render there,
and react-three-fiber reaches for React internals at module scope that the SSR
runtime does not expose — importing it server-side throws outright. Excluding it
is what the component *is*, not a workaround.

It also code-splits Three.js out of the initial bundle: the route's first-load
JS dropped from 248 kB to 24.8 kB.

## A dependency trap worth remembering

Next 15's App Router bundles React 19 regardless of what `package.json`
declares. With React 18 installed, react-three-fiber v8 read a React 18 internal
(`ReactCurrentOwner`) that React 19 removed, and the canvas failed at import.
The fix is to align the whole stack — React 19, R3F v9, drei v10 — and to pin
react to the line R3F supports (`>=19 <19.3`).

Worse, `npm install` left the old React 18 hoisted at the workspace root while
the app resolved React 19, so elements created by one copy were rendered by the
other and the production build failed with a minified error #31 during
prerender. `package-lock.json` held the stale resolution across reinstalls;
regenerating the lockfile was the only thing that cleared it. **If a React error
mentions an object with `{$$typeof, type, key, ref, props}`, check for two React
copies before anything else.**

---

# Notifications and the simulation relay

## 33. Notification delivery is recorded, not fire-and-forget

Every destination gets a row in `alert_notifications` — channel, target, status,
attempt count and last error.

The first question after an incident is "was anyone actually told?", and an
in-memory counter cannot answer it after a restart. The target is stored on the
attempt rather than read back from `alert_rules.notify`, because that config is
editable and the audit answer must be where it *was* sent, not where it would go
now.

The email channel has no transport wired, so it records `failed` with
"no email transport configured". Silently skipping would leave the audit trail
implying nothing was ever configured; recording the reason answers the question
honestly — no, and here is why.

Delivery is dispatched off the alert path: a webhook that is down must not stop
an alert being opened or broadcast.

## 34. Webhook destinations are resolved and checked before the request

A webhook URL is operator-edited configuration that this service will make an
HTTP request to. Unchecked, that turns ingest into a proxy for anything on the
internal network — `169.254.169.254`, a database admin port, an internal API.

The check is on the **resolved IP**, not the hostname: a public name can resolve
to a private address, so string matching proves nothing. Redirects are not
followed, since a public URL could otherwise redirect into the range the check
just cleared it of. Private destinations are allowed only behind an explicit
flag, which exists so a local receiver can be tested — and the guard itself is
tested directly rather than through that opening.

*The reasoning here stands; the mechanism did not hold.* The check resolved the
name and `fetch` then resolved it again, so the address judged was not
necessarily the address contacted. §52 closes that and keeps everything above.

The whole feature is off by default. Sending is outward-facing, and a dev
database seeded with someone's real webhook should not start calling it because
a service booted.

## 35. The simulation worker holds no socket of its own

It posts `sim.progress` / `sim.complete` / `sim.failed` to an internal endpoint
on ingest, which fans them out to subscribers.

The worker is a batch compute service that may run on another box, scale
separately, or restart mid-run. Giving it fan-out duties would put client
connections in two services and backpressure in two places to get wrong. Ingest
already owns every subscription.

Broadcasting is best-effort and off the critical path: a run that produced
correct results has succeeded whether or not anyone was listening, and the run
row plus `simulation_results` are the durable record. Verified by running the
worker against a dead ingest address — runs complete with no error recorded.

## 36. Optional and nullable are different things, and Pydantic writes both as null

`SimulationParams.setpointDeltaK` is **optional**: absent means "this scenario
does not override the stored profile". `SimulationRun.startedAt` is
**nullable**: null is the value, meaning "not started yet". Zod distinguishes
these; `model_dump()` renders both as `null`.

So the first completed run's broadcast was rejected by ingest with
`summary.run.params.setpointDeltaK: Expected number, received null`. The fix is
surgical — `exclude_none` on `params` only. Applying it to the whole summary
would strip the nullable fields Zod requires to be present; omitting it entirely
sends nulls into optional fields.

This is the concrete cost of the two-language split that §26 anticipated, and it
is why the sim smoke test now asserts the serialised wire shape directly rather
than trusting the models to agree.

## 37. Progress is reported by percentage, not interval count

A fixed "every N intervals" is wrong at both ends: with N = 50, a three-day run
has 72 intervals and reports twice — a progress bar that jumps from nothing to
done — while a year reports 175 times. Crossing a 2% step gives a steady ~50
updates whatever the run length. Measured: a three-day run went from 2 frames
to 37.

---

# Multi-tenancy

Design accepted 18 September 2026; migrations `007`/`008` written, application
layers not yet built. The full model is in [multi-tenancy.md](multi-tenancy.md).
Every claim marked *verified* below was measured against TimescaleDB 2.30.1 on
PostgreSQL 17.11, the image this project runs.

## 38. `tenant_id` is denormalised onto every table, not joined up to `buildings`

The schema otherwise keeps tables narrow — §9 argues the case for `telemetry`
specifically. Tenancy reverses that, deliberately.

A row-level security policy is evaluated per row. Written as a reach up the
hierarchy it becomes a correlated subquery on every row and defeats index use:

```sql
-- what we did NOT do
USING (EXISTS (SELECT 1 FROM floors f JOIN buildings b ON b.id = f.building_id
                WHERE f.id = zones.floor_id AND b.tenant_id = current_tenant_id()))
```

A local column stays a plain filter. *Verified:* with the policy active, chunk
exclusion and `SkipScan` survive intact —

```
 Unique
   ->  Custom Scan (SkipScan) on _hyper_1_1_chunk
         ->  Index Scan using _hyper_1_1_chunk_tel_uidx on _hyper_1_1_chunk
               Index Cond: ("time" > (now() - '24:00:00'::interval))
               Filter: (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
```

## 39. Composite foreign keys, so a denormalised `tenant_id` cannot drift

Denormalisation usually means a column maintained by convention, and one buggy
INSERT puts a zone in a tenant its floor does not belong to — invisible until it
leaks. Each parent gets `UNIQUE (tenant_id, id)` and each child a foreign key on
`(tenant_id, parent_id)`, so the database rejects the mismatch and re-parenting
across tenants is impossible rather than merely discouraged.

*Verified:* inserting a zone under another tenant's floor fails with
`violates foreign key constraint "zones_floor_tenant_fk"`.

`ON DELETE SET NULL` names its column list (PG15+). Plain `SET NULL` would try
to null `tenant_id`, which is `NOT NULL`, and every parent delete would fail.

## 40. Policies fail closed, and carry `WITH CHECK`

`current_tenant_id()` returns `NULL` when `app.tenant_id` is unset, and
`tenant_id = NULL` is never true, so an unscoped connection reads **nothing**.
The alternative — treating "no tenant" as "all tenants" for admin convenience —
makes every forgotten `set_config` a silent full-table disclosure.

`WITH CHECK` is not redundant with `USING`: a `USING`-only policy does not apply
to `INSERT`. *Verified:* a cross-tenant insert succeeded until the check clause
was added, and afterwards fails with `new row violates row-level security
policy`.

The GUC is set **transaction-locally** (`set_config(…, true)`), never on the
session. In a pooled service a session-level setting outlives the request that
set it and is inherited by whoever gets that connection next.

## 41. The application does not connect as the schema owner

A superuser bypasses RLS unconditionally — `FORCE` included. Connecting services
as `dtwin`, which owns the schema, would make every policy in `007` inert while
looking perfectly configured. `007` creates `dtwin_app`, a plain `LOGIN` role;
`dtwin` is now only the migration runner's identity.

This was not a precaution. It was found by a probe that *leaked*: see §42.

Roles are cluster-scoped, not database-scoped, so `CREATE ROLE` is guarded by an
existence check — otherwise re-migrating after a `DROP DATABASE` fails.

## 42. A barrier view filters on `current_tenant_id()` itself, never by joining an RLS-protected table

The tidier-looking design lets the join to `sensors` do the filtering:

```sql
CREATE VIEW telemetry_v AS  -- WRONG
  SELECT t.* FROM telemetry t JOIN sensors s ON s.id = t.sensor_id;
```

A view body executes with the privileges of the view's **owner**. The owner owns
the schema, the schema owner is a superuser, and superusers bypass RLS. *Tested:*
this returned both tenants' rows and did not fail closed when no tenant was set.

The explicit form is correct and fails closed:

```sql
CREATE VIEW telemetry_1h_t WITH (security_barrier = true) AS
  SELECT * FROM telemetry_1h WHERE tenant_id = current_tenant_id();
```

*Verified:* correct tenant only, and zero rows unscoped. `security_barrier`
additionally stops the planner pushing a user-supplied function below the tenant
filter.

## 43. `telemetry` keeps compression and gets no policy; its rollups get views

TimescaleDB 2.30 makes RLS and compression mutually exclusive, in both
directions. *Verified:*

```
ALTER TABLE <compressed hypertable> ENABLE ROW LEVEL SECURITY
  ERROR:  operation not supported on hypertables that have columnstore enabled
ALTER TABLE <rls table> SET (timescaledb.compress, …)
  ERROR:  columnstore cannot be used on table with row security
```

`telemetry` is compressed after 7 days and retained 2 years. Trading that away
on the highest-volume table in the schema to gain a policy is a bad exchange, so
it keeps compression. Only `telemetry` is compressed — `weather_observations`
and `simulation_results` are not, and are covered by ordinary policies.

A continuous aggregate is a **view** (`relkind = 'v'`) and cannot carry RLS at
all; `ALTER VIEW … SET (security_invoker)` and the `ALTER MATERIALIZED VIEW`
form are both rejected. So the aggregates are rebuilt with `tenant_id` in the
grouping, direct access is revoked, and reads go through the `_t` barrier views.

One consequence worth knowing before running `008`: dropping the aggregates
discards their materialised history, and rollups older than raw telemetry's
retention window cannot be rebuilt from anything.

*Verified:* a continuous aggregate refresh is **not** subject to RLS. Rows
inserted into an RLS-protected hypertable with no tenant set still materialised.
That is what makes the rebuild possible at all.

## 44. Telemetry writes derive `tenant_id` from `sensors` instead of trusting the caller

`telemetry` has no policy (§43), so the write path cannot rely on one. Rather
than accepting a caller-supplied tenant, the insert joins the RLS-protected
`sensors` table and takes the tenant from there:

```sql
INSERT INTO telemetry (time, tenant_id, sensor_id, value, quality)
SELECT to_timestamp(t.ts / 1000.0), s.tenant_id, t.sensor_id, t.value, t.quality
  FROM unnest(…) AS t(ts, sensor_id, value, quality)
  JOIN sensors s ON s.id = t.sensor_id
ON CONFLICT (sensor_id, time) DO NOTHING;
```

A reading naming another tenant's sensor does not join and is dropped — no
per-row trigger, one statement, and a caller cannot write into a tenant it
cannot already read. *Verified:* a two-row batch naming one sensor from each of
two tenants inserted exactly one row, and a retry of the same batch inserted
none.

The cost: cross-tenant readings vanish without a distinct error. They must be
reported alongside ingest's existing `unknownIds` count rather than discarded.

**`ON CONFLICT` with an inference target requires `SELECT` on the table.** A
bare `INSERT` succeeds where the same statement with `ON CONFLICT (sensor_id,
time)` fails with `permission denied for table telemetry`. That upsert is what
makes a re-delivered gateway batch idempotent instead of double-counting a
meter, so it cannot be dropped — and granting table-wide `SELECT` to get it back
would hand the application an unscoped read path around the barrier view.
A column-level grant on the two index columns is exactly enough:

```sql
GRANT SELECT (sensor_id, "time") ON telemetry TO dtwin_app;
```

*Verified:* the upsert works; `SELECT value` and `SELECT *` both remain denied.

## 45. Simulation topics are keyed by building, not by run

`sim:<runId>` could never be subscribed to. The topic-owner map is built from
spatial ids at refresh, a run id is never in it, and `ownerOf` returning
undefined is correctly treated as "refuse". Nobody noticed because every sim
event is also fanned out to `building:<buildingId>`, where the dashboard already
sits — and because **no client had ever subscribed to a sim topic**: `topics.sim`
had exactly two call sites in the repository, the producer and the smoke test.

Authorising a run id means a run→tenant lookup, which is I/O inside a subscribe
path that is synchronous on purpose (`registry.ts`: "a database round trip there
would make topic authorisation the slowest thing the socket does"). Three shapes
were considered and each pays for that differently:

- **An async predicate** needs per-connection frame serialisation to keep acks
  in arrival order — including for `ping`, which the server deliberately answers
  before the auth gate so a client can hold a socket while it fetches a ticket.
  A tri-state `allow`/`deny`/`defer` does not avoid this: the frame after a
  deferred one is dispatched immediately and its ack overtakes.
- **An on-demand lookup** lets an authenticated client force one query per
  unknown UUID, 64 per `subscribe` frame, with no rate limiting anywhere in
  `server.ts`, against a ten-connection pool shared with the telemetry writer.
  Random UUIDs are never repeated, so a negative cache buys nothing.
- **A cache fed by the relay** is worse than the bug. `/internal/sim-event`
  checks the event's `buildingId` against the key's tenant but nothing ties
  `runId` to `buildingId`, so a holder of a valid `sim:notify` key for tenant A
  could post an event naming its own building and tenant B's run id, caching
  "run B is owned by A" — and `sim.complete` carries the full summary.

The event already names the building, the building is already in the owner map,
and the relay already performs exactly the ownership check that authorising a
sim topic needs — once, on the write side, against an authenticated key. Keying
the topic by building makes authorisation the check that already exists: no
lookup, no cache, no ordering change, and one comparison now guards both
destinations. `maySubscribe` needed no new branch; the fix was deleting a
docstring that described code nobody had written.

It also makes the topic **stable for a session**, which is what the client
needs: `useLiveData` keys its effect on the topic list, so a run-keyed topic
would tear down and reopen the socket once per simulation run.

The cost, plainly: a client cannot follow exactly one run. Within a tenant it
sees progress and summaries for every run on that building — colleagues'
scenarios, never another tenant's. Every event still carries `runId`, and
`ScenarioPanel` already filtered on it, so nothing downstream changed.
Run-level addressing returns the day a client needs it, and it will arrive with
the lookup, the per-connection rate limit and the bounded cache that make it
safe. Building it now would pay that cost for a subscriber that does not exist.

Once the topic is stable, the dashboard can simply hold it, so the building
topic stops being a second destination for sim events. It was only ever
carrying them because sim topics could not be subscribed to. Sending to both
would now deliver twice to the root view, and the building topic goes back to
meaning telemetry.

*Verified:* the smoke check that had been failing since the topic was
introduced now passes with no database fixture — `fakeRunId` still has no row in
`simulation_runs` and does not need one — and `sim:<random uuid>` is still
refused with `subscribe.denied`. Ingest went 82 passing + 1 failing to 84
passing.

## 46. A future-dated reading blinds the 5-minute view for everyone

Found by CI, in the worst way: a test wrote five readings timestamped a day
ahead — as a cheap way to claim a range nothing else writes to — deleted them
immediately, and a *different* suite three steps later reported an empty
history for a sensor that plainly had data.

`telemetry_5m` is a continuous aggregate with `materialized_only = false`, so a
read is the union of the materialised range and a live query over raw rows at
or after the **materialisation watermark**. A refresh moves that watermark to
the newest data it saw. If the newest data is dated tomorrow, the watermark
goes to tomorrow — and every row subsequently written at the real "now" lands
*below* the watermark, in the range the view answers from materialised results
that were computed before those rows existed. The rows are in the hypertable
and invisible in the view. Deleting the offending future row does not move the
watermark back.

*Verified* on a fresh database: one current row reads as one bucket; after a
future row plus a refresh, a newly written current row adds no bucket, while
the raw table shows it.

Two consequences, and the second is the one that matters.

**For tests:** claim a private range in the past, never the future. The past is
below the watermark and already materialised, and any check that counts rows
should read the hypertable rather than the rollup anyway.

**Never call `refresh_continuous_aggregate` with a NULL end.** Found the same
day, by the same failing check, with a different cause. A NULL end materialises
through the bucket containing `now()` and leaves the watermark at that bucket's
**end** — ahead of the clock. The database suite did exactly that, and the web
suite three steps later reported an empty history for a sensor that plainly had
readings: the watermark sat at 14:20 while the newest row was 14:16:51, so
real-time aggregation covered nothing and the materialised copy predated every
row written since.

It is invisible on a long-running database, because the five-minute policy
heals it within one bucket. It is very visible on a fresh one, where everything
happens inside that window — a new deployment's dashboard shows no 5-minute
history for up to five minutes, and no hourly history for up to an hour.

So a manual refresh names an end in the past and leaves the tail to real-time
aggregation, which is what the policies' own `end_offset` does and what the
comment above them says it is for. `008_tenancy_timeseries.sql` still calls
`NULL, NULL`; that is harmless on the empty table a fresh install gives it
(the watermark stays at `-infinity`), and it would have this effect on an
upgrade of a database that already holds history. Worth knowing before the next
aggregate rebuild.

**For production: the watermark is a property of the hypertable, not of a
tenant.** One gateway with a clock skewed into the future would blank the
history view for *every tenant sharing that hypertable*, silently, with no
error anywhere and the data sitting in the table the whole time. The quality
gate checks that a value is plausible; nothing checks that a timestamp is.
`assessQuality` should reject or clamp a reading dated beyond a small tolerance
ahead of the server's clock, the same way it rejects a temperature of -273.
That is not built — this decision records the hazard and the reason, and the
fix belongs on the ingest path where the timestamp arrives.

## 47. A run is admitted, cancellable and reaped — but still not queued

`apps/sim` ran simulations in a FastAPI `BackgroundTask`: no cap, no way to
stop one, and no memory of one that did not finish. Three consequences, each
closed differently, and the shape of the fix is as much the decision as the fix.

**Admission, not a queue.** A run is CPU-bound numpy in FastAPI's thread pool,
so the thing worth protecting is this process. Past `SIM_MAX_CONCURRENT_RUNS`
(two by default — enough to compare a baseline against a scenario) `/simulate`
answers **429** rather than accepting the work. A 202 meaning "queued behind an
unbounded number of others" is a promise the worker cannot keep, and the caller
can retry knowing what it was told. A durable queue is the right answer at the
point where runs must survive the process, and it brings a broker with it; this
does not pretend to be one.

Admission happens **before** the row is created. Creating it first and then
refusing would leave a `queued` row nothing will ever pick up — precisely the
orphan the reaper below had to be written for.

**Cancellation at the progress hook.** `cancelled` had been in the status enum
since 004 with nothing able to set it. The row is updated first, with the status
test inside the UPDATE's WHERE clause so a run that finishes between check and
write is not overwritten; the in-process flag is second. The integration loop
notices at its next progress step, which is every 2%, so a cancelled run stops
within a fraction of its remaining work rather than instantly. Interrupting
numpy mid-array is the alternative and it would leave results half written.

The flag is in-process on purpose. A run belonging to another worker is that
worker's to stop, and one belonging to a dead worker is the reaper's — so a
shared cancellation channel would be machinery for a case the next two
mechanisms already cover.

**Reaping at startup.** A `BackgroundTask` dies with its process, so a restart
left rows at `queued` or `running` that nothing would ever advance — and a
caller polling one cannot tell it from a run that is merely slow. Startup now
fails them with `worker restarted while this run was in flight`.

It iterates tenants rather than running unscoped: `simulation_runs` is under
row-level security, so an unscoped connection would see, and update, nothing at
all. `tenants` carries no policy, which is what makes that list readable before
a tenant is chosen. `SIM_REAP_ORPHANS=false` turns it off for a deployment
running several workers against one database, where another process's live run
is not this one's orphan — the honest limit of a startup reaper, and the point
at which run ownership needs a lease rather than an assumption.

*Verified:* a run cancelled mid-flight ends `cancelled` and a second cancel is
409; a third concurrent request is refused 429 with the first two accepted, and
leaves no `queued` row; a row planted at `running` is `failed` with that message
within seconds of a worker start.

## 48. Latent load is a load on the coil, not on the zone

The model was sensible-heat only, and `interview/08` listed that first among
the things most likely to be caught overclaiming: *"Understates HVAC energy in a
humid coastal climate, where dehumidification is a substantial share."* It was
not an approximation. A sensible balance has **no term** for moisture, so the
question could not be asked of it at all.

It is now asked, and the answer for Corniche Tower over three days in June is
**3,155 kWh of 8,043 kWh — 39% of cooling energy**. Whole-building HVAC went
from about 5,000 kWh to about 8,000. That reversed a comparison the smoke suite
had been asserting since it was written: plug load used to exceed HVAC, because
a 200 m² server room at 450 W/m² is 90 kW continuous. It no longer does. In a
Gulf June, drying the ventilation air costs more than the data hall's plugs.

**The modelling decision that matters is where the term goes.** Drying air does
not change its temperature, so latent load is kept out of the sensible balance
that decides where the zone floats to. It is a load on the **coil**. Putting it
into `q_net` would have been easy and would have produced a building that
cooled itself by dehumidifying — moisture appearing as degrees.

Three consequences of that placement:

- It is only met **while the coil is running**. With no cooling call nothing is
  dehumidifying the space, and charging for moisture removal that did not happen
  would invent energy. The space drifts damp, which is what an unconditioned
  building here does.
- The **plant is sized for the total coil load**, sensible plus latent, as a real
  chiller is — at the peak hour's own humidity, not a nominal one. Sizing on
  sensible alone would leave it short on exactly the days that matter, and the
  shortfall would surface as unmet hours describing the sizing rule rather than
  the building.
- `latent_load_kwh` is reported as a **subset** of `hvac_load_kwh`, not an
  addition. "Why is this building expensive?" has a different answer in Abu
  Dhabi than in Munich, and one HVAC number cannot give it.

**A second correction came with it.**
`thermal_profiles.occupancy_heat_gain_w_person` defaults to 120 W, which is a
seated adult's *total* output; ASHRAE puts roughly 75 W of it into the air as
heat and the rest as water. The engine treated all 120 W as sensible,
overstating the temperature-raising gain by about 70% while having nowhere to
put the moisture. It is now split, so the column keeps meaning what it says.

**Indoor humidity is a target, not a state.** The space is held at 50% RH at
setpoint — the middle of the ASHRAE 55 envelope and what a Gulf building is
designed for. Simulating the room's own moisture balance needs a second
capacitance and a second integration, and the quantity that matters here is set
by the outdoor air brought in, not by how the room's humidity swings between
coil cycles. The day that question matters — a humidifier, a tight archive, a
lab — this becomes a state and the note in `psychro.py` is where to start.

`psychro.py` implements three functions rather than taking a dependency:
Hyland-Wexler saturation pressure, humidity ratio, and the latent power of an
air stream. *Verified against ASHRAE Fundamentals tables:* 25.2 g/kg at 35 °C
and 70% RH against a tabulated 25.0, 9.3 against 9.3 at 24 °C and 50%, and
saturation pressure at 100 °C within 0.1% of one atmosphere.

**Still not modelled**, and worth saying before anyone asks: there is no
humidifier, so the model never adds moisture; no latent capacity limit separate
from sensible, so a coil cannot run out of dehumidification while still having
cooling left; and no sensible heat ratio on the equipment, so the split between
the two is the load's, not the machine's.

## 49. Facade orientation is derived from the geometry, not stored beside it

`solar.py` averaged surface irradiance over the four cardinal orientations and
said why: zone orientation "is not in the schema". Its own note added that
recording it per zone "is the fix, and it belongs in the model, not here."

It was already in the model. `zones.boundary` and `floors.footprint` are
PostGIS polygons in a local metre CRS whose axes are declared — +X east,
+Y north (§1) — so which way a wall faces is a property of geometry the
database already holds, not a new fact to record about it.

**So it is derived, not added as a column.** A stored `facade_azimuth_deg`
would be a second source of truth about where a wall points, free to drift from
the polygon that actually says so. That is the failure §27 exists to avoid for
the building as a whole, and it does not become acceptable one column at a
time. An edge counts as exterior when its midpoint lies on the floor outline;
the outward normal is whichever perpendicular points away from the zone
centroid; the zone's irradiance is the length-weighted mean over the walls it
has.

**The averaged version was not a small error.** A west office takes its peak
gain late in the afternoon, when the outdoor temperature is also at its highest
and the plant has least headroom; an east office takes the same energy in the
morning, when it is cheap. *Verified:* on one floor of the seeded building, the
west-edge zone now peaks at **17:00** and the east-edge zone at **07:00**. The
cardinal average put both at the same middling hour, which is exactly the
difference a facade-retrofit or a shading scenario would be asked about —
whole-building energy barely moved (8,043 to 8,003 kWh), because averaging over
a building with all four aspects represented is nearly conservative in total
and wrong for every zone individually.

**Where the geometry and the asset register disagree, the weaker assumption
wins.** A zone whose polygon yields no exterior edge but whose
`exterior_wall_area_m2` says it has one keeps the cardinal average rather than
being declared windowless. A core zone — no exterior edge and no wall area —
gets zero, which is correct rather than conservative.

**Limits worth stating.** The outward normal is chosen by comparing against the
zone centroid, which is well defined for the convex, axis-aligned zones this
building has and would need a proper point-in-polygon test for a concave one.
Self-shading between wings, and shading from anything outside the building, are
still not modelled. And the irradiance matrix is `(zones × steps)`: about
20 MB for a year at a 300-second step, which is fine here and is the first
thing to reconsider for a campus.

The derivation is a pure function with no database in it, and has **12 unit
tests** — corner zones, edge zones, core zones, an unclosed ring, a wall just
inside the outline and one well inside it. A swapped normal would otherwise
show up only as a building whose afternoon peak is in the morning, which is a
slow and ambiguous way to find a sign error.

## 50. The air side comes from the asset register, and the register is ambiguous

HVAC energy was thermal load divided by COP. Two things were missing from that,
and finding the second is more useful than fixing the first.

**One COP was used for both directions.** That is only right for a machine that
has one. A reversible heat pump is usually better at heating than cooling; an
electric resistance heater is exactly 1.0 and nothing else. `heating_cop` is
now its own column, defaulting to `hvac_cop` when unset so a profile that has
not been told its heating efficiency keeps behaving as it did. The seeded
building reheats electrically at the VAV terminals, so it is 1.0 against a
cooling 2.6–3.2. It barely moves this building's number — a Gulf tower heats
almost never — which is exactly why it was worth fixing now: the error is
currently invisible and would stop being invisible the first time this model is
pointed at a building with a winter.

**Moving air was free.** The supply fan runs whenever the coil does. Airflow
follows the *sensible* load, since that is what a temperature rise across the
coil carries; latent load rides on the same air and does not call for more of
it. `SUPPLY_AIR_DELTA_T_K = 11` is the standard design range.

**Specific fan power is derived from the register, not from literature.** §14
says the simulator must agree with the asset register, and the register has the
numbers: four AHUs rated 15 kW at 18,000 m³/h is **3.0 W per litre per second**.

That produces a fan share of about **28% of HVAC**, which is high — and the
honest reading is that it is a fact about the seeded register rather than about
the model. 3.0 W/(l/s) is roughly double what ASHRAE 90.1 permits a new VAV
system. This building's fans are modelled as the inefficient ones the register
says they are, because §14 settles which of the two gives way. A real
commissioning exercise would question the rating; the model should not quietly
improve it.

### The ambiguity worth knowing about

**`equipment.rated_power_kw` means different things for different equipment
types, and nothing in the schema says so.**

| Type | Seeded value | What it evidently means |
|---|---|---|
| `chiller` | 320 kW ×2 | **Thermal capacity.** As electrical input it would imply a megawatt of cooling for a 4,800 m² building |
| `ahu` | 15 kW at 18,000 m³/h | **Electrical** fan input — 3.0 W/(l/s) |
| `vav` | 0.4 kW at 3,000 m³/h | Electrical, terminal fan and reheat |
| `lighting_circuit` | 9.6 kW | Electrical connected load |

Summing that column across types adds kilowatts of two different kinds. The
fan query therefore restricts itself to `ahu` rows, and says why in its
docstring. The schema-level fix is either a `rated_power_kind` discriminator or
separate `rated_capacity_kw` and `rated_input_kw` columns; either is a
migration plus a re-seed, and neither should happen without deciding which the
BMS integration will actually populate.

**Consequently the chillers' 320 kW is still not used for plant capacity.**
§24's auto-sizing stands — its argument was against a flat W/m² rule, not
against the register, so using the register would be consistent with it in
principle. What stops it is that chiller capacity is a *building-level* number
and §24's capacity is *per zone*: distributing one to the other means modelling
the chiller→AHU→VAV tree that the schema already holds in
`equipment_zone_service`. That is the next piece of air-side work, and it wants
its own decision rather than being smuggled in here.

> **Superseded in part by [§59](#59-the-fan-turns-down-runs-for-ventilation-and-heats-the-air-it-moves).**
> Fan heat and the part-load curve are now modelled; duct losses and the
> distribution tree are not. The paragraph below is kept as written, including
> its estimate of "a few percent" for fan heat, which turned out to be ten.

**Also still not modelled:** fan heat into the supply air, which is a real gain
of a few percent and introduces a feedback loop (more cooling, more air, more
fan heat) that wants care rather than a line; duct leakage and thermal losses;
and any part-load fan curve — power here is linear in flow, where a real
variable-speed fan is closer to cubic, so this *overstates* fan energy at low
load and understates the benefit of a VAV retrofit.

## 51. The delivery record commits with the alert, and one worker owns each row

Two defects, both named in `docs/cto-assessment.md`, both about the same table.

**The record was written after the alert, in a different transaction.** The
engine opened the alert, committed, and then called the notifier, which opened
its own transaction to insert the `pending` rows. A crash in between left an
alert with **no notification rows at all** — and nothing would ever create
them, because the retry sweep only retries rows that exist. The alert was
durable and the intent to tell anyone about it was not.

The rows are now inserted by `openAlert`, inside the alert's own transaction.
That is the whole of the outbox pattern, and the consequence worth stating is
what it does to the dispatch that follows: **it becomes an optimisation.** If
the process dies before it runs, or it throws, the sweep finds the rows. The
cost of losing it is one sweep interval, not a notification.

**Nothing stopped two workers sending the same row.** The sweep did a plain
`SELECT` and then delivered, so two ingest replicas read the same `pending` row
and both sent it. Claiming is now an `UPDATE … WHERE id IN (SELECT … FOR UPDATE
SKIP LOCKED)`: each worker takes a disjoint set and the others step over the
locked rows rather than blocking behind them.

`claimed_at` is a **lease**, not a flag. A worker that dies mid-delivery would
otherwise hold its rows forever; past `ALERT_NOTIFY_LEASE_MS` they are
claimable again. The honest cost is at-least-once: a worker that is merely
*slow* can have a row taken from under it and the receiver sees it twice. Every
payload carries the alert id, which is what a receiver keys its own idempotency
on. Exactly-once would need the receiver's cooperation and is not something
this side can promise alone.

**The sweep no longer filters `channel = 'webhook'`.** That filter was
survivable while the notifier created rows and delivered them in the same
breath — a log or email row was never left pending. Now that rows commit with
the alert and are delivered afterwards, a channel the sweep ignores is a
channel that never recovers from a restart.

**Notifications disabled means no rows, not queued rows.**
`ALERT_NOTIFY_ENABLED` is false by default, so writing the outbox anyway would
give every deployment that has not opted in an unbounded queue of `pending`
deliveries — and flood every one of them the moment somebody enabled it. A
switch that says "this deployment does not send notifications" must not be
quietly accumulating the ones it did not send. The `skipped` counter still
moves, so the difference is visible on `/healthz` rather than unexplained.

`POST /internal/notify-sweep` runs the sweep now rather than at the next
interval. An operator action, not test scaffolding: after fixing a receiver
that has been refusing deliveries, the alternative is waiting out
`ALERT_NOTIFY_RETRY_MS` with no way to tell whether the fix worked. It is safe
to call concurrently, which is the same property that makes a second replica
safe.

*Verified:* every alert a rule opens has its full set of destination rows, and
none of them is timestamped after the alert it belongs to; nine pending rows
against three concurrent sweeps produce exactly nine deliveries and nine
claims, where an unclaimed sweep would produce up to twenty-seven. Reverting
the claim to the old `SELECT` pattern fails eight checks, so none of this is
asserted vacuously.

## 52. The webhook connects to the address that was checked, and only that one

§34 resolves a webhook hostname and refuses private addresses, because rule
config is operator-edited input that this service makes requests to. The check
was sound and the request that followed it was a different request. Three
holes, all of the kind that every legitimate webhook sails past:

**The check and the connection resolved the name separately.** `lookup` said
"public", then `fetch` asked DNS again and connected to whatever it was told the
second time. A name with a short TTL that answers public first and `127.0.0.1`
second — DNS rebinding — walks straight through, and the check was looking at an
address nobody connected to. `docs/cto-assessment.md` said as much: the existing
checks "should not be treated as complete SSRF protection."

**Only the first record was examined.** A name with one public and one private
record passed. Which one the client dials is the resolver's ordering, which is
to say the name owner's.

**The range list was a handful of regexes.** It missed carrier-grade NAT,
multicast and the reserved blocks, matched IPv6 link-local by the literal prefix
`fe80` when the range is `fe80::/10`, and did not know that `::ffff:127.0.0.1`
is loopback wearing an IPv6 address.

The fix is to resolve **once**, judge **every** address, and hand the connection
exactly the addresses that were judged. `postPinned` uses `node:http` with a
`lookup` that answers only from that list, because `fetch` offers no way to say
which address to connect to — and a guard that cannot constrain the connection
is a guard over a different request from the one that gets made. The hostname is
still used for the Host header, for SNI and for certificate verification; only
the question "where is it?" has been taken away from DNS.

Two things fall out of that choice rather than being added to it. `node:http`
cannot follow a redirect, so a public URL answering `302` to
`http://127.0.0.1/` is reported as the failed delivery it is — the old code
needed `redirect: 'manual'` to get the same. And each delivery uses its own
socket (`agent: false`): a kept-alive socket would be reused without passing
through `lookup`, which is harmless for an already-checked address and harder
to reason about than it is worth.

Ranges are RFC 6890's special-purpose space in `net.BlockList`, not regexes, and
an IPv4-mapped IPv6 address is judged as the IPv4 host it reaches. WHATWG `URL`
already normalises the exotic IPv4 spellings — `2130706433`, `0x7f.0.0.1`,
`0177.0.0.1`, `127.1` — to dotted form before the check sees them, which is
tested rather than assumed. Credentials in a URL are refused outright: they end
up in logs and in `alert_notifications.target`.

`ALERT_WEBHOOK_ALLOW_PRIVATE` skips the judgement and **keeps the pin**, so the
smoke suite — which has to reach a receiver on loopback — exercises the real
request path end to end rather than a test-only one.

*Verified:* 39 unit tests with no network. The one that matters sends to
`webhook.invalid`, a name reserved never to resolve, with `127.0.0.1` pinned:
it succeeds, and with the `lookup` line removed it fails with `ENOTFOUND` — so
the socket demonstrably goes where it was told, not where DNS says. A rebinding
resolver is asked exactly once. A `302` to a second local server leaves that
server with zero hits.

**Still true:** this is one layer. A receiver on a public address that is
itself a proxy into a private network is outside what any client-side check can
see, which is why the assessment's other recommendation — an egress policy on
the host — remains the right complement rather than something this replaces.

## 53. Every bound says what it does when it is reached

"Shed load, never queue it unboundedly" was already a hard rule for the write
buffer and the socket backlog. It had not been applied to reads, to the
registry, or to what a single request may ask for. Going through them, the
interesting part was not adding limits — it was that **the right behaviour at
the limit is different each time**, and a bound that does the wrong thing when
reached is a second bug.

| What | Bound | At the limit | Why that, and not the other |
|---|---|---|---|
| Sensor history | buckets per resolution | route **refuses** (400, names the limit); query truncates to the most recent as a safety net | A capped time series still means something — it is the latest window |
| Spatial tree | rows per collection | **throws** | There is no honest subset of a floor plan. Zones that are not drawn cannot be clicked, cannot alert, and look exactly like zones that do not exist |
| Sensor registry | total sensors | refresh **abandoned, previous registry kept** | It must hold every sensor to work, so it cannot be a LIMIT — a registry missing sensors reports real points as unknown. Stale and correct beats current and OOM-killed. At boot there is no previous one, so the service refuses to start |
| Unknown-id memory | entries | id **not remembered**, no early refresh | The map is written by callers — 10,000 invented ids a batch. Nothing is lost: the timer refresh still runs, and a flood of junk ids has no claim on an early one |
| Simulation request | intervals, interval floor, zone-steps | **refused** (422), before any row exists | A 202 for a century at one second is a promise the worker cannot keep |
| `?hours=` | per query | **refused**, not clamped | Clamping answers a different question without saying so: a chart asking for ten years and given a week draws a week and labels it ten years |

Three things found on the way that were not about size at all:

**An incremental registry refresh does not work here**, though it is the
obvious improvement. The writer stamps `sensors.last_seen_at` on every flush,
which fires the `updated_at` trigger — so every sensor that is reporting has
"changed" since the last refresh, and `WHERE updated_at > $last` re-fetches
exactly the sensors that matter. The load is keyset-paged instead, which bounds
what any one statement returns; node-postgres buffers a whole result set, so
the process used to hold the table twice, once as rows and once as the maps
built from them. Making it truly incremental needs a column the writer does not
touch.

**`runId` went into the worker's URL path unchecked.**
`GET /api/simulate?runId=../weather/generate` asked the worker for a different
route. A GET, so limited — but ids bound for a `uuid` comparison or a URL path
are now parsed as uuids, which also turns a class of 500s into 400s: Postgres
raises on a malformed uuid rather than matching nothing, and `$2::metric_type`
raises on an unknown label.

**§47's admission cap bounded how many runs, not how large.** The request
validated with `intervalS > 0` and nothing else. The interval floor matters as
much as the count — the integration substep is `min(300 s, interval)` — and
the product `zones × steps` needed its own ceiling, because §49's per-zone
irradiance matrix is exactly that shape: 5,000 zones for a year at 300 seconds
is four gigabytes in one allocation. It is checked before the weather series
exists, since the point of a ceiling is not to have already allocated what it
forbids.

*Verified:* the spatial ceiling throws at 5 zones and loads at exactly 24; the
registry loads 190 sensors in pages of 50 with none dropped or doubled, and a
server started over its ceiling exits non-zero naming the variable; nine
malformed or oversized query inputs are all 400; a century-long run and a
one-second interval are both 422 and leave no run row behind.

> **Since closed.** `listActiveTenants` now has a ceiling of 2,000 and throws
> past it. "Deliberately" below was the wrong word for it: the docstring said
> the design stops being right at thousands of tenants, and a limit is how a
> design says where it stops. It throws rather than truncates for the same
> reason the registry does — a list missing a tenant is a registry missing that
> tenant's sensors, whose readings are then dropped as unknown ids, silently,
> for whichever tenants sort last. And rate limiting arrived in §54.

**Not bounded, deliberately:** `activeTenants()` still returns every tenant, and
its own docstring already says why that is right for tens and wrong for
thousands. The registry's spatial-id query is sized by zones rather than
sensors and rides under the same practical ceiling. And none of this is rate
limiting — a bound on one request says nothing about how many requests arrive.

---

## 54. Rate limits are per resource, keyed by whoever can exhaust it

§53 bounded the size of one request and said in its last line that this is not
rate limiting. A caller allowed 10,000 readings a request was allowed 10,000
readings a thousand times a second.

**One limiter keyed one way would have protected nothing well**, because the
things worth protecting are exhausted by different parties:

| Limit | Keyed by | Protects | Why that key |
|---|---|---|---|
| Failed authentication | calling address | the connection pool | the caller has no key to key on. Every key that does not resolve is still a query, on a ten-connection pool the telemetry writer shares — a stranger with nothing could slow ingest for every tenant |
| Requests | API key | parse CPU | checked before the body is read |
| Readings | **tenant** | the write buffer | see below |
| WebSocket frames | connection | the owner-map walk a 64-topic `subscribe` costs | checked before the auth gate |
| WebSocket connections | tenant | the fan-out loop | a ticket is signed, not stored, so it cannot be single-use |
| Sign-in failures | email as typed, and address | scrypt | 100 ms and 32 MB each, by design |
| Sign-in verifications in flight | — (a ceiling of 3) | memory, and libuv's thread pool | fifty at once are 1.6 GB however slowly they arrived. Three rather than four because scrypt shares libuv's four threads with hostname resolution, so four hashes leave none for opening a database connection |

**The readings limit is a fairness mechanism, not a throttle.** The write
buffer sheds its OLDEST rows on overflow (§12) and does not ask whose they are.
So before this, one tenant's flood was every other tenant's data loss — the
isolation that row-level security guarantees for reads did not exist for
writes under load. It is per tenant rather than per key because a tenant can
mint keys. A batch over budget is refused whole: a gateway can retry a batch
but cannot know which half of one was kept.

**Only failures are charged** on both authentication paths. The check comes
before the expensive step — since that step is what is rationed — and the
charge only when it fails, so a gateway with a good key and a person with the
right password are never slowed by a limit that exists for callers with
neither.

**`X-Forwarded-For` is read from the right, or not at all.** Its first entry is
whatever the caller typed; taking it lets a stranger choose the address their
failures are charged to, which defeats the limit and spends someone else's. Only
entries appended by proxies we operate are believed, and with none configured
the header is ignored. The web service has no socket to fall back on — Next
fills the header only when absent — so there the per-address limit is simply
**off** until a trusted proxy is declared. A limit a caller can step around by
changing a string is worse than none, because it reads as protection.

**The 429 must not become an oracle.** `login()` goes to some length not to
reveal whether an address exists. The sign-in limiter is keyed on the
address as typed, never on whether it matched a user, so a 429 says nothing a
401 did not.

**The limiter's own memory is bounded**, since its keys are caller-supplied. At
`maxKeys` it first drops buckets that have refilled completely — a full bucket
and an absent one behave identically, so that loses nothing and needs no timer.
If every key is mid-burst, which is what rotating keys looks like, newcomers
**share one bucket**. Evicting an old key instead would hand its owner a fresh
burst, making "fill the limiter" the way to defeat it; refusing new keys would
let a stranger lock everyone out.

**Costs.** State is per process, so N replicas admit N times the limit. That is
tolerable because every resource above is per-process too; it would not be for
a billing quota. The per-email limit lets anyone who knows an address slow its
owner's sign-in by failing on purpose — it refills one attempt a minute, so the
owner is delayed and never locked out, which is the difference between a rate
limit and a denial-of-service feature. And every 429 carries `Retry-After`: a
gateway told "no" without "until when" retries at once, and a limit that
provokes a retry storm has made things worse.

**Found on the way: `login()` held a database connection for the whole of the
password hash.** One pooled connection, pinned for ~100 ms of CPU that needs no
database at all, per attempt — ten concurrent sign-ins emptied the pool. The
lookup, the verification and the session insert are now three steps, and only
the first and last hold a connection. *Measured:* across 24 concurrent sign-ins
the pool was fully idle in 0% of samples before and 98–99% after. The first
version of that measurement read 54%, which is how the thread-pool contention
in the table above was found: it was mostly watching connections being opened
behind the hashes.

---

## 55. The live map judges a reading before it draws one

The dashboard kept `Map<sensorId, number>`: the latest value and nothing else.

- **A flagged reading coloured its zone.** −273 °C from a failed probe painted
  the zone deep blue, while the alert engine — correctly, per §17 — refused to
  evaluate that same reading. A map and an alert list that disagree invite the
  wrong conclusion about which is broken.
- **A value never aged.** A sensor that stopped an hour ago went on painting its
  zone the colour it had when it died, under a green "live" light.
- **The zone panel cleared its "stale" mark** the moment any live reading
  existed for a point, and never set it again.
- **Live load summed `value ?? 0`**, so a dead meter contributed its last
  reading for ever and one never heard from contributed zero. Both produce a
  plausible total.

The client now keeps value, timestamp, quality and arrival time, and a pure
module (`apps/web/lib/live.ts`) decides what may be drawn:

**Only `Good`, fresh readings enter a zone's mean** — the same rule the alert
engine applies, so the two cannot disagree. Stale means more than three sample
intervals, the multiple `getZoneDetail` already used in SQL.

**Age is `now − min(ts, receivedAt)`.** A device clock running ahead cannot make
a reading look fresher than its own arrival; a backfilled reading from
yesterday is as old as its timestamp says.

**Silence is only evidence while we were listening.** The dashboard subscribes
to the floor in frame (§31), so every other floor hears nothing *by design*.
Ages are floored at the moment the current subscription was accepted, and
out-of-scope floors are held rather than judged — otherwise focusing a floor
would grey out the rest of the building three minutes later, for a silence the
client arranged itself.

**The historical baseline is for the first paint only.** It stands in while a
point has not yet been listened to for long enough to expect it, and never for
a point that has gone quiet: a one-hour mean fetched when the page opened is
older than the reading it would replace.

**Staleness needs a clock, not a frame.** It is the one thing on the screen that
changes when nothing arrives, so a ten-second tick drives it. A building whose
gateway has died sends no frame to re-render on.

A grey zone now carries its reason — "no reading · 4 min", "reading flagged",
"2 of 3 points" — because grey alone reads as "no sensor here", which is a
different fact.

**Found on the way: the `ZoneMesh` memo from the rendering work never held.**
That change stabilised the `onSelect` callback and said the memo now worked. It
did not: `visual` is a fresh object for every zone on every recompute, and the
default comparison is by reference. It now compares what the visual says.

*Verified in a browser, against the running stack:* a `spike` fault greys its
zone as "reading flagged" within one sample; an `offline` fault greys its zone
with a growing age once three intervals pass; clearing both restores colour on
the next frame.

---

## 56. An alert frame is never skipped; a client too slow for one is disconnected

"Alerts are never coalesced or shed" has been a rule since §12, and it held for
the queue and not for the socket. `Fanout.send` pushed alerts through the same
`#deliver` as telemetry, which skips any client whose send buffer is over
`INGEST_CLIENT_BUFFER_MAX_BYTES`. A client slow enough to miss a telemetry
frame therefore silently never heard that an alert had opened. The 18 September
review had this as a P0, and it was still open.

**Neither obvious repair is acceptable.** Sending regardless queues without
bound behind a client that is not reading — the exact failure §12 exists to
prevent. Skipping is the defect. A per-client alert queue with its own bound
only moves the question to what happens when *that* fills.

**So the socket is closed**, with 1013. The dashboard reconnects on its own, and
on every accepted subscription it refetches the open alerts over HTTP — the one
source that cannot have missed anything, because it is the table. The slow
client loses its connection, not its alert. Simulation progress goes on being
skippable: it has a successor, and a polling fallback behind it.

**That only works if the client reconciles correctly, and it did not** — the
second P0 from the same review. The dashboard fetched open alerts once, at
mount, and merged live events over them. `alert.resolved` removed the alert
from the *live* list only, so an alert that was already open when the page
loaded stayed on screen after it resolved, for as long as the page stayed open.
An operator acts on that list.

The rule now, in `apps/web/lib/alerts.ts`: **the snapshot is the truth about
everything before it was requested; events are the truth about everything
after.**

- An event older than the snapshot is ignored. This is what makes the refetch
  correct rather than merely frequent: an alert raised while connected and
  resolved during a gap would otherwise be resurrected from the live list.
- An event newer than it is applied on top, and a `resolved` removes the alert
  wherever it came from.
- "Requested", not "received". The rows were read somewhere between those two
  moments; an event in that window is applied again, which is harmless —
  upsert and remove are idempotent — where dropping it would lose it.

Only the latest event per alert is kept, which loses nothing because both
operations are last-writer-wins, so the memory is sized by distinct alerts and
not by traffic. The snapshot is also refetched every five minutes, so no event
has to be remembered for long. The merged list is sorted the way `/api/alerts`
sorts, so a critical raised live lands at the top rather than appended under an
hour of warnings, and an alert does not change position depending on which
path delivered it.

**Cost.** A client on a genuinely bad link is disconnected each time an alert
fires while it is behind, and reconnects into the same link. That is visible —
`fanout.backloggedClosed` on `/healthz`, "reconnecting" on the dashboard — and
it is the honest state: that client is not receiving a live feed, and a green
light over a connection silently dropping frames was the alternative.

> **Since addressed.** Both alert listings now return `total`, `limit` and
> `truncated` beside the page, and the dashboard shows "100 of 431" rather than
> "100". The cap stays — it truncates rather than throwing, unlike the spatial
> tree, because the ordering is severity-then-recency so the head of the list is
> the part worth acting on, and refusing would take the whole screen away to
> protect the tail. `count(*) OVER ()` supplies the total in the same query:
> window functions run after `WHERE` and before `LIMIT`, so it costs no second
> round trip and cannot disagree with the page it describes.
>
> One consequence to know: while truncated, an alert outside the page does not
> appear when one inside it resolves, until the next snapshot (five minutes).
> The count is right throughout, which is what the screen is read for.

Still not addressed: the alert list is capped at 100 by the route, and an alert
beyond that is invisible to this reconciliation as to everything else.

---

## 57. A flagged sample is counted in the rollup and kept out of its statistics

The quality gate stores a bad reading with a flag instead of dropping it: "the sensor reported −273 for six hours" is a diagnosis, and
discarding it turns a visible fault into an unexplained gap. The continuous
aggregates then counted those samples in `bad_quality_count` — **and also
averaged them.**

So a consumer was handed a contaminated mean with a count beside it that it
could not use to repair it, because you cannot subtract a sample from a mean
you were not given the sum of. Measured on the suite's own fixture, an hour of
one-minute readings around 22 °C with thirty minutes of a failed probe:

| | Unfiltered | `quality = 0` only |
|---|---|---|
| Hourly mean, 30 of 60 samples flagged | **−125.68 °C** | 21.64 °C |
| Hourly mean, 10 of 60 flagged | −26.82 °C | 22.42 °C |
| Six hours of a meter at 3 kWh/min, one flagged spike | **9,000,001,056 kWh** | 1,056 kWh |

The meter is the worse of the two. To a reset-aware counter an absurd value
followed by a sane one *is* a reset, so `counter_agg` — adopted in §10 precisely
so that a rollover would not corrupt consumption — faithfully reported nine
billion kilowatt-hours that nobody used.

This was the third place a flagged reading could act as a real one, and the one
the other two fall back on. The alert engine has refused them since §17; the
live map since §55; but the map's first paint is a mean from `telemetry_5m`.

**avg, min, max, last and `counter_agg` now carry `FILTER (WHERE quality = 0)`.**
A bucket with no good sample is NULL there, which is the truth and which every
reader already handled — the columns were always nullable, because a bucket can
be empty. `sample_count` still counts everything, so coverage is computable as
before, and nothing is hidden: the flagged rows remain in `telemetry`.

**The column names are kept.** A second set — `good_avg_value` beside
`avg_value` — would have left the wrong number in place under the obvious name,
for the next query to reach for.

**It costs a rebuild.** A continuous aggregate's query cannot be altered, so
migration 016 drops and recreates all three, and re-materialises from
`telemetry`. Rollup rows older than raw retention (two years) cannot be
reconstructed; no such deployment exists, and the migration says so in capitals
for the day one does. The rebuild was also the chance not to repeat two things
008 got wrong: it removes the refresh policies **before** dropping the views,
rather than racing the scheduler into `tuple concurrently deleted`; and it
backfills to an end in the past, which repairs §46's watermark for any database
still carrying 008's `NULL, NULL` refresh.

*Verified:* `FILTER` inside a continuous aggregate, including on `last()` and
the toolkit's `counter_agg`, was proven on a scratch view against this
TimescaleDB (2.30.1) before the migration was written. After it, no watermark
is ahead of `now()`, all three policies exist, and the application role holds
`SELECT` on the recreated barrier views and nothing else. A sensor that had
carried a `spike` fault earlier the same day — 51 flagged readings peaking at
247 °C — shows an hourly max of 24.76 °C. The db suite writes both fixtures
above and asserts the flagged samples are counted, excluded, and that a
5-minute bucket holding nothing else has no mean at all rather than a wrong one.

---

## 58. Liveness does not ask the database; metrics carry no tenant

The original plan listed three observability items and the delivery note for
that phase said the phase was complete. It was not: none of the three existed.
Recorded here because a plan marked done is exactly the kind of derived
document that drifts silently.

**`/healthz` was one endpoint doing two jobs.** It returns 503 when the write
path is not draining — registry empty, buffer at its cap, last flush failed.
That is the right answer to "should traffic come here?" and the wrong answer to
"should this process be restarted?". Pointed at by a liveness probe, a database
outage restarts ingest in a loop, and each restart discards the in-memory write
buffer whose entire purpose is to ride that outage out. So:

| | Asks | Consults the database |
|---|---|---|
| `GET /livez` | is the event loop turning? | **never** |
| `GET /readyz` | should traffic be sent here? | through the writer's last result |
| `GET /healthz` | the same as `/readyz`, with the full stats tree | the same |

`/healthz` keeps its behaviour; existing checks and the CI wait loop use it.
Docker has one probe where an orchestrator has two, so the image has to choose:
it uses `/readyz`, which is right for Compose (reports, does not restart) and
wrong anywhere unhealthy means restart. The Dockerfile says so.

**`/metrics` is a formatter, not instrumentation.** Every number was already
being counted — shed load has been surfaced since §12 — but only as JSON on a
health endpoint, which can say "it is dropping frames" and cannot say "since
when". It is a pure function of a snapshot, so its output is tested without
starting a pipeline. It refuses, at render time, the three mistakes a scraper
punishes by rejecting the WHOLE payload: a duplicate name, an invalid name, and
a counter not ending in `_total`. A duration that does not exist yet is `NaN`,
not `0`, and with the alert engine disabled its series are absent rather than
zero — "no alerts opened" and "nothing was looking" must not read the same.

**There are deliberately no per-tenant labels.** They would be the first thing
anyone asked for. The endpoint is served without a key, like `/healthz`, which
is only acceptable while it says nothing that belongs to a tenant; per-tenant
series would turn it into a list of who the customers are and how busy each one
is, and make the series count a function of the customer count. Per-tenant
figures belong behind authentication, from the database.

**Not done:** structured JSON logging with a correlation id from gateway to
database. The services still log lines of text. And neither the worker nor the
web service exposes metrics.

> **The logging half is now done** ([§61](#61-one-request-id-three-services-and-an-event-name-that-is-not-prose)).
> Metrics for the worker and the web service are not.

---

## 59. The fan turns down, runs for ventilation, and heats the air it moves

§50 took fan power from the asset register and closed by listing what it still
got wrong. Three of those are fixed here. They pull in different directions,
which is the interesting part: **the old total looked plausible because its
errors partly cancelled.** The same three-day Gulf June, one correction at a
time:

| | Fan kWh | HVAC kWh |
|---|---|---|
| As §50 left it: power linear in flow, fan on only with the coil, no fan heat | 3,147 | 11,150 |
| + variable-speed part-load curve | 1,830 | 9,832 |
| + runs whenever people are present, never below the VAV minimum | 2,783 | 10,785 |
| + fan heat lands on the coil | 2,908 | 11,920 |

The first row reproduces the previous release to the kilowatt-hour, which is
what says the decomposition is measuring the changes and nothing else.

**Power was linear in flow.** The register's 3.0 W per l/s is a *design-point*
figure — 15 kW at 18,000 m³/h. Multiplying it by a part-load airflow says a fan
moving half the air draws half the power. Shaft power goes near the cube of
flow; with a duct static-pressure setpoint a real system lands between square
and cube, about 30% at half flow. And §14 applies: the register lists 24 VAV
terminals on 4 AHUs, each with an airflow and a damper-position point.
Constant-volume fans contradicted the equipment list. **−42% fan energy.**

**The fan only ran while the coil did.** But the zone balance has charged for
ventilation air whenever people are present since the first version of the
engine, and something moves that air. A fan that is off during occupied hours
in the deadband, while outdoor air arrives anyway, is air moved for free. It now
runs for ventilation or a coil call, and never below 30% of design flow — a VAV
box does not close. **+52%.**

**Fan heat went nowhere.** The motor and wheel sit in the airstream, so every
watt drawn becomes heat in the supply air and the coil takes it out again. §50
guessed "a few percent"; it is **+10.5% on HVAC**, because at 3.0 W per l/s
against ~13 W per l/s of cooling carried, the system puts about a fifth on top
of its own load.

**§50 also warned that fan heat "introduces a feedback loop … that wants care
rather than a line."** The care taken: the fan's *minimum* draw is known before
the control decision — it depends only on whether anyone is present — so that
much goes into the zone balance like any other gain, and the coil or the heating
it offsets accounts for it with no special case. The part above the minimum
depends on the cooling the balance decides; iterating on that would make the
result depend on the integration step, which §22 exists to prevent. So it is
charged where it lands instead: on the coil while cooling, and as heating the
coil did not have to supply while heating. Nothing is solved in a circle, and
end uses still sum to the total.

**The curve is from the literature, and that is a disclosed break with §14.**
The register gives the design point and says nothing about turn-down, so the
curve is ASHRAE 90.1 Appendix G's part-load equation for a variable-speed fan
with static-pressure reset — what a baseline building must be modelled with. It
is an assumption about a fan nobody has measured. `HEAT_TO_AIRSTREAM_FRACTION`
is 1.0, a motor in the airstream, which is how a packaged AHU is built.

*Verified:* eight unit tests on the curve and turn-down with no database — full
flow is design power, half flow is 30% and not 50%, a running fan holds the VAV
minimum, a stopped one moves no air rather than its minimum. End to end, a mild
week against the Gulf June: the coil has far less to do, the people are the
same, and the fan's share of HVAC rises from 24% to 30%. Under the old rule that
share was identical in every climate, because fan energy was cooling energy
times a constant. Unmet hours stay at zero, so the extra load did not outrun the
auto-sized plant.

**Still not modelled:** duct leakage and thermal losses; the chiller→AHU→VAV
tree, so airflow is still per zone rather than per air handler — four AHUs each
see the *sum* of their zones, and a sum turns down less than its parts, so
per-zone turn-down overstates the saving; and no economiser, which in a mild
week is most of what a real plant would be doing.

---

## 60. The physics is verified against closed forms, which is not validation

Every previous test of this model asserted a **direction**. Cooling peaks in the
afternoon; a west zone peaks later than an east one; a better COP uses less
electricity. Those catch sign errors and very little else — and this project has
now twice shipped a model that pointed the right way and was wrong by a large
factor: `occupancy_heat_gain_w_person` treated as entirely sensible (§48,
overstating that gain ~70%), and the fan model whose three errors cancelled
(§59, ±40–50% each). **Both survived every directional check in the suite.**

The reason the tests were all directional is structural: the heat balance lived
inside `run()`'s hot loop, so reaching it meant a migrated database, a seeded
building, a spawned worker and a completed run. What that setup can observe is
a summary — and a summary is where a factor-of-two error hides best.

`integrate_substep` is now a module-level pure function: one substep for every
zone, no database, no schedule lookup, no weather generation, no run id.
`run()` calls it and nothing else does the arithmetic, so the tests and the
production path cannot diverge. The extraction was proven behaviour-preserving
before anything was asserted about it — the same three-day request, before and
after, agreeing to twelve decimal places on every end use.

**What is now checked against something independent of the code:**

| Case | Closed form |
|---|---|
| Free float, envelope only | `T(t) = T_out + (T₀−T_out)·e^(−t/τ)`, `τ = C/UA` |
| The same, discretely | `T_n = T_out + (T₀−T_out)(1 − UA·dt/C)ⁿ` — matched to 1e-12 |
| Convergence order | halving `dt` halves the error: explicit Euler's published first order |
| Time constant | 63.2% of the step covered after one `τ` |
| Steady state | a constant gain settles at exactly `Q/UA` above outdoors |
| Linearity | double the gain, double the rise |
| First law | `C·ΔT = (q_net + q_hvac)·dt`, exactly, floating **and** pinned **and** short of capacity |
| Ideal loads | a pinned zone is cooled by exactly its load — the equality that *is* §22 |
| Step independence | 6 h of pinned cooling = `load × hours`, identical at dt = 60, 300 and 900 s |
| Capacity shortfall | the zone ends above setpoint by exactly the unmet watts × dt / C |

**Why the convergence-order test earns its place.** An integrator converging at
the wrong order is integrating something else. It is the sharpest statement
available here that the discretisation is sound, and no amount of
"cooling peaks in the afternoon" implies it.

**This is verification, not validation, and the distinction is the point.** In
ASHRAE 140's terms there are three ways to test a building model: analytical
verification, comparative testing against another tool, and empirical validation
against a measured building. This is the **first and weakest** — the only one
that needs no other software and no instrumented building. It establishes that
where the physics is simple enough to solve with a pen, the engine gives the
pen's answer.

It does **not** establish that the model is right about a real building, and
nothing here licenses quoting an absolute kWh figure to a client. Every closed
form above is a single zone with terms switched off; none of them exercises
solar geometry, psychrometrics, the occupancy schedule or the fan curve
together, because those cases have no closed form — which is exactly why
comparative testing against EnergyPlus exists and why it is still the largest
open item in `docs/cto-assessment.md`.

The honest sentence is: *analytically verified, not calibrated.*

---

## 61. One request id, three services, and an event name that is not prose

§58 shipped `/metrics` and the probes and recorded what was still missing:
structured logging with a correlation id. This is that, and it is the last of
the three observability items the original plan named.

**What was wrong with `console.error('[alerts] failed to open', name, err)`.**
A person can read it. Nothing else can. The interesting values are interpolated
into a sentence, so there is no field to filter on and no way to count how often
something happened without a regex over free text. And the one that matters at
three in the morning: **no way to select the lines belonging to the request that
went wrong** out of every other request interleaved with it.

Two separate ideas fix that.

**An event name, and fields.** `event` is a stable identifier that never
contains a value — `alerts.open_failed` — and everything variable is a named
field. Aggregation keys on the event; the prose is for whoever reads one line.
The wording can change freely, the event never.

**A request id carried out of band.** `AsyncLocalStorage` in Node and a
`ContextVar` in Python keep it attached to the logical request across every
`await`, callback and background thread, so it does not have to be threaded
through the signature of every function that might log. Code deep in the
pipeline logs it without knowing it exists — and a simulation run keeps the id
of the click that started it for its whole life, including the parts that
finish long after the HTTP response.

**It spans the services, which is the whole point.** The browser's id (or one
minted at the edge) goes to the web proxy, which forwards it to the worker,
which forwards it to ingest on `/internal/sim-event`. One `grep` returns the
story of one click. Every service also returns it in `x-request-id`, because an
id nobody can see is an id nobody can quote in a bug report.

**A caller-supplied id is sanitised at every boundary.** Bounded to 64
characters and `[A-Za-z0-9._-]`, because an id is written into a log line and an
unchecked one is log forging — `\n{"level":"info"...}` would be a second record
that never happened, and an ANSI escape drives the terminal of whoever tails the
file. JSON output escapes newlines anyway, so the defence is belt and braces;
text output has no such guarantee. It is **replaced rather than rejected**: the
id is diagnostic, and failing a telemetry POST over a malformed header would be
a poor trade.

*Found while testing it:* neither `fetch` nor `httpx` will transmit a header
value containing a newline or a trailing space — they raise locally. So those
cases can only arrive from a raw socket, and the suites assert what a real
client can actually put on the wire while the unit tests cover the rest at the
function. A test that cannot send its hostile input is not testing anything.

**The record shape is identical across both languages** — `ts`, `level`,
`service`, `event`, then fields. Python's `WARNING` is mapped to `warn` and
`CRITICAL` to `error`, because a consumer filtering `level="warn"` that silently
misses one service is the kind of gap nobody notices until the night it matters.

**Access logging is ours, not uvicorn's.** The middleware records
`http.request` with method, path, status and duration, and uvicorn's own access
logger is silenced rather than left to print a second, unstructured copy of the
same event with no request id and no duration. Probe paths log at `debug` —
three a minute saying nothing when healthy.

**JSON is the default because the default is what production gets.** `text` is
for a human watching a dev server and is what `npm run dev:*` asks for. That is
an explicit choice by environment variable, not a `NODE_ENV` branch: this
project has been bitten by a build-time constant gating a runtime decision.

**Never log a secret.** No API keys, no session tokens, no ticket payloads, no
passwords. A key's *id* is fine and is what an audit trail wants; the key itself
must not reach a log file, where it outlives every rotation.

**Still not done:** the web service logs through Next.js's own output rather
than this, so the first hop of a trace is thinner than the other two; and
neither the worker nor the web service exposes `/metrics`.

---

## 62. The twin is allowed to act, and every part of that is a refusal

Everything before this reads the building. This is the first thing that writes
to it, and the difference is not one of degree: **a wrong number on a dashboard
is read by someone who can disbelieve it; a wrong setpoint is obeyed.**

So the design is mostly made of refusals, and the interesting decisions are
about *which* refusals and *where* they live.

### An override with an expiry, not an edit to the baseline

`thermal_profiles.setpoint_temp_c` is the building's designed setpoint and
nothing in the control path ever writes to it. A command is a temporary
override that lapses at `effective_until`, after which the zone is back on its
baseline **because nothing is overriding it any more** — no revert command, no
cleanup job, no service that has to still be alive.

That is the deadman, and it is the property the whole design rests on. The
failure worth building around is not a bad command; it is a good command
followed by a dead optimiser, holding every zone at 19 °C through a weekend
with nobody able to say why. An override that expires cannot do that. A row
that edited the profile could.

*Verified against the running stack:* an override applied at t+10 s, held for
its 20 s, and the zone was back to its designed 23.0 °C by t+35 s with nothing
having reverted it.

### Commands are pulled, never pushed

CLAUDE.md has said since the beginning that devices push over `POST /ingest`
and the WebSocket is subscribe-only. Control could have been the exception —
and the exception would have meant an inbound connection to a building.

A BMS gateway sits behind the building's firewall and accepts nothing inbound;
it already reaches out to post telemetry, so it reaches out for its work too.
`POST /control/dispatch/claim` hands it commands and it reports back. The
deliberate asymmetry survives: **everything still enters through a request the
building itself made**, and controlling a building needs no open port on the
building's side.

Claims take a lease with `FOR UPDATE SKIP LOCKED`, the same mechanism as the
notification outbox (§51). At-least-once is the honest limit, which is why the
commandable quantity is a **setpoint — a level, not an increment**. Applying
the same level twice is harmless; applying the same "+1 K" twice is not. That
is not an accident of the design, it is why the design commands levels.

### Three facts, from three sources, none of which can forge the others

| Fact | Source |
|---|---|
| this *service* may act for this tenant | the API key's `control:write` scope |
| the acting *user* is this one | the `x-acting-user` header the web service sets from its session |
| that user's *role* permits commanding | looked up in `tenant_members`, in the database |

A proxy asserting "this user is an operator" would be the simulation worker
trusting `X-Tenant-Id` all over again. And `control:dispatch` is a separate
scope from `ingest:write` on purpose: one physical gateway holds both, but **a
key that may post telemetry must not thereby be able to move a building's
setpoints.**

`viewer` cannot command. This is the first time a role in this project has
meant anything — until now every member of a tenant could do everything a
member could do — and it is the obvious place to start: a read-only role that
moves setpoints is not read-only.

The demo tenant cannot command either, and for a better reason than
configuration: it has no user behind it, `requested_by` is a foreign key to
`users`, and **a control action nobody is accountable for is not one anyone
should accept.**

### The envelope is a pure function, and it runs twice

`evaluate(request, context)` reads nothing and writes nothing, so all 32 of its
cases are exercised without a database, a gateway or a building. It runs once
when a person asks — so they are told no while they are still there to be told
— and **again when a gateway claims the command**, because the world moves in
between. A command validated four minutes ago against a healthy AHU must not
reach one that has since faulted. The second evaluation is the one that
matters; the first is the courtesy.

A command failing re-evaluation is *released*, not failed: the condition may
clear before it expires, and a transient fault should not consume an operator's
intent.

The checks are ordered authority → capability → interlocks → value → rate,
because the first failure is what the operator is shown and it should name the
real problem. Interlocks precede the value check so a dead sensor is reported
as a dead sensor, rather than the operator being told their number is fine and
meeting the interlock on the next attempt.

### The interlock that matters: you may not act on a reading you would not draw

§55 established that only a good, fresh reading may colour a zone. Control
applies **the same rule to acting**, and that is why the freshness predicate
moved into `@dtwin/types` where both import it. A map that greys a zone because
its sensor is dead, beside a control path that would happily command that zone
anyway, is a system disagreeing with itself about what it knows — and the half
that acts is the half that matters. A control loop closed over a dead sensor is
how a building gets frozen.

`degraded` equipment is deliberately still commandable: it is running and doing
its job less well, and refusing would withdraw supervisory control exactly when
the building needs help. `maintenance` blocks, because somebody is working on
it and a setpoint moving under a technician's hands is how people get hurt.

### Off by default, and the envelope is per tenant

`control_settings.enabled` defaults to **false**. Notifications are off by
default so a development database does not call someone's webhook; control is
off by default because an outward-*acting* capability must never switch itself
on merely because a service booted and a table existed. The kill switch is read
on every claim and never cached — one that needs a restart is not a kill
switch.

The limits are per tenant rather than global because "how far may the twin move
a setpoint" is a question about a building, and §14 says the register governs:
a server room and an open-plan floor do not share an envelope. And setting the
limits is an owner-or-admin authority while commanding within them is an
operator's — collapsing those would make the envelope advisory.

### What this is not

**There is no BMS.** Commands are applied by the device simulator, which is
this stack's simulated building, going through the same `claimForGateway` /
`reportResult` the HTTP routes call rather than a private path beside them. A
real gateway would poll those routes over the network and write to a real
point. The lifecycle is real, the audit trail is real, the envelope is real;
the equipment is not. It says so when it reports: *"applied by the in-process
device simulator."*

**It is not closed-loop optimisation.** Nothing yet decides *what* the setpoint
should be — a person does, and the twin's job here is to refuse the unsafe
ones, record the rest, and let them lapse. An optimiser writing to this surface
is the obvious next thing and is a different decision: it would need the
model-versus-meter comparison that §60 says is still missing, because an
optimiser that cannot tell whether its last move helped is not optimising.

*Found while building it:* my own dev testing left an applied override on a
zone, and the smoke suite then measured every step from 24.5 °C instead of the
designed 23 °C — four refusals that should have fired did not, and three
commands that should not have existed were accepted. The section now owns its
zone before commanding it, exactly as the telemetry checks own their window.
