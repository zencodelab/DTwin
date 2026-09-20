"""What one request may ask of the worker.

The request used to be bounded only by `intervalS > 0`, so a century at
one-second resolution validated. §47's admission cap limits how MANY runs there
are; these are about how large one of them may be.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from app.models import (
    MAX_INTERVALS,
    MIN_INTERVAL_S,
    SimulationRequest,
    WeatherGenerateRequest,
)

START = datetime(2026, 6, 20, tzinfo=UTC)
BUILDING = "246e02dc-e011-4a8e-80b0-9e47680e0b09"
SYNTHETIC = {"mode": "synthetic", "peakDryBulbC": 42.0, "minDryBulbC": 30.0}


def request(**overrides: object) -> SimulationRequest:
    body: dict[str, object] = {
        "buildingId": BUILDING, "scenarioName": "bounds",
        "periodStart": START, "periodEnd": START + timedelta(days=3),
        "weather": SYNTHETIC,
    }
    body.update(overrides)
    return SimulationRequest(**body)  # type: ignore[arg-type]


class TestSimulationRequest:
    def test_an_ordinary_run_is_accepted(self) -> None:
        assert request().intervalS == 3600

    def test_a_year_at_fifteen_minutes_is_accepted(self) -> None:
        # The finest resolution worth comparing against a bill or a BMS trend,
        # and what the ceiling was chosen to admit.
        request(periodEnd=START + timedelta(days=365), intervalS=900)

    def test_exactly_at_the_ceiling_is_accepted(self) -> None:
        request(periodEnd=START + timedelta(seconds=MAX_INTERVALS * 3600))

    def test_one_interval_over_is_refused_and_says_the_limit(self) -> None:
        with pytest.raises(ValidationError) as err:
            request(periodEnd=START + timedelta(seconds=(MAX_INTERVALS + 1) * 3600))
        assert f"{MAX_INTERVALS:,}" in str(err.value)

    def test_a_century_is_refused(self) -> None:
        with pytest.raises(ValidationError):
            request(periodEnd=START + timedelta(days=36_500))

    def test_a_one_second_interval_is_refused(self) -> None:
        # The substep is min(300 s, interval), so this would also be a
        # one-second physics step.
        with pytest.raises(ValidationError):
            request(periodEnd=START + timedelta(hours=1), intervalS=1)
        request(periodEnd=START + timedelta(hours=1), intervalS=MIN_INTERVAL_S)

    def test_an_interval_longer_than_a_day_is_refused(self) -> None:
        with pytest.raises(ValidationError):
            request(intervalS=86_401)

    def test_a_reversed_period_is_still_refused(self) -> None:
        with pytest.raises(ValidationError):
            request(periodEnd=START - timedelta(days=1))

    def test_the_zone_list_is_bounded(self) -> None:
        ids = ["246e02dc-e011-4a8e-80b0-9e47680e0b09"] * 5001
        with pytest.raises(ValidationError):
            request(zoneIds=ids)

    def test_an_inline_series_is_bounded(self) -> None:
        point = {"ts": START, "dryBulbC": 30.0}
        with pytest.raises(ValidationError):
            request(weather={"mode": "inline", "series": [point] * (MAX_INTERVALS + 1)})

    def test_free_text_is_bounded(self) -> None:
        with pytest.raises(ValidationError):
            request(scenarioName="x" * 201)
        with pytest.raises(ValidationError):
            request(description="x" * 2001)


class TestWeatherGenerateRequest:
    def test_shares_the_same_ceiling(self) -> None:
        # One row per interval into weather_observations: an unbounded period
        # is an unbounded insert.
        WeatherGenerateRequest(
            buildingId=BUILDING, periodStart=START, periodEnd=START + timedelta(days=30))
        with pytest.raises(ValidationError):
            WeatherGenerateRequest(
                buildingId=BUILDING, periodStart=START,
                periodEnd=START + timedelta(days=36_500))
