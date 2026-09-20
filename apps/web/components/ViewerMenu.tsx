'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { TenantMembership } from '@dtwin/types';

/**
 * Who you are, which tenant you are looking at, and the way out.
 *
 * Memberships are fetched when the menu opens rather than rendered into every
 * page: the switcher is used rarely and the list costs an unscoped query, so
 * paying for it on each dashboard render would be paying for it almost never
 * being read. The cost of the lazy fetch is a moment of "Loading…" the first
 * time, which is the right trade for a menu.
 *
 * Demo-tenant mode has no viewer — the tenant came from configuration, not from
 * a person — so the menu becomes a badge saying exactly that. Pretending there
 * is a user to sign out would offer an action that does nothing.
 */
export function ViewerMenu({
  viewer,
  tenantName,
}: {
  viewer: { displayName: string; email: string; role: string } | null;
  tenantName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [memberships, setMemberships] = useState<TenantMembership[] | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (!open || memberships || !viewer) return;
    let cancelled = false;
    fetch('/api/auth/tenant')
      .then((r) => (r.ok ? r.json() : { tenants: [] }))
      .then((body) => { if (!cancelled) setMemberships(body.tenants ?? []); })
      .catch(() => { if (!cancelled) setMemberships([]); });
    return () => { cancelled = true; };
  }, [open, memberships, viewer]);

  if (!viewer) {
    return (
      <span
        className="rounded px-2 py-1 text-xs"
        style={{ border: '1px dashed var(--border)', color: 'var(--text-muted)' }}
        title="DTWIN_DEMO_TENANT_ID is set and no one is signed in. Ignored when NODE_ENV=production."
      >
        demo tenant · {tenantName}
      </span>
    );
  }

  async function signOut() {
    setBusy(true);
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    // Same reasoning as the login form: the cookie is invisible to this code and
    // the dashboard is a server component, so reload rather than transition.
    router.replace('/login');
    router.refresh();
  }

  async function switchTo(tenantId: string) {
    setBusy(true);
    const res = await fetch('/api/auth/tenant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) {
      // The whole page is scoped to the old tenant — geometry included — so
      // there is nothing on screen worth keeping.
      window.location.assign('/');
    }
  }

  const others = (memberships ?? []).filter((m) => m.name !== tenantName);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="rounded px-2 py-1 text-xs"
        style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
      >
        {viewer.displayName} · {tenantName} ▾
      </button>

      {open && (
        <div
          role="menu"
          className="panel absolute right-0 z-50 mt-1 w-60 p-2 text-xs shadow-lg"
        >
          <div className="px-2 py-1">
            <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
              {viewer.email}
            </div>
            <div style={{ color: 'var(--text-muted)' }}>{viewer.role} of {tenantName}</div>
          </div>

          <div className="my-1 border-t" style={{ borderColor: 'var(--border)' }} />

          {memberships === null ? (
            <div className="px-2 py-1" style={{ color: 'var(--text-muted)' }}>Loading…</div>
          ) : others.length === 0 ? (
            <div className="px-2 py-1" style={{ color: 'var(--text-muted)' }}>
              No other tenants
            </div>
          ) : (
            others.map((m) => (
              <button
                key={m.tenantId}
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => switchTo(m.tenantId)}
                className="block w-full rounded px-2 py-1 text-left hover:opacity-70"
                style={{ color: 'var(--text-secondary)' }}
              >
                Switch to {m.name}
              </button>
            ))
          )}

          <div className="my-1 border-t" style={{ borderColor: 'var(--border)' }} />

          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={signOut}
            className="block w-full rounded px-2 py-1 text-left hover:opacity-70"
            style={{ color: 'var(--text-secondary)' }}
          >
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  );
}
