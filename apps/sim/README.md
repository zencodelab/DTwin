# @dtwin/sim

Energy and thermal simulation worker. Python, FastAPI, numpy — the only Python
in the system, and it owns exactly one thing: the physics.

## Run

```bash
cd apps/sim
uv venv --python 3.12 && uv pip install -r requirements.txt
DATABASE_URL=postgres://dtwin:dtwin_dev_pwd@localhost:5432/dtwin \
  .venv/bin/uvicorn app.main:app --port 8000
python -m app.smoke_test          # end-to-end check against a running worker
```

## The model

A lumped-capacitance heat balance per zone, stepped forward in time:

```
C dT/dt = Q_solar + Q_internal + Q_envelope + Q_infiltration + Q_ventilation + Q_hvac
```

Each zone is one thermal node with a heat capacity. HVAC is a controller acting
on that node, bounded by installed capacity — which is what makes *unmet hours*
a real output rather than an assumption.

**Why dynamic and not a steady-state load sum.** Thermal mass is the reason a
building does not track outdoor temperature, and the reason cooling demand lags
the solar peak by hours. A steady-state calculation cannot produce overnight
free-float, a morning pull-down, or unmet hours — which are the outputs a
facility manager acts on. `thermal_mass_kj_per_k` is in the schema for this.

**Solar gain gets real geometry.** In a Gulf climate, gain through glazing
dominates cooling load, so it is computed from actual sun position (Duffie &
Beckman) with beam, sky-diffuse and ground-reflected components resolved
separately — not as a fraction of GHI. Where a weather record has GHI but no
DNI, the Erbs correlation splits it, because beam and diffuse strike a vertical
facade completely differently.

**Plant is auto-sized** from each zone's design load rather than a flat W/m².
A flat rule would cripple the server room, whose equipment density is an order
of magnitude above an office, and report unmet hours that describe the rule of
thumb instead of the building.

### Assumptions worth knowing

- **Zone facade orientation is not in the schema**, so surface irradiance is
  averaged over the four cardinal aspects. Correct for a zone with facades all
  round, wrong for a single-aspect perimeter zone. Recording orientation per
  zone is the fix, and it belongs in the model.
- **Zones do not exchange heat with each other.** Each is coupled only to
  outdoors, so a core zone with no exterior wall has no envelope path at all.
- **Latent load is not modelled** — sensible heat only. In a humid coastal
  climate this understates real HVAC energy; dehumidification is a substantial
  share of it.
- **Heating and cooling share one COP.** Reasonable for a heat pump, and heating
  is nearly irrelevant at this latitude.

## API

| Route | Purpose |
|---|---|
| `GET /healthz` | Returns **503** if the database is unreachable — the worker reads the model from it and writes every result back. |
| `POST /simulate` | Returns **202** with a `runId`; the run executes in the background. Also reports `zonesWithoutProfile`, which are excluded from results. |
| `GET /runs/{id}` | Status and `progressPct`. |
| `GET /runs/{id}/summary` | Whole-building and per-zone energy breakdown. **409** unless the run completed. |
| `GET /runs/{id}/results` | Per-interval rows, optionally `?zoneId=`. |
| `POST /weather/generate` | Writes a synthetic clear-sky series into `weather_observations` so the `observed` mode has something to replay. Upserts, tagged `source='synthetic'`. |

## Contract

`app/models.py` mirrors `packages/types/src/simulation.ts` field for field, in
camelCase. That duplication is the cost of the two-language split, paid
deliberately in one file; the smoke test round-trips a request built from the
TypeScript shapes to catch drift.
