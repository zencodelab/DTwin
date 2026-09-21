"""Analytical verification: the engine against closed-form solutions.

Every other test of this model checks a DIRECTION — cooling peaks in the
afternoon, a west zone peaks later than an east one, a better COP uses less
electricity. Those catch sign errors and little else; a model can point the
right way and be wrong by a factor of two, and this one was (twice: the
occupant gain, and the fans — see §48 and §59).

A closed-form solution is the one thing available here that is independent of
the code. It is not calibration and it is not a comparison against EnergyPlus;
in ASHRAE 140's terms this is analytical verification, the weakest of the three
and the only one that needs no other software and no measured building. What it
does establish is that for the cases simple enough to solve with a pen, the
engine gives the answer the pen gives.

It became possible when `integrate_substep` was lifted out of `run()`'s loop
(§60). Before that the only way to reach the heat balance was through a
migrated database, a seeded building and a live worker.
"""
from itertools import pairwise

import numpy as np
import pytest

from app import engine
from app.models import SimulationParams

# A zone with every term switched off. Each test turns on exactly the ones its
# closed-form solution accounts for, so nothing else can contribute.
INERT_ZONE = {
    "id": "00000000-0000-0000-0000-000000000001",
    "name": "analytical",
    "area_m2": 100.0,
    "volume_m3": 300.0,
    "design_occupancy": 0.0,
    "exterior_wall_area_m2": 0.0,
    "window_to_wall_ratio": 0.0,
    "shgc": 0.0,
    "thermal_mass_kj_per_k": 2_000.0,      # 2e6 J/K
    "u_value_wall_w_m2k": 0.0,
    "u_value_window_w_m2k": 0.0,
    "infiltration_ach": 0.0,
    "lighting_power_density_w_m2": 0.0,
    "equipment_power_density_w_m2": 0.0,
    "occupancy_heat_gain_w_person": 0.0,
    "ventilation_l_s_person": 0.0,
    "setpoint_temp_c": 24.0,
    "deadband_k": 2.0,
    "hvac_cop": 3.0,
    "heating_cop": 1.0,
    "zone_ring": [],
    "floor_ring": [],
}

CAPACITY_J_K = INERT_ZONE["thermal_mass_kj_per_k"] * 1000.0


def arrays_for(**overrides):
    """A one-zone `ZoneArrays`, built through the real constructor."""
    zone = {**INERT_ZONE, **overrides}
    a = engine.ZoneArrays([zone], SimulationParams())
    a.capacity_w = np.zeros(1)          # no plant unless a test installs some
    return a


def step(a, temperature, *, t_out, dt, capacity_w=None):
    if capacity_w is not None:
        a.capacity_w = np.array([capacity_w], dtype=float)
    return engine.integrate_substep(
        a, np.array([temperature], dtype=float),
        t_out=t_out,
        irradiance=np.zeros(1),
        occupancy_fraction=np.zeros(1),
        outdoor_humidity=0.0,
        indoor_humidity=np.zeros(1),
        design_fan_w=np.zeros(1),
        dt=dt,
    )


def free_float(a, *, t_start, t_out, dt, seconds, capacity_w=None):
    """Integrate for `seconds` and return the final temperature."""
    t = t_start
    for _ in range(int(round(seconds / dt))):
        t = float(step(a, t, t_out=t_out, dt=dt, capacity_w=capacity_w).temperature[0])
    return t


# --------------------------------------------------------------------------
# 1. Newton cooling: the envelope alone
# --------------------------------------------------------------------------
# dT/dt = UA (T_out - T) / C   =>   T(t) = T_out + (T0 - T_out) e^(-t/tau)
#
# The engine integrates that with explicit Euler, so it reproduces the
# DISCRETE solution exactly and the continuous one only as dt -> 0. Both
# halves are asserted: the first says the arithmetic is right, the second says
# it is converging on the right thing rather than on a neighbouring problem.

UA = 200.0          # W/K, via 100 m2 of wall at U = 2.0
TAU_S = CAPACITY_J_K / UA   # 10,000 s


def conduction_zone():
    return arrays_for(exterior_wall_area_m2=100.0, u_value_wall_w_m2k=2.0)


def test_envelope_conductance_is_what_the_closed_form_assumes():
    assert conduction_zone().ua_envelope[0] == pytest.approx(UA)


