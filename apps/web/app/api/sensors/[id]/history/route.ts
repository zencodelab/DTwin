import { NextResponse } from 'next/server';
import { withTenant } from '@dtwin/db';
import { getSensorHistory, maxHistoryHours } from '@dtwin/db/queries';
import { AggregateResolution } from '@dtwin/types';
import { parseHours, parseUuid } from '@/lib/params';
import { currentTenant, unauthorized } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await currentTenant();
  if (!ctx) return unauthorized();

  const sensor = parseUuid((await params).id, 'sensor id');
  if (!sensor.ok) return sensor.response;
  const id = sensor.value;
  const url = new URL(request.url);

  const resolution = AggregateResolution.safeParse(url.searchParams.get('resolution') ?? '5m');
  if (!resolution.success) {
    return NextResponse.json({ error: 'resolution must be 5m, 1h or 1d' }, { status: 400 });
  }

  // The ceiling depends on the resolution, because what is being bounded is
  // the number of buckets: a week at 5 minutes and three months at an hour are
  // the same size of answer. The query carries its own LIMIT as a safety net,
  // which truncates silently — this is what lets the caller be told instead.
  const window = parseHours(url.searchParams.get('hours'),
                            { fallback: 6, max: maxHistoryHours(resolution.data) });
  if (!window.ok) return window.response;

  const to = new Date();
  const from = new Date(to.getTime() - window.value * 3600_000);

  const buckets = await withTenant(ctx, (db) =>
    getSensorHistory(db, id, resolution.data, from, to),
  );

  return NextResponse.json({ buckets });
}
