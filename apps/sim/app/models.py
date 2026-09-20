"""Pydantic models mirroring `packages/types/src/simulation.ts`.

This duplication is the price of the two-language split, paid deliberately and
in one place. Field names match the TypeScript exactly (camelCase on the wire)
so the contract is checkable by eye, and the smoke test round-trips a request
built from the TypeScript shapes to catch drift.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Wire(BaseModel):
    """camelCase on the wire, matching @dtwin/types."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


# How much one request may ask for.
#
# The request was bounded only by `intervalS > 0` and `periodEnd > periodStart`,
# so a century at one-second resolution was a valid request: three billion
# intervals, written as rows, by a worker that would accept it with a 202 and
# then run until something killed it. The admission cap from §47 limits how
# MANY runs there are and said nothing about how large one may be.
#
# 40,000 intervals is a year at fifteen minutes, which is the finest resolution
# a utility bill or a BMS trend is worth comparing against. The interval floor
# matters as much as the count: the integration substep is min(300 s, interval),
# so a one-second interval would also mean a one-second physics step.
MAX_INTERVALS = 40_000
MIN_INTERVAL_S = 60
MAX_INTERVAL_S = 86_400


class WeatherPoint(Wire):
    ts: datetime
    dryBulbC: float
    rhPct: float | None = None
    ghiW_m2: float | None = None
    dniW_m2: float | None = None
    windM_s: float | None = None
    cloudPct: float | None = None


class SimulationParams(Wire):
    setpointDeltaK: float | None = None
    lightingScale: Annotated[float, Field(gt=0)] | None = None
    equipmentScale: Annotated[float, Field(gt=0)] | None = None
    occupancyScale: Annotated[float, Field(gt=0)] | None = None
    hvacCopScale: Annotated[float, Field(gt=0)] | None = None
    infiltrationScale: Annotated[float, Field(gt=0)] | None = None
    gridCarbonKgPerKwh: Annotated[float, Field(ge=0)] | None = None


class ObservedWeather(Wire):
    mode: Literal["observed"]


class InlineWeather(Wire):
    mode: Literal["inline"]
    series: Annotated[list[WeatherPoint], Field(min_length=1, max_length=MAX_INTERVALS)]


class SyntheticWeather(Wire):
    mode: Literal["synthetic"]
    peakDryBulbC: float
    minDryBulbC: float
    peakGhiW_m2: Annotated[float, Field(ge=0)] = 950.0


WeatherSpec = Annotated[
    ObservedWeather | InlineWeather | SyntheticWeather, Field(discriminator="mode")
]


def _check_period(start: datetime, end: datetime, interval_s: int) -> None:
    """Shared by both requests that take a period and an interval."""
    if end <= start:
        raise ValueError("periodEnd must be after periodStart")
    intervals = (end - start).total_seconds() / interval_s
    if intervals > MAX_INTERVALS:
        raise ValueError(
            f"period is {intervals:,.0f} intervals at {interval_s}s; the most one "
            f"request may ask for is {MAX_INTERVALS:,}. Shorten the period or "
            "lengthen the interval."
        )


class SimulationRequest(Wire):
    buildingId: UUID
    scenarioName: Annotated[str, Field(min_length=1, max_length=200)]
    description: Annotated[str, Field(max_length=2000)] | None = None
    periodStart: datetime
    periodEnd: datetime
    intervalS: Annotated[int, Field(ge=MIN_INTERVAL_S, le=MAX_INTERVAL_S)] = 3600
    params: SimulationParams = SimulationParams()
    zoneIds: Annotated[list[UUID], Field(max_length=5000)] | None = None
    weather: WeatherSpec = ObservedWeather(mode="observed")

    @model_validator(mode="after")
    def _period_bounded(self) -> SimulationRequest:
        _check_period(self.periodStart, self.periodEnd, self.intervalS)
        return self


class EnergyBreakdown(Wire):
    hvacKwh: float
    # A SUBSET of hvacKwh, not an addition to it: the dehumidification share.
    # Nullable because a run made before the latent model existed has none to
    # report, and 0.0 would claim it measured moisture and found none.
    latentKwh: float | None = None
    # Also a subset of hvacKwh: supply-fan electricity.
    fanKwh: float | None = None
    lightingKwh: float
    plugKwh: float
    totalKwh: float
    co2Kg: float
    peakDemandKw: float | None = None
    euiKwhPerM2: float | None = None
    unmetHours: float | None = None


class ZoneBreakdown(EnergyBreakdown):
    zoneId: UUID
    zoneName: str


class SimulationRun(Wire):
    id: UUID
    buildingId: UUID
    scenarioName: str
    description: str | None
    periodStart: datetime
    periodEnd: datetime
    intervalS: int
    params: SimulationParams
    status: Literal["queued", "running", "completed", "failed", "cancelled"]
    progressPct: float
    requestedAt: datetime
    startedAt: datetime | None
    completedAt: datetime | None
    error: str | None


class SimulationSummary(Wire):
    run: SimulationRun
    building: EnergyBreakdown
    byZone: list[ZoneBreakdown]


class WeatherGenerateRequest(Wire):
    """Populate `weather_observations` so the `observed` path has something to read."""

    buildingId: UUID
    periodStart: datetime
    periodEnd: datetime
    intervalS: Annotated[int, Field(ge=MIN_INTERVAL_S, le=MAX_INTERVAL_S)] = 3600
    peakDryBulbC: float = 42.0
    minDryBulbC: float = 30.0
    peakGhiW_m2: Annotated[float, Field(ge=0)] = 950.0

    @model_validator(mode="after")
    def _period_bounded(self) -> WeatherGenerateRequest:
        # Same ceiling as a simulation: this writes one row per interval into
        # weather_observations, so an unbounded period is an unbounded insert.
        _check_period(self.periodStart, self.periodEnd, self.intervalS)
        return self
