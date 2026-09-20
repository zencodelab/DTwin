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

from . import facade, fans, psychro, repository, solar
from . import weather as weather_mod
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

# How much of a person's heat gain is sensible rather than latent.
#
# `thermal_profiles.occupancy_heat_gain_w_person` is a TOTAL — its default of
# 120 W is the whole output of a seated adult, and ASHRAE Fundamentals puts
# roughly 75 W of that into the air as heat and the rest into it as water.
# Treating all 120 W as sensible, which is what this model did, overstates the
# temperature-raising gain by about 70% and has no term at all for the moisture.
OCCUPANT_SENSIBLE_FRACTION = 0.62

# The humidity the conditioned space is held at, as relative humidity at the
# zone setpoint.
#
# A target rather than a simulated state: modelling the moisture balance of the
# room needs a second capacitance and a second integration, and the answer that
# matters here is the coil load, which is set by the outdoor air brought in.
# 50% is the middle of the ASHRAE 55 comfort envelope and what a Gulf building
# is designed to hold.
INDOOR_TARGET_RH_PCT = 50.0

# Temperature rise across the cooling coil, K.
#
# Sets how much air has to move to carry a given sensible load: 10-12 K is the
# standard design range for a comfort system, and it is what makes 3 W per l/s
# of fan power into a believable share of the total rather than a free extra.
SUPPLY_AIR_DELTA_T_K = 11.0


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
        # Split, not used whole. See OCCUPANT_SENSIBLE_FRACTION: the column is
        # a person's total output and only part of it warms the air.
        occupancy_total_w = f("occupancy_heat_gain_w_person")
        self.occupancy_gain_w = occupancy_total_w * OCCUPANT_SENSIBLE_FRACTION
        self.occupancy_latent_w = occupancy_total_w * (1.0 - OCCUPANT_SENSIBLE_FRACTION)
        self.ventilation_m3_s_person = f("ventilation_l_s_person") / 1000.0

        self.setpoint = f("setpoint_temp_c") + (params.setpointDeltaK or 0.0)
        self.deadband = f("deadband_k")
        self.cop = f("hvac_cop") * (params.hvacCopScale or 1.0)
        # Separate, because one COP for both directions is only right for a
        # machine that has one. The seeded building reheats electrically, so
        # its heating COP is 1.0 against a cooling 2.6-3.2 (§50). The scenario
        # scale applies to cooling only: "chiller upgrade" is about the chiller.
        self.heating_cop = f("heating_cop")

        # Which way each zone's exterior walls face, derived from the stored
        # polygons rather than stored alongside them (§49). An empty list means
        # either a core zone with no outside wall, or geometry that did not
        # resolve — the caller distinguishes them by exterior_wall_area_m2.
        self.facades = [
            facade.exterior_facades(z.get("zone_ring") or [], z.get("floor_ring") or [])
            for z in zones
        ]
        self.exterior_wall_area = wall_area

        self.occupancy_scale = params.occupancyScale or 1.0
        self.capacity_w = np.zeros(n)  # sized once weather is known

    def size_plant(
        self, design_outdoor_c: float, design_outdoor_rh_pct: float = 55.0
    ) -> None:
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

        # The plant is sized for the TOTAL coil load, sensible plus latent, as
        # a real chiller is. Sizing on sensible alone would leave it short by
        # the dehumidification duty on exactly the days that matter here, and
        # the shortfall would surface as unmet hours describing the sizing rule
        # rather than the building.
        design_outdoor_w = psychro.humidity_ratio(
            np.array([design_outdoor_c]), np.array([design_outdoor_rh_pct])
        )[0]
        design_indoor_w = psychro.humidity_ratio(
            self.setpoint, np.full_like(self.setpoint, INDOOR_TARGET_RH_PCT)
        )
        design_latent = psychro.latent_power_w(
            (ventilation_ua + self.ua_infiltration) / AIR_CP_J_KGK,
            design_outdoor_w, design_indoor_w,
        ) + self.design_occupancy * self.occupancy_latent_w

        design_load = (
            self.lighting_w
            + self.equipment_w
            + self.design_occupancy * self.occupancy_gain_w
            + self.window_area * self.shgc * DESIGN_SOLAR_W_M2
            + design_latent
            + (self.ua_envelope + self.ua_infiltration + ventilation_ua) * delta_t
        )
        self.capacity_w = settings.capacity_safety_factor * np.maximum(design_load, 1000.0)


