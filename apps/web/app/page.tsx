import { redirect } from 'next/navigation';
import { withTenant } from '@dtwin/db';
import { getSpatialTree, getTenant, SpatialTreeTooLargeError } from '@dtwin/db/queries';
import { Dashboard } from '@/components/Dashboard';
import { currentTenant, currentViewer } from '@/lib/tenant';

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
  // No session and no demo tenant: send them to the front door rather than
  // explaining the absence. This is the whole reason the Compose stack was
  // unusable — with the demo fallback off (it is opt-in via
  // DTWIN_ALLOW_DEMO_TENANT, not NODE_ENV) and no login screen, there was
  // nowhere to go.
  if (!ctx) redirect('/login');

  const viewer = await currentViewer();

  // One transaction for all three reads. The tenant scope IS the transaction
  // scope, so splitting these would open three of them to answer one page.
  // A building over the tree's ceiling is reported here rather than left to
  // the error boundary: in production Next replaces a server error's message
  // with a digest, so the one explanation the operator needs — "this building
  // is too large to load whole" — would be the part that got stripped.
  let tooLarge: string | null = null;

  const result = await withTenant(ctx, async (db) => {
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM buildings ORDER BY name LIMIT 1',
    );
    const buildingId = rows[0]?.id;
    if (!buildingId) return null;
    const [tree, tenant] = await Promise.all([
      getSpatialTree(db, buildingId).catch((err: unknown) => {
        if (err instanceof SpatialTreeTooLargeError) {
          tooLarge = err.message;
          return null;
        }
        throw err;
      }),
      getTenant(db),
    ]);
    // getSpatialTree can still answer null — the id came from a row this
    // transaction read, but RLS could have hidden its children.
    if (!tree) return null;
    return { tree, tenantName: tenant?.name ?? 'Unknown tenant' };
  });

  if (tooLarge) return <EmptyState message={tooLarge} />;

  if (!result) {
    return (
      <EmptyState message="No building visible for this tenant. Run the migrations and seed, and check DTWIN_DEMO_TENANT_ID matches a seeded tenant." />
    );
  }

  return (
    <Dashboard
      tree={result.tree}
      tenantId={ctx.tenantId}
      tenantName={result.tenantName}
      viewer={viewer}
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
