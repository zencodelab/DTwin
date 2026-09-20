"""Unit tests for the solar geometry and irradiance correlations.

`solar.py` is 213 lines of astronomy on which the largest term in the heat
balance depends, and the smoke suite reaches it only through a whole simulation
run: it can tell you the afternoon cooling peak moved, not that Cooper's
equation has the wrong sign in December.

These check the correlations against values that are independently knowable —
solstice declination, equinox day length, the longitude correction for Abu
Dhabi, the Erbs limits — rather than against the code's own output.
"""
from __future__ import annotations

import numpy as np
import pytest

from app import solar

# The seeded building: Corniche Road, Abu Dhabi.
LAT = 24.4539
LON = 54.3773
TZ = 4.0

JUN_21 = 172
DEC_21 = 355
MAR_21 = 80


def arr(*values: float) -> np.ndarray:
    return np.array(values, dtype=float)


class TestDeclination:
    def test_solstices_reach_the_tropics(self) -> None:
        # The Earth's axial tilt; Cooper's equation should land within ~0.5 deg.
        assert solar.declination_deg(arr(JUN_21))[0] == pytest.approx(23.45, abs=0.5)
        assert solar.declination_deg(arr(DEC_21))[0] == pytest.approx(-23.45, abs=0.5)

    def test_equinoxes_are_near_zero(self) -> None:
        assert abs(solar.declination_deg(arr(MAR_21))[0]) < 1.0

    def test_stays_within_the_tropics_all_year(self) -> None:
        days = np.arange(1, 366, dtype=float)
        assert np.all(np.abs(solar.declination_deg(days)) <= 23.46)


class TestEquationOfTime:
    def test_stays_within_the_known_envelope(self) -> None:
        # The real equation of time runs about -14 to +16 minutes.
        days = np.arange(1, 366, dtype=float)
        eot = solar.equation_of_time_min(days)
        assert eot.min() > -20.0 and eot.max() < 20.0

    def test_has_both_signs(self) -> None:
        days = np.arange(1, 366, dtype=float)
        eot = solar.equation_of_time_min(days)
        assert eot.min() < -5.0 and eot.max() > 5.0


class TestHourAngle:
    def test_advances_fifteen_degrees_per_hour(self) -> None:
        h = solar.hour_angle_deg(arr(10.0, 11.0), arr(MAR_21, MAR_21), LON, TZ)
        assert (h[1] - h[0]) == pytest.approx(15.0, abs=1e-9)

    def test_is_negative_in_the_morning_and_positive_in_the_afternoon(self) -> None:
        h = solar.hour_angle_deg(arr(8.0, 16.0), arr(MAR_21, MAR_21), LON, TZ)
        assert h[0] < 0.0 < h[1]

    def test_abu_dhabi_solar_noon_falls_after_the_clock_noon(self) -> None:
        # 54.38E is west of the UTC+4 standard meridian at 60E, so the sun
        # crosses later than 12:00 local — roughly 22 minutes, per the docstring.
        hours = np.arange(11.0, 13.0, 1.0 / 60.0)
        omega = solar.hour_angle_deg(hours, np.full_like(hours, MAR_21), LON, TZ)
        solar_noon = hours[int(np.argmin(np.abs(omega)))]
        assert 12.2 < solar_noon < 12.6


