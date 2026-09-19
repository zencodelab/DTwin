import { withTenant } from '@dtwin/db';
import { getSpatialTree } from '@dtwin/db/queries';
import { Dashboard } from '@/components/Dashboard';
import { currentTenant } from '@/lib/tenant';

/**
 * The spatial tree is loaded on the server and handed to the client in one
 * piece — no request waterfall, and the canvas has every zone, asset and point
 * it needs before its first frame.
 *
 * Rendered per request rather than prerendered: this page is a view onto live
 * state, and a build-time snapshot would be wrong the moment it was taken. It
 * also means `next build` does not need a database.
 */
export const dynamic = 'force-dynamic';

export default async function Page() {
  const ctx = await currentTenant();
  if (!ctx) {
    return (
      <EmptyState message="Not signed in, and no demo tenant is configured. Set DTWIN_DEMO_TENANT_ID to a seeded tenant." />
    );
  }

  // One transaction for both reads. The tenant scope IS the transaction scope,
  // so splitting these would open two of them to answer one page.
  const result = await withTenant(ctx, async (db) => {
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM buildings ORDER BY name LIMIT 1',
    );
    const buildingId = rows[0]?.id;
    if (!buildingId) return null;
    return getSpatialTree(db, buildingId);
  });

  if (!result) {
    return (
      <EmptyState message="No building visible for this tenant. Run the migrations and seed, and check DTWIN_DEMO_TENANT_ID matches a seeded tenant." />
    );
  }

  return (
    <Dashboard
      tree={result}
      tenantId={ctx.tenantId}
      wsUrl={process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8787/ws'}
    />
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <main className="grid h-screen place-items-center p-8">
      <div className="panel max-w-md p-6 text-center">
        <h1 className="mb-2 text-lg font-semibold">Nothing to show yet</h1>
        <p style={{ color: 'var(--text-secondary)' }}>{message}</p>
        <code className="mt-4 block text-sm" style={{ color: 'var(--text-muted)' }}>
          npm run db:up &amp;&amp; npm run db:migrate
        </code>
      </div>
    </main>
  );
}
