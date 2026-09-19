"""Database access.

A connection pool rather than a connection per request: a simulation writes its
results in batches from a background task while HTTP requests continue to poll
run status, so the two must not contend for one connection.

**Every connection is tenant-scoped.** The scope is bound once per request with
`tenant_scope()` and read here, rather than threaded through `main` → `engine`
→ `repository` as a parameter. That is a deliberate departure from the
TypeScript side, where `withTenant(ctx, db => …)` passes the handle explicitly:
here the call graph runs through the physics, and a `tenant_id` argument on the
heat balance would put tenancy in the one module that should know nothing about
it.

The safety that gives up — a forgotten parameter is a type error, a forgotten
context is not — is bought back by `connection()` refusing to open at all when
nothing is bound. A missed entry point then fails loudly on its first query,
instead of quietly writing into whichever tenant the pooled connection last
served.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from uuid import UUID

from psycopg import Connection
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import settings

_pool: ConnectionPool | None = None

# A ContextVar, not a module global: FastAPI runs sync endpoints in a thread
# pool and background tasks in their own context, so a plain global would be
# shared across concurrent runs for different tenants. A ContextVar is copied
# into each context and cannot leak sideways.
_current_tenant: ContextVar[str | None] = ContextVar("current_tenant", default=None)


class NoTenantScope(RuntimeError):
    """Raised when a query is attempted outside `tenant_scope`."""


def pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(
            settings.database_url,
            min_size=1,
            max_size=8,
            kwargs={"row_factory": dict_row},
            open=True,
        )
    return _pool


@contextmanager
def tenant_scope(tenant_id: str | UUID) -> Iterator[None]:
    """Bind the tenant that every connection in this context will be scoped to."""
    if not tenant_id:
        raise NoTenantScope("tenant_scope requires a tenant id")
    token = _current_tenant.set(str(tenant_id))
    try:
        yield
    finally:
        _current_tenant.reset(token)


def current_tenant() -> str:
    """The bound tenant, or raise. Repositories read this to fill `tenant_id`."""
    tenant = _current_tenant.get()
    if tenant is None:
        raise NoTenantScope(
            "no tenant bound — every database access must run inside tenant_scope()"
        )
    return tenant


@contextmanager
def connection() -> Iterator[Connection]:
    """A tenant-scoped connection.

    `set_config(..., true)` is transaction-local, exactly as `withTenant` does
    it in `packages/db/src/client.ts`. The `true` is load-bearing: a
    session-level setting would outlive this checkout and be inherited by
    whichever request is handed the connection next — a cross-tenant read that
    appears only under concurrency, and only in production.
    """
    tenant = current_tenant()
    with pool().connection() as conn:
        conn.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant,))
        yield conn


@contextmanager
def connection_unscoped() -> Iterator[Connection]:
    """A connection with no tenant scope.

    For the liveness check only. Under row-level security this sees no tenant
    rows at all, so it is not a way around the policies — but it is the one
    place the database is not doing the thinking, so keep its queries trivial.
    """
    with pool().connection() as conn:
        yield conn


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None