def test_free_float_matches_the_discrete_euler_solution_exactly():
    a, dt, n = conduction_zone(), 300.0, 20
    t0, t_out = 30.0, 20.0
    got = free_float(a, t_start=t0, t_out=t_out, dt=dt, seconds=dt * n)
    expected = t_out + (t0 - t_out) * (1.0 - UA * dt / CAPACITY_J_K) ** n
    assert got == pytest.approx(expected, rel=1e-12)


def test_free_float_converges_on_the_exponential_at_first_order():
    """Halving the step halves the error — Euler's published order.

    A model that merely "goes the right way" passes no version of this. It is
    also the sharpest available statement that the discretisation is sound:
    an integrator converging at the wrong order is integrating something else.
    """
    a = conduction_zone()
    t0, t_out, total = 30.0, 20.0, TAU_S
    exact = t_out + (t0 - t_out) * np.exp(-total / TAU_S)

    errors = [
        abs(free_float(a, t_start=t0, t_out=t_out, dt=dt, seconds=total) - exact)
        for dt in (400.0, 200.0, 100.0)
    ]
    assert errors[0] > 0.0
    for coarse, fine in pairwise(errors):
        assert fine / coarse == pytest.approx(0.5, abs=0.02)


def test_the_time_constant_is_c_over_ua():
    """After one tau, 63.2% of the way. The textbook check on a time constant."""
    a = conduction_zone()
    t0, t_out = 30.0, 20.0
    got = free_float(a, t_start=t0, t_out=t_out, dt=10.0, seconds=TAU_S)
    covered = (t0 - got) / (t0 - t_out)
    assert covered == pytest.approx(1.0 - 1.0 / np.e, abs=2e-3)


def test_no_gradient_and_no_gains_moves_nothing_at_all():
    a = conduction_zone()
    assert free_float(a, t_start=21.0, t_out=21.0, dt=300.0, seconds=86_400) == 21.0


# --------------------------------------------------------------------------
# 2. Steady state: gains against the envelope
# --------------------------------------------------------------------------
# At equilibrium the gain equals the loss:  Q = UA (T - T_out)  =>  dT = Q/UA.

def test_a_constant_gain_settles_at_q_over_ua_above_outdoors():
    # Unoccupied plug load is PLUG_STANDBY_FRACTION of the connected load,
    # which is the constant this case needs.
    connected_w = 100.0 * 20.0           # 100 m2 at 20 W/m2
    q = engine.PLUG_STANDBY_FRACTION * connected_w
    a = arrays_for(
        exterior_wall_area_m2=100.0, u_value_wall_w_m2k=2.0,
        equipment_power_density_w_m2=20.0,
    )
    settled = free_float(a, t_start=20.0, t_out=20.0, dt=60.0, seconds=20 * TAU_S)
    assert settled == pytest.approx(20.0 + q / UA, abs=1e-6)


def test_the_zone_is_linear_in_its_gains():
    """Double the gain, double the rise. Linearity is what makes superposition
    legitimate, and it is quietly assumed everywhere a term is added to q_net."""
    def rise(w_m2):
        a = arrays_for(
            exterior_wall_area_m2=100.0, u_value_wall_w_m2k=2.0,
            equipment_power_density_w_m2=w_m2,
        )
        return free_float(a, t_start=20.0, t_out=20.0, dt=60.0, seconds=20 * TAU_S) - 20.0

    assert rise(20.0) == pytest.approx(2.0 * rise(10.0), rel=1e-9)


# --------------------------------------------------------------------------
# 3. Conservation: an identity the integrator must satisfy at every step
# --------------------------------------------------------------------------

@pytest.mark.parametrize("t_start,t_out,dt,capacity", [
    (24.0, 45.0, 300.0, 50_000.0),
    (24.0, -5.0, 900.0, 50_000.0),
    (28.0, 30.0, 60.0, 0.0),
    (19.0, 20.0, 600.0, 3_000.0),
])
def test_energy_in_equals_energy_stored_plus_energy_removed(t_start, t_out, dt, capacity):
    """C dT = (q_net + q_hvac) dt, exactly, whatever the plant did.

    This is the first law applied to the node. It holds whether the zone is
    floating, pinned, or short of capacity, which is what makes it worth
    asserting over the awkward cases rather than a comfortable one.
    """
    a = arrays_for(
        exterior_wall_area_m2=100.0, u_value_wall_w_m2k=2.0,
        equipment_power_density_w_m2=15.0,
    )
    r = step(a, t_start, t_out=t_out, dt=dt, capacity_w=capacity)
    stored = CAPACITY_J_K * (float(r.temperature[0]) - t_start)
    supplied = (float(r.q_net_w[0]) + float(r.heating_w[0]) - float(r.cooling_w[0])) * dt
    assert stored == pytest.approx(supplied, rel=1e-12)


