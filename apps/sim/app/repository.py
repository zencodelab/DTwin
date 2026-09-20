"""Database reads and writes for the simulation worker.

Hand-written SQL for the same reason the TypeScript side uses it: the shapes
here are joins and batch inserts, not entity graphs, and an ORM would add a
layer without removing one.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any
from uuid import UUID

from psycopg import sql
from psycopg.types.json import Jsonb

from .db import connection, connection_unscoped, current_tenant, tenant_scope

ZONE_SQL = """
  SELECT z.id, z.name,
         COALESCE(z.area_m2, 100)               AS area_m2,
         COALESCE(z.volume_m3, COALESCE(z.area_m2, 100) * 3.0) AS volume_m3,
         COALESCE(z.design_occupancy, 0)        AS design_occupancy,
         COALESCE(z.exterior_wall_area_m2, 0)   AS exterior_wall_area_m2,
         z.occupancy_schedule_id,
         tp.u_value_wall_w_m2k, tp.u_value_window_w_m2k,
         tp.window_to_wall_ratio, tp.shgc, tp.infiltration_ach,
         tp.thermal_mass_kj_per_k,
         tp.lighting_power_density_w_m2, tp.equipment_power_density_w_m2,
         tp.occupancy_heat_gain_w_person,
         tp.setpoint_temp_c, tp.deadband_k,
         tp.ventilation_l_s_person, tp.hvac_cop
    FROM zones z
    JOIN floors f           ON f.id = z.floor_id
    JOIN thermal_profiles tp ON tp.id = z.thermal_profile_id
   WHERE f.building_id = %s
"""


def load_building(building_id: UUID) -> dict[str, Any] | None:
    with connection() as conn:
        row = conn.execute(
            """
            SELECT id, name, timezone,
                   ST_Y(location::geometry) AS latitude,
                   ST_X(location::geometry) AS longitude,
                   grid_carbon_kg_per_kwh
              FROM buildings WHERE id = %s
            """,
            (building_id,),
        ).fetchone()
    return row


def load_zones(building_id: UUID, zone_ids: list[UUID] | None) -> list[dict[str, Any]]:
    """Zones with their thermal profile joined.

    The join is inner on `thermal_profiles`: a zone with no profile has no
    physics to run. Silently substituting defaults would emit numbers that look
    like results but describe a building nobody specified.
    """
    query = ZONE_SQL
    params: list[Any] = [building_id]
    if zone_ids:
        query += " AND z.id = ANY(%s)"
        params.append(list(zone_ids))
    query += " ORDER BY z.name"

    with connection() as conn:
        return conn.execute(query, params).fetchall()


def count_zones_without_profile(building_id: UUID) -> int:
    with connection() as conn:
        row = conn.execute(
            """
            SELECT count(*) AS n FROM zones z
              JOIN floors f ON f.id = z.floor_id
             WHERE f.building_id = %s AND z.thermal_profile_id IS NULL
            """,
            (building_id,),
        ).fetchone()
    return int(row["n"]) if row else 0


def load_schedules() -> dict[UUID, dict[str, list[float]]]:
    with connection() as conn:
        rows = conn.execute(
            "SELECT schedule_id, day_type, hourly_fractions FROM occupancy_schedule_days"
        ).fetchall()

    out: dict[UUID, dict[str, list[float]]] = {}
    for r in rows:
        out.setdefault(r["schedule_id"], {})[r["day_type"]] = list(r["hourly_fractions"])
    return out


def load_weather(building_id: UUID, start: datetime, end: datetime) -> list[dict[str, Any]]:
    with connection() as conn:
        return conn.execute(
            """
            SELECT time, dry_bulb_c, ghi_w_m2, dni_w_m2, rh_pct, wind_m_s
              FROM weather_observations
             WHERE building_id = %s AND time >= %s AND time <= %s
             ORDER BY time
            """,
            (building_id, start, end),
        ).fetchall()


def store_weather(building_id: UUID, rows: list[tuple[Any, ...]]) -> int:
    """Upsert generated weather. Idempotent so regenerating a period is safe."""
    if not rows:
        return 0
    tenant = current_tenant()
    with connection() as conn, conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO weather_observations
                   (tenant_id, time, building_id, dry_bulb_c, rh_pct, ghi_w_m2, dni_w_m2,
                    wind_m_s, source)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'synthetic')
            ON CONFLICT (building_id, time, source) DO UPDATE
               SET dry_bulb_c = EXCLUDED.dry_bulb_c,
                   ghi_w_m2   = EXCLUDED.ghi_w_m2,
                   dni_w_m2   = EXCLUDED.dni_w_m2
            """,
            # tenant_id is prepended here rather than built into the caller's
            # rows: the weather generator produces physical values and has no
            # business knowing who it is generating them for.
            [(tenant, *row) for row in rows],
        )
        conn.commit()
    return len(rows)


