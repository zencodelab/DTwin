import { listActiveTenants } from '@dtwin/db/queries';

/**
 * Ingest is one process serving every tenant.
 *
 * That is a deliberate choice and the reason several things in this service
 * look more complicated than their single-tenant versions: the sensor registry,
 * the write buffer and the alert engine all span tenants, while every database
 * statement they issue must be scoped to exactly one.
 *
 * The alternative — a process per tenant — removes that complexity and
 * replaces it with N WebSocket servers, N connection pools and N device
 * endpoints to route between. For a service whose whole job is fan-out, one
 * process holding scoped handles is the smaller problem.
 *
 * The rule that follows, and it is the only one that matters here: **nothing in
 * this service may hold a database handle that is not scoped to one tenant.**
 * `withTenant` is the only way in.
 */
export interface TenantRef {
  id: string;
  slug: string;
}

export async function activeTenants(): Promise<TenantRef[]> {
  return listActiveTenants();
}
