/**
 * Shown while the server component loads the spatial tree.
 *
 * The page is `force-dynamic` and reads the whole building — geometry, assets
 * and every point — in one transaction before it can render anything, so on a
 * cold connection there is a visible gap. Without this the browser showed the
 * previous page, or nothing.
 */
export default function Loading() {
  return (
    <main className="grid h-screen place-items-center p-8">
      <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
        Loading the building…
      </div>
    </main>
  );
}
