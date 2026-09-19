/**
 * App Router needs its own not-found page. Without one Next falls back to the
 * legacy Pages Router `/_error`, which is prerendered at build time and pulls
 * in a different React runtime than the App Router uses.
 */
export default function NotFound() {
  return (
    <main className="grid h-screen place-items-center p-8">
      <div className="panel max-w-md p-6 text-center">
        <h1 className="mb-2 text-lg font-semibold">Not found</h1>
        <p style={{ color: 'var(--text-secondary)' }}>
          That page does not exist.
        </p>
        <a href="/" className="mt-4 inline-block text-sm" style={{ color: 'var(--accent)' }}>
          Back to the dashboard
        </a>
      </div>
    </main>
  );
}
