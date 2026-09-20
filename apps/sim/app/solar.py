"""Solar position and irradiance on building surfaces.

Duffie & Beckman, *Solar Engineering of Thermal Processes*, chapters 1-2. The
equations are standard; what matters for this model is that solar gain through
glazing dominates cooling load in a Gulf climate, so approximating it with a
flat fraction of GHI would put the largest term in the heat balance on a guess.

`pvlib` implements all of this (and more accurately, using the NREL SPA
algorithm). It is not used here because these correlations are within a fraction
of a degree for a building-energy timestep, and the whole worker is currently
one modest dependency set. Swapping in pvlib later is a drop-in for
`solar_position`.

`mean_vertical_irradiance` averages over the four cardinal orientations and is
now the FALLBACK, not the default. Orientation was never missing from the
model — it is derivable from the stored polygons — so `engine.zone_irradiance`
gives each zone irradiance on the walls it actually has, and falls back to this
average only where the geometry and the asset register disagree. See
`facade.py` and docs/decisions.md §49.
"""

from __future__ import annotations

import numpy as np

SOLAR_CONSTANT_W_M2 = 1367.0

# Surface azimuths measured from south, positive west (Duffie's convention):
# south, west, north, east.
CARDINAL_AZIMUTHS_DEG = np.array([0.0, 90.0, 180.0, -90.0])


def declination_deg(day_of_year: np.ndarray) -> np.ndarray:
    """Cooper's equation."""
    return 23.45 * np.sin(np.radians(360.0 * (284.0 + day_of_year) / 365.0))


def equation_of_time_min(day_of_year: np.ndarray) -> np.ndarray:
    """Discrepancy between apparent and mean solar time, in minutes."""
    b = np.radians(360.0 * (day_of_year - 81.0) / 364.0)
    return 9.87 * np.sin(2 * b) - 7.53 * np.cos(b) - 1.5 * np.sin(b)


def hour_angle_deg(
    clock_hour: np.ndarray,
    day_of_year: np.ndarray,
    longitude_east_deg: float,
    tz_offset_h: float,
) -> np.ndarray:
    """Hour angle: 0 at solar noon, 15 degrees per hour, positive afternoon.

    The longitude correction is why a site is not at solar noon when its clock
    says 12:00 — Abu Dhabi at 54.4E sits west of the UTC+4 standard meridian
    (60E), so its solar noon falls about 22 minutes later than the clock's.
    """
    correction_min = 4.0 * (longitude_east_deg - 15.0 * tz_offset_h) + equation_of_time_min(
        day_of_year
    )
    solar_hour = clock_hour + correction_min / 60.0
    return 15.0 * (solar_hour - 12.0)


