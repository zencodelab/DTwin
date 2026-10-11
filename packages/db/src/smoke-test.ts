/**
 * End-to-end smoke test for the data layer.
 *
 * Exercises the schema against a real database: spatial tree hydration, 3D
 * picking with elevation disambiguation, batched telemetry writes, reset-aware
 * counter aggregation, the heatmap rollup, the Zod parse boundary, — since
 * 007/008 — tenant isolation, and the copilot's READ ONLY queries (§64).
 *
 * TWO POOLS, ON PURPOSE. Assertions run through `withTenant` as the application
 * role, so they exercise the row-level security policies rather than going
 * around them. Fixture setup (creating a second tenant's building, deleting
 * rows, refreshing aggregates) runs on the owner pool, because those are
 * operations the application role is deliberately not granted.
 *
 * Writes synthetic telemetry into the seeded building — a development check,
 * not something to point at production. Run with:
 *   npm run smoke -w @dtwin/db
 */
import { getOwnerPool, getPool, closePool, withTenant, type Db } from './client.ts';
import {
  getSpatialTree, findZoneAtPoint, insertReadings, SPATIAL_LIMITS, SpatialTreeTooLargeError,
  getLatestReadingsForZone, getSensorHistory, getZoneHeatmap,
  createTenant, listBuildings, getTenant, createUser, addMember, login,
  listActiveTenants, TooManyTenantsError,
  copilotOrient, copilotListZones, copilotZoneConditions, copilotZoneHistory,
  copilotZoneTimeline, copilotEquipmentStatus, copilotListAlerts, copilotControlHistory,
  copilotEnergyByEndUse, copilotMeterConsumption, copilotCompareZones, bucketStartsIn,
  BUILDING_PLANT,
} from './queries/index.ts';
import {
  ClientMessage, TelemetryBatch, parseServerMessage,
  expandReading, compactReading, uuidv7, Building, SpatialTree,
  METRIC_UNITS, CUMULATIVE_METRICS, topics,
} from '@dtwin/types';
import type { Reading } from '@dtwin/types';

/**
 * A failed assertion sets the exit code.
 *
 * It used to only print. A suite that reports FAIL and exits 0 is invisible to
 * CI, which is the one reader that never skims the output — and the isolation
 * checks below are exactly the kind that must never fail quietly.
 */
let failures = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const owner = getOwnerPool();

// The seeded tenant. Resolved on the owner pool because at this point we do not
// yet have a tenant to scope to — this is the bootstrap, not a query path.
const { rows: [seeded] } = await owner.query<{ tenantId: string; id: string }>(
  'SELECT tenant_id AS "tenantId", id FROM buildings ORDER BY name LIMIT 1',
);
if (!seeded) {
  console.error('\nNo building found. Run `npm run db:migrate` first.\n');
  process.exit(1);
}
const A = { tenantId: seeded.tenantId, buildingId: seeded.id };

// ---------------------------------------------------------------- spatial tree
console.log('\n[1] Spatial tree');
const tree = await withTenant(A, (db) => getSpatialTree(db, A.buildingId));
ok('getSpatialTree returns a tree', tree !== null);
ok('4 floors', tree!.floors.length === 4, `got ${tree!.floors.length}`);
ok('24 zones across floors', tree!.floors.reduce((s, f) => s + f.zones.length, 0) === 24);
ok('190 sensors', tree!.sensors.length === 190, `got ${tree!.sensors.length}`);
ok('40 equipment', tree!.equipment.length === 40);

const parsedTree = SpatialTree.safeParse(tree);
ok('SpatialTree passes its own Zod schema', parsedTree.success,
   parsedTree.success ? '' : JSON.stringify(parsedTree.error.issues.slice(0, 3)));

const l1 = tree!.floors.find((f) => f.level === 1)!;
const z0 = l1.zones[0]!;
ok('zone boundary is GeoJSON PolygonZ with 3D coords',
   z0.boundary?.type === 'Polygon' && z0.boundary.coordinates[0]![0]!.length === 3,
   JSON.stringify(z0.boundary?.coordinates[0]?.[0]));

// AHU serves many zones; VAV serves one — the many-to-many check.
const ahu = tree!.equipment.find((e) => e.equipmentType === 'ahu')!;
const ahuZones = tree!.services.filter((s) => s.equipmentId === ahu.id).length;
const vav = tree!.equipment.find((e) => e.equipmentType === 'vav')!;
const vavZones = tree!.services.filter((s) => s.equipmentId === vav.id).length;
ok('one AHU serves 6 zones', ahuZones === 6, `got ${ahuZones}`);
ok('one VAV serves 1 zone', vavZones === 1, `got ${vavZones}`);

// Serving tree: chiller -> AHU -> VAV
const vavParent = tree!.equipment.find((e) => e.id === vav.parentEquipmentId);
const ahuParent = tree!.equipment.find((e) => e.id === vavParent?.parentEquipmentId);
ok('serving tree VAV -> AHU -> chiller',
   vavParent?.equipmentType === 'ahu' && ahuParent?.equipmentType === 'chiller',
   `${vav.tag} -> ${vavParent?.tag} -> ${ahuParent?.tag}`);

// The tree is loaded whole and handed to a browser, so it has ceilings — and
// breaching one THROWS rather than truncating. A capped time series still means
// something; a capped floor plan is a building drawn with rooms missing, and
// zones that are not drawn look exactly like zones that do not exist.
const overLimit = await withTenant(A, (db) =>
  getSpatialTree(db, A.buildingId, { ...SPATIAL_LIMITS, zones: 5 }))
  .then(() => null, (err: unknown) => err);
ok('a tree over its ceiling is refused, not truncated',
   overLimit instanceof SpatialTreeTooLargeError
     && overLimit.collection === 'zones' && overLimit.limit === 5,
   overLimit instanceof Error ? overLimit.message.slice(0, 60) : 'returned a tree');

const atLimit = await withTenant(A, (db) =>
  getSpatialTree(db, A.buildingId, { ...SPATIAL_LIMITS, zones: 24 }));
ok('a tree exactly AT its ceiling still loads',
   atLimit?.floors.reduce((n, f) => n + f.zones.length, 0) === 24);

// -------------------------------------------------------------- 3D picking
console.log('\n[2] 3D picking (elevation disambiguation)');
const [hitL1, hitL3] = await withTenant(A, async (db) => [
  await findZoneAtPoint(db, A.buildingId, 20, 8, 5.0),   // Level 1 is at z=4
  await findZoneAtPoint(db, A.buildingId, 20, 8, 13.0),  // Level 3 is at z=12
]);
ok('point at z=5 resolves to a Level 1 zone', hitL1?.name === 'OFF-101', hitL1?.name);
ok('same x,y at z=13 resolves to Level 3', hitL3?.name === 'OFF-301', hitL3?.name);
ok('picks differ by elevation', hitL1?.id !== hitL3?.id);

