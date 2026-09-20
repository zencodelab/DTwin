"""Caller authentication for the simulation worker.

The worker's only legitimate caller is the web service, acting for a person it
has already authenticated. Until now that was the whole of it: the tenant
arrived in `X-Tenant-Id` and the worker believed it, which is sound exactly as
long as nothing else can reach the port. `interview/08` listed it as a known
gap and the route's own docstring said it should present a service key "like
the one it already uses to reach POST /internal/sim-event".

So the two are now separate questions:

  * the API KEY answers *who is calling*, and whether that caller is entitled
    to name a tenant at all;
  * `X-Tenant-Id` answers *for whom*, which the key deliberately does NOT,
    because one web service serves every tenant and would otherwise need a key
    per tenant.

That is the same shape ingest uses for `x-acting-user`: a header is trusted
only once the credential beside it has been verified.

Verification mirrors packages/db/src/auth.ts exactly — prefix narrows the index
scan, the SHA-256 authenticates, and the comparison happens in SQL rather than
in application code so there is no timing comparison here to get wrong. Tokens
are stored as an unsalted digest on purpose: the input is 256 bits of entropy,
so there is nothing to brute-force and no reason to pay a KDF per request.
"""

from __future__ import annotations

import hashlib
import os

from fastapi import Header, HTTPException

from .db import connection_unscoped

# What a key must carry to ask this worker to run a simulation.
SCOPE = "sim:run"

# Off only for a worker on a closed network with no proxy in front of it. The
# default is on, because a default that works everywhere is a default that
# ships — the same reason AUTH_SECRET has none.
REQUIRE_API_KEY = os.environ.get("SIM_REQUIRE_API_KEY", "true") == "true"


def _bearer(header: str | None) -> str | None:
    if not header:
        return None
    parts = header.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return header.strip() or None


def verify_caller(authorization: str | None = Header(default=None)) -> None:
    """Refuse a caller that cannot present a key with the sim:run scope.

    Runs unscoped, necessarily: `api_keys` carries no tenant policy, because
    authenticating has to work before a tenant is known.
    """
    if not REQUIRE_API_KEY:
        return

    key = _bearer(authorization)
    if not key:
        raise HTTPException(
            status_code=401,
            detail="an API key with the sim:run scope is required",
        )

    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    with connection_unscoped() as conn:
        row = conn.execute(
            """
            SELECT 1 FROM api_keys k
              JOIN tenants t ON t.id = k.tenant_id
             WHERE k.key_prefix = %s
               AND k.key_hash = %s
               AND %s = ANY(k.scopes)
               AND k.revoked_at IS NULL
               AND (k.expires_at IS NULL OR k.expires_at > now())
               AND t.status = 'active'
            """,
            (key[:8], digest, SCOPE),
        ).fetchone()

    if row is None:
        # One message for an unknown key, a revoked one and a key without the
        # scope alike: distinguishing them tells an attacker which half of the
        # credential was right.
        raise HTTPException(status_code=401, detail="invalid API key")