def test_the_sensible_balance_is_the_sum_of_its_named_terms():
    """q_net has no unnamed contributor, so the reported breakdown accounts for
    the whole of what moved the zone."""
    a = arrays_for(
        exterior_wall_area_m2=100.0, u_value_wall_w_m2k=2.0,
        equipment_power_density_w_m2=15.0, lighting_power_density_w_m2=10.0,
    )
    r = step(a, 26.0, t_out=40.0, dt=300.0, capacity_w=0.0)
    named = (r.q_solar_w + r.q_light_w + r.q_equip_w + r.q_people_w
             + r.q_envelope_w + r.q_ventilation_w)
    assert float(r.q_net_w[0]) == pytest.approx(float(named[0]), rel=1e-12)


# --------------------------------------------------------------------------
# 4. Ideal-loads control (§22)
# --------------------------------------------------------------------------

def test_a_pinned_zone_is_cooled_by_exactly_its_load():
    """Held on the deadband edge, the coil removes the load and not a watt more.

    That equality IS ideal-loads control. Bang-bang would remove whatever the
    plant happened to be rated at, and overshoot by a step's worth of gain.
    """
    a = arrays_for(
        exterior_wall_area_m2=100.0, u_value_wall_w_m2k=2.0,
        equipment_power_density_w_m2=30.0,
    )
    upper = 24.0 + 2.0 / 2.0
    t = upper
    for _ in range(50):                      # settle onto the edge
        t = float(step(a, t, t_out=38.0, dt=300.0, capacity_w=1e7).temperature[0])
    r = step(a, t, t_out=38.0, dt=300.0, capacity_w=1e7)

    assert float(r.temperature[0]) == pytest.approx(upper, abs=1e-9)
    assert float(r.cooling_w[0]) == pytest.approx(float(r.q_net_w[0]), rel=1e-9)


@pytest.mark.parametrize("dt", [60.0, 300.0, 900.0])
def test_cooling_energy_does_not_depend_on_the_integration_step(dt):
    """The claim §22 was written to make true, here as an exact equality.

    Under bang-bang this is where a model betrays itself: the answer moves with
    the step, so it is a fact about the solver rather than the building.
    """
    a = arrays_for(
        exterior_wall_area_m2=100.0, u_value_wall_w_m2k=2.0,
        equipment_power_density_w_m2=30.0,
    )
    # Started ON the edge, not mid-band: from mid-band the zone first free-
    # floats up to the edge, and that climb has its own (solvable, tedious)
    # integral. Pinned from the first step, the load is constant and the
    # closed form is one multiplication.
    t_out, upper, hours = 38.0, 25.0, 6.0
    load_w = UA * (t_out - upper) + engine.PLUG_STANDBY_FRACTION * 100.0 * 30.0
    expected_kwh = load_w * hours / 1000.0

    t, joules = upper, 0.0
    for _ in range(int(round(hours * 3600.0 / dt))):
        r = step(a, t, t_out=t_out, dt=dt, capacity_w=1e7)
        joules += float(r.cooling_w[0]) * dt
        t = float(r.temperature[0])

    assert joules / 3.6e6 == pytest.approx(expected_kwh, rel=1e-12)


def test_plant_short_of_the_load_leaves_the_zone_above_setpoint():
    """And by exactly the shortfall, not by an amount the step size decides."""
    a = arrays_for(
        exterior_wall_area_m2=100.0, u_value_wall_w_m2k=2.0,
        equipment_power_density_w_m2=30.0,
    )
    dt, capacity = 300.0, 500.0
    r = step(a, 25.0, t_out=38.0, dt=dt, capacity_w=capacity)
    assert float(r.cooling_w[0]) == capacity
    unmet_w = float(r.q_net_w[0]) - capacity
    assert float(r.temperature[0]) == pytest.approx(25.0 + unmet_w * dt / CAPACITY_J_K, rel=1e-12)
