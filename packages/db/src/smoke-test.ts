/**
 * End-to-end smoke test for the data layer.
 *
 * Exercises the schema against a real database: spatial tree hydration, 3D
 * picking with elevation disambiguation, batched telemetry writes, reset-aware
 * counter aggregation, the heatmap rollup, the Zod parse boundary, and — since
 * 007/008 — tenant isolation.
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
import { getOwnerPool, closePool, withTenant } from './client.ts';
import {
  getSpatialTree, findZoneAtPoint, insertReadings, SPATIAL_LIMITS, SpatialTreeTooLargeError,
  getLatestReadingsForZone, getSensorHistory, getZoneHeatmap,
  createTenant, listBuildings, getTenant,
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
for (let i = 360; i >= 0; i--) {
  const ts = now - i * 60_000;
  readings.push({
    sensorId: tempSensor.id as Reading['sensorId'],
    ts,
    value: 23 + 2 * Math.sin((ts / 3_600_000) * Math.PI / 6),
    quality: 0,
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
  meterReadings.push({
    sensorId: meter.id as Reading['sensorId'],
    ts: now - i * 60_000, value: acc, quality: 0,
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
const naive = Math.max(...meterReadings.map(r => r.value)) - Math.min(...meterReadings.map(r => r.value));
ok('naive max-min would have been wrong', Math.abs(naive - totalDelta) > 1000,
   `naive = ${naive.toFixed(0)} vs counter_agg = ${totalDelta.toFixed(0)}`);

const tempHist = await withTenant(A, (db) => getSensorHistory(db, tempSensor.id, '1h', from, to));
ok('gauge sensor history has buckets', tempHist.length > 0, `${tempHist.length} buckets`);
ok('gauge delta is null (not a counter)', tempHist[0]?.deltaValue === null);
ok('gauge avg is in range', (tempHist[0]?.avgValue ?? 0) > 20 && (tempHist[0]?.avgValue ?? 0) < 26,
   `avg = ${tempHist[0]?.avgValue?.toFixed(2)}`);

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