def zone_irradiance(
    arrays: ZoneArrays, series: Any, ground_reflectance: float
) -> np.ndarray:
    """Irradiance on each zone's own glazing, `(zones, steps)` in W/m2.

    The model used one series for every zone: the mean over the four cardinal
    orientations, because orientation "is not in the schema". It is in the
    geometry, so each zone now gets the length-weighted mean over the walls it
    actually has.

    This is not a refinement of a small error. A west office takes its peak
    gain late in the afternoon, when outdoor temperature is also at its highest
    and the plant has least headroom; an east office takes the same energy in
    the morning, when it is cheap. The cardinal average puts both at the same
    middling hour and erases the difference — which is precisely the difference
    a facade-retrofit scenario would be asked about.

    A zone whose geometry yields no exterior edge but which the asset register
    says has exterior wall keeps the cardinal average. That is the honest
    answer to a disagreement between two sources: fall back to the weaker
    assumption rather than silently declaring the zone windowless.
    """
    n_steps = series.dry_bulb_c.size
    out = np.zeros((len(arrays.ids), n_steps), dtype=float)

    for z, facades in enumerate(arrays.facades):
        if not facades:
            if arrays.exterior_wall_area[z] > 0.0:
                out[z, :] = series.vertical_irradiance
            # else: a core zone, and zero is correct.
            continue

        total_length = sum(length for _, length in facades)
        for azimuth, length in facades:
            out[z, :] += (length / total_length) * solar.irradiance_on_surface(
                series.dni, series.dhi, series.ghi,
                series.altitude_deg, series.azimuth_deg,
                azimuth, ground_reflectance,
            )

    return out


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

    # Checked before the weather series or the irradiance matrix exist: the
    # point of a ceiling is not to have already allocated what it forbids.
    cells = len(zones) * len(step_stamps)
    if cells > settings.max_cells:
        raise ValueError(
            f"run needs {cells:,} zone-steps ({len(zones)} zones x "
            f"{len(step_stamps):,} steps); the limit is {settings.max_cells:,}. "
            "Shorten the period, lengthen the interval, or pass zoneIds."
        )

    series = weather_mod.build(request, building, step_stamps, settings.ground_reflectance)
    if series.dry_bulb_c.size:
        peak_i = int(np.argmax(series.dry_bulb_c))
        arrays.size_plant(
            float(series.dry_bulb_c[peak_i]), float(series.rh_pct[peak_i])
        )
    else:
        arrays.size_plant(DESIGN_OUTDOOR_FALLBACK_C)

    carbon_factor = (
        request.params.gridCarbonKgPerKwh
        if request.params.gridCarbonKgPerKwh is not None
        else float(building["grid_carbon_kg_per_kwh"])
    )

    # Start at setpoint: the alternative is a cold start whose first day is
    # dominated by charging the thermal mass rather than by the building.
    # The indoor humidity ratio the coil is holding the space at. Constant for
    # the run: the setpoint does not move, and this is a target rather than a
    # simulated state (see INDOOR_TARGET_RH_PCT).
    indoor_humidity = psychro.humidity_ratio(
        arrays.setpoint, np.full_like(arrays.setpoint, INDOOR_TARGET_RH_PCT)
    )
    outdoor_humidity_series = psychro.humidity_ratio(series.dry_bulb_c, series.rh_pct)
    irradiance_by_zone = zone_irradiance(arrays, series, settings.ground_reflectance)

    # Fan power per litre per second of supply air, from the asset register
    # rather than a literature value (§14, §50). None means the register has
    # nothing to say, and the honest answer is then to report no fan energy
    # rather than to invent a plausible number.
    sfp_w_per_l_s = repository.specific_fan_power_w_per_l_s(request.buildingId)

    # The register's figure is a DESIGN-point figure, so it is applied at the
    # design point: the airflow that carries each zone's installed cooling
    # capacity. What the fan draws below that is `fans.py`'s business — it is
    # emphatically not this number times a part-load airflow (§59).
    if sfp_w_per_l_s is None:
        design_fan_w = np.zeros(len(zones))
    else:
        design_airflow_l_s = (
            arrays.capacity_w / (AIR_CP_J_KGK * SUPPLY_AIR_DELTA_T_K * AIR_DENSITY_KG_M3)
        ) * 1000.0
        design_fan_w = design_airflow_l_s * sfp_w_per_l_s

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
                        "envelope", "ventilation", "unmet", "occupants", "temp",
                        "latent", "fan")
        }
        steps_done = 0

        for _ in range(substeps_per_interval):
            if step_index >= n_steps:
                break

            t_out = series.dry_bulb_c[step_index]
            irradiance = irradiance_by_zone[:, step_index]
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

            # The fan moves the ventilation air this balance has always charged
            # for, so it runs whenever anyone is present, at the VAV minimum at
            # least. That much is known before the control decision, and every
            # watt of it ends up as heat in the airstream serving the zone — so
            # it belongs in the balance, where the coil (or the heating it
            # offsets) then accounts for it without a special case.
            ventilating = occupants > 0.0
            fan_floor_w = fans.fan_power_w(
                np.where(ventilating, fans.MIN_FLOW_FRACTION, 0.0), design_fan_w
            )

            q_net = (
                q_solar + q_light + q_equip + q_people
                + q_envelope + q_infiltration + q_ventilation
                + fans.HEAT_TO_AIRSTREAM_FRACTION * fan_floor_w
            )

            # Latent load, kept OUT of q_net on purpose.
            #
            # Drying air does not change its temperature, so moisture has no
            # place in the sensible balance that decides where the zone floats
            # to. It is a load on the COIL, not on the node — which is exactly
            # why a sensible-only model does not approximate this term, it has
            # no term for it. See docs/decisions.md §48.
            #
            # Two sources: outdoor air brought in for ventilation and leaking
            # in through the envelope, and the people themselves.
            outdoor_air_kg_s = (
                (ua_ventilation + arrays.ua_infiltration) / AIR_CP_J_KGK
            )
            q_latent = psychro.latent_power_w(
                outdoor_air_kg_s, outdoor_humidity_series[step_index], indoor_humidity
            ) + occupants * arrays.occupancy_latent_w

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

            # Latent load is only met while the coil is running. With no
            # cooling call there is nothing dehumidifying the space, and
            # charging for moisture removal that did not happen would invent
            # energy — the space simply drifts damp, which is what an
            # unconditioned building in this climate does.
            latent_met = np.where(cooling > 0.0, q_latent, 0.0)

            # Air-side energy (§50, §59). The fan runs for ventilation or for a
            # coil call, turns down with the sensible load to the VAV minimum,
            # and draws power along a variable-speed curve rather than in
            # proportion to flow.
            running = ventilating | (cooling > 0.0) | (heating > 0.0)
            fan_w = fans.fan_power_w(
                fans.flow_fraction(cooling, arrays.capacity_w, running), design_fan_w
            )

            # Fan heat above the floor already in q_net. It could not go into
            # the balance: it depends on the cooling the balance decides, and
            # solving that circle would make the result depend on the step. So
            # it is charged where it lands — on the coil while cooling, and as
            # heating the coil did not have to supply while heating.
            fan_heat_extra = fans.HEAT_TO_AIRSTREAM_FRACTION * (fan_w - fan_floor_w)
            coil_w = cooling + latent_met + np.where(cooling > 0.0, fan_heat_extra, 0.0)
            heating_net = np.maximum(
                heating - np.where(heating > 0.0, fan_heat_extra, 0.0), 0.0
            )

            # fan_w is not divided by COP: it is already electricity, not a
            # thermal load a machine has to move.
            acc["fan"] += fan_w * kwh
            acc["hvac"] += (
                coil_w / arrays.cop + heating_net / arrays.heating_cop + fan_w
            ) * kwh
            acc["latent"] += latent_met / arrays.cop * kwh
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
                float(acc["latent"][z]), float(acc["fan"][z]),
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
