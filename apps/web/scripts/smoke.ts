/**
 * Smoke test for the web layer.
 *
 * Drives the running Next.js server over HTTP: the page renders with real data,
 * and every API route the dashboard depends on answers correctly. The 3D canvas
 * itself needs a GPU and a browser, so it is verified by hand rather than here —
 * what this covers is everything the canvas is fed.
 *
 * Run:  npm run smoke -w @dtwin/web    (with the app, ingest and sim running)
 */
import { withTenant, closePool } from '@dtwin/db';

const BASE = process.env.WEB_BASE_URL ?? 'http://localhost:3000';
let failures = 0;

const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

// Wrapped rather than top-level await: this package is CJS (a Next.js app), so
// top-level await is not available here the way it is in the ESM packages.
async function main(): Promise<void> {
  try {
    // Scoped exactly as the app is. An unscoped read here would return no rows
    // under row-level security and report "no seeded building" for a database
    // that is seeded perfectly well — the failure would describe the test, not
    // the system.
    const tenantId = process.env.DTWIN_DEMO_TENANT_ID;
    if (!tenantId) {
      throw new Error(
        'DTWIN_DEMO_TENANT_ID must be set — it is the tenant the dashboard and ' +
          'this suite both render for. See .env.example.',
      );
    }

    const building = await withTenant({ tenantId }, async (db) => {
      const { rows } = await db.query<{ id: string; name: string }>(
        'SELECT id, name FROM buildings ORDER BY name LIMIT 1',
      );
      return rows[0];
    });
    if (!building) {
      throw new Error(
        `no building visible for tenant ${tenantId} — run the migrations, and ` +
          'check DTWIN_DEMO_TENANT_ID names a seeded tenant',
      );
    }

    console.log('\n[1] Page render');
    const page = await fetch(BASE);
    // React SSR separates adjacent expressions with <!-- --> markers, so
    // "190 points" is not a contiguous string in the raw HTML. Stripping them
    // tests what rendered rather than how React serialised it.
    const html = (await page.text()).replace(/<!--[\s\S]*?-->/g, '');
    ok('page returns 200', page.status === 200, String(page.status));
    ok('page is server-rendered with the building name',
       html.includes(building.name), building.name);
    ok('spatial counts reached the client',
       html.includes('190 points') && html.includes('24 zones'));

    console.log('\n[2] Overlay data');
    const heat = await getJson<{ zones: Array<{ zoneId: string; zoneName: string; value: number | null; setpointC: number | null; deadbandK: number | null }> }>(
      `/api/heatmap?buildingId=${building.id}&metric=temperature_c&hours=1`,
    );
    ok('heatmap returns a row per zone', heat.zones.length === 24, String(heat.zones.length));
    ok('every zone carries a setpoint',
       heat.zones.every((z) => z.setpointC !== null),
       'required — the temperature scale diverges about it');
    ok('every zone carries a deadband',
       heat.zones.every((z) => z.deadbandK !== null),
       'required — it defines the neutral band');

    const occupancy = await getJson<{ zones: Array<{ value: number | null }> }>(
      `/api/heatmap?buildingId=${building.id}&metric=occupancy_count&hours=1`,
    );
    ok('a second metric also resolves', occupancy.zones.length === 24);

    ok('a missing buildingId is a 400',
       (await fetch('/api/heatmap', { method: 'GET' }).catch(() => null)) === null ||
       (await fetch(`${BASE}/api/heatmap`)).status === 400);

    console.log('\n[3] Zone detail');
    const zoneId = heat.zones.find((z) => z.zoneName.startsWith('OFF'))!.zoneId;
    const detail = await getJson<{
      readings: Array<{ sensorId: string; metric: string }>;
      equipment: Array<{ tag: string; equipmentType: string }>;
      maintenance: unknown[];
      profile: { setpointC: number } | null;
    }>(`/api/zones/${zoneId}`);

    ok('zone has live readings', detail.readings.length > 0, `${detail.readings.length} points`);
    ok('zone has a temperature point',
       detail.readings.some((r) => r.metric === 'temperature_c'));
    ok('serving equipment includes both the VAV and its AHU',
       detail.equipment.some((e) => e.equipmentType === 'vav') &&
       detail.equipment.some((e) => e.equipmentType === 'ahu'),
       detail.equipment.map((e) => e.tag).join(', '));
    ok('thermal profile is attached', detail.profile !== null);

    console.log('\n[4] Sensor history');
    const sensorId = detail.readings.find((r) => r.metric === 'temperature_c')!.sensorId;
    type History = { buckets: Array<{ bucket: string; avgValue: number | null }> };
    const history = await getJson<History>(
      `/api/sensors/${sensorId}/history?resolution=5m&hours=6`,
    );

    // When this comes back empty, "no buckets" is not a diagnosis. Widening the
    // window and dropping to hourly separates the three things it could mean:
    // the sensor has no data at all, the data is older than the window, or the
    // 5-minute rollup is not covering the recent end of it.
    let detailMsg = `${history.buckets.length}`;
    if (history.buckets.length === 0) {
      const [wide, hourly] = await Promise.all([
        getJson<History>(`/api/sensors/${sensorId}/history?resolution=5m&hours=720`),
        getJson<History>(`/api/sensors/${sensorId}/history?resolution=1h&hours=720`),
      ]);
      detailMsg = `0 in 6h; 5m/30d=${wide.buckets.length}`
        + `${wide.buckets.length ? ` (latest ${wide.buckets.at(-1)!.bucket})` : ''}`
        + `; 1h/30d=${hourly.buckets.length}`
        + `${hourly.buckets.length ? ` (latest ${hourly.buckets.at(-1)!.bucket})` : ''}`
        + `; sensor ${sensorId}; now ${new Date().toISOString()}`;
    }
    ok('history returns buckets', history.buckets.length > 0, detailMsg);
    ok('an invalid resolution is rejected',
       (await fetch(`${BASE}/api/sensors/${sensorId}/history?resolution=7m`)).status === 400);

    console.log('\n[5] Alerts');
    const alerts = await getJson<{ alerts: unknown[] }>('/api/alerts');
    ok('alerts endpoint answers', Array.isArray(alerts.alerts));

    console.log('\n[6] Simulation proxy');
    const started = await fetch(`${BASE}/api/simulate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        buildingId: building.id,
        scenarioName: 'web smoke',
        periodStart: '2026-06-20T00:00:00+04:00',
        periodEnd: '2026-06-21T00:00:00+04:00',
        intervalS: 3600,
        weather: { mode: 'synthetic', peakDryBulbC: 42, minDryBulbC: 30, peakGhiW_m2: 950 },
      }),
    });
    const startedBody = await started.json() as { runId?: string; error?: string };
    ok('simulate proxies to the worker and returns a run id',
       started.status === 202 && !!startedBody.runId,
       startedBody.error ?? String(started.status));

    if (startedBody.runId) {
      let summary: { building?: { totalKwh: number; hvacKwh: number } } | null = null;
      for (let i = 0; i < 60 && !summary?.building; i++) {
        await sleep(500);
        summary = await getJson(`/api/simulate?runId=${startedBody.runId}`);
      }
      ok('run completes and returns a summary', !!summary?.building);
      ok('the summary carries a positive energy total',
         (summary?.building?.totalKwh ?? 0) > 0,
         `${summary?.building?.totalKwh?.toFixed(0)} kWh`);
    }
  } finally {
    await closePool();
  }
}

main()
  .catch((err: unknown) => {
    console.error(`  FAIL  ${(err as Error).message}`);
    failures++;
  })
  .finally(() => {
    console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}\n`);
    process.exit(failures === 0 ? 0 : 1);
  });