class TestSolarPosition:
    def test_sun_is_below_the_horizon_at_midnight(self) -> None:
        alt, _, _ = solar.solar_position(arr(JUN_21), arr(0.0), LAT, LON, TZ)
        assert alt[0] < 0.0

    def test_summer_noon_is_higher_than_winter_noon(self) -> None:
        summer, _, _ = solar.solar_position(arr(JUN_21), arr(12.5), LAT, LON, TZ)
        winter, _, _ = solar.solar_position(arr(DEC_21), arr(12.5), LAT, LON, TZ)
        assert summer[0] > winter[0]

    def test_noon_altitude_matches_the_closed_form(self) -> None:
        # At solar noon, altitude = 90 - |latitude - declination|.
        for day in (JUN_21, DEC_21, MAR_21):
            hours = np.arange(11.0, 14.0, 1.0 / 120.0)
            alt, _, dec = solar.solar_position(
                np.full_like(hours, day), hours, LAT, LON, TZ
            )
            expected = 90.0 - abs(LAT - dec[0])
            assert alt.max() == pytest.approx(expected, abs=0.2)

    def test_equinox_day_length_is_about_twelve_hours(self) -> None:
        hours = np.arange(0.0, 24.0, 1.0 / 60.0)
        alt, _, _ = solar.solar_position(np.full_like(hours, MAR_21), hours, LAT, LON, TZ)
        daylight = float((alt > 0).sum()) / 60.0
        assert daylight == pytest.approx(12.0, abs=0.25)

    def test_the_sun_stays_just_south_of_overhead_at_midsummer(self) -> None:
        # Abu Dhabi is 24.45N, a degree NORTH of the Tropic of Cancer, so the
        # June declination of 23.45 never quite reaches it: at midsummer noon
        # the sun is 89 deg up and still marginally south. One degree further
        # south and this would flip, which is exactly why it is pinned.
        hours = np.arange(11.0, 14.0, 1.0 / 120.0)
        alt, azi, dec = solar.solar_position(
            np.full_like(hours, JUN_21), hours, LAT, LON, TZ
        )
        peak = int(np.argmax(alt))
        assert dec[0] < LAT
        assert alt[peak] == pytest.approx(90.0 - (LAT - dec[0]), abs=0.2)
        assert abs(azi[peak]) < 90.0


class TestSplitGhi:
    def test_night_splits_to_nothing(self) -> None:
        dni, dhi = solar.split_ghi(arr(0.0), arr(-10.0), arr(JUN_21))
        assert dni[0] == 0.0 and dhi[0] == 0.0

    def test_components_are_never_negative(self) -> None:
        days = np.full(200, float(JUN_21))
        alt = np.linspace(-5.0, 85.0, 200)
        ghi = np.linspace(0.0, 1100.0, 200)
        dni, dhi = solar.split_ghi(ghi, alt, days)
        assert np.all(dni >= 0.0) and np.all(dhi >= 0.0)

    def test_a_clear_sky_is_mostly_beam_and_an_overcast_one_is_all_diffuse(self) -> None:
        alt, day = arr(60.0), arr(JUN_21)
        clear_dni, clear_dhi = solar.split_ghi(arr(950.0), alt, day)
        dull_dni, dull_dhi = solar.split_ghi(arr(120.0), alt, day)

        # Erbs: a high clearness index is beam-dominated, a low one is not.
        assert clear_dni[0] > clear_dhi[0]
        assert dull_dhi[0] > dull_dni[0]

    def test_reconstructing_ghi_from_the_split_is_consistent(self) -> None:
        alt = arr(50.0)
        ghi = arr(800.0)
        dni, dhi = solar.split_ghi(ghi, alt, arr(JUN_21))
        horizontal = dni[0] * np.sin(np.radians(alt[0])) + dhi[0]
        assert horizontal == pytest.approx(ghi[0], rel=0.02)


