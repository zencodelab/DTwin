"""Configuration, parsed once at import.

Mirrors the discipline the TypeScript services use: a worker that starts with a
malformed interval and only misbehaves mid-simulation is worse than one that
refuses to start.
"""

import os

from pydantic import BaseModel, Field


class Settings(BaseModel):
    database_url: str = Field(
        default_factory=lambda: os.environ.get(
            "DATABASE_URL", "postgres://dtwin:dtwin_dev_pwd@localhost:5432/dtwin"
        )
    )
    port: int = Field(default_factory=lambda: int(os.environ.get("SIM_PORT", 8000)))

    # Integration step inside each reporting interval. The zone time constant
    # (mass / conductance) runs to tens of hours, so 300 s is far inside the
    # stability limit for explicit stepping while staying cheap.
    substep_s: int = Field(
        default_factory=lambda: int(os.environ.get("SIM_SUBSTEP_S", 300))
    )

    # Ground reflectance for the reflected component of surface irradiance.
    # 0.2 is the standard value for ordinary ground; sand and light paving run
    # higher, which matters in a Gulf context.
    ground_reflectance: float = Field(
        default_factory=lambda: float(os.environ.get("SIM_GROUND_REFLECTANCE", 0.2))
    )

    # Plant is auto-sized from each zone's design load; this is the safety
    # margin an engineer would apply on top.
    capacity_safety_factor: float = Field(
        default_factory=lambda: float(os.environ.get("SIM_CAPACITY_FACTOR", 1.25))
    )

    # How many runs this process will execute at once.
    #
    # A cap on THIS process, deliberately, not a queue depth across replicas: a
    # run is CPU-bound numpy in FastAPI's thread pool, and the thing being
    # protected is this machine. Past the cap /simulate answers 429 rather than
    # accepting work it will not get to, because a 202 that means "queued
    # behind an unbounded number of others" is a promise the worker cannot
    # keep. Two by default — enough to compare a baseline against a scenario.
    max_concurrent_runs: int = Field(
        default_factory=lambda: int(os.environ.get("SIM_MAX_CONCURRENT_RUNS", 2))
    )

    # Fail runs left mid-flight by a previous process, at startup.
    #
    # A BackgroundTask dies with its process, so a restart leaves rows at
    # `running` with no one advancing them — indistinguishable, to a caller
    # polling, from a run that is merely slow. Off only for a deployment
    # running several workers against one database, where another process's
    # live run is not this one's orphan.
    reap_orphans_on_start: bool = Field(
        default_factory=lambda: os.environ.get("SIM_REAP_ORPHANS", "true") == "true"
    )


settings = Settings()