// ---------------------------------------------------------------- telemetry
console.log('\n[3] Telemetry write + read');
const { rows: sensors } = await owner.query<{ id: string }>(
  `SELECT s.id FROM sensors s
    WHERE s.zone_id = $1 AND s.metric = 'temperature_c' LIMIT 1`,
  [hitL1!.id],
);
const tempSensor = sensors[0]!;

const now = Date.now();

/**
 * Own the fixture window before writing into it.
 *
 * These sensors are shared with the ingest simulator, which writes at real
 * wall-clock timestamps. Without this the exact row counts and counter deltas
 * below silently measure someone else's data, and an accidental
 * same-millisecond collision makes `ON CONFLICT DO NOTHING` skip a row that the
 * test then reports as a failed insert.
 *
 * On the owner pool: the application role has INSERT on telemetry and no
 * DELETE, which is the intended grant and not something to widen for a test.
 */
const windowStart = new Date(now - 7 * 3600_000);
await owner.query('DELETE FROM telemetry WHERE sensor_id = $1 AND time >= $2',
  [tempSensor.id, windowStart]);

const readings: Reading[] = [];
// 6 hours of 1-minute temperature data with a diurnal swing.
//
// Forty of them are a failed probe: -273 C, flagged OutOfRange, which is what
// the quality gate stores rather than drops. Thirty in one stretch, so an
// hourly mean has something to be dragged by; ten in another, long enough that
// at least one wall-clock-aligned 5-minute bucket holds nothing else.
const probeFailed = (i: number) => (i >= 200 && i < 230) || (i >= 295 && i < 305);
for (let i = 360; i >= 0; i--) {
  const ts = now - i * 60_000;
  readings.push({
    sensorId: tempSensor.id as Reading['sensorId'],
    ts,
    value: probeFailed(i) ? -273 : 23 + 2 * Math.sin((ts / 3_600_000) * Math.PI / 6),
    quality: probeFailed(i) ? 2 : 0,
  });
}
const written = await withTenant(A, (db) => insertReadings(db, readings));
ok('batch insert wrote 361 rows', written === 361, `got ${written}`);

const dupes = await withTenant(A, (db) => insertReadings(db, readings));
ok('re-delivered batch is idempotent (0 new rows)', dupes === 0, `got ${dupes}`);

const latest = await withTenant(A, (db) => getLatestReadingsForZone(db, hitL1!.id));
// Find the point by metric rather than by position: a zone carries several
// sensors, and once the ingest simulator has run they all have data, so
// latest[0] is whichever sensor id happens to sort first.
const latestTemp = latest.find((r) => r.sensorId === tempSensor.id);
ok('latest readings for zone returns the temperature point', latestTemp !== undefined);
ok('latest reading is not stale', latestTemp?.isStale === false);
ok('unit carried through', latestTemp?.unit === 'degC', latestTemp?.unit);

// ------------------------------------------------- cumulative meter / counter_agg
console.log('\n[4] Cumulative meter (counter_agg, reset-aware)');
const { rows: meters } = await owner.query<{ id: string }>(
  `SELECT id FROM sensors WHERE is_cumulative AND metric = 'energy_kwh' LIMIT 1`,
);
const meter = meters[0]!;
await owner.query('DELETE FROM telemetry WHERE sensor_id = $1 AND time >= $2',
  [meter.id, windowStart]);
const meterReadings: Reading[] = [];
let acc = 1_000_000;
for (let i = 360; i >= 0; i--) {
  acc += 3; // 3 kWh per minute
  // Simulate a meter rollover two hours ago — the case that makes max-min lie.
  if (i === 120) acc = 0;
  // And one flagged spike an hour ago. To a reset-aware counter an absurd
  // value followed by a sane one IS a reset, so unless the rollup leaves it
  // out, `delta` reports nine billion kWh that nobody used.
  const spiked = i === 60;
  meterReadings.push({
    sensorId: meter.id as Reading['sensorId'],
    ts: now - i * 60_000, value: spiked ? 9e9 : acc, quality: spiked ? 2 : 0,
  });
}
await withTenant(A, (db) => insertReadings(db, meterReadings));

// Refresh to an END IN THE PAST, never NULL.
//
// A NULL end materialises through the bucket containing now() and leaves the
// watermark at that bucket's END — ahead of the clock. Real-time aggregation
// only covers buckets at or after the watermark, so from then until a policy
// refresh, every newly written row is in the hypertable and invisible in the
// rollup. This suite's two lines did that to the whole database, and the web
// suite three steps later reported an empty history for a sensor that had
// readings. See docs/decisions.md §46.
//
// Ten minutes back is comfortably older than this suite's fixtures, which span
// hours, and it leaves the recent tail to real-time aggregation — which is
// what covers it correctly.
const refreshTo = new Date(now - 10 * 60_000).toISOString();
await owner.query(
  `CALL refresh_continuous_aggregate('telemetry_1h', NULL, $1::timestamptz)`, [refreshTo]);
await owner.query(
  `CALL refresh_continuous_aggregate('telemetry_5m', NULL, $1::timestamptz)`, [refreshTo]);

const from = new Date(now - 6 * 3600_000);
const to = new Date(now + 3600_000);
const meterHist = await withTenant(A, (db) => getSensorHistory(db, meter.id, '1h', from, to));
const totalDelta = meterHist.reduce((s, b) => s + (b.deltaValue ?? 0), 0);
ok('counter_agg delta is positive despite the reset', totalDelta > 0,
   `sum(delta) = ${totalDelta.toFixed(1)} kWh`);
// 361 readings at 3 kWh a minute is 1,080 kWh. The sum sits under that: the
// hour bucket containing `from` starts before it and is excluded (up to 180),
// and a per-bucket delta does not span the boundary between buckets (3 each).
// What matters is the order of magnitude — unfiltered, this is ~9,000,000,000.
ok('a flagged spike on a meter does not become energy',
   totalDelta > 800 && totalDelta < 1_100, `sum(delta) = ${totalDelta.toFixed(1)} kWh`);
const good = meterReadings.filter((r) => r.quality === 0);
const naive = Math.max(...good.map(r => r.value)) - Math.min(...good.map(r => r.value));
ok('naive max-min would have been wrong', Math.abs(naive - totalDelta) > 1000,
   `naive = ${naive.toFixed(0)} vs counter_agg = ${totalDelta.toFixed(0)}`);

// From `windowStart`, not `from`: the query keeps whole buckets, so the hour
// bucket that CONTAINS `from` is excluded — and the fixture's second flagged
// stretch reaches back to now-304 min, which sits in that bucket whenever the
// suite starts at :01–:03 past the hour. CI ran at :03 and counted 39. A window
// that reaches past the whole fixture makes the count a fact about the rollup
// rather than about the runner's clock.
const tempHist = await withTenant(A, (db) => getSensorHistory(db, tempSensor.id, '1h', windowStart, to));
ok('gauge sensor history has buckets', tempHist.length > 0, `${tempHist.length} buckets`);
ok('gauge delta is null (not a counter)', tempHist[0]?.deltaValue === null);
ok('gauge avg is in range', (tempHist[0]?.avgValue ?? 0) > 20 && (tempHist[0]?.avgValue ?? 0) < 26,
   `avg = ${tempHist[0]?.avgValue?.toFixed(2)}`);

