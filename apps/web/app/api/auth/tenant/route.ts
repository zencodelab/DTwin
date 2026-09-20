import { NextResponse } from 'next/server';
import { SwitchTenantRequest } from '@dtwin/types';
import { listMemberships, switchTenant } from '@dtwin/db/queries';
import { currentViewer, unauthorized } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * The tenant switcher.
 *
 * Reads run unscoped because the question is which tenants this user belongs
 * to, which no single tenant scope can answer. The membership check is not
 * done here: `switchTenant` puts it inside the UPDATE's WHERE clause, so there
 * is no window between checking and switching, and a request naming a tenant
 * the user does not belong to changes nothing and returns false.
 *
 * Demo-tenant mode has no viewer, so there is nothing to switch — 401 rather
 * than silently repointing a session that does not exist.
 */
export async function GET() {
  const viewer = await currentViewer();
  if (!viewer) return unauthorized();
  return NextResponse.json({ tenants: await listMemberships(viewer.userId) });
}

export async function POST(request: Request) {
  const viewer = await currentViewer();
  if (!viewer) return unauthorized();

  let parsed;
  try {
    parsed = SwitchTenantRequest.safeParse(await request.json());
  } catch {
    return NextResponse.json({ error: 'malformed request body' }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: 'tenantId must be a uuid' }, { status: 400 });
  }

  const ok = await switchTenant(viewer.sessionId, viewer.userId, parsed.data.tenantId);
  if (!ok) return NextResponse.json({ error: 'not a member of that tenant' }, { status: 403 });
  return NextResponse.json({ ok: true });
}
