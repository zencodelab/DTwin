'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The front door.
 *
 * Deliberately dull: one generic error for every failure, because the server is
 * written not to distinguish a bad address from a bad password and a form that
 * did so anyway would reintroduce the enumeration oracle on the client side.
 *
 * A full navigation rather than `router.push` on success. The session arrives
 * as an HttpOnly cookie the client cannot see, and the dashboard is a server
 * component that reads it during render — a client-side transition can be
 * served from the router cache and show the signed-out page to a signed-in
 * user. `refresh()` then `push` would also work; a reload is one thing that
 * cannot be subtly wrong.
 */
export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? 'Incorrect email or password.');
        setBusy(false);
        return;
      }
      router.replace('/');
      router.refresh();
    } catch {
      // A network failure is not an authentication failure, and saying
      // "incorrect password" here would send the user hunting for the wrong bug.
      setError('Could not reach the server. Is the web service running?');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel w-full max-w-sm p-6">
      <h1 className="text-lg font-semibold">DTwin</h1>
      <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
        Sign in to the building twin.
      </p>

      <label className="mt-5 block text-sm" htmlFor="email">Email</label>
      <input
        id="email"
        type="email"
        autoComplete="username"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="mt-1 w-full rounded-md px-3 py-2 text-sm"
        style={{
          background: 'var(--page)',
          border: '1px solid var(--border)',
          color: 'var(--text-primary)',
        }}
      />

      <label className="mt-3 block text-sm" htmlFor="password">Password</label>
      <input
        id="password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="mt-1 w-full rounded-md px-3 py-2 text-sm"
        style={{
          background: 'var(--page)',
          border: '1px solid var(--border)',
          color: 'var(--text-primary)',
        }}
      />

      {error && (
        <p role="alert" className="mt-3 text-sm" style={{ color: '#d14343' }}>
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="mt-5 w-full rounded-md px-3 py-2 text-sm font-medium"
        style={{
          background: 'var(--accent)',
          color: '#fff',
          opacity: busy ? 0.6 : 1,
          cursor: busy ? 'progress' : 'pointer',
        }}
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
