"""Weather series assembly for a simulation timeline.

Produces the external boundary condition at integration-step resolution for all
three request modes, together with the solar geometry each step needs.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np

from . import repository, solar
from .models import SimulationRequest


class WeatherSeries:
    """Boundary conditions and sun position, aligned to the integration steps."""

    def __init__(
        self,
        dry_bulb_c: np.ndarray,
        rh_pct: np.ndarray,
        ghi: np.ndarray,
        dni: np.ndarray,
        dhi: np.ndarray,
        altitude_deg: np.ndarray,
        azimuth_deg: np.ndarray,
        vertical_irradiance: np.ndarray,
        local_hour: np.ndarray,
        day_type_index: np.ndarray,
    ) -> None:
        self.dry_bulb_c = dry_bulb_c
        # Relative humidity is in the weather table and was never read. It is
        # what the latent load is computed from — see engine.py and §48.
        self.rh_pct = rh_pct
        self.ghi = ghi
        self.dni = dni
        self.dhi = dhi
        self.altitude_deg = altitude_deg
        # Carried so a zone can be given irradiance on its OWN facades rather
        # than the cardinal average — see engine.zone_irradiance and §49.
        self.azimuth_deg = azimuth_deg
        self.vertical_irradiance = vertical_irradiance
        self.local_hour = local_hour
        self.day_type_index = day_type_index


DAY_TYPES = ["weekday", "saturday", "sunday", "holiday"]


def _local_calendar(
    stamps: list[datetime], timezone: str
) -> tuple[np.ndarray, np.ndarray, np.ndarray, float]:
    """Local hour, day-of-year and day-type for each step, in the site's timezone.

    Solar time and occupancy schedules are both local concepts. Running either
    off UTC would shift the solar peak and put the working day in the wrong
    place — in Abu Dhabi, by four hours.
    """
    tz = ZoneInfo(timezone)
    hours = np.empty(len(stamps), dtype=float)
    doy = np.empty(len(stamps), dtype=float)
    day_type = np.empty(len(stamps), dtype=np.int64)

    for i, ts in enumerate(stamps):
        local = ts.astimezone(tz)
        hours[i] = local.hour + local.minute / 60.0 + local.second / 3600.0
        doy[i] = local.timetuple().tm_yday
        weekday = local.weekday()  # Monday = 0
        day_type[i] = 1 if weekday == 5 else 2 if weekday == 6 else 0

    offset = stamps[0].astimezone(tz).utcoffset()
    tz_offset_h = offset.total_seconds() / 3600.0 if offset else 0.0
    return hours, doy, day_type, tz_offset_h


def diurnal_relative_humidity(
    dry_bulb_c: np.ndarray, min_c: float
) -> np.ndarray:
    """Relative humidity from dry bulb, for a coastal site.

    Absolute humidity varies far less over a day than relative humidity does:
    the air holds roughly the same water and the temperature swing moves the
    saturation point past it. So RH is modelled as falling as the day warms,
    which is the shape a coastal station actually records — high at dawn, low
    in the afternoon, and never dry, because the sea is there.

    Extracted from the weather generator, where it already was: the generator
    wrote this into `weather_observations` and the simulation then had no way
    to read it back for a synthetic run. One correlation, both paths.
    """
    return np.clip(95.0 - (np.asarray(dry_bulb_c, dtype=float) - min_c) * 3.5, 20.0, 95.0)


def build(
    request: SimulationRequest,
    building: dict,
    stamps: list[datetime],
    ground_reflectance: float,
) -> WeatherSeries:
    local_hour, doy, day_type, tz_offset = _local_calendar(stamps, building["timezone"])

    latitude = building.get("latitude")
    longitude = building.get("longitude")
    if latitude is None or longitude is None:
        raise ValueError(
            "building has no location; solar gain cannot be computed without one"
        )

    altitude, azimuth, _ = solar.solar_position(
        doy, local_hour, float(latitude), float(longitude), tz_offset
    )

    spec = request.weather
    epoch = np.array([ts.timestamp() for ts in stamps], dtype=float)

    if spec.mode == "synthetic":
        ghi = solar.clear_sky_ghi(doy, altitude, spec.peakGhiW_m2)
        dry_bulb = _diurnal_temperature(local_hour, spec.minDryBulbC, spec.peakDryBulbC)
        rh = diurnal_relative_humidity(dry_bulb, spec.minDryBulbC)
        dni, dhi = solar.split_ghi(ghi, altitude, doy)

    else:
        if spec.mode == "inline":
            source = [
                (p.ts.timestamp(), p.dryBulbC, p.ghiW_m2, p.dniW_m2, p.rhPct)
                for p in spec.series
            ]
        else:
            rows = repository.load_weather(
                request.buildingId, request.periodStart, request.periodEnd
            )
            if not rows:
                # An explicit failure beats silently substituting a design day:
                # the caller asked to replay measured weather and there is none.
                raise ValueError(
                    "weather mode 'observed' but weather_observations holds no rows "
                    "for this building and period — generate or ingest weather first, "
                    "or use mode 'synthetic'"
                )
            source = [
                (r["time"].timestamp(), r["dry_bulb_c"], r["ghi_w_m2"],
                 r["dni_w_m2"], r["rh_pct"])
                for r in rows
            ]

        src_t = np.array([s[0] for s in source], dtype=float)
        dry_bulb = np.interp(epoch, src_t, np.array([s[1] for s in source], dtype=float))

        # `rh_pct` is nullable in weather_observations and optional on an inline
        # point, so a series without it falls back to the same correlation the
        # synthetic path uses rather than to a constant — a fixed number would
        # flatten the daily swing that drives most of the latent load.
        rh_src = np.array(
            [s[4] if s[4] is not None else np.nan for s in source], dtype=float
        )
        if np.all(np.isnan(rh_src)):
            rh = diurnal_relative_humidity(dry_bulb, float(np.min(dry_bulb)))
        else:
            rh = np.interp(epoch, src_t, np.nan_to_num(rh_src, nan=float(
                np.nanmean(rh_src))))

        ghi_src = np.array(
            [s[2] if s[2] is not None else np.nan for s in source], dtype=float
        )
        if np.all(np.isnan(ghi_src)):
            # No measured irradiance: fall back to clear sky rather than zero,
            # which would remove the dominant cooling term entirely.
            ghi = solar.clear_sky_ghi(doy, altitude, 950.0)
        else:
            ghi = np.interp(epoch, src_t, np.nan_to_num(ghi_src))

        dni_src = np.array(
            [s[3] if s[3] is not None else np.nan for s in source], dtype=float
        )
        if np.all(np.isnan(dni_src)):
            dni, dhi = solar.split_ghi(ghi, altitude, doy)
        else:
            dni = np.interp(epoch, src_t, np.nan_to_num(dni_src))
            dhi = np.maximum(ghi - dni * np.sin(np.radians(np.maximum(altitude, 0.0))), 0.0)

    vertical = solar.mean_vertical_irradiance(
        dni, dhi, ghi, altitude, azimuth, ground_reflectance
    )

    return WeatherSeries(
        dry_bulb_c=dry_bulb, rh_pct=rh, ghi=ghi, dni=dni, dhi=dhi,
        altitude_deg=altitude, azimuth_deg=azimuth, vertical_irradiance=vertical,
        local_hour=local_hour, day_type_index=day_type,
    )


def _diurnal_temperature(
    local_hour: np.ndarray, min_c: float, peak_c: float
) -> np.ndarray:
    """Sinusoid with its minimum near 03:00 and peak near 15:00.

    Air temperature lags solar noon by a few hours because the ground keeps
    releasing stored heat; a curve peaking at noon would put the cooling peak an
    hour or two early.
    """
    mean = (peak_c + min_c) / 2.0
    amplitude = (peak_c - min_c) / 2.0
    return mean + amplitude * np.sin(2 * np.pi * (local_hour - 9.0) / 24.0)


def generate_rows(
    building: dict,
    start: datetime,
    end: datetime,
    interval_s: int,
    min_c: float,
    peak_c: float,
    peak_ghi: float,
) -> list[tuple]:
    """Synthetic hourly weather for storage, so the `observed` path has data."""
    stamps: list[datetime] = []
    cursor = start
    while cursor <= end:
        stamps.append(cursor)
        cursor += timedelta(seconds=interval_s)

    local_hour, doy, _, tz_offset = _local_calendar(stamps, building["timezone"])
    altitude, _, _ = solar.solar_position(
        doy, local_hour, float(building["latitude"]), float(building["longitude"]), tz_offset
    )
    ghi = solar.clear_sky_ghi(doy, altitude, peak_ghi)
    dni, _ = solar.split_ghi(ghi, altitude, doy)
    dry_bulb = _diurnal_temperature(local_hour, min_c, peak_c)
    # Gulf coastal humidity: high overnight, falling as the air warms.
    rh = diurnal_relative_humidity(dry_bulb, min_c)

    return [
        (
            stamps[i], building["id"], float(dry_bulb[i]), float(rh[i]),
            float(ghi[i]), float(dni[i]), 3.0,
        )
        for i in range(len(stamps))
    ]