def create_run(req: Any) -> UUID:
    with connection() as conn:
        row = conn.execute(
            """
            INSERT INTO simulation_runs
                   (tenant_id, building_id, scenario_name, description,
                    period_start, period_end, interval_s, params, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'queued')
            RETURNING id
            """,
            (
                current_tenant(),
                req.buildingId, req.scenarioName, req.description,
                req.periodStart, req.periodEnd, req.intervalS,
                Jsonb(json.loads(req.params.model_dump_json(exclude_none=True))),
            ),
        ).fetchone()
        conn.commit()
    return row["id"]


def mark_running(run_id: UUID) -> None:
    with connection() as conn:
        conn.execute(
            "UPDATE simulation_runs SET status='running', started_at=now() WHERE id=%s",
            (run_id,),
        )
        conn.commit()


def set_progress(run_id: UUID, pct: float) -> None:
    with connection() as conn:
        conn.execute(
            "UPDATE simulation_runs SET progress_pct=%s WHERE id=%s",
            (min(100.0, max(0.0, pct)), run_id),
        )
        conn.commit()


def mark_completed(run_id: UUID) -> None:
    with connection() as conn:
        conn.execute(
            """UPDATE simulation_runs
                  SET status='completed', progress_pct=100, completed_at=now()
                WHERE id=%s""",
            (run_id,),
        )
        conn.commit()


def mark_cancelled(run_id: UUID) -> bool:
    """Cancel a run that has not finished. Returns False if it already had.

    The status is part of the WHERE clause rather than checked first, so a run
    that completes between the check and the update is not overwritten with
    `cancelled` — the same reason switchTenant puts its membership test in the
    UPDATE.
    """
    with connection() as conn:
        cur = conn.execute(
            """UPDATE simulation_runs
                  SET status='cancelled', completed_at=now()
                WHERE id=%s AND status IN ('queued', 'running')""",
            (run_id,),
        )
        conn.commit()
        return cur.rowcount > 0


def reap_orphaned_runs() -> int:
    """Fail runs a previous process left mid-flight.

    Runs execute in a FastAPI BackgroundTask, which dies with the process. A
    restart therefore leaves rows at `queued` or `running` that nothing will
    ever advance, and a caller polling one cannot tell it apart from a run that
    is merely slow. This closes them with an error that says what happened.

    Iterates tenants rather than running unscoped: `simulation_runs` is under
    row-level security, so an unscoped connection would see — and update —
    nothing at all. `tenants` itself carries no policy, which is what makes the
    list readable before a tenant is chosen.
    """
    reaped = 0
    with connection_unscoped() as conn:
        tenants = [
            r["id"]
            for r in conn.execute(
                "SELECT id FROM tenants WHERE status = 'active'"
            ).fetchall()
        ]

    for tenant in tenants:
        with tenant_scope(str(tenant)), connection() as conn:
            cur = conn.execute(
                """UPDATE simulation_runs
                      SET status='failed', completed_at=now(),
                          error='worker restarted while this run was in flight'
                    WHERE status IN ('queued', 'running')""",
            )
            conn.commit()
            reaped += cur.rowcount
    return reaped


def mark_failed(run_id: UUID, error: str) -> None:
    with connection() as conn:
        conn.execute(
            """UPDATE simulation_runs
                  SET status='failed', error=%s, completed_at=now()
                WHERE id=%s""",
            (error[:2000], run_id),
        )
        conn.commit()


RESULT_COLUMNS = (
    "run_id", "zone_id", "interval_start",
    "hvac_load_kwh", "lighting_kwh", "plug_kwh", "total_kwh", "co2_kg",
    "peak_demand_kw", "indoor_temp_c",
    "solar_gain_kwh", "internal_gain_kwh", "envelope_loss_kwh",
    "ventilation_loss_kwh", "occupancy_count", "unmet_hours",
    "latent_load_kwh",
)


# Rows per INSERT. PostgreSQL caps a statement at 65535 parameters; at 17
# columns this is ~15k, comfortably inside it while keeping round trips rare.
RESULT_CHUNK_ROWS = 1000