def solar_position(
    day_of_year: np.ndarray,
    clock_hour: np.ndarray,
    latitude_deg: float,
    longitude_east_deg: float,
    tz_offset_h: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (altitude_deg, azimuth_deg_from_south, declination_deg)."""
    phi = np.radians(latitude_deg)
    delta = np.radians(declination_deg(day_of_year))
    omega = np.radians(
        hour_angle_deg(clock_hour, day_of_year, longitude_east_deg, tz_offset_h)
    )

    sin_alt = np.sin(phi) * np.sin(delta) + np.cos(phi) * np.cos(delta) * np.cos(omega)
    sin_alt = np.clip(sin_alt, -1.0, 1.0)
    altitude = np.arcsin(sin_alt)

    cos_zenith = sin_alt
    sin_zenith = np.sqrt(np.clip(1.0 - cos_zenith**2, 0.0, 1.0))

    # Guard the pole/zenith degeneracy where azimuth is undefined.
    denom = np.where(sin_zenith * np.cos(phi) == 0.0, 1e-9, sin_zenith * np.cos(phi))
    cos_azimuth = np.clip((cos_zenith * np.sin(phi) - np.sin(delta)) / denom, -1.0, 1.0)
    azimuth = np.sign(omega) * np.abs(np.arccos(cos_azimuth))

    return np.degrees(altitude), np.degrees(azimuth), np.degrees(delta)


def extraterrestrial_normal_w_m2(day_of_year: np.ndarray) -> np.ndarray:
    """Solar constant corrected for the Earth's orbital eccentricity."""
    return SOLAR_CONSTANT_W_M2 * (
        1.0 + 0.033 * np.cos(np.radians(360.0 * day_of_year / 365.0))
    )


def split_ghi(
    ghi: np.ndarray, altitude_deg: np.ndarray, day_of_year: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Erbs correlation: split global horizontal into (dni, dhi).

    Used when a weather record carries GHI but no DNI. Beam and diffuse strike a
    vertical facade completely differently — beam depends on incidence angle,
    diffuse barely does — so treating all of GHI as one component would misstate
    the gain badly at low sun angles.
    """
    sin_alt = np.sin(np.radians(altitude_deg))
    daytime = sin_alt > 0.01

    i0 = extraterrestrial_normal_w_m2(day_of_year)
    with np.errstate(divide="ignore", invalid="ignore"):
        kt = np.where(daytime, ghi / np.maximum(i0 * sin_alt, 1e-6), 0.0)
    kt = np.clip(kt, 0.0, 1.0)

    diffuse_fraction = np.where(
        kt <= 0.22,
        1.0 - 0.09 * kt,
        np.where(
            kt <= 0.80,
            0.9511
            - 0.1604 * kt
            + 4.388 * kt**2
            - 16.638 * kt**3
            + 12.336 * kt**4,
            0.165,
        ),
    )

    dhi = np.where(daytime, ghi * diffuse_fraction, 0.0)
    dni = np.where(daytime, (ghi - dhi) / np.maximum(sin_alt, 1e-6), 0.0)
    return np.maximum(dni, 0.0), np.maximum(dhi, 0.0)


def cos_incidence(
    altitude_deg: np.ndarray,
    azimuth_deg: np.ndarray,
    surface_azimuth_deg: float,
    surface_tilt_deg: float = 90.0,
) -> np.ndarray:
    """Cosine of the angle between the sun and a surface normal."""
    alt = np.radians(altitude_deg)
    gamma_s = np.radians(azimuth_deg)
    gamma = np.radians(surface_azimuth_deg)
    beta = np.radians(surface_tilt_deg)

    return np.cos(alt) * np.sin(beta) * np.cos(gamma_s - gamma) + np.sin(alt) * np.cos(beta)


def irradiance_on_surface(
    dni: np.ndarray,
    dhi: np.ndarray,
    ghi: np.ndarray,
    altitude_deg: np.ndarray,
    azimuth_deg: np.ndarray,
    surface_azimuth_deg: float,
    ground_reflectance: float,
    surface_tilt_deg: float = 90.0,
) -> np.ndarray:
    """Total irradiance on a tilted surface, isotropic sky (Liu & Jordan).

    Three components: beam by incidence angle, diffuse from the sky dome, and
    ground reflection — which is not a rounding error on a vertical facade,
    where it sees half its view of bright ground.
    """
    beta = np.radians(surface_tilt_deg)
    cos_theta = np.maximum(cos_incidence(altitude_deg, azimuth_deg, surface_azimuth_deg,
                                         surface_tilt_deg), 0.0)
    daytime = altitude_deg > 0.0

    beam = np.where(daytime, dni * cos_theta, 0.0)
    sky = dhi * (1.0 + np.cos(beta)) / 2.0
    ground = ghi * ground_reflectance * (1.0 - np.cos(beta)) / 2.0
    return beam + sky + ground


def mean_vertical_irradiance(
    dni: np.ndarray,
    dhi: np.ndarray,
    ghi: np.ndarray,
    altitude_deg: np.ndarray,
    azimuth_deg: np.ndarray,
    ground_reflectance: float,
) -> np.ndarray:
    """Irradiance on a vertical facade averaged over the four cardinal aspects.

    See the module docstring: zone orientation is not recorded, so this is the
    honest aggregate rather than a guess at which way each zone faces.
    """
    total = np.zeros_like(ghi, dtype=float)
    for surface_azimuth in CARDINAL_AZIMUTHS_DEG:
        total += irradiance_on_surface(
            dni, dhi, ghi, altitude_deg, azimuth_deg,
            float(surface_azimuth), ground_reflectance,
        )
    return total / len(CARDINAL_AZIMUTHS_DEG)


def clear_sky_ghi(
    day_of_year: np.ndarray, altitude_deg: np.ndarray, peak_ghi_w_m2: float
) -> np.ndarray:
    """Clear-sky GHI for synthetic weather.

    Derived from actual sun position rather than a bare sine over the day, so a
    synthetic run still has correct day length and solar timing for the site and
    season — the things that determine when the cooling peak lands.
    """
    sin_alt = np.maximum(np.sin(np.radians(altitude_deg)), 0.0)
    transmittance = 0.78  # typical clear-sky bulk atmospheric transmittance
    return np.minimum(
        extraterrestrial_normal_w_m2(day_of_year) * sin_alt * transmittance,
        peak_ghi_w_m2,
    )
