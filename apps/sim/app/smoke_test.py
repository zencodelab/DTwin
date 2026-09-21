"""End-to-end smoke test for the simulation worker.

Spawns the real uvicorn process and drives it over HTTP. Beyond the plumbing,
this checks that the physics points the right way — a model that runs cleanly
and gets the direction of a change wrong is worse than one that crashes.

Requires a migrated, seeded database.  Run:  python -m app.smoke_test
"""

from __future__ import annotations

import hashlib
import os
import re
import secrets
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

import httpx

PORT = 8912
BASE = f"http://127.0.0.1:{PORT}"
TZ = timezone(timedelta(hours=4))  # Asia/Dubai, no DST

failures = 0


def ok(label: str, cond: bool, detail: str = "") -> None:
    global failures
    if not cond:
        failures += 1
    print(f"  {'PASS' if cond else 'FAIL'}  {label}{f' — {detail}' if detail else ''}")


def wait_healthy(client: httpx.Client, timeout_s: float = 45.0) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            if client.get(f"{BASE}/healthz", timeout=2.0).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.3)
    raise RuntimeError("worker did not become healthy")


def run_until_done(client: httpx.Client, run_id: str, timeout_s: float = 120.0) -> dict[str, Any]:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        run = client.get(f"{BASE}/runs/{run_id}").json()
        if run["status"] in ("completed", "failed", "cancelled"):
            return run
        time.sleep(0.3)
    raise RuntimeError(f"run {run_id} did not finish")


def simulate(client: httpx.Client, **overrides: Any) -> dict[str, Any]:
    """Launch a run and return its summary, failing loudly if it did not finish."""
    body: dict[str, Any] = {
        "buildingId": BUILDING_ID,
        "scenarioName": overrides.pop("scenarioName", "smoke"),
        "periodStart": PERIOD_START,
        "periodEnd": PERIOD_END,
        "intervalS": 3600,
        "weather": {
            "mode": "synthetic",
            "peakDryBulbC": 42.0,
            "minDryBulbC": 30.0,
            "peakGhiW_m2": 950.0,
        },
    }
    body.update(overrides)

    started = client.post(f"{BASE}/simulate", json=body)
    assert started.status_code == 202, started.text
    run_id = started.json()["runId"]
    run = run_until_done(client, run_id)
    assert run["status"] == "completed", run.get("error")
    return client.get(f"{BASE}/runs/{run_id}/summary").json() | {"runId": run_id}


# Three days around the summer solstice: deterministic sun, peak cooling season.
PERIOD_START = datetime(2026, 6, 20, 0, 0, tzinfo=TZ).isoformat()
PERIOD_END = datetime(2026, 6, 23, 0, 0, tzinfo=TZ).isoformat()
BUILDING_ID = ""

