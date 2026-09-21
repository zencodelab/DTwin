"""Posting simulation events to the ingest service.

The worker holds no WebSocket of its own. It is a batch compute service that may
run on another box, scale separately, or restart mid-run; giving it fan-out
duties would put client connections in two places and backpressure in two places
to get wrong. Ingest already owns every subscription, so this tells it what
happened and lets it decide who hears.

Every call here is best-effort. A simulation that produced correct results has
succeeded even if nobody was listening — the run row and `simulation_results`
are the durable record, and this is only the live channel on top of them.
"""

from __future__ import annotations

import logging
import os
from typing import Any
from uuid import UUID

import httpx

from . import log as applog

log = logging.getLogger("sim.notify")

INGEST_BASE_URL = os.environ.get("INGEST_BASE_URL", "http://localhost:8787")
TIMEOUT_S = float(os.environ.get("INGEST_NOTIFY_TIMEOUT_S", 3.0))

# A tenant-scoped `service` API key with the `sim:notify` scope, minted through
# createApiKey (packages/db/src/queries/tenancy.ts). It replaces the shared
# INGEST_INTERNAL_TOKEN, which named no tenant and therefore could not be
# checked against one: ingest takes the tenant from the key, never from the
# payload, for the same reason a device never names the tenant it writes into.
INGEST_API_KEY = os.environ.get("INGEST_API_KEY")


def _post(payload: dict[str, Any]) -> bool:
    headers = {"content-type": "application/json"}
    if INGEST_API_KEY:
        headers["authorization"] = f"Bearer {INGEST_API_KEY}"
    # Forward the id, so the last hop of the trace joins the first two. The
    # web proxy gave it to this worker; this worker gives it to ingest.
    request_id = applog.get_request_id()
    if request_id:
        headers["x-request-id"] = request_id

    try:
        response = httpx.post(
            f"{INGEST_BASE_URL}/internal/sim-event",
            json=payload,
            headers=headers,
            timeout=TIMEOUT_S,
        )
        if response.status_code >= 400:
            log.warning("ingest.rejected", extra={
                "eventType": payload.get("type"),
                "status": response.status_code,
                "body": response.text[:200],
            })
            return False
        return True
    except httpx.HTTPError as exc:
        # Debug, not warning: ingest being down is normal in a worker-only
        # deployment, and a failed broadcast changes nothing about the run.
        log.debug("ingest.unreachable", extra={"error": str(exc)})
        return False


def progress(run_id: UUID, building_id: UUID, pct: float) -> None:
    _post({
        "type": "sim.progress",
        "runId": str(run_id),
        "buildingId": str(building_id),
        "progressPct": round(pct, 1),
    })


def summary_payload(summary: Any) -> dict[str, Any]:
    """Serialise a summary the way the TypeScript schema parses it.

    Two different meanings of "no value" have to survive this boundary, and
    Pydantic writes both as null:

    * `SimulationParams` fields are *optional* — absent means "this scenario
      does not override the stored profile". Zod declares them `.optional()`,
      so a null there is a type error, and the field must simply not be sent.
    * Fields like `peakDemandKw` and `startedAt` are *nullable* — null is the
      value, meaning "known to be nothing yet". Those must stay null.

    So `exclude_none` is applied to params only. Blanket-applying it would strip
    the nullable fields Zod requires to be present, and omitting it entirely
    sends nulls into optional fields — which is exactly how this was first
    caught, by ingest rejecting a completed run's broadcast.
    """
    payload = summary.model_dump(mode="json")
    payload["run"]["params"] = summary.run.params.model_dump(
        mode="json", exclude_none=True
    )
    return payload


def complete(run_id: UUID, building_id: UUID, summary: Any) -> None:
    _post({
        "type": "sim.complete",
        "runId": str(run_id),
        "buildingId": str(building_id),
        "summary": summary_payload(summary),
    })


def failed(run_id: UUID, building_id: UUID, error: str) -> None:
    _post({
        "type": "sim.failed",
        "runId": str(run_id),
        "buildingId": str(building_id),
        "error": error[:1000],
    })
