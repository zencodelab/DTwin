import { NextResponse } from 'next/server';
import { withTenant } from '@dtwin/db';
import { getSensorHistory } from '@dtwin/db/queries';
import { AggregateResolution } from '@dtwin/types';
import { currentTenant, unauthorized } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await currentTenant();
  if (!ctx) return unauthorized();

  const { id } = await params;
  const url = new URL(request.url);

  const resolution = AggregateResolution.safeParse(url.searchParams.get('resolution') ?? '5m');
  if (!resolution.success) {
    return NextResponse.json({ error: 'resolution must be 5m, 1h or 1d' }, { status: 400 });
  }

  const hours = Number(url.searchParams.get('hours') ?? 6);
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3600_000);

  const buckets = await withTenant(ctx, (db) =>
    getSensorHistory(db, id, resolution.data, from, to),
  );

  return NextResponse.json({ buckets });
}
