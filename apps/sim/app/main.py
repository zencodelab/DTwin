"""FastAPI surface for the simulation worker.

Runs are asynchronous. A year at hourly resolution takes seconds rather than
milliseconds, and holding an HTTP connection open for it would make every
caller's timeout the worker's problem. `POST /simulate` returns 202 with a run
id; the caller polls, and `simulation_runs.progress_pct` carries progress.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import JSONResponse

from . import engine, notify, repository, weather
from .config import settings
from .db import close_pool, connection, connection_unscoped, tenant_scope
from .models import (
    EnergyBreakdown,
    SimulationRequest,
    SimulationRun,
    SimulationSummary,
    WeatherGenerateRequest,
    ZoneBreakdown,
)

logging.basicConfig(level=logging.INFO, format="[sim] %(message)s")
log = logging.getLogger("sim")


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    close_pool()


app = FastAPI(title="DTwin simulation worker", version="0.1.0", lifespan=lifespan)


def tenant_id(x_tenant_id: str | None = Header(default=None)) -> str:
    """The tenant this request acts for.

    The worker is internal: the web service is its only caller, and that is
    where a person is authenticated. So the tenant arrives as a header the
    proxy sets from the session, never from a request body a browser could
    compose — and never resolved from `buildingId`, which is caller-supplied
    and would make the building id the access-control decision.

    This trusts its caller, which is sound only while the worker is unreachable
    from outside. When that stops being true it should present a service API
    key like the one it already uses to reach `POST /internal/sim-event`.
    """
    if not x_tenant_id:
        raise HTTPException(status_code=401, detail="X-Tenant-Id header is required")
    return x_tenant_id


def _run_model(row: dict[str, Any]) -> SimulationRun:
    return SimulationRun(
        id=row["id"],
        buildingId=row["building_id"],
        scenarioName=row["scenario_name"],
        description=row["description"],
        periodStart=row["period_start"],
        periodEnd=row["period_end"],
        intervalS=row["interval_s"],
        params=row["params"] or {},
        status=row["status"],
        progressPct=row["progress_pct"],
        requestedAt=row["requested_at"],
        startedAt=row["started_at"],
        completedAt=row["completed_at"],
        error=row["error"],
    )


def _execute(run_id: UUID, request: SimulationRequest, tenant: str) -> None:
    """Background entry point. Any failure is recorded on the run, not swallowed.

    The tenant is passed in rather than inherited: this runs after the response
    has been sent, in its own context, so the scope the request bound is already
    gone by the time the physics starts.
    """
    with tenant_scope(tenant):
        try:
            repository.mark_running(run_id)
            engine.run(
                run_id, request,
                on_progress=lambda pct: notify.progress(run_id, request.buildingId, pct),
            )
            repository.mark_completed(run_id)
            log.info("run %s completed", run_id)

            summary = _build_summary(run_id)
            if summary is not None:
                notify.complete(run_id, request.buildingId, summary)
        # Catching broadly on purpose: the run row is the error channel. A
        # background task has no caller left to raise to, so an escaped
        # exception would strand the run at `running` forever with nothing
        # recorded — the exact state the reaper would later have to clean up.
        except Exception as exc:
            log.exception("run %s failed", run_id)
            message = f"{type(exc).__name__}: {exc}"
            repository.mark_failed(run_id, message)
            notify.failed(run_id, request.buildingId, message)


def _build_summary(run_id: UUID) -> SimulationSummary | None:
    """Assemble a run's summary. Shared by the HTTP route and the completion
    broadcast so both describe a finished run identically."""
    row = repository.get_run(run_id)
    if row is None:
        return None

    building, by_zone = repository.summarize(run_id)
    if building is None:
        return None

    return SimulationSummary(
        run=_run_model(row),
        building=EnergyBreakdown(**{k: _num(v) for k, v in building.items()}),
        byZone=[
            ZoneBreakdown(
                zoneId=z["zoneId"], zoneName=z["zoneName"],
                **{k: _num(v) for k, v in z.items() if k not in ("zoneId", "zoneName")},
            )
            for z in by_zone
        ],
    )


@app.get("/healthz")
def healthz() -> JSONResponse:
    try:
        # Unscoped on purpose: liveness is a fact about the process and its
        # database, not about any tenant, and a probe has no session to scope to.
        with connection_unscoped() as conn:
            conn.execute("SELECT 1").fetchone()
    # The suppression below is load-bearing, unlike at _execute: ruff treats a
    # logged exception as handled, and this one is reported to the prober
    # instead. Any failure to reach the database is a degraded answer here,
    # whatever kind of failure it was.
    except Exception as exc:  # noqa: BLE001
        # The worker is useless without the database: it reads the model from it
        # and writes every result back. Reporting healthy would be a lie.
        return JSONResponse(
            status_code=503, content={"status": "degraded", "error": str(exc)}
        )
    return JSONResponse({"status": "ok", "substepS": settings.substep_s})


@app.post("/simulate", status_code=202)
def simulate(
    request: SimulationRequest,
    background: BackgroundTasks,
    tenant: str = Depends(tenant_id),
) -> dict[str, Any]:
    with tenant_scope(tenant):
        # `buildingId` is still caller-supplied, but it no longer decides access:
        # the lookup runs inside this tenant's scope, so another tenant's
        # building is simply not there — a 404, not their data.
        building = repository.load_building(request.buildingId)
        if building is None:
            raise HTTPException(status_code=404, detail="unknown building")

        skipped = repository.count_zones_without_profile(request.buildingId)
        run_id = repository.create_run(request)
    background.add_task(_execute, run_id, request, tenant)

    return {
        "runId": str(run_id),
        "status": "queued",
        # Surfaced rather than hidden: a zone with no thermal profile is absent
        # from the results, and a caller comparing totals deserves to know why.
        "zonesWithoutProfile": skipped,
    }


@app.get("/runs/{run_id}")
def get_run(run_id: UUID, tenant: str = Depends(tenant_id)) -> SimulationRun:
    with tenant_scope(tenant):
        row = repository.get_run(run_id)
    if row is None:
        raise HTTPException(status_code=404, detail="unknown run")
    return _run_model(row)


@app.get("/runs/{run_id}/summary")
def get_summary(run_id: UUID, tenant: str = Depends(tenant_id)) -> SimulationSummary:
    with tenant_scope(tenant):
        row = repository.get_run(run_id)
        if row is None:
            raise HTTPException(status_code=404, detail="unknown run")
        if row["status"] != "completed":
            raise HTTPException(
                status_code=409,
                detail=f"run is {row['status']}, not completed",
            )

        summary = _build_summary(run_id)
    if summary is None:
        raise HTTPException(status_code=409, detail="run produced no results")
    return summary


@app.get("/runs/{run_id}/results")
def get_results(
    run_id: UUID,
    zone_id: UUID | None = Query(default=None, alias="zoneId"),
    limit: int = Query(default=500, le=10_000),
    tenant: str = Depends(tenant_id),
) -> dict[str, Any]:
    query = """
        SELECT zone_id AS "zoneId", interval_start AS "intervalStart",
               hvac_load_kwh AS "hvacLoadKwh", lighting_kwh AS "lightingKwh",
               plug_kwh AS "plugKwh", total_kwh AS "totalKwh", co2_kg AS "co2Kg",
               peak_demand_kw AS "peakDemandKw", indoor_temp_c AS "indoorTempC",
               solar_gain_kwh AS "solarGainKwh", internal_gain_kwh AS "internalGainKwh",
               envelope_loss_kwh AS "envelopeLossKwh",
               ventilation_loss_kwh AS "ventilationLossKwh",
               occupancy_count AS "occupancyCount", unmet_hours AS "unmetHours"
          FROM simulation_results WHERE run_id = %s
    """
    params: list[Any] = [run_id]
    if zone_id is not None:
        query += " AND zone_id = %s"
        params.append(zone_id)
    query += " ORDER BY interval_start, zone_id LIMIT %s"
    params.append(limit)

    with tenant_scope(tenant), connection() as conn:
        rows = conn.execute(query, params).fetchall()
    return {"results": rows}


@app.post("/weather/generate")
def generate_weather(
    request: WeatherGenerateRequest,
    tenant: str = Depends(tenant_id),
) -> dict[str, Any]:
    """Populate `weather_observations` with a synthetic clear-sky series.

    Exists so the `observed` weather mode has something to replay. Rows are
    marked `source='synthetic'` and upserted, so regenerating a period is safe
    and real measurements are never overwritten by a generated series.
    """
    with tenant_scope(tenant):
        building = repository.load_building(request.buildingId)
        if building is None:
            raise HTTPException(status_code=404, detail="unknown building")
        if building.get("latitude") is None:
            raise HTTPException(status_code=422, detail="building has no location")

        rows = weather.generate_rows(
            building, request.periodStart, request.periodEnd, request.intervalS,
            request.minDryBulbC, request.peakDryBulbC, request.peakGhiW_m2,
        )
        written = repository.store_weather(request.buildingId, rows)
    return {"written": written}


def _num(value: Any) -> float | None:
    return None if value is None else float(value)
