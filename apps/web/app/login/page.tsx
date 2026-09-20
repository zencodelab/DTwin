import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/LoginForm';
import { currentTenant } from '@/lib/tenant';

/**
 * Rendered per request, because whether to show it depends on a cookie.
 *
 * An already-authenticated visitor is sent to the dashboard rather than shown a
 * form that would only confuse them. `currentTenant` is used rather than
 * `currentViewer` so that demo-tenant mode also skips the form — there is no
 * session to create in that mode and the login would appear to do nothing.
 */
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  if (await currentTenant()) redirect('/');

  return (
    <main className="grid h-screen place-items-center p-8">
      <LoginForm />
    </main>
  );
}