server: subprocess.Popen[bytes] | None = None
try:
    import psycopg

    dsn = os.environ.get(
        "DATABASE_URL", "postgres://dtwin:dtwin_dev_pwd@localhost:5432/dtwin"
    )
    # The worker is tenant-scoped now, so this suite must be too. An unscoped
    # read here returns no rows under row-level security and the suite would
    # report "no building" against a database that is seeded correctly.
    TENANT_ID = os.environ.get("DTWIN_DEMO_TENANT_ID", "")
    if not TENANT_ID:
        raise SystemExit(
            "DTWIN_DEMO_TENANT_ID must be set — it is the tenant this suite "
            "simulates for. See .env.example."
        )

    with psycopg.connect(dsn) as conn:
        conn.execute("SELECT set_config('app.tenant_id', %s, false)", (TENANT_ID,))
        row = conn.execute("SELECT id FROM buildings ORDER BY name LIMIT 1").fetchone()
        if row is None:
            raise SystemExit(f"no building visible for tenant {TENANT_ID}")
        BUILDING_ID = str(row[0])

        # Mint this suite's own keys, the way the ingest suite does. Inserted
        # directly because createApiKey lives in TypeScript; the hash is the
        # same unsalted SHA-256 the worker verifies against.
        tenant_row = conn.execute(
            "SELECT id FROM tenants WHERE id = %s", (TENANT_ID,)
        ).fetchone()
        if tenant_row is None:
            raise SystemExit(f"tenant {TENANT_ID} not found")

        def _mint(scopes: list[str], name: str) -> str:
            raw = secrets.token_urlsafe(32)
            conn.execute(
                """INSERT INTO api_keys
                        (tenant_id, kind, name, key_prefix, key_hash, scopes)
                   VALUES (%s, 'service', %s, %s, %s, %s)""",
                (TENANT_ID, f"{name}-{int(time.time())}", raw[:8],
                 hashlib.sha256(raw.encode()).hexdigest(), scopes),
            )
            return raw

        SMOKE_API_KEY = _mint(["sim:run"], "smoke-sim-run")
        WRONG_SCOPE_KEY = _mint(["ingest:write"], "smoke-wrong-scope")
        conn.commit()

    server = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(PORT), "--log-level", "warning"],
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        env={
            **os.environ,
            "DATABASE_URL": dsn,
            # Deliberately a dead port. Broadcasting progress is best-effort:
            # a run that produced correct results has succeeded whether or not
            # anyone was listening, and the run row plus simulation_results are
            # the durable record. If notification were on the critical path, an
            # ingest outage would take the simulator down with it.
            "INGEST_BASE_URL": "http://127.0.0.1:9",
            "INGEST_NOTIFY_TIMEOUT_S": "0.3",
        },
    )

    # Every request carries the tenant AND a key, exactly as the web service
    # sends them: the key says this caller may name a tenant, the header says
    # which one.
    with httpx.Client(
        timeout=30.0,
        headers={"x-tenant-id": TENANT_ID, "authorization": f"Bearer {SMOKE_API_KEY}"},
    ) as client:
        wait_healthy(client)

        # The credential half, before anything that depends on it. A worker
        # that accepted these would be trusting X-Tenant-Id on its own, which
        # is the gap this key closes.
        ok("a request with no API key is refused",
           httpx.post(f"{BASE}/simulate", json={}, timeout=10.0,
                      headers={"x-tenant-id": TENANT_ID}).status_code == 401)
        ok("a key without the sim:run scope is refused",
           httpx.post(f"{BASE}/simulate", json={}, timeout=10.0,
                      headers={"x-tenant-id": TENANT_ID,
                               "authorization": f"Bearer {WRONG_SCOPE_KEY}"}
                      ).status_code == 401)
        ok("healthz stays open, since a probe has no key",
           httpx.get(f"{BASE}/healthz", timeout=10.0).status_code == 200)

        # ------------------------------------------------------------ plumbing
        print("\n[1] Service and validation")
        ok("healthz reports ok", client.get(f"{BASE}/healthz").json()["status"] == "ok")

        # The middle hop of the trace. The web proxy sends the browser's id
        # here, and this worker sends it on to ingest, so one id covers a click
        # end to end (decisions.md §61).
        traced = client.get(f"{BASE}/healthz", headers={"x-request-id": "trace-abc_1.2"})
        # Spaces and length, not a newline or a trailing space: httpx refuses
        # to transmit either, so those can only arrive from a raw socket. The
        # unit tests cover them at the function; this covers what a real client
        # can actually put on the wire.
        forged = client.get(
            f"{BASE}/healthz", headers={"x-request-id": ("not an id " * 12).strip()})
        ok("a usable request id is echoed and a hostile one is replaced",
           traced.headers.get("x-request-id") == "trace-abc_1.2"
           and re.fullmatch(r"[A-Za-z0-9._-]{1,64}",
                            forged.headers.get("x-request-id") or ""),
           f"echoed={traced.headers.get('x-request-id')}")
        ok(
            "unknown building is a 404",
            client.post(f"{BASE}/simulate", json={
                "buildingId": "00000000-0000-0000-0000-000000000000",
                "scenarioName": "x", "periodStart": PERIOD_START, "periodEnd": PERIOD_END,
            }).status_code == 404,
        )
        ok(
            "reversed period is rejected",
            client.post(f"{BASE}/simulate", json={
                "buildingId": BUILDING_ID, "scenarioName": "x",
                "periodStart": PERIOD_END, "periodEnd": PERIOD_START,
            }).status_code == 422,
        )
        ok(
            "summary of an unknown run is a 404",
            client.get(f"{BASE}/runs/00000000-0000-0000-0000-000000000000/summary")
            .status_code == 404,
        )

        # ------------------------------------------------------------- baseline
        print("\n[2] Baseline run")
        base = simulate(client, scenarioName="baseline")
        b = base["building"]
        ok("run completed", base["run"]["status"] == "completed")
        ok("progress reached 100", base["run"]["progressPct"] == 100)
        ok("every zone produced results", len(base["byZone"]) == 24, str(len(base["byZone"])))

        total = b["hvacKwh"] + b["lightingKwh"] + b["plugKwh"]
        ok("end uses sum to the total", abs(total - b["totalKwh"]) < 1e-6,
           f"{total:.2f} vs {b['totalKwh']:.2f}")
        ok("carbon follows the grid factor",
           abs(b["co2Kg"] - b["totalKwh"] * 0.42) < 1e-3,
           f"{b['co2Kg']:.1f} kg for {b['totalKwh']:.1f} kWh")
        # One 200 m2 server room at 450 W/m2 is ~90 kW continuous, which is
        # most of the building's plug load. Checking a normal office zone is
        # the meaningful test of "cooling dominates"; the whole-building
        # comparison is made separately below, and latent load changed its
        # answer.
        office_zone = next(z for z in base["byZone"] if z["zoneName"].startswith("OFF"))
        ok("cooling dominates an office zone's energy",
           office_zone["hvacKwh"] > office_zone["lightingKwh"]
           and office_zone["hvacKwh"] > office_zone["plugKwh"],
           f"hvac={office_zone['hvacKwh']:.0f} light={office_zone['lightingKwh']:.0f} "
           f"plug={office_zone['plugKwh']:.0f}")
        # The server room still dominates plug load — a 90 kW data hall against
        # 23 offices — so plug remains the largest NON-HVAC end use.
        server_zone = next(z for z in base["byZone"] if z["zoneName"].startswith("SER"))
        ok("the server room dominates whole-building plug load",
           server_zone["plugKwh"] > 0.5 * b["plugKwh"]
           and b["plugKwh"] > b["lightingKwh"],
           f"server={server_zone['plugKwh']:.0f} of {b['plugKwh']:.0f} kWh plug, "
           f"vs {b['lightingKwh']:.0f} lighting")

        # This comparison used to be `plugKwh > hvacKwh`, and it was true while
        # the model was sensible-only. Adding the latent load moved building
        # HVAC from about 5,000 kWh to about 8,000 and reversed it — which is
        # the point of §48 stated as a number: in a Gulf June, drying the
        # ventilation air costs more than the data hall's plugs.
        ok("cooling now outweighs plug load, as latent load implies",
           b["hvacKwh"] > b["plugKwh"],
           f"hvac={b['hvacKwh']:.0f} > plug={b['plugKwh']:.0f} kWh")
        # Fan power comes from the asset register, not a literature value
        # (§14, §50): 4 AHUs rated 15 kW at 18,000 m3/h is 3.0 W per l/s.
        #
        # The resulting share is high — around a quarter of HVAC — and that is
        # a fact about the seeded register rather than about the model. 3.0 W
        # per l/s is roughly double what ASHRAE 90.1 allows a new VAV system,
        # so this building's fans are modelled as the inefficient ones the
        # register says they are. §14 is explicit that the simulator agrees
        # with the register rather than the other way round.
        ok("fan energy is reported and is a plausible share of HVAC",
           b["fanKwh"] is not None
           and 0.10 < b["fanKwh"] / b["hvacKwh"] < 0.40
           and b["fanKwh"] < b["hvacKwh"],
           f"fan={b['fanKwh']:.0f} of hvac={b['hvacKwh']:.0f} kWh "
           f"({100 * b['fanKwh'] / b['hvacKwh']:.0f}%, at 3.0 W per l/s)")

        # The fan moves the ventilation air the balance has always charged for,
        # so it runs when people are present whether or not the coil does
        # (§59). A mild week shows it: the coil has far less to do, the people
        # are the same, and the fan's share of HVAC must therefore RISE. Under
        # the old rule — fan on only with the coil, power linear in flow — the
        # share was the same in every climate, because fan energy was just
        # cooling energy times a constant.
        mild = simulate(client, scenarioName="smoke-mild", weather={
            "mode": "synthetic", "peakDryBulbC": 24.0, "minDryBulbC": 15.0, "peakGhiW_m2": 600.0,
        })["building"]
        summer_share = b["fanKwh"] / b["hvacKwh"]
        mild_share = mild["fanKwh"] / mild["hvacKwh"]
        ok("the fan keeps moving ventilation air when the coil has little to do",
           mild["fanKwh"] > 0 and mild["hvacKwh"] < b["hvacKwh"] and mild_share > summer_share * 1.15,
           f"fan share of HVAC {100 * summer_share:.0f}% in a Gulf June, "
           f"{100 * mild_share:.0f}% in a mild week "
           f"(fan {mild['fanKwh']:.0f} of {mild['hvacKwh']:.0f} kWh)")

        ok("latent is a material share of cooling, and a subset of it",
           b["latentKwh"] is not None
           and 0.15 < b["latentKwh"] / b["hvacKwh"] < 0.65
           and b["latentKwh"] < b["hvacKwh"],
           f"latent={b['latentKwh']:.0f} of hvac={b['hvacKwh']:.0f} kWh "
           f"({100 * b['latentKwh'] / b['hvacKwh']:.0f}%)")

        # 3 days of a Gulf office: a plausible annual EUI of 150-400 kWh/m2
        # scales to roughly 1.2-3.3 kWh/m2 over this period.
        eui = b["euiKwhPerM2"]
        ok("energy intensity is in a plausible range", 0.8 < eui < 6.0,
           f"{eui:.2f} kWh/m2 over 3 days -> ~{eui / 3 * 365:.0f}/yr")
        ok("auto-sized plant leaves few unmet hours", b["unmetHours"] < 20,
           f"{b['unmetHours']:.1f} h across 24 zones")

        # ----------------------------------------------------------- physics
        print("\n[3] Physics direction and shape")
        results = client.get(
            f"{BASE}/runs/{base['runId']}/results", params={"limit": 10000}
        ).json()["results"]
        ok("per-interval results are returned", len(results) > 0, f"{len(results)} rows")

        by_hour: dict[int, float] = {}
        solar_by_hour: dict[int, float] = {}
        for r in results:
            hour = datetime.fromisoformat(r["intervalStart"]).astimezone(TZ).hour
            by_hour[hour] = by_hour.get(hour, 0.0) + r["hvacLoadKwh"]
            solar_by_hour[hour] = solar_by_hour.get(hour, 0.0) + r["solarGainKwh"]

        peak_hour = max(by_hour, key=lambda h: by_hour[h])
        ok("cooling peaks in the afternoon, not at night", 11 <= peak_hour <= 18,
           f"peak at {peak_hour}:00")
        ok("no solar gain at midnight", solar_by_hour.get(0, 0.0) < 1e-6)
        ok("solar gain at midday", solar_by_hour.get(12, 0.0) > 0)

        # Vertical glazing at 24N behaves the opposite way to a roof: at summer
        # solar noon the sun is nearly overhead and grazes the glass, while the
        # beam strikes east and west facades near-perpendicular morning and
        # evening. The profile therefore has twin peaks and a midday dip — which
        # is why east/west glazing, not south, is the problem in the tropics.
        # A model showing a noon peak here would have the geometry wrong.
        # Orientation now comes from each zone's own walls, not an average
        # over four aspects (§49). The decisive evidence is that two zones on
        # the same floor, differing only in which side of the building they sit
        # on, take their solar gain at different times of day. Averaging erased
        # exactly this, and it is the difference a facade-retrofit question is
        # asking about.
        #
        # OFF-100 is on the west edge, COR-102 on the east; both also have a
        # south wall, which dilutes the contrast rather than creating it.
        def peak_solar_hour_for(zone_name: str) -> int | None:
            zone = next((z for z in base["byZone"] if z["zoneName"] == zone_name), None)
            if zone is None:
                return None
            rows = client.get(
                f"{BASE}/runs/{base['runId']}/results",
                params={"zoneId": str(zone["zoneId"]), "limit": 10000},
            ).json()["results"]
            per_hour: dict[int, float] = {}
            for r in rows:
                h = datetime.fromisoformat(r["intervalStart"]).astimezone(TZ).hour
                per_hour[h] = per_hour.get(h, 0.0) + r["solarGainKwh"]
            return max(per_hour, key=lambda h: per_hour[h]) if per_hour else None

        west_peak = peak_solar_hour_for("OFF-100")
        east_peak = peak_solar_hour_for("COR-102")
        ok("a west-edge zone takes its solar gain later than an east-edge one",
           west_peak is not None and east_peak is not None and west_peak > east_peak,
           f"west OFF-100 peaks {west_peak}:00, east COR-102 peaks {east_peak}:00")

        peak_solar_hour = max(solar_by_hour, key=lambda h: solar_by_hour[h])
        ok("vertical-facade solar peaks morning or afternoon, not at noon",
           peak_solar_hour in range(5, 10) or peak_solar_hour in range(14, 19),
           f"peak at {peak_solar_hour}:00")
        ok("vertical-facade solar dips at solar noon",
           solar_by_hour[12] < solar_by_hour[peak_solar_hour],
           f"noon {solar_by_hour[12]:.1f} < peak {solar_by_hour[peak_solar_hour]:.1f} kWh")
        ok("cooling peaks later than the morning solar peak, tracking outdoor temperature",
           peak_hour > 10, f"cooling peaks {peak_hour}:00")

        temps = [r["indoorTempC"] for r in results]
        ok("indoor temperature stays in a habitable band",
           all(15 < t < 35 for t in temps),
           f"{min(temps):.1f}..{max(temps):.1f} C")

        server_room = next((z for z in base["byZone"] if z["zoneName"].startswith("SER")), None)
        office = next((z for z in base["byZone"] if z["zoneName"].startswith("OFF")), None)
        ok("the server room is the most energy-intense zone",
           server_room is not None and office is not None
           and server_room["euiKwhPerM2"] > office["euiKwhPerM2"],
           f"server {server_room['euiKwhPerM2']:.1f} vs office {office['euiKwhPerM2']:.1f}")

        # -------------------------------------------------------- scenarios
        print("\n[4] Scenario response")
        warmer = simulate(client, scenarioName="setpoint +2K",
                          params={"setpointDeltaK": 2.0})
        ok("raising the setpoint reduces cooling energy",
           warmer["building"]["hvacKwh"] < b["hvacKwh"],
           f"{warmer['building']['hvacKwh']:.0f} < {b['hvacKwh']:.0f} kWh")

        cooler = simulate(client, scenarioName="setpoint -2K",
                          params={"setpointDeltaK": -2.0})
        ok("lowering the setpoint increases cooling energy",
           cooler["building"]["hvacKwh"] > b["hvacKwh"],
           f"{cooler['building']['hvacKwh']:.0f} > {b['hvacKwh']:.0f} kWh")

        led = simulate(client, scenarioName="LED retrofit",
                       params={"lightingScale": 0.5})
        ok("halving lighting power halves lighting energy",
           abs(led["building"]["lightingKwh"] - b["lightingKwh"] / 2) < 1.0,
           f"{led['building']['lightingKwh']:.1f} vs {b['lightingKwh'] / 2:.1f}")
        ok("an LED retrofit also reduces cooling load",
           led["building"]["hvacKwh"] < b["hvacKwh"],
           "less waste heat to remove")

        better_plant = simulate(client, scenarioName="chiller upgrade",
                                params={"hvacCopScale": 1.25})
        # Two claims in one check, so the detail names both: a failure that
        # prints one number cannot say which half broke. CI hit this and the
        # message could not distinguish "COP did not help" from "plug load
        # moved", which are very different bugs. It was the second, and only
        # beyond the sixth decimal place.
        #
        # Plug load is compared with a tolerance, like every other equality in
        # this file — `==` was the one exception and it was an oversight, not
        # strictness. `summarize()` sums float8 in SQL, float8 addition is not
        # associative, and a parallel aggregate partitions the rows differently
        # from run to run, so identical inputs can differ in the last bits. It
        # passed on a two-core laptop that never chose a parallel plan and
        # failed intermittently on CI, which is the signature of exactly that.
        ok("a better COP reduces HVAC electricity without changing the load",
           better_plant["building"]["hvacKwh"] < b["hvacKwh"]
           and abs(better_plant["building"]["plugKwh"] - b["plugKwh"]) < 1e-6,
           f"hvac {better_plant['building']['hvacKwh']:.1f} vs {b['hvacKwh']:.1f} kWh"
           f" (margin {b['hvacKwh'] - better_plant['building']['hvacKwh']:+.3f});"
           f" plug {better_plant['building']['plugKwh']:.6f} vs {b['plugKwh']:.6f}")

        ppa = simulate(client, scenarioName="green tariff",
                       params={"gridCarbonKgPerKwh": 0.1})
        ok("the emission factor changes carbon but not energy",
           abs(ppa["building"]["totalKwh"] - b["totalKwh"]) < 1e-6
           and ppa["building"]["co2Kg"] < b["co2Kg"],
           f"{ppa['building']['co2Kg']:.0f} vs {b['co2Kg']:.0f} kg")

        print("\n[5] Cross-language contract")
        # The summary crosses into TypeScript, where "optional" and "nullable"
        # are different things that Pydantic writes identically. This is the
        # boundary the two-language split actually costs something at, so it is
        # asserted rather than assumed.
        from app.models import SimulationSummary as PySummary
        from app.notify import summary_payload

        # `base` is the summary JSON with runId bolted on by the helper; the
        # Pydantic models forbid extra keys, so drop it before validating.
        raw = {k: v for k, v in base.items() if k != "runId"}
        wire = summary_payload(PySummary.model_validate(raw))
        ok("scenario params carry no nulls (Zod declares them optional)",
           all(v is not None for v in wire["run"]["params"].values()),
           str(wire["run"]["params"]))
        ok("nullable fields are still present as null, not dropped",
           "peakDemandKw" in wire["building"] and "startedAt" in wire["run"],
           "optional and nullable must not be conflated")

        print("\n[6] Resilience")
        ok("runs complete with the ingest service unreachable",
           base["run"]["status"] == "completed",
           "progress broadcast is best-effort, not on the critical path")
        ok("an unreachable ingest leaves no error on the run",
           base["run"]["error"] is None)

        # -- bounds: how large one run may be ---------------------------------
        #
        # Admission below limits how MANY runs there are. This is about how
        # large one may be: the request used to be bounded only by
        # `intervalS > 0`, so a century at one second validated and was
        # accepted with a 202.
        too_long = client.post(f"{BASE}/simulate", json={
            "buildingId": BUILDING_ID, "scenarioName": "a century",
            "periodStart": "1926-01-01T00:00:00Z", "periodEnd": "2026-01-01T00:00:00Z",
            "weather": {"mode": "synthetic", "peakDryBulbC": 42.0, "minDryBulbC": 30.0},
        })
        ok("a run far over the interval ceiling is a 422, not a 202",
           too_long.status_code == 422, str(too_long.status_code))

        too_fine = client.post(f"{BASE}/simulate", json={
            "buildingId": BUILDING_ID, "scenarioName": "one second",
            "periodStart": PERIOD_START, "periodEnd": PERIOD_END, "intervalS": 1,
            "weather": {"mode": "synthetic", "peakDryBulbC": 42.0, "minDryBulbC": 30.0},
        })
        ok("a one-second interval is refused", too_fine.status_code == 422,
           str(too_fine.status_code))

        with psycopg.connect(dsn) as check:
            check.execute("SELECT set_config('app.tenant_id', %s, false)", (TENANT_ID,))
            leaked = check.execute(
                "SELECT count(*) FROM simulation_runs WHERE scenario_name IN (%s, %s)",
                ("a century", "one second"),
            ).fetchone()[0]
        ok("a refused request creates no run row", leaked == 0, f"{leaked} row(s)")

        # -- durability: admission, cancellation, and orphan reaping ---------
        #
        # `cancelled` has been in the status enum since 004 with nothing able
        # to set it, and a BackgroundTask dies with its process, so a restart
        # left rows at `running` that nothing would ever advance.

        body = {
            "buildingId": BUILDING_ID, "scenarioName": "cancel me",
            "periodStart": PERIOD_START, "periodEnd": PERIOD_END,
            "intervalS": 3600,
            "weather": {"mode": "synthetic", "peakDryBulbC": 42.0,
                        "minDryBulbC": 30.0, "peakGhiW_m2": 950.0},
        }
        started = client.post(f"{BASE}/simulate", json=body)
        ok("a run is accepted while a slot is free", started.status_code == 202,
           str(started.status_code))
        cancel_id = started.json()["runId"]

        cancelled = client.post(f"{BASE}/runs/{cancel_id}/cancel")
        ok("cancelling a live run is accepted", cancelled.status_code == 200,
           str(cancelled.status_code))

        final = run_until_done(client, cancel_id)
        ok("a cancelled run ends cancelled, not completed",
           final["status"] == "cancelled", final["status"])

        again = client.post(f"{BASE}/runs/{cancel_id}/cancel")
        ok("cancelling a finished run is a 409, not a silent success",
           again.status_code == 409, str(again.status_code))

        ok("cancelling an unknown run is a 404",
           client.post(f"{BASE}/runs/{uuid4()}/cancel").status_code == 404)

        # Fill every slot, then check the next request is refused rather than
        # queued behind work the worker has not promised to reach.
        held = [client.post(f"{BASE}/simulate", json=body) for _ in range(3)]
        codes = [r.status_code for r in held]
        ok("admission refuses past the concurrency cap with 429",
           429 in codes, f"got {codes}")
        for r in held:
            if r.status_code == 202:
                run_until_done(client, r.json()["runId"])

        # A refused run must leave no row behind: admission happens before the
        # insert, so a 429 cannot create the `queued` orphan the reaper exists
        # to clean up.
        with psycopg.connect(dsn) as check:
            check.execute("SELECT set_config('app.tenant_id', %s, false)", (TENANT_ID,))
            stranded = check.execute(
                "SELECT count(*) FROM simulation_runs"
                " WHERE scenario_name = %s AND status = 'queued'",
                ("cancel me",),
            ).fetchone()[0]
        ok("a refused run leaves no queued row behind", stranded == 0,
           f"{stranded} stranded")

        # ------------------------------------------------------ determinism
        print("\n[7] Determinism and weather modes")
        repeat = simulate(client, scenarioName="baseline repeat")
        ok("the same request reproduces the same result",
           abs(repeat["building"]["totalKwh"] - b["totalKwh"]) < 1e-6,
           f"{repeat['building']['totalKwh']:.4f}")

        missing = client.post(f"{BASE}/simulate", json={
            "buildingId": BUILDING_ID, "scenarioName": "observed with no data",
            "periodStart": datetime(2019, 1, 1, tzinfo=TZ).isoformat(),
            "periodEnd": datetime(2019, 1, 2, tzinfo=TZ).isoformat(),
            "weather": {"mode": "observed"},
        })
        failed_run = run_until_done(client, missing.json()["runId"])
        ok("observed mode fails loudly when no weather exists, rather than inventing it",
           failed_run["status"] == "failed" and "weather" in (failed_run["error"] or ""),
           (failed_run["error"] or "")[:70])

        written = client.post(f"{BASE}/weather/generate", json={
            "buildingId": BUILDING_ID,
            "periodStart": PERIOD_START, "periodEnd": PERIOD_END,
        }).json()
        ok("weather generation writes hourly rows", written["written"] > 70,
           f"{written['written']} rows")

        observed = simulate(client, scenarioName="observed replay",
                            weather={"mode": "observed"})
        ok("observed mode runs once weather exists",
           observed["building"]["totalKwh"] > 0,
           f"{observed['building']['totalKwh']:.0f} kWh")
        ok("replayed weather gives a comparable answer to the synthetic day",
           abs(observed["building"]["totalKwh"] - b["totalKwh"]) / b["totalKwh"] < 0.25,
           f"{observed['building']['totalKwh']:.0f} vs {b['totalKwh']:.0f} kWh")

finally:
    if server is not None:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()

print(f"\n{'all checks passed' if failures == 0 else f'{failures} check(s) FAILED'}\n")
sys.exit(1 if failures else 0)