// Flagged samples are counted, and kept out of every statistic (migration 016).
// Before it they were counted AND averaged: thirty minutes at -273 C pulled an
// hourly mean down by ~150 degrees, with a count beside it that could not be
// used to repair it — you cannot subtract a sample from a mean you were not
// given the sum of.
const flaggedTotal = tempHist.reduce((n, b) => n + b.badQualityCount, 0);
ok('flagged samples are still counted', flaggedTotal === 40, `bad_quality_count = ${flaggedTotal}`);
ok('and kept out of min, max and mean',
   tempHist.every((b) => b.avgValue === null
     || (b.minValue! > 20 && b.maxValue! < 26 && b.avgValue > 20 && b.avgValue < 26)),
   `lowest hourly min = ${Math.min(...tempHist.map((b) => b.minValue ?? Infinity)).toFixed(2)}`);

const fiveMin = await withTenant(A, (db) => getSensorHistory(db, tempSensor.id, '5m', windowStart, to));
const allBad = fiveMin.filter((b) => b.sampleCount > 0 && b.badQualityCount === b.sampleCount);
ok('a bucket holding only flagged samples has no mean at all, rather than a wrong one',
   allBad.length >= 1 && allBad.every((b) => b.avgValue === null && b.minValue === null),
   `${allBad.length} such 5-minute bucket(s)`);

// ------------------------------------------------------------------ heatmap
console.log('\n[5] Heatmap overlay');
const heat = await withTenant(A, (db) => getZoneHeatmap(db, A.buildingId, 'temperature_c', from, to));
ok('heatmap returns a row per zone', heat.length === 24, `got ${heat.length}`);
ok('the seeded zone has a value', heat.find(h => h.zoneId === hitL1!.id)?.value !== null);

// Asking for a metric no sensor reports isolates the "absent" case from the
// "zero" case regardless of what telemetry already exists. A zone with no data
// must come back null — rendering it as 0 would paint a cold spot on the
// heatmap where there is simply no coverage.
const absent = await withTenant(A, (db) => getZoneHeatmap(db, A.buildingId, 'pressure_pa', from, to));
ok('a metric with no sensors still returns a row per zone', absent.length === 24);
ok('zones with no data are null, not zero',
   absent.every(h => h.value === null),
   `${absent.filter(h => h.value !== null).length} non-null`);

// --------------------------------------------------------------- Zod / wire
console.log('\n[6] Zod boundary + wire format');
const tuple = compactReading(readings[0]!);
ok('reading round-trips through the compact tuple',
   expandReading(tuple).value === readings[0]!.value);

const batch: unknown = { readings: readings.slice(0, 3).map(compactReading), sentAt: now };
ok('valid TelemetryBatch parses', TelemetryBatch.safeParse(batch).success);
ok('batch with a bad quality code is rejected',
   !TelemetryBatch.safeParse({ readings: [[tempSensor.id, now, 23.5, 99]] }).success);
ok('batch with a non-uuid sensor id is rejected',
   !TelemetryBatch.safeParse({ readings: [['not-a-uuid', now, 23.5, 0]] }).success);
ok('empty batch is rejected', !TelemetryBatch.safeParse({ readings: [] }).success);

const frame = JSON.stringify({
  type: 'telemetry.batch', topic: topics.zone(hitL1!.id),
  readings: [tuple], sentAt: now,
});
ok('ServerMessage frame parses', parseServerMessage(frame).ok);
ok('unknown message type is rejected',
   !parseServerMessage('{"type":"telemetry.nope"}').ok);
ok('malformed JSON is rejected without throwing',
   !parseServerMessage('{oh no').ok);
ok('bad topic shape is rejected',
   !ClientMessage.safeParse({ type: 'subscribe', topics: ['floor:oops'] }).success);
ok('well-formed subscribe parses',
   ClientMessage.safeParse({ type: 'subscribe', topics: [topics.zone(hitL1!.id)] }).success);
// The global alert topic was removed in the tenancy work; it must not parse.
ok('the old global alerts:all topic no longer parses',
   !ClientMessage.safeParse({ type: 'subscribe', topics: ['alerts:all'] }).success);

// wire size comparison — the reason for tuples
const asObjects = JSON.stringify(readings.slice(0, 100));
const asTuples = JSON.stringify(readings.slice(0, 100).map(compactReading));
ok('tuple encoding is materially smaller',
   asTuples.length < asObjects.length * 0.75,
   `${asObjects.length}B -> ${asTuples.length}B (${Math.round(100 - asTuples.length / asObjects.length * 100)}% saved)`);

// ------------------------------------------------------------------- misc
console.log('\n[7] Helpers');
const id = uuidv7();
ok('uuidv7 has version nibble 7', id[14] === '7', id);
ok('uuidv7 values are unique', new Set(Array.from({ length: 10_000 }, uuidv7)).size === 10_000);
const ids = Array.from({ length: 10_000 }, uuidv7);
ok('10k uuidv7 values sort in generation order (monotonic within a ms)',
   [...ids].sort().join() === ids.join());
ok('METRIC_UNITS covers every metric', METRIC_UNITS.temperature_c === '°C');
ok('CUMULATIVE_METRICS flags energy but not temperature',
   CUMULATIVE_METRICS.has('energy_kwh') && !CUMULATIVE_METRICS.has('temperature_c'));
ok('Building schema rejects a bad lat/lng',
   !Building.safeParse({ ...tree!.building, location: { lat: 999, lng: 0 } }).success);

// ------------------------------------------------------------------ tenancy
console.log('\n[8] Tenant isolation');

/**
 * A second tenant with one building, so isolation has something to hide.
 *
 * Built through the scoped path rather than the owner pool: if `withTenant`
 * could not create it, that is itself a finding.
 */
const bSlug = `smoke-${Date.now().toString(36)}`;
const bTenantId = await createTenant(bSlug, 'Smoke Test Tenant');
const B = { tenantId: bTenantId };

