# @dtwin/web

The facility-manager dashboard: a 3D building view with live overlays, zone
drill-down, alerts and energy scenarios. Next.js App Router, Tailwind,
react-three-fiber.

## Run

```bash
npm run dev:web                 # :3000 — needs the database; ingest and sim for live data
npm run smoke -w @dtwin/web     # drives the running server over HTTP
```

## The 3D view renders the database

Zone volumes are **extruded at runtime from the PostGIS polygons the schema
holds** — there is no GLB in the render path. A model file would be a second
source of truth and the first thing to go stale after a fit-out. Because the
geometry is already in a local metre CRS, the stored coordinates are usable as
three.js world coordinates directly; a single scene rotation (−90° about X)
reconciles +Z-up with three.js's Y-up, and nothing else is transformed by hand.

`gltf_node_id` stays on every row for the day a real BIM export is loaded
alongside this, reconciled by node id.

## Overlays

| Overlay | Scale | Why |
|---|---|---|
| Temperature vs setpoint | **Diverging**, neutral midpoint | Deviation is *polarity*. Absolute temperature answers a question nobody asks — 21 °C is a fault in a lobby and correct in a server room. |
| Occupancy | **Sequential**, one hue | Magnitude. |
| CO₂ | **Sequential**, one hue | Magnitude. |

Each zone's own **deadband is subtracted before scaling**: inside it the zone is
on target, so it renders neutral. Without that, every zone reads as alarming for
being 0.9 K off setpoint — that is, for being correctly controlled.

Every zone carries a visible name and value label, and the legend is always
present. Colour never carries the number alone.

## Live data

The view subscribes to the **floor in frame**, not the building — ingest fans out
per topic, and a building-wide subscription ships all 190 points to a view
showing 45. Historical means paint the first frame so the building is never
briefly grey; live values replace them as they arrive.

## Panels

- **Zone** — thermal condition against setpoint and deadband, live sensors with
  a 6-hour sparkline, every asset serving the zone, and the maintenance log for
  all of them (an AHU's service history is part of diagnosing the zone it
  conditions).
- **Alerts** — open alerts with severity as icon + label + colour, click to fly
  to the zone. Read straight from the database so the list survives an ingest
  restart.
- **Scenarios** — runs the Python worker and compares end-use breakdown against
  the baseline over the same period, so the delta is attributable to the change.

## Notes

- The canvas is **client-only**. There is no WebGL context on a server; this also
  code-splits Three.js out of the initial bundle (248 kB → 24.8 kB first load).
- The page is `force-dynamic`: it is a view onto live state, and `next build`
  does not need a database.
- **React 19, R3F v9, drei v10 must stay aligned**, with react pinned to the line
  R3F supports (`>=19 <19.3`). See the dependency note at the end of
  [docs/decisions.md](../../docs/decisions.md).
- Run `next build` and `next dev` against the same `.next` and the dev server
  serves 500s for chunks. Clear it between modes.