class TestIrradianceOnSurface:
    def test_a_facade_facing_away_from_the_sun_gets_no_beam(self) -> None:
        # Sun due south at 40 deg; a north-facing wall sees diffuse and ground
        # reflection only, so it must be strictly less than the south wall.
        kw = dict(dni=arr(800.0), dhi=arr(120.0), ghi=arr(700.0),
                  altitude_deg=arr(40.0), azimuth_deg=arr(0.0), ground_reflectance=0.2)
        south = solar.irradiance_on_surface(surface_azimuth_deg=0.0, **kw)
        north = solar.irradiance_on_surface(surface_azimuth_deg=180.0, **kw)
        assert north[0] < south[0]
        assert north[0] > 0.0  # diffuse + ground, not zero

    def test_ground_reflection_contributes_to_a_vertical_surface(self) -> None:
        kw = dict(dni=arr(0.0), dhi=arr(100.0), ghi=arr(600.0),
                  altitude_deg=arr(40.0), azimuth_deg=arr(0.0), surface_azimuth_deg=180.0)
        bright = solar.irradiance_on_surface(ground_reflectance=0.4, **kw)
        dark = solar.irradiance_on_surface(ground_reflectance=0.0, **kw)
        assert bright[0] > dark[0]

    def test_night_leaves_only_the_diffuse_terms(self) -> None:
        got = solar.irradiance_on_surface(
            dni=arr(800.0), dhi=arr(0.0), ghi=arr(0.0),
            altitude_deg=arr(-5.0), azimuth_deg=arr(0.0),
            surface_azimuth_deg=0.0, ground_reflectance=0.2,
        )
        assert got[0] == pytest.approx(0.0)


class TestMeanVerticalIrradiance:
    def test_is_the_mean_of_the_four_cardinal_aspects(self) -> None:
        kw = dict(dni=arr(700.0), dhi=arr(150.0), ghi=arr(750.0),
                  altitude_deg=arr(35.0), azimuth_deg=arr(20.0), ground_reflectance=0.2)
        each = [
            solar.irradiance_on_surface(surface_azimuth_deg=float(a), **kw)[0]
            for a in solar.CARDINAL_AZIMUTHS_DEG
        ]
        got = solar.mean_vertical_irradiance(**kw)
        assert got[0] == pytest.approx(sum(each) / 4.0)

    def test_dips_at_solar_noon_at_this_latitude(self) -> None:
        # The documented, counter-intuitive behaviour: with the sun high, a
        # VERTICAL facade receives less beam than it does mid-morning. Flagged
        # in CLAUDE.md as correct rather than a bug — so it is pinned here.
        hours = np.arange(6.0, 18.0, 0.25)
        days = np.full_like(hours, float(JUN_21))
        alt, azi, _ = solar.solar_position(days, hours, LAT, LON, TZ)
        ghi = solar.clear_sky_ghi(days, alt, 1000.0)
        dni, dhi = solar.split_ghi(ghi, alt, days)
        vertical = solar.mean_vertical_irradiance(dni, dhi, ghi, alt, azi, 0.2)

        noon = int(np.argmax(alt))
        assert vertical[noon] < vertical.max()

        # ...while the horizontal surface peaks at noon, as it must. The cap in
        # clear_sky_ghi is raised out of the way here: at 1000 W/m2 the middle
        # of a June day is clipped into a plateau, and argmax would report the
        # plateau's first index rather than the solar peak.
        uncapped = solar.clear_sky_ghi(days, alt, 5000.0)
        assert int(np.argmax(uncapped)) == noon


class TestClearSkyGhi:
    def test_is_zero_when_the_sun_is_down(self) -> None:
        got = solar.clear_sky_ghi(arr(JUN_21), arr(-1.0), 1000.0)
        assert got[0] == 0.0

    def test_is_capped_at_the_stated_peak(self) -> None:
        days = np.full(100, float(JUN_21))
        alt = np.linspace(0.0, 89.0, 100)
        assert solar.clear_sky_ghi(days, alt, 950.0).max() <= 950.0

    def test_rises_with_sun_altitude(self) -> None:
        got = solar.clear_sky_ghi(arr(JUN_21, JUN_21), arr(20.0, 60.0), 2000.0)
        assert got[1] > got[0]

    def test_never_exceeds_the_extraterrestrial_normal(self) -> None:
        days = np.arange(1, 366, dtype=float)
        alt = np.full_like(days, 90.0)
        assert np.all(solar.clear_sky_ghi(days, alt, 5000.0)
                      <= solar.extraterrestrial_normal_w_m2(days))