def write_results(rows: list[tuple[Any, ...]]) -> int:
    """Batch-insert results.

    This used COPY, which is the right tool for ~210k rows — a year at hourly
    resolution over 24 zones — and streams them in one pass instead of a round
    trip per row.

    **COPY is not available here any more.** PostgreSQL refuses `COPY FROM` on a
    table with row-level security outright:

        FeatureNotSupported: COPY FROM not supported with row-level security
        HINT: Use INSERT statements instead.

    So the bulk path is chunked multi-row INSERT: one statement per
    RESULT_CHUNK_ROWS rows rather than one per row, which keeps the round trips
    proportional to batches instead of rows. It is measurably slower than COPY
    and that is a real cost of the isolation, not a free swap. The alternative —
    connecting as a role that bypasses RLS — would buy the throughput back by
    giving up the guarantee the policies exist to provide.
    """
    if not rows:
        return 0
    tenant = current_tenant()

    # tenant_id leads the column list and is prepended per row here, so the
    # engine keeps emitting pure result tuples. It is written explicitly rather
    # than left to a default because the policy checks it on INSERT.
    columns = ("tenant_id", *RESULT_COLUMNS)
    row_placeholder = sql.SQL("({})").format(
        sql.SQL(", ").join([sql.Placeholder()] * len(columns))
    )
    column_list = sql.SQL(", ").join(sql.Identifier(c) for c in columns)

    with connection() as conn, conn.cursor() as cur:
        for offset in range(0, len(rows), RESULT_CHUNK_ROWS):
            chunk = rows[offset : offset + RESULT_CHUNK_ROWS]
            statement = sql.SQL("INSERT INTO simulation_results ({}) VALUES {}").format(
                column_list,
                sql.SQL(", ").join([row_placeholder] * len(chunk)),
            )
            flat: list[Any] = []
            for row in chunk:
                flat.append(tenant)
                flat.extend(row)
            cur.execute(statement, flat)
        conn.commit()
    return len(rows)


def get_run(run_id: UUID) -> dict[str, Any] | None:
    with connection() as conn:
        return conn.execute(
            """
            SELECT id, building_id, scenario_name, description,
                   period_start, period_end, interval_s, params,
                   status, progress_pct, requested_at, started_at, completed_at, error
              FROM simulation_runs WHERE id = %s
            """,
            (run_id,),
        ).fetchone()


def summarize(run_id: UUID) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """Whole-run rollup plus a per-zone breakdown.

    Peak demand is the maximum of the per-interval means, not a sum of per-zone
    peaks: zones do not peak simultaneously, so adding their individual maxima
    would overstate the building's demand charge.
    """
    with connection() as conn:
        building = conn.execute(
            """
            WITH per_interval AS (
              SELECT interval_start, sum(total_kwh) AS kwh
                FROM simulation_results WHERE run_id = %s
               GROUP BY interval_start
            )
            SELECT sum(r.hvac_load_kwh) AS "hvacKwh",
                   sum(r.latent_load_kwh) AS "latentKwh",
                   sum(r.lighting_kwh)  AS "lightingKwh",
                   sum(r.plug_kwh)      AS "plugKwh",
                   sum(r.total_kwh)     AS "totalKwh",
                   sum(r.co2_kg)        AS "co2Kg",
                   sum(r.unmet_hours)   AS "unmetHours",
                   (SELECT max(kwh) FROM per_interval)
                     / (sr.interval_s / 3600.0)          AS "peakDemandKw",
                   sum(r.total_kwh) / NULLIF(
                     (SELECT sum(COALESCE(z.area_m2, 0))
                        FROM zones z
                       WHERE z.id IN (SELECT DISTINCT zone_id
                                        FROM simulation_results WHERE run_id = %s)), 0
                   ) AS "euiKwhPerM2"
              FROM simulation_results r
              JOIN simulation_runs sr ON sr.id = r.run_id
             WHERE r.run_id = %s
             GROUP BY sr.interval_s
            """,
            (run_id, run_id, run_id),
        ).fetchone()

        by_zone = conn.execute(
            """
            SELECT r.zone_id AS "zoneId", z.name AS "zoneName",
                   sum(r.hvac_load_kwh) AS "hvacKwh",
                   sum(r.latent_load_kwh) AS "latentKwh",
                   sum(r.lighting_kwh)  AS "lightingKwh",
                   sum(r.plug_kwh)      AS "plugKwh",
                   sum(r.total_kwh)     AS "totalKwh",
                   sum(r.co2_kg)        AS "co2Kg",
                   sum(r.unmet_hours)   AS "unmetHours",
                   max(r.peak_demand_kw) AS "peakDemandKw",
                   sum(r.total_kwh) / NULLIF(z.area_m2, 0) AS "euiKwhPerM2"
              FROM simulation_results r
              JOIN zones z ON z.id = r.zone_id
             WHERE r.run_id = %s
             GROUP BY r.zone_id, z.name, z.area_m2
             ORDER BY sum(r.total_kwh) DESC
            """,
            (run_id,),
        ).fetchall()

    return building, by_zone
