"""The fan curve and turn-down, with no database and no engine."""
import numpy as np
import pytest

from app import fans


def test_full_flow_is_design_power():
    # 0.9991, not 1.0: that is the published curve.
    assert fans.part_load_power_fraction(np.array([1.0]))[0] == pytest.approx(0.9991, abs=1e-4)


def test_half_flow_is_far_below_half_power():
    """The defect: a linear model charged 50% of design power at 50% flow."""
    half = fans.part_load_power_fraction(np.array([0.5]))[0]
    assert half == pytest.approx(0.300, abs=0.002)
    assert half < 0.5


def test_curve_is_monotonic_and_never_above_linear():
    f = np.linspace(0.05, 1.0, 96)
    p = fans.part_load_power_fraction(f)
    assert np.all(np.diff(p) > 0)
    # At or below the line everywhere — a variable-speed fan is never WORSE at
    # part load than one that scales linearly.
    assert np.all(p <= f + 1e-9)


def test_curve_clamps_outside_its_domain():
    p = fans.part_load_power_fraction(np.array([-0.2, 1.7]))
    assert p[0] == pytest.approx(0.0013)
    assert p[1] == pytest.approx(0.9991, abs=1e-4)


def test_running_fan_holds_the_vav_minimum():
    frac = fans.flow_fraction(
        np.array([0.0, 100.0, 600.0, 5000.0]), np.full(4, 1000.0), np.full(4, True)
    )
    assert frac.tolist() == [fans.MIN_FLOW_FRACTION, fans.MIN_FLOW_FRACTION, 0.6, 1.0]


def test_fan_that_is_off_moves_no_air_rather_than_its_minimum():
    frac = fans.flow_fraction(np.array([0.0]), np.array([1000.0]), np.array([False]))
    assert frac[0] == 0.0
    assert fans.fan_power_w(frac, np.array([3000.0]))[0] == 0.0


def test_zero_capacity_zone_does_not_divide_by_zero():
    frac = fans.flow_fraction(np.array([50.0]), np.array([0.0]), np.array([True]))
    assert np.isfinite(frac).all() and frac[0] == fans.MIN_FLOW_FRACTION


def test_minimum_flow_costs_about_an_eighth_of_design_power():
    p = fans.fan_power_w(np.array([fans.MIN_FLOW_FRACTION]), np.array([1000.0]))[0]
    assert p == pytest.approx(128.0, abs=2.0)
