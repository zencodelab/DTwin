'use client';

import { useEffect } from 'react';

/**
 * The route-level error boundary.
 *
 * Without one, an exception in the server component rendered Next's unstyled
 * default page — which in production says only "Application error: a
 * server-side exception has occurred", with the reason in a log nobody looking
 * at the dashboard can reach.
 *
 * The message is shown because every plausible cause here is operational and
 * actionable by the person reading it: the database is down, the tenant has no
 * building, a migration has not run. It is not user-supplied content.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[dashboard]', error);
  }, [error]);

  return (
    <main className="grid h-screen place-items-center p-8">
      <div className="panel max-w-lg p-6">
        <h1 className="text-lg font-semibold">The dashboard could not load</h1>
        <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {error.message || 'An unexpected error occurred.'}
        </p>
        {error.digest && (
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            digest {error.digest}
          </p>
        )}
        <p className="mt-4 text-xs" style={{ color: 'var(--text-muted)' }}>
          Most often this is the database: check <code>npm run db:up</code> and
          that the migrations have run.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-5 rounded-md px-3 py-2 text-sm font-medium"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          Try again
        </button>
      </div>
    </main>
  );
}
