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
    series: Annotated[list[WeatherPoint], Field(min_length=1)]


class SyntheticWeather(Wire):
    mode: Literal["synthetic"]
    peakDryBulbC: float
    minDryBulbC: float
    peakGhiW_m2: Annotated[float, Field(ge=0)] = 950.0


WeatherSpec = Annotated[
    ObservedWeather | InlineWeather | SyntheticWeather, Field(discriminator="mode")
]


class SimulationRequest(Wire):
    buildingId: UUID
    scenarioName: str
    description: str | None = None
    periodStart: datetime
    periodEnd: datetime
    intervalS: Annotated[int, Field(gt=0)] = 3600
    params: SimulationParams = SimulationParams()
    zoneIds: list[UUID] | None = None
    weather: WeatherSpec = ObservedWeather(mode="observed")

    @model_validator(mode="after")
    def _period_ordered(self) -> SimulationRequest:
        if self.periodEnd <= self.periodStart:
            raise ValueError("periodEnd must be after periodStart")
        return self


class EnergyBreakdown(Wire):
    hvacKwh: float
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
    intervalS: Annotated[int, Field(gt=0)] = 3600
    peakDryBulbC: float = 42.0
    minDryBulbC: float = 30.0
    peakGhiW_m2: Annotated[float, Field(ge=0)] = 950.0
