"""Zone thermal and energy engine.

A lumped-capacitance heat balance per zone, stepped forward in time — the model
IES and EnergyPlus elaborate rather than replace. Each zone is one thermal node
with a heat capacity, exchanging heat with outdoors through the envelope, by
infiltration and ventilation, and gaining heat from sun, lights, equipment and
people. HVAC is a controller acting on that node, capped by installed capacity.

Why dynamic rather than a steady-state load sum: thermal mass is the reason a
building does not track outdoor temperature, and the reason cooling demand lags
the solar peak. A steady-state calculation cannot produce overnight free-float,
cannot show a morning pull-down after setback, and cannot report unmet hours —
which are precisely the outputs a facility manager acts on. The schema carries
`thermal_mass_kj_per_k` for exactly this.

    C dT/dt = Q_solar + Q_internal + Q_envelope + Q_infiltration + Q_ventilation + Q_hvac

All gains are watts and positive into the zone. Integration is explicit Euler at
`SIM_SUBSTEP_S`; zone time constants here (mass over conductance) run to tens of
hours, so a 300 s step sits far inside the stability limit.

Vectorised over zones with numpy: one year at hourly output over 24 zones is
~105k integration steps, and stepping them as arrays keeps that a couple of
seconds rather than a couple of minutes.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

import numpy as np

from . import repository, weather as weather_mod
from .config import settings
from .models import SimulationRequest

AIR_DENSITY_KG_M3 = 1.2
AIR_CP_J_KGK = 1005.0
J_PER_KWH = 3.6e6

# Design assumptions for auto-sizing plant.
DESIGN_SOLAR_W_M2 = 800.0
DESIGN_OUTDOOR_FALLBACK_C = 42.0
#: Beyond this far outside the deadband, an occupied zone counts as unmet.
UNMET_TOLERANCE_K = 0.5
#: Progress is reported each time the run crosses this many percent.
PROGRESS_STEP_PCT = 2.0
#: Lighting never falls to zero in an occupied building — egress and security.
MIN_LIGHTING_FRACTION = 0.05
#: Plug loads keep drawing when nobody is present; equipment is left on.
PLUG_STANDBY_FRACTION = 0.3

DAY_TYPE_COUNT = 4


class ZoneArrays:
    """Zone properties as parallel numpy arrays, in SI units."""

    def __init__(self, zones: list[dict[str, Any]], params: Any) -> None:
        self.ids = [z["id"] for z in zones]
        self.names = [z["name"] for z in zones]
        n = len(zones)

        f = lambda key: np.array([float(z[key]) for z in zones], dtype=float)  # noqa: E731

        self.area = f("area_m2")
        self.volume = f("volume_m3")
        self.design_occupancy = f("design_occupancy")
        wall_area = f("exterior_wall_area_m2")

        wwr = f("window_to_wall_ratio")
        self.window_area = wall_area * wwr
        opaque_area = wall_area * (1.0 - wwr)

        self.shgc = f("shgc")
        self.thermal_capacity_j_k = f("thermal_mass_kj_per_k") * 1000.0

        # Envelope conductance. A zone with no exterior wall (a core zone) gets
        # zero, which is correct: it exchanges heat with neighbours, not outdoors.
        self.ua_envelope = f("u_value_wall_w_m2k") * opaque_area + (
            f("u_value_window_w_m2k") * self.window_area
        )

        infiltration_scale = params.infiltrationScale or 1.0
        self.ua_infiltration = (
            f("infiltration_ach") * infiltration_scale
            * self.volume * AIR_DENSITY_KG_M3 * AIR_CP_J_KGK / 3600.0
        )

        self.lighting_w = f("lighting_power_density_w_m2") * self.area * (
            params.lightingScale or 1.0
        )
        self.equipment_w = f("equipment_power_density_w_m2") * self.area * (
            params.equipmentScale or 1.0
        )
        self.occupancy_gain_w = f("occupancy_heat_gain_w_person")
        self.ventilation_m3_s_person = f("ventilation_l_s_person") / 1000.0

        self.setpoint = f("setpoint_temp_c") + (params.setpointDeltaK or 0.0)
        self.deadband = f("deadband_k")
        self.cop = f("hvac_cop") * (params.hvacCopScale or 1.0)

        self.occupancy_scale = params.occupancyScale or 1.0
        self.capacity_w = np.zeros(n)  # sized once weather is known

    def size_plant(self, design_outdoor_c: float) -> None:
        """Auto-size cooling capacity from each zone's design load.

        A flat W/m2 rule would cripple the server room, whose equipment density
        is an order of magnitude above an office — it would report enormous
        unmet hours that reflect the rule of thumb, not the building. Sizing from
        the zone's own design load is what an engineer would do, and it makes
        unmet hours mean something.
        """
        ventilation_ua = (
            self.design_occupancy * self.ventilation_m3_s_person
            * AIR_DENSITY_KG_M3 * AIR_CP_J_KGK
        )
        delta_t = np.maximum(design_outdoor_c - self.setpoint, 0.0)

        design_load = (
            self.lighting_w
            + self.equipment_w
            + self.design_occupancy * self.occupancy_gain_w
            + self.window_area * self.shgc * DESIGN_SOLAR_W_M2
            + (self.ua_envelope + self.ua_infiltration + ventilation_ua) * delta_t
        )
        self.capacity_w = settings.capacity_safety_factor * np.maximum(design_load, 1000.0)


def _schedule_tables(
    zones: list[dict[str, Any]], schedules: dict[UUID, dict[str, list[float]]]
) -> np.ndarray:
    """(n_zones, day_type, hour) occupancy fractions, for O(1) lookup per step."""
    table = np.zeros((len(zones), DAY_TYPE_COUNT, 24), dtype=float)
    for i, zone in enumerate(zones):
        by_day = schedules.get(zone["occupancy_schedule_id"], {})
        for d, day_type in enumerate(weather_mod.DAY_TYPES):
            fractions = by_day.get(day_type)
            if fractions:
                table[i, d, :] = fractions
    return table


def _timeline(start: datetime, end: datetime, step_s: int) -> list[datetime]:
    stamps: list[datetime] = []
    cursor = start
    while cursor < end:
        stamps.append(cursor)
        cursor += timedelta(seconds=step_s)
    return stamps


def run(
    run_id: UUID,
    request: SimulationRequest,
    on_progress: Callable[[float], None] | None = None,
) -> None:
    """Execute a run to completion, writing results and progress as it goes."""
    building = repository.load_building(request.buildingId)
    if building is None:
        raise ValueError(f"no building {request.buildingId}")

    zones = repository.load_zones(request.buildingId, request.zoneIds)
    if not zones:
        raise ValueError(
            "no zones with a thermal profile; assign profiles before simulating"
        )

    schedules = repository.load_schedules()
    arrays = ZoneArrays(zones, request.params)
    occupancy_table = _schedule_tables(zones, schedules)

    substep_s = min(settings.substep_s, request.intervalS)
    substeps_per_interval = max(1, request.intervalS // substep_s)

    interval_starts = _timeline(request.periodStart, request.periodEnd, request.intervalS)
    step_stamps = _timeline(request.periodStart, request.periodEnd, substep_s)
    if not interval_starts or not step_stamps:
        raise ValueError("simulation period is shorter than one interval")

    series = weather_mod.build(request, building, step_stamps, settings.ground_reflectance)
    arrays.size_plant(float(np.max(series.dry_bulb_c)) if series.dry_bulb_c.size
                      else DESIGN_OUTDOOR_FALLBACK_C)

    carbon_factor = (
        request.params.gridCarbonKgPerKwh
        if request.params.gridCarbonKgPerKwh is not None
        else float(building["grid_carbon_kg_per_kwh"])
    )

    # Start at setpoint: the alternative is a cold start whose first day is
    # dominated by charging the thermal mass rather than by the building.
    temperature = arrays.setpoint.copy()
    interval_hours = request.intervalS / 3600.0
    dt = float(substep_s)

    rows: list[tuple] = []
    total_intervals = len(interval_starts)
    step_index = 0
    n_steps = len(step_stamps)
    last_reported_pct = -PROGRESS_STEP_PCT

    for interval_i, interval_start in enumerate(interval_starts):
        acc = {
            key: np.zeros(len(zones))
            for key in ("hvac", "light", "plug", "solar", "internal",
                        "envelope", "ventilation", "unmet", "occupants", "temp")
        }
        steps_done = 0

        for _ in range(substeps_per_interval):
            if step_index >= n_steps:
                break

            t_out = series.dry_bulb_c[step_index]
            irradiance = series.vertical_irradiance[step_index]
            hour = int(series.local_hour[step_index]) % 24
            day_type = int(series.day_type_index[step_index])

            occupancy_fraction = np.clip(
                occupancy_table[:, day_type, hour] * arrays.occupancy_scale, 0.0, 1.0
            )
            occupants = arrays.design_occupancy * occupancy_fraction

            q_solar = arrays.window_area * arrays.shgc * irradiance
            q_light = arrays.lighting_w * np.maximum(occupancy_fraction, MIN_LIGHTING_FRACTION)
            q_equip = arrays.equipment_w * (
                PLUG_STANDBY_FRACTION + (1.0 - PLUG_STANDBY_FRACTION) * occupancy_fraction
            )
            q_people = occupants * arrays.occupancy_gain_w

            delta_t = t_out - temperature
            q_envelope = arrays.ua_envelope * delta_t
            q_infiltration = arrays.ua_infiltration * delta_t
            ua_ventilation = (
                occupants * arrays.ventilation_m3_s_person
                * AIR_DENSITY_KG_M3 * AIR_CP_J_KGK
            )
            q_ventilation = ua_ventilation * delta_t

            q_net = (
                q_solar + q_light + q_equip + q_people
                + q_envelope + q_infiltration + q_ventilation
            )

            # Ideal-loads control, as EnergyPlus calls it: predict where the
            # node would float to with no HVAC, then apply exactly the power
            # needed to land on the nearest setpoint boundary, bounded by
            # installed plant.
            #
            # The naive alternative — react once the measured temperature has
            # already crossed the deadband — is bang-bang control, and its
            # overshoot is one step's worth of gain. That is invisible in an
            # office (0.07 K per step) and dominant in a server room, where
            # 90 kW into a small thermal mass moves the node 1.5 K per 300 s
            # step and manufactures unmet hours that describe the integration
            # step rather than the building. Predicting the float removes the
            # overshoot entirely and makes the result step-size independent.
            upper = arrays.setpoint + arrays.deadband / 2.0
            lower = arrays.setpoint - arrays.deadband / 2.0

            free_float = temperature + q_net * dt / arrays.thermal_capacity_j_k
            per_kelvin = arrays.thermal_capacity_j_k / dt

            cooling = np.clip(
                np.where(free_float > upper, (free_float - upper) * per_kelvin, 0.0),
                0.0, arrays.capacity_w,
            )
            heating = np.clip(
                np.where(free_float < lower, (lower - free_float) * per_kelvin, 0.0),
                0.0, arrays.capacity_w,
            )
            q_hvac = heating - cooling

            temperature = free_float + q_hvac * dt / arrays.thermal_capacity_j_k

            kwh = dt / J_PER_KWH
            acc["hvac"] += (cooling + heating) / arrays.cop * kwh
            acc["light"] += q_light * kwh
            acc["plug"] += q_equip * kwh
            acc["solar"] += q_solar * kwh
            acc["internal"] += (q_light + q_equip + q_people) * kwh
            acc["envelope"] += q_envelope * kwh
            acc["ventilation"] += (q_infiltration + q_ventilation) * kwh

            occupied = occupancy_fraction > 0.05
            out_of_band = (temperature > upper + UNMET_TOLERANCE_K) | (
                temperature < lower - UNMET_TOLERANCE_K
            )
            acc["unmet"] += np.where(occupied & out_of_band, dt / 3600.0, 0.0)
            acc["occupants"] += occupants
            acc["temp"] += temperature

            step_index += 1
            steps_done += 1

        if steps_done == 0:
            break

        total_kwh = acc["hvac"] + acc["light"] + acc["plug"]
        mean_temp = acc["temp"] / steps_done
        mean_occupants = acc["occupants"] / steps_done

        for z in range(len(zones)):
            rows.append((
                run_id, arrays.ids[z], interval_start,
                float(acc["hvac"][z]), float(acc["light"][z]), float(acc["plug"][z]),
                float(total_kwh[z]), float(total_kwh[z] * carbon_factor),
                float(total_kwh[z] / interval_hours),
                float(mean_temp[z]),
                float(acc["solar"][z]), float(acc["internal"][z]),
                float(acc["envelope"][z]), float(acc["ventilation"][z]),
                float(mean_occupants[z]), float(acc["unmet"][z]),
            ))

        # Flush periodically so a long run's memory stays flat, and so progress
        # reflects work that is actually durable.
        if len(rows) >= 20_000:
            repository.write_results(rows)
            rows = []

        # Report by percentage, not by interval count. A fixed "every N
        # intervals" is wrong at both ends: a three-day run has 72 intervals and
        # would report twice, while a year reports 175 times. Crossing a
        # percentage step gives a steady ~50 updates whatever the run length.
        pct = 100.0 * (interval_i + 1) / total_intervals
        if pct - last_reported_pct >= PROGRESS_STEP_PCT or interval_i == total_intervals - 1:
            last_reported_pct = pct
            repository.set_progress(run_id, pct)
            if on_progress is not None:
                on_progress(pct)

    repository.write_results(rows)