const bBuildingId = await withTenant(B, async (db) => {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO buildings (tenant_id, name) VALUES ($1, 'Smoke Tower') RETURNING id`,
    [bTenantId],
  );
  const buildingId = rows[0]!.id;
  const { rows: fr } = await db.query<{ id: string }>(
    `INSERT INTO floors (tenant_id, building_id, level, name, elevation_m)
     VALUES ($1, $2, 0, 'Ground', 0) RETURNING id`,
    [bTenantId, buildingId],
  );
  const { rows: zr } = await db.query<{ id: string }>(
    `INSERT INTO zones (tenant_id, floor_id, name, zone_type)
     VALUES ($1, $2, 'Smoke Lobby', 'lobby') RETURNING id`,
    [bTenantId, fr[0]!.id],
  );
  // The same external_id as one of tenant A's points. This was impossible
  // before 007 — `sensors.external_id` was globally UNIQUE, which quietly made
  // the second customer unonboardable.
  await db.query(
    `INSERT INTO sensors (tenant_id, external_id, name, metric, unit, zone_id)
     VALUES ($1, $2, 'Smoke point', 'temperature_c', 'degC', $3)`,
    [bTenantId, tree!.sensors[0]!.externalId, zr[0]!.id],
  );
  return buildingId;
});

ok('two tenants can hold the same sensor external_id', true,
   tree!.sensors[0]!.externalId);

const aBuildings = await withTenant(A, listBuildings);
const bBuildings = await withTenant(B, listBuildings);
ok('each tenant sees only its own buildings',
   aBuildings.length === 1 && bBuildings.length === 1
     && aBuildings[0]!.id !== bBuildings[0]!.id,
   `A=${aBuildings.map(x => x.name)} B=${bBuildings.map(x => x.name)}`);

ok('getTenant returns the scoped tenant and only that',
   (await withTenant(B, getTenant))?.slug === bSlug);

// The sharp edge that made the line above necessary, asserted rather than
// assumed: the identity tables have no policy, so a bare read of `tenants` as
// the application role is NOT scoped. Any accessor over them must filter
// itself. If this assertion ever starts failing, someone added a policy to
// `tenants` and login is about to break.
const allTenants = await withTenant(B, (db) =>
  db.query<{ n: number }>('SELECT count(*)::int AS n FROM tenants'));
ok('`tenants` is deliberately NOT policy-scoped (auth reads it pre-tenant)',
   (allTenants.rows[0]?.n ?? 0) >= 2,
   `a scoped connection still sees ${allTenants.rows[0]?.n} tenant rows`);

// The assertion that matters most: a valid id from another tenant.
const stolen = await withTenant(B, (db) => getSpatialTree(db, A.buildingId));
ok('another tenant\'s building id resolves to null, not data', stolen === null);

const stolenZone = await withTenant(B, (db) => getLatestReadingsForZone(db, hitL1!.id));
ok('another tenant\'s zone yields no readings', stolenZone.length === 0,
   `got ${stolenZone.length}`);

const stolenHeat = await withTenant(B, (db) =>
  getZoneHeatmap(db, A.buildingId, 'temperature_c', from, to));
ok('another tenant\'s heatmap is empty', stolenHeat.length === 0,
   `got ${stolenHeat.length} zones`);

const stolenHist = await withTenant(B, (db) =>
  getSensorHistory(db, tempSensor.id, '1h', from, to));
ok('another tenant\'s sensor history is empty', stolenHist.length === 0,
   `got ${stolenHist.length} buckets`);

// Writes: a reading naming tenant A's sensor, sent while scoped to B, must not
// land. There is no policy on `telemetry` to catch it — the join to `sensors`
// is what drops it. See docs/decisions.md §44.
const crossWrite = await withTenant(B, (db) => insertReadings(db, [{
  sensorId: tempSensor.id as Reading['sensorId'],
  ts: now + 1, value: 99.9, quality: 0,
}]));
ok('a reading for another tenant\'s sensor is dropped, not written',
   crossWrite === 0, `wrote ${crossWrite}`);

// And a direct cross-tenant INSERT is refused outright by the policy.
let refused = false;
try {
  await withTenant(B, (db) => db.query(
    `INSERT INTO buildings (tenant_id, name) VALUES ($1, 'Smuggled')`, [A.tenantId],
  ));
} catch (err) {
  refused = /row-level security/i.test((err as Error).message);
}
ok('a cross-tenant INSERT is refused by the policy', refused);

// Composite foreign keys: the structural half. Parenting a zone onto another
// tenant's floor must be impossible, not merely unusual.
let fkRefused = false;
try {
  await withTenant(B, (db) => db.query(
    `INSERT INTO zones (tenant_id, floor_id, name, zone_type)
     VALUES ($1, $2, 'Stolen zone', 'office')`,
    [bTenantId, l1.id],
  ));
} catch (err) {
  fkRefused = /foreign key/i.test((err as Error).message);
}
ok('a zone cannot be parented onto another tenant\'s floor', fkRefused);

// Fail closed: no tenant at all must mean no rows, not all rows.
const { rows: unscoped } = await owner.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM buildings`,
);
ok('the owner pool still sees every building (it bypasses RLS, by design)',
   (unscoped[0]?.n ?? 0) >= 2, `got ${unscoped[0]?.n}`);

// The tenant list is what every background loop in ingest iterates, so its
// bound cannot truncate: a list missing a tenant means a registry missing that
// tenant's sensors, whose readings are then dropped as unknown ids.
const activeList = await listActiveTenants();
ok('the tenant list holds both tenants within its ceiling',
   activeList.some((t) => t.id === A.tenantId) && activeList.some((t) => t.id === bTenantId));
let tenantCeiling: unknown = null;
try { await listActiveTenants(1); } catch (err) { tenantCeiling = err; }
ok('over its ceiling the tenant list throws rather than returning the first N',
   tenantCeiling instanceof TooManyTenantsError,
   tenantCeiling instanceof Error ? tenantCeiling.name : 'returned a truncated list');

// ------------------------------------------------------------ copilot reads
console.log('\n[9] Copilot reads (READ ONLY, as dtwin_app)');
/**
 * Every copilot query, the way the copilot runs it: `withTenant(…, { readOnly:
 * true })` as the application role. The fixtures above give them something
 * to find — six hours of OFF-101 temperature with forty flagged samples in two
 * runs, and a main meter that resets once and carries one flagged 9e9 spike —
 * and tenant B, still alive here, gives isolation something to hide.
 */
const roA = <T>(fn: (db: Db) => Promise<T>) => withTenant(A, fn, { readOnly: true });
const roB = <T>(fn: (db: Db) => Promise<T>) => withTenant(B, fn, { readOnly: true });
const until = new Date();

// A read-only transaction really is one: a write inside it is refused by
// Postgres, whatever the role's grants say.
const roWrite = await roA((db) => db.query(
  `INSERT INTO maintenance_logs (tenant_id, equipment_id, performed_at, log_type)
   VALUES ($1, $2, now(), 'inspection')`, [A.tenantId, ahu.id],
)).then(() => null, (err: unknown) => err as { code?: string });
ok('a READ ONLY transaction refuses an INSERT (SQLSTATE 25006)', roWrite?.code === '25006',
   roWrite ? `code ${roWrite.code}` : 'the row was written');

const orient = await roA((db) => copilotOrient(db));
ok('orient: the seeded building, its timezone and 24 directory zones',
   orient.building?.id === A.buildingId && orient.building.timezone.length > 0
     && orient.directory.length === 24 && !orient.multipleBuildings,
   `${orient.building?.name} ${orient.building?.timezone} ${orient.directory.length} zones`);
const dirL1 = orient.directory.find((z) => z.id === hitL1!.id);
ok('orient: a directory row carries its design band and serving equipment',
   typeof dirL1?.designed_setpoint_c === 'number' && typeof dirL1.deadband_k === 'number'
     && dirL1.serving.some((s) => /^AHU-\d+ \(\w+\)$/.test(s)),
   JSON.stringify(dirL1?.serving));
ok('orient: no floor or zone energy meter exists in the seed',
   !orient.availability.perFloorEnergyMeter && !orient.availability.perZoneEnergyMeter);
ok('orient: the telemetry span is known', orient.availability.telemetryFrom !== null
   && orient.availability.telemetryTo !== null);
// The prompts name no building's meters; this list is how a model learns
// them. Every tag in it must be one meter_consumption accepts.
ok('orient: lists the seed\'s readable meters by tag and unit',
   JSON.stringify(orient.availability.meters) === JSON.stringify([
     { tag: 'MTR-MAIN', type: 'electric_meter', unit: 'kwh' },
     { tag: 'MTR-WATER', type: 'water_meter', unit: 'm3' },
   ]),
   JSON.stringify(orient.availability.meters));
const orientB = await roB((db) => copilotOrient(db));
ok('orient under another tenant sees only that tenant\'s building',
   orientB.building?.id === bBuildingId && orientB.directory.length === 1,
   `${orientB.building?.name}, ${orientB.directory.length} zone(s)`);

const zonesV1 = await roA((db) => copilotListZones(db));
ok('list_zones (v1) returns every zone', zonesV1.length === 24, `got ${zonesV1.length}`);

const cond = await roA((db) => copilotZoneConditions(db, { zoneId: hitL1!.id, from: windowStart, to: until }));
const t = cond?.metrics.temperature_c;
ok('zone_conditions counts the flagged samples and keeps them out of the statistics',
   t?.flagged_samples_count === 40 && t.min_c !== null && t.min_c > 20
     && t.mean_c !== null && t.mean_c > 20 && t.mean_c < 26,
   `flagged ${t?.flagged_samples_count}, min ${t?.min_c?.toFixed(2)}, mean ${t?.mean_c?.toFixed(2)}`);
ok('zone_conditions reports coverage against the buckets the window should hold',
   t !== undefined && t.good_buckets_count > 0 && t.good_buckets_count <= t.expected_buckets_count
     && t.expected_buckets_count === bucketStartsIn(windowStart, until, 300),
   `${t?.good_buckets_count} of ${t?.expected_buckets_count}`);
ok('zone_conditions carries the design band and the serving AHU',
   cond?.design.setpoint_c !== null && cond?.design.deadband_k !== null
     && /^AHU-/.test(cond?.ahu?.tag ?? '') && cond?.comfort !== undefined,
   JSON.stringify(cond?.design));
const comfort = cond?.comfort;
ok('zone_conditions judges comfort only where occupancy was reported',
   comfort !== undefined && (comfort.occupied_min === null
     ? Object.values(comfort).every((v) => v === null)
     : [comfort.above_design_band_min, comfort.below_design_band_min]
         .every((v) => v === null || v <= comfort.occupied_min!)),
   JSON.stringify(comfort));
ok('another tenant\'s zone has no conditions, not an error',
   (await roB((db) => copilotZoneConditions(db, { zoneId: hitL1!.id, from: windowStart, to: until }))) === null);

const hist = await roA((db) => copilotZoneHistory(db, {
  zoneId: hitL1!.id, metrics: ['temperature_c'], resolution: '1h', from: windowStart, to: until,
}));
const series = hist.series.temperature_c ?? [];
ok('zone_history: hourly series, flagged counted and excluded',
   series.length > 0 && series.reduce((n, p) => n + p.flagged_count, 0) === 40
     && series.every((p) => p.mean_c === null || (p.mean_c > 20 && p.mean_c < 26)),
   `${series.length} points`);
const histRefused = await roA((db) => copilotZoneHistory(db, {
  zoneId: hitL1!.id, metrics: ['temperature_c'], resolution: '5m',
  from: new Date(until.getTime() - 200 * 3600_000), to: until,
})).then(() => null, (err: unknown) => err);
ok('zone_history refuses a span its reader would truncate, naming the limit',
   histRefused instanceof RangeError && /168 h/.test(histRefused.message),
   histRefused instanceof Error ? histRefused.message : 'answered');

const timeline = await roA((db) => copilotZoneTimeline(db, {
  zoneId: hitL1!.id, from: windowStart, to: until, limit: 50,
}));
const episodes = timeline.items.filter((i) => i.kind === 'flag_episode');
ok('zone_timeline finds both runs of flagged samples, forty samples in all',
   episodes.length >= 2
     && episodes.reduce((n, e) => n + Number(e.detail.flagged_samples_count), 0) === 40,
   episodes.map((e) => `${e.detail.duration_min} min/${e.detail.flagged_samples_count}`).join(', '));
ok('zone_timeline is chronological and counts every event',
   timeline.items.every((e, i, all) => i === 0 || all[i - 1]!.at <= e.at)
     && timeline.total === timeline.items.length && !timeline.truncated);
const drift = timeline.rulesInScope.items.find((r) => r.condition === 'rate_of_change');
ok('zone_timeline lists the rules in scope, thresholds keyed by their unit',
   timeline.rulesInScope.total >= 1 && (drift === undefined || 'threshold_k_per_h' in drift),
   `${timeline.rulesInScope.total} rules; drift keys ${drift ? Object.keys(drift).filter((k) => k.startsWith('threshold')) : 'n/a'}`);
const tl1 = await roA((db) => copilotZoneTimeline(db, { zoneId: hitL1!.id, from: windowStart, to: until, limit: 1 }));
ok('a timeline at its cap says so and keeps the most recent event',
   tl1.truncated && tl1.items.length === 1 && tl1.total === timeline.total
     && tl1.items[0]!.at === timeline.items.at(-1)!.at,
   `total ${tl1.total}, kept ${tl1.items[0]?.kind}`);

const equip = await roA((db) => copilotEquipmentStatus(db, { tag: null, zoneId: hitL1!.id, limit: 40, buildingId: A.buildingId }));
const zoneVav = equip.items.find((e) => e.type === 'vav');
const chiller = equip.items.find((e) => e.type === 'chiller');
ok('equipment_status by zone is the serving chain, with each unit\'s chain upward',
   equip.total === 4 && zoneVav?.chain_up.length === 3 && zoneVav.zones_served_count === 1,
   equip.items.map((e) => `${e.tag}<${e.chain_up.join('<')}>`).join(' '));
ok('equipment_status counts every zone below a unit and names the first eight',
   chiller?.zones_served_count === 24 && chiller.zones_served.length === 8);
const equip2 = await roA((db) => copilotEquipmentStatus(db, { tag: null, zoneId: hitL1!.id, limit: 2, buildingId: A.buildingId }));
ok('equipment_status at its cap says so', equip2.truncated && equip2.total === 4 && equip2.items.length === 2);
// Configured evidence: a measured draw inside it would be cited as configured.
ok('equipment_status carries configuration only, no measured draw',
   equip.items.every((e) => !Object.keys(e).some((k) => k.includes('_kw') || k.startsWith('last_hour'))),
   Object.keys(equip.items[0] ?? {}).join(','));

const monthAgo = new Date(until.getTime() - 31 * 24 * 3600_000);
const alertsPage = await roA((db) => copilotListAlerts(db, { state: 'any', from: monthAgo, to: until, zoneId: null, limit: 50, buildingId: A.buildingId }));
ok('list_alerts returns a capped page', Array.isArray(alertsPage.items)
   && alertsPage.total >= alertsPage.items.length && alertsPage.limit === 50
   && alertsPage.truncated === (alertsPage.total > alertsPage.items.length));
const commands = await roA((db) => copilotControlHistory(db, { zoneId: null, from: monthAgo, to: until, limit: 50, buildingId: A.buildingId }));
ok('control_history returns a capped page', Array.isArray(commands.items)
   && commands.total >= commands.items.length
   && commands.items.every((c) => 'reason_untrusted' in c && !('reason' in c)));

const energy = await roA((db) => copilotEnergyByEndUse(db, { from: windowStart, to: until, groupBy: 'floor', timezone: tree!.building.timezone, buildingId: A.buildingId }));
ok('energy_by_end_use: one row per floor plus the unallocated plant',
   energy.rows.length === 5 && energy.rows.some((r) => 'floor' in r && r.floor === BUILDING_PLANT)
     && energy.rows.every((r) => r.sensors_count > 0 && r.good_buckets_count <= r.expected_buckets_count),
   energy.rows.map((r) => ('floor' in r ? r.floor : r.day)).join(', '));
const energyDays = await roA((db) => copilotEnergyByEndUse(db, { from: windowStart, to: until, groupBy: 'local_day', timezone: tree!.building.timezone, buildingId: A.buildingId }));
ok('energy_by_end_use by local day generates every day in the window',
   energyDays.rows.length >= 1 && energyDays.rows.every((r) => 'day' in r && r.day_end > r.day_start));

// The meter over the real-time tail. The hourly rollup was refreshed to ten
// minutes ago, so the newest hour is aggregated live — where a parallel plan
// has failed with "out of order points".
const meterTag = tree!.equipment.find((e) => e.id === tree!.sensors.find((s) => s.id === meter.id)?.equipmentId)?.tag;
const hourMs = 3600_000;
const meterFrom = new Date(Math.ceil(windowStart.getTime() / hourMs) * hourMs);
const meterTo = new Date(Math.ceil(until.getTime() / hourMs) * hourMs + hourMs);
const byHour = await roA((db) => copilotMeterConsumption(db, {
  meterTag: meterTag ?? '', from: meterFrom, to: meterTo, bucket: 'hour', timezone: tree!.building.timezone, buildingId: A.buildingId,
})).then((v) => v, (err: unknown) => err as Error);
const hourly = byHour instanceof Error || 'unknownMeter' in byHour || byHour.unit !== 'kwh' ? null : byHour;
ok('meter_consumption runs over the real-time tail without "out of order points"',
   hourly !== null, byHour instanceof Error ? byHour.message : JSON.stringify(byHour).slice(0, 80));
// 361 readings at 3 kWh a minute across one reset: (1,000,720 − 1,000,003) +
// 0 at the reset + 360 after it = 1,077 kWh. The flagged 9e9 spike would be
// nine billion if the rollup counted it.
ok('the window total is its own reset-aware rollup, spike excluded',
   hourly !== null && hourly.total_kwh !== null && hourly.total_kwh > 1_000 && hourly.total_kwh < 1_100
     && hourly.total_resets_count >= 1,
   `total ${hourly?.total_kwh?.toFixed(1)} kWh, ${hourly?.total_resets_count} reset(s)`);
const byDay = await roA((db) => copilotMeterConsumption(db, {
  meterTag: meterTag ?? '', from: meterFrom, to: meterTo, bucket: 'local_day', timezone: tree!.building.timezone, buildingId: A.buildingId,
})).then((v) => v, (err: unknown) => err as Error);
ok('meter_consumption by local day agrees on the window total',
   !(byDay instanceof Error) && !('unknownMeter' in byDay) && byDay.unit === 'kwh'
     && byDay.total_kwh === hourly?.total_kwh && byDay.buckets.length >= 1,
   byDay instanceof Error ? byDay.message : '');
const listedAccepted = await Promise.all(orient.availability.meters.map((m) => roA((db) => copilotMeterConsumption(db, {
  meterTag: m.tag, from: meterFrom, to: meterTo, bucket: 'hour', timezone: tree!.building.timezone, buildingId: A.buildingId,
})).then((v) => !('unknownMeter' in v) && v.unit === m.unit, () => false)));
ok('every meter orient lists is one meter_consumption reads, in the unit listed',
   listedAccepted.length === 2 && listedAccepted.every(Boolean), JSON.stringify(listedAccepted));
ok('a tag that is not a meter is unknown, not an error',
   'unknownMeter' in await roA((db) => copilotMeterConsumption(db, {
     meterTag: ahu.tag, from: meterFrom, to: meterTo, bucket: 'hour', timezone: tree!.building.timezone, buildingId: A.buildingId,
   })));

const ranked = await roA((db) => copilotCompareZones(db, {
  metric: 'temperature_c', from: windowStart, to: until, floorLevel: 1, orderBy: 'mean', limit: 2, buildingId: A.buildingId,
}));
const l1Row = ranked.items.find((r) => r.zone_id === hitL1!.id);
ok('compare_zones ranks one floor, capped, with the page flagged as truncated',
   ranked.total === 6 && ranked.items.length === 2 && ranked.truncated);
ok('compare_zones: the fixture zone ranks with its flagged samples counted',
   l1Row !== undefined && l1Row.flagged_samples_count === 40
     && Number(l1Row.mean_c) > 20 && Number(l1Row.mean_c) < 26,
   JSON.stringify(l1Row));
ok('compare_zones floor mean covers the whole floor, not the page',
   ranked.floor_means.length === 1 && ranked.floor_means[0]!.zones_count === 6);
const band = await roA((db) => copilotCompareZones(db, {
  metric: 'temperature_c', from: windowStart, to: until, floorLevel: null, orderBy: 'minutes_above_band', limit: 24, buildingId: A.buildingId,
}));
ok('compare_zones can rank by occupied minutes above the designed band',
   band.total === 24 && band.items.every((r) => 'minutes_above_band_min' in r));
// Coverage is counted in 5-minute periods, not hours: the fixture zone has six
// hours of minute data, so it has far more good periods than hours.
const { rows: [l1Periods] } = await roA((db) => db.query<{ n: number }>(
  `SELECT count(DISTINCT a.bucket)::int AS n
     FROM sensors s JOIN telemetry_5m_t a ON a.sensor_id = s.id
    WHERE s.zone_id = $1 AND s.metric = 'temperature_c' AND s.is_active AND a.avg_value IS NOT NULL
      AND a.bucket >= $2 AND a.bucket < $3`,
  [hitL1!.id, ranked.covered.from, new Date(Math.ceil(until.getTime() / 3600_000) * 3600_000)]));
const l1All = (await roA((db) => copilotCompareZones(db, {
  metric: 'temperature_c', from: windowStart, to: until, floorLevel: 1, orderBy: 'mean', limit: 24, buildingId: A.buildingId,
}))).items.find((r) => r.zone_id === hitL1!.id);
ok('compare_zones counts coverage in the 5-minute periods of the window it covered',
   l1All !== undefined && l1All.good_buckets_count === l1Periods!.n && l1All.good_buckets_count > 12,
   `${l1All?.good_buckets_count} counted, ${l1Periods?.n} good periods`);

console.log('\n[9b] Copilot reads: what the review found (each in a transaction that is rolled back)');
/**
 * Each case needs a state the fixtures above do not hold — an alert on plant,
 * a zone with no temperature point, a second building — so each is built,
 * read and ROLLED BACK in one transaction, the reads running on that
 * transaction's own connection. Nothing here outlives its check.
 */
const ROLLBACK = new Error('smoke: roll back');
async function rolledBack<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  let out: { value: T } | null = null;
  try {
    await withTenant(A, async (db) => {
      out = { value: await fn(db) };
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  return out!.value;
}

// An AHU has no zone, so an alert on its supply-air point resolves to none.
// The zone's timeline promises the equipment serving it.
const plantAlert = await rolledBack(async (db) => {
  const { rows: [point] } = await db.query<{ id: string; tag: string }>(
    `SELECT s.id, e.tag
       FROM equipment_zone_service es
       JOIN equipment e ON e.id = es.equipment_id
       JOIN sensors s ON s.equipment_id = e.id
      WHERE es.zone_id = $1 AND e.equipment_type = 'ahu' AND e.zone_id IS NULL AND s.zone_id IS NULL
      ORDER BY e.tag, s.id LIMIT 1`, [hitL1!.id]);
  const { rows: [rule] } = await db.query<{ id: string }>(`SELECT id FROM alert_rules ORDER BY name, id LIMIT 1`);
  await db.query(
    `INSERT INTO alerts (tenant_id, rule_id, sensor_id, severity, state, message, opened_at)
     VALUES ($1, $2, $3, 'warning', 'open', 'smoke: serving AHU', $4)`,
    [A.tenantId, rule!.id, point!.id, new Date(until.getTime() - 60_000)]);
  const tl = await copilotZoneTimeline(db, { zoneId: hitL1!.id, from: windowStart, to: until, limit: 50 });
  return { tag: point!.tag, opened: tl.items.filter((i) => i.kind === 'alert_opened' && i.detail.equipment === point!.tag) };
});
ok('zone_timeline includes an alert on the AHU serving the zone, and names the AHU',
   plantAlert.opened.length === 1, `${plantAlert.tag}: ${plantAlert.opened.length} alert(s)`);

// A zone with no active temperature point: no feed, so no gap in it — and,
// occupied, no "zero minutes out of band" either, because nothing was judged.
const noTemperature = await rolledBack(async (db) => {
  await db.query(`UPDATE sensors SET is_active = false WHERE zone_id = $1 AND metric = 'temperature_c'`, [hitL1!.id]);
  const { rows: [occ] } = await db.query<{ id: string }>(
    `SELECT id FROM sensors WHERE zone_id = $1 AND metric = 'occupancy_count' AND is_active ORDER BY id LIMIT 1`,
    [hitL1!.id]);
  // Occupied for the last nine minutes: after the rollup's watermark (ten
  // minutes back), so real-time aggregation reads it. Never future-dated.
  const t0 = Date.now();
  await insertReadings(db, Array.from({ length: 9 }, (_, i) => ({
    sensorId: occ!.id as Reading['sensorId'], ts: t0 - (9 - i) * 60_000, value: 12, quality: 0,
  })));
  const tl = await copilotZoneTimeline(db, { zoneId: hitL1!.id, from: windowStart, to: new Date(t0), limit: 50 });
  const cz = await copilotZoneConditions(db, { zoneId: hitL1!.id, from: new Date(t0 - 10 * 60_000), to: new Date(t0) });
  return { gaps: tl.items.filter((i) => i.kind === 'data_gap'), comfort: cz?.comfort };
});
ok('zone_timeline reports no temperature gap for a zone with no temperature point',
   noTemperature.gaps.length === 0, JSON.stringify(noTemperature.gaps));
ok('zone_conditions leaves the band minutes null when the zone was occupied and no temperature was judged',
   (noTemperature.comfort?.occupied_min ?? 0) > 0 && noTemperature.comfort?.occupied_with_temperature_min === 0
     && noTemperature.comfort.above_design_band_min === null && noTemperature.comfort.below_design_band_min === null
     && noTemperature.comfort.above_effective_band_min === null,
   JSON.stringify(noTemperature.comfort));

// A second building on the same tenant, sorting after the first: orient
// answers about the first and says so, and every read below must keep to it.
// Its level-1 floor shares the level, its meter shares the tag (and sorts
// first by id), and its AHU carries a power point and an open alert.
const secondBuilding = await rolledBack(async (db) => {
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO buildings (tenant_id, name, timezone) VALUES ($1, 'Zzz Smoke Annex', 'UTC') RETURNING id`, [A.tenantId]);
  const { rows: [f] } = await db.query<{ id: string }>(
    `INSERT INTO floors (tenant_id, building_id, level, name, elevation_m) VALUES ($1, $2, 1, $3, 0) RETURNING id`,
    [A.tenantId, b!.id, l1.name]);
  await db.query(`INSERT INTO zones (tenant_id, floor_id, name, zone_type, area_m2) VALUES ($1, $2, 'ZZ-101', 'office', 50)`,
    [A.tenantId, f!.id]);
  const { rows: [ahuB] } = await db.query<{ id: string }>(
    `INSERT INTO equipment (tenant_id, building_id, floor_id, tag, equipment_type) VALUES ($1, $2, $3, 'AHU-ZZ', 'ahu') RETURNING id`,
    [A.tenantId, b!.id, f!.id]);
  const { rows: [kw] } = await db.query<{ id: string }>(
    `INSERT INTO sensors (tenant_id, external_id, name, metric, unit, equipment_id)
     VALUES ($1, 'smoke-zz-kw-' || gen_random_uuid(), 'AHU-ZZ kW', 'power_kw', 'kW', $2) RETURNING id`, [A.tenantId, ahuB!.id]);
  const { rows: [mtr] } = await db.query<{ id: string }>(
    `INSERT INTO equipment (id, tenant_id, building_id, tag, equipment_type)
     VALUES ('00000000-0000-0000-0000-000000000001', $1, $2, $3, 'electric_meter') RETURNING id`,
    [A.tenantId, b!.id, meterTag]);
  await db.query(
    `INSERT INTO sensors (tenant_id, external_id, name, metric, unit, equipment_id, is_cumulative)
     VALUES ($1, 'smoke-zz-mtr-' || gen_random_uuid(), 'ZZ main kWh', 'energy_kwh', 'kWh', $2, true)`, [A.tenantId, mtr!.id]);
  const { rows: [rule] } = await db.query<{ id: string }>(`SELECT id FROM alert_rules ORDER BY name, id LIMIT 1`);
  await db.query(
    `INSERT INTO alerts (tenant_id, rule_id, sensor_id, equipment_id, severity, state, message, opened_at)
     VALUES ($1, $2, $3, $4, 'critical', 'open', 'smoke: the other building', $5)`,
    [A.tenantId, rule!.id, kw!.id, ahuB!.id, new Date(until.getTime() - 60_000)]);

  const scope = { buildingId: A.buildingId };
  return {
    orient: await copilotOrient(db),
    compare: await copilotCompareZones(db, {
      metric: 'temperature_c', from: windowStart, to: until, floorLevel: 1, orderBy: 'mean', limit: 24, ...scope,
    }),
    energy: await copilotEnergyByEndUse(db, { from: windowStart, to: until, groupBy: 'floor', timezone: tree!.building.timezone, ...scope }),
    meter: await copilotMeterConsumption(db, {
      meterTag: meterTag ?? '', from: meterFrom, to: meterTo, bucket: 'hour', timezone: tree!.building.timezone, ...scope,
    }),
    equipment: await copilotEquipmentStatus(db, { tag: meterTag ?? '', zoneId: null, limit: 40, ...scope }),
    alerts: await copilotListAlerts(db, { state: 'any', from: monthAgo, to: until, zoneId: null, limit: 500, ...scope }),
  };
});
ok('with a second building, orient still answers about the first and says there is another',
   secondBuilding.orient.building?.id === A.buildingId && secondBuilding.orient.multipleBuildings);
ok('compare_zones keeps to orient\'s building: the other building\'s level-1 zone is not ranked',
   secondBuilding.compare.total === ranked.total && secondBuilding.compare.floor_means[0]?.zones_count === 6,
   `${secondBuilding.compare.total} zones`);
ok('energy_by_end_use keeps to orient\'s building: the other building\'s AHU is not summed',
   JSON.stringify(secondBuilding.energy.rows.map((r) => r.sensors_count)) === JSON.stringify(energy.rows.map((r) => r.sensors_count)),
   secondBuilding.energy.rows.map((r) => `${'floor' in r ? r.floor : ''}:${r.sensors_count}`).join(', '));
ok('meter_consumption reads orient\'s building\'s meter, not the other one with the same tag',
   !('unknownMeter' in secondBuilding.meter) && secondBuilding.meter.unit === 'kwh'
     && secondBuilding.meter.total_kwh === hourly?.total_kwh,
   'unknownMeter' in secondBuilding.meter ? 'unknown' : JSON.stringify(secondBuilding.meter).slice(0, 120));
ok('equipment_status by tag finds one unit, in orient\'s building', secondBuilding.equipment.total === 1,
   `${secondBuilding.equipment.total} unit(s)`);
ok('list_alerts keeps to orient\'s building', !secondBuilding.alerts.items.some((a) => a.equipment === 'AHU-ZZ'));

console.log('\n[10] Sign-in');
// `login()` had no coverage in any suite: the web smoke runs on the demo tenant
// and never signs in. It is exercised here, against the real hash and the real
// tables, while the fixture tenant still exists to be a member of.
const signInEmail = `signin-${Date.now().toString(36)}@example.invalid`;
const signInUser = await createUser(signInEmail, 'Sign-in Smoke', 'correct horse battery');
await addMember(bTenantId, signInUser, 'viewer');

const goodLogin = await login(signInEmail.toUpperCase(), 'correct horse battery');
ok('the right password opens a session on the member tenant, case-insensitively',
   goodLogin?.tenantId === bTenantId && goodLogin.role === 'viewer' && goodLogin.token.length >= 32);
ok('a wrong password, an unknown address and a wrong tenant all answer the same null',
   (await login(signInEmail, 'wrong')) === null
   && (await login('nobody@example.invalid', 'correct horse battery')) === null
   && (await login(signInEmail, 'correct horse battery', 'no-such-tenant')) === null);

// The hash must not hold a database connection. It did: `login` was one
// `withoutTenant` block, so each attempt pinned a pooled connection for ~100 ms
// of CPU that needs no database, and ten concurrent sign-ins emptied the pool
// for every other query in the process.
//
// Sampled, not timed. Twenty-four lookups starting together MUST queue for a
// moment on a ten-connection pool, so "nobody ever waited" is the wrong
// assertion (it was the first one written here, and it failed against correct
// code). What distinguishes the two shapes is where the connections are while
// the hashes run: under the old one all ten were checked out for the entire
// stretch; now they are out for the few milliseconds of lookup at each end and
// idle for the hundreds in between. The share of samples that found the pool
// fully idle is a ratio of those durations, so it does not depend on how fast
// the machine is — ~0% before, most of them now.
const appPool = getPool();
// Open the pool's connections first. Opening one resolves a hostname, which
// libuv does on the same four-thread pool scrypt runs on — so a connection
// requested mid-hash waits behind the hashes, and the first version of this
// measurement read 54% idle because it was mostly watching connections being
// established. Real, and worth knowing, but not what this check is about.
await Promise.all(Array.from({ length: appPool.options.max ?? 10 }, () => appPool.query('SELECT 1')));
let samples = 0;
let idleSamples = 0;
const sampler = setInterval(() => {
  samples += 1;
  if (appPool.totalCount - appPool.idleCount === 0 && appPool.waitingCount === 0) idleSamples += 1;
}, 5);
const concurrent = await Promise.all(
  Array.from({ length: 24 }, () => login(signInEmail, 'wrong')),
);
clearInterval(sampler);
const idleShare = samples === 0 ? 0 : idleSamples / samples;
ok('no database connection is held while a password is being hashed',
   concurrent.every((r) => r === null) && samples >= 10 && idleShare > 0.5,
   `pool fully idle in ${(idleShare * 100).toFixed(0)}% of ${samples} samples across 24 concurrent sign-ins`);

await owner.query('UPDATE users SET is_active = false WHERE id = $1', [signInUser]);
ok('a deactivated user cannot sign in with the right password',
   (await login(signInEmail, 'correct horse battery')) === null);
await owner.query('DELETE FROM users WHERE id = $1', [signInUser]);

// Clean up the fixture tenant. ON DELETE CASCADE from `tenants` removes its
// building, floor, zone and sensor, which is itself worth asserting.
await withTenant(B, (db) => db.query('DELETE FROM tenants WHERE id = $1', [bTenantId]));
const { rows: leftovers } = await owner.query<{ n: number }>(
  'SELECT count(*)::int AS n FROM buildings WHERE id = $1', [bBuildingId],
);
ok('deleting a tenant cascades its whole world away', leftovers[0]?.n === 0);

await closePool();
console.log(
  failures === 0
    ? '\ndone — all checks passed.\n'
    : `\ndone — ${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
