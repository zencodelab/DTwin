import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/LoginForm';
import { currentViewer } from '@/lib/tenant';

/**
 * Rendered per request, because whether to show it depends on a cookie.
 *
 * Gated on `currentViewer` — a real signed-in PERSON — and emphatically not on
 * `currentTenant`, which it used to be.
 *
 * `currentTenant` is satisfied by the demo-tenant fallback, so with
 * `DTWIN_ALLOW_DEMO_TENANT=true` (which `.env.example` ships) this page
 * redirected every visitor to the dashboard and **the login form could not be
 * reached at all**. Sign-in, sign-out, the tenant switcher and supervisory
 * control were all unreachable without editing `.env` and restarting — in the
 * exact configuration the README tells a newcomer to set up.
 *
 * The comment that used to sit here said demo mode "has no session to create,
 * so the login would appear to do nothing". That was backwards: `currentTenant`
 * resolves a real session FIRST and only falls back to the demo tenant, so
 * signing in works perfectly well from demo mode — it just replaces the
 * fallback. The form was turning away the one visitor who needed it.
 */
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  if (await currentViewer()) redirect('/');

  return (
    <main className="grid h-screen place-items-center p-8">
      <LoginForm />
    </main>
  );
}
