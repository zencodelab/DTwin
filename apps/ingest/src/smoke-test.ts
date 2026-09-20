/**
 * End-to-end smoke test for the ingest service.
 *
 * Spawns the real server process and drives it over HTTP and WebSocket, rather
 * than importing the modules and calling them directly — the things most likely
 * to be wrong (routing, framing, subscription lifecycle, shutdown flushing) only
 * exist in the assembled process.
 *
 * Requires a migrated, seeded database. Run with:  npm run smoke -w @dtwin/ingest
 */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { getOwnerPool, closePool, withTenant, signWsTicket } from '@dtwin/db';
import { createApiKey, createTenant } from '@dtwin/db/queries';
import { parseServerMessage, topics, type AlertWithContext, type ServerMessage, type Topic } from '@dtwin/types';
import { checkDestination, parseTargets } from './rules/notify.ts';

const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;

/**
 * The service authenticates everything now, so the test has to hold real
 * credentials: a device key for HTTP and a signed ticket for the socket. They
 * are minted against the seeded tenant before the server starts.
 *
 * AUTH_SECRET is set here and passed to the child process. It has no default
 * anywhere in the system, deliberately, so the test has to supply one too.
 */
const AUTH_SECRET = 'smoke-test-auth-secret-at-least-32-chars';
process.env.AUTH_SECRET = AUTH_SECRET;

const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Credentials, filled in before the server starts.
 *
 * `authHeaders` is applied by the helpers below, so the ~30 call sites that
 * predate authentication did not each have to grow a header. The few
 * assertions that deliberately send the WRONG credentials pass their own.
 */
let deviceKey = '';
let serviceKey = '';
let TENANT = '';
let ACTING_USER = '';

const authHeaders = (): Record<string, string> => ({
  authorization: `Bearer ${deviceKey}`,
  'x-acting-user': ACTING_USER,
});

/** fetch().json() is `unknown` by design; these responses are our own shapes. */
async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  return (await (await fetch(url, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers ?? {}) },
  })).json()) as T;
}

const postJson = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(), ...headers },
    body: JSON.stringify(body),
  });

const del = (url: string): Promise<Response> =>
  fetch(url, { method: 'DELETE', headers: authHeaders() });

/**
 * Open a socket and complete the auth handshake.
 *
 * Every subscribe is refused until this succeeds, so a helper that forgets the
 * handshake produces a test that silently observes nothing.
 */
function openSocket(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const timer = setTimeout(() => reject(new Error('socket auth timed out')), 10_000);
    socket.on('open', () => {
      socket.send(JSON.stringify({
        type: 'auth',
        ticket: signWsTicket({ tenantId: TENANT, userId: ACTING_USER }),
      }));
    });
    socket.on('message', function onMessage(data: Buffer) {
      const parsed = parseServerMessage(data.toString());
      if (parsed.ok && parsed.message.type === 'authenticated') {
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(socket);
      }
    });
    socket.on('error', reject);
  });
}

interface Health {
  status: string; sensors: number;
  simulator: { enabled: boolean; emitted?: number; tracking?: number };
}
interface IngestResponse { accepted: number; flagged: number; unknownIds: string[] }
interface AlertsResponse { alerts: AlertWithContext[] }

/** Create a rule scoped to one sensor, tagged so cleanup can find it. */
async function createRule(spec: {
  name: string; sensorId: string; condition: string;
  threshold?: number | null; windowS?: number | null;
  consecutive?: number; cooldownS?: number; severity?: string;
}): Promise<string> {
  const { rows } = await withTenant({ tenantId: TENANT }, (db) => db.query<{ id: string }>(
    `INSERT INTO alert_rules (tenant_id, name, sensor_id, condition, threshold, window_s,
                              consecutive_breaches, cooldown_s, severity)
     VALUES ($1, $2, $3, $4::alert_condition, $5, $6, $7, $8, $9::alert_severity)
     RETURNING id`,
    [TENANT, `smoke: ${spec.name}`, spec.sensorId, spec.condition,
     spec.threshold ?? null, spec.windowS ?? null,
     spec.consecutive ?? 1, spec.cooldownS ?? 0, spec.severity ?? 'warning'],
  ));
  return rows[0]!.id;
}

/** Poll until a predicate holds, so the test paces itself off real state. */
async function until<T>(
  fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 12_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!pred(last) && Date.now() < deadline) {
    await sleep(150);
    last = await fn();
  }
  return last;
}

const liveAlerts = () => getJson<AlertsResponse>(`${BASE}/alerts?state=live`);

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('ingest server did not become healthy');
}

/**
 * Refuse to run alongside another ingest service.
 *
 * This test spawns its own instance with its own device simulator. A second
 * simulator writing to the same database advances the shared cumulative meters
 * on its own accumulator, and the counter-monotonicity assertion then fails on
 * data this test did not produce — a confusing symptom for a simple cause.
 */
async function assertNoOtherIngest(): Promise<void> {
  try {
    const res = await fetch('http://127.0.0.1:8787/healthz', {
      signal: AbortSignal.timeout(500),
    });
    if (res.ok) {
      throw new Error(
        'another ingest service is running on :8787. Its device simulator writes ' +
        'to the same meters as this test\'s, so results would be meaningless. ' +
        'Stop it and re-run.',
      );
    }
  } catch (err) {
    // A connection failure is the expected case: nothing is listening.
    if ((err as Error).message.includes('another ingest service')) throw err;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
let server: ChildProcess | undefined;

/**
 * Only readings this run produced are in scope. The db smoke test writes six
 * hours of backdated history for the same meter, including a deliberate reset —
 * assertions here must not accidentally measure that.
 */
const runStart = new Date();

try {
  await assertNoOtherIngest();

  // ------------------------------------------------------------ credentials
  const owner = getOwnerPool();
  const { rows: [seed] } = await owner.query<{ tenantId: string }>(
    'SELECT tenant_id AS "tenantId" FROM buildings ORDER BY name LIMIT 1');
  if (!seed) throw new Error('no seeded building; run npm run db:migrate');
  TENANT = seed.tenantId;

  // A real user, because `acknowledged_by` is now a foreign key to `users` and
  // an invented id is rejected by the database rather than quietly stored.
  // ON CONFLICT infers on `lower(email)`, matching users_email_uidx. Naming the
  // bare column fails with "no unique or exclusion constraint matching the ON
  // CONFLICT specification" — email is unique only through that expression
  // index, which is what makes the address case-insensitive.
  const { rows: [u] } = await owner.query<{ id: string }>(
    `INSERT INTO users (email, display_name) VALUES ($1, 'Smoke Test')
     ON CONFLICT (lower(email)) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`, ['smoke@example.invalid']);
  ACTING_USER = u!.id;
  await owner.query(
    `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'operator')
     ON CONFLICT DO NOTHING`, [TENANT, ACTING_USER]);

  deviceKey = (await createApiKey(TENANT, 'device', `smoke-device-${Date.now()}`,
    ['ingest:write'])).key;
  serviceKey = (await createApiKey(TENANT, 'service', `smoke-service-${Date.now()}`,
    ['sim:notify'])).key;

  // The installed binary, not `npx`. Two reasons, and the second is why CI
  // found this: npx is a wrapper process, so `server.kill('SIGTERM')` signals
  // the wrapper and `exit` fires when the wrapper exits — while the node
  // process that actually holds the port keeps running. On macOS the signal
  // happened to reach through; on a Linux runner it did not, so [10] was
  // asserting against a server that had never been asked to shut down. The
  // Dockerfile already invokes the binary directly, for the adjacent reason
  // that it keeps container start offline and instant.
  const tsxBin = join(here, '..', '..', '..', 'node_modules', '.bin', 'tsx');
  server = spawn(tsxBin, [join(here, 'server.ts')], {
    env: {
      ...process.env,
      INGEST_PORT: String(PORT),
      // Fast enough that the test does not spend its life waiting.
      SIM_TICK_MS: '200',
      SIM_SPEEDUP: '600',
      INGEST_FLUSH_INTERVAL_MS: '300',
      INGEST_FANOUT_INTERVAL_MS: '200',
      ALERT_SWEEP_INTERVAL_MS: '300',
      ALERT_REFRESH_MS: '700',
      ALERT_NOTIFY_ENABLED: 'true',
      // The receiver below is on loopback, which the SSRF guard blocks by
      // default. Opened deliberately here; the guard itself is tested directly.
      ALERT_WEBHOOK_ALLOW_PRIVATE: 'true',
      ALERT_NOTIFY_RETRY_MS: '1000',
      AUTH_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d: Buffer) => process.stderr.write(`    [server] ${d}`));

  await waitForHealth();

  // ------------------------------------------------------------------ health
  console.log('\n[1] Health and registry');
  const health = await getJson<Health>(`${BASE}/healthz`);
  ok('healthz reports ok', health.status === 'ok', health.status);
  ok('registry loaded 190 sensors', health.sensors === 190, String(health.sensors));

  // Poll rather than assume: /healthz answers as soon as the server is
  // listening, which can be before the simulator's first tick.
  let simHealth = health;
  for (let i = 0; i < 40 && (simHealth.simulator.emitted ?? 0) === 0; i++) {
    await sleep(100);
    simHealth = await getJson<Health>(`${BASE}/healthz`);
  }
  ok('simulator is emitting', (simHealth.simulator.emitted ?? 0) > 0,
     `${simHealth.simulator.emitted} readings`);

  // ------------------------------------------------------------- HTTP ingest
  console.log('\n[2] HTTP ingest');
  const pool = getOwnerPool();
  const { rows: [probe] } = await pool.query<{
    id: string; externalId: string; min: number; max: number;
    floorId: string; zoneId: string;
  }>(
    `SELECT s.id, s.external_id AS "externalId", s.min_plausible AS "min",
            s.max_plausible AS "max", z.floor_id AS "floorId", s.zone_id AS "zoneId"
       FROM sensors s JOIN zones z ON z.id = s.zone_id
      WHERE s.metric = 'temperature_c' LIMIT 1`,
  );
  if (!probe) throw new Error('no temperature sensor in the seeded building');

  const ts = Date.now();
  const accept = await postJson(`${BASE}/ingest`, {
    readings: [{ externalId: probe.externalId, ts, value: 22.7 }],
    source: 'smoke-test',
  });
  const accepted = (await accept.json()) as IngestResponse;
  ok('valid batch returns 202 Accepted', accept.status === 202, String(accept.status));
  ok('one reading accepted', accepted.accepted === 1);
  ok('nothing flagged for an in-range value', accepted.flagged === 0);

  const unknown = (await (await postJson(`${BASE}/ingest`, {
    readings: [{ externalId: 'BAC:NOPE:XX', value: 1 },
  ] })).json()) as IngestResponse;
  ok('unknown external id is reported, not silently dropped',
     unknown.unknownIds[0] === 'BAC:NOPE:XX' && unknown.accepted === 0);

  const outOfRange = (await (await postJson(`${BASE}/ingest`, {
    readings: [{ externalId: probe.externalId, ts: ts + 1, value: 5000 }],
  })).json()) as IngestResponse;
  ok('out-of-plausible-range value is flagged but accepted',
     outOfRange.accepted === 1 && outOfRange.flagged === 1);

  const bad = await postJson(`${BASE}/ingest`, {
    readings: [{ externalId: probe.externalId, value: 'hot' }],
  });
  ok('malformed batch returns 400 with issues', bad.status === 400);
  ok('empty batch is rejected',
     (await postJson(`${BASE}/ingest`, { readings: [] })).status === 400);

  await sleep(800); // let the writer flush
  const { rows: [persisted] } = await pool.query(
    `SELECT value, quality FROM telemetry WHERE sensor_id = $1 AND time = to_timestamp($2/1000.0)`,
    [probe.id, ts],
  );
  ok('reading reached the database', persisted?.value === 22.7, String(persisted?.value));
  const { rows: [flagged] } = await pool.query(
    `SELECT quality FROM telemetry WHERE sensor_id = $1 AND time = to_timestamp($2/1000.0)`,
    [probe.id, ts + 1],
  );
  ok('out-of-range row stored with quality 2, not discarded',
     flagged?.quality === 2, `quality=${flagged?.quality}`);

  // -------------------------------------------------------------- WebSocket
  console.log('\n[3] WebSocket subscription and fan-out');
  // `openSocket` resolves only once the socket is open AND the server has
  // accepted its ticket, so both events are already in the past here. Waiting
  // on 'open' again would wait forever — `once` does not replay a fired event.
  const ws = await openSocket();
  const inbox: ServerMessage[] = [];
  ws.on('message', (d) => {
    const p = parseServerMessage(d.toString());
    if (p.ok) inbox.push(p.message);
  });

  ws.send(JSON.stringify({ type: 'ping', ts: 12345 }));
  await sleep(300);
  ok('ping is answered with a matching pong',
     inbox.some((m) => m.type === 'pong' && m.ts === 12345));

  ws.send('{not json');
  await sleep(200);
  ok('malformed frame yields an error message', inbox.some((m) => m.type === 'error'));
  ok('connection survives a malformed frame', ws.readyState === WebSocket.OPEN);

  ws.send(JSON.stringify({ type: 'subscribe', topics: ['floor:not-a-uuid'] }));
  await sleep(200);
  ok('invalid topic is rejected',
     inbox.filter((m) => m.type === 'error').length >= 2);

  const floorTopic = topics.floor(probe.floorId);
  inbox.length = 0;
  ws.send(JSON.stringify({ type: 'subscribe', topics: [floorTopic] }));
  await sleep(1500);

  const confirmed = inbox.find((m) => m.type === 'subscribed');
  ok('subscribe is acknowledged with the effective topic set',
     confirmed?.type === 'subscribed' && confirmed.topics.includes(floorTopic));

  const frames = inbox.filter((m) => m.type === 'telemetry.batch');
  ok('telemetry frames arrive', frames.length > 0, `${frames.length} frames`);
  ok('all frames carry the subscribed topic',
     frames.every((f) => f.type === 'telemetry.batch' && f.topic === floorTopic));

  const totalReadings = frames.reduce(
    (s, f) => s + (f.type === 'telemetry.batch' ? f.readings.length : 0), 0);
  ok('readings are coalesced, not one frame each',
     totalReadings > frames.length, `${totalReadings} readings in ${frames.length} frames`);

  const { rows: floorSensors } = await pool.query(
    `SELECT s.id FROM sensors s
       LEFT JOIN zones z ON z.id = s.zone_id
       LEFT JOIN equipment e ON e.id = s.equipment_id
      WHERE z.floor_id = $1 OR e.floor_id = $1`, [probe.floorId]);
  const allowed = new Set(floorSensors.map((r) => r.id));
  const streamed = new Set(
    frames.flatMap((f) => f.type === 'telemetry.batch' ? f.readings.map((r) => r[0]) : []));
  ok('only that floor\'s sensors are streamed',
     [...streamed].every((id) => allowed.has(id)),
     `${streamed.size} distinct sensors, all on floor`);
  ok('the whole building is not being broadcast', streamed.size < 190, `${streamed.size} < 190`);

  inbox.length = 0;
  ws.send(JSON.stringify({ type: 'unsubscribe', topics: [floorTopic] }));
  await sleep(900);
  ok('unsubscribe stops the stream',
     inbox.filter((m) => m.type === 'telemetry.batch').length === 0);

  // ----------------------------------------------------- model consistency
  console.log('\n[4] Simulator respects the asset register');
  const { rows: [ch2] } = await pool.query(
    `SELECT s.id FROM sensors s JOIN equipment e ON e.id = s.equipment_id
      WHERE e.tag = 'CH-02' AND s.metric = 'power_kw'`);
  const { rows: [ch1] } = await pool.query(
    `SELECT s.id FROM sensors s JOIN equipment e ON e.id = s.equipment_id
      WHERE e.tag = 'CH-01' AND s.metric = 'power_kw'`);
  await sleep(500);
  const { rows: [ch2v] } = await pool.query(
    `SELECT max(value) AS v FROM telemetry WHERE sensor_id = $1 AND time >= $2`, [ch2.id, runStart]);
  const { rows: [ch1v] } = await pool.query(
    `SELECT max(value) AS v FROM telemetry WHERE sensor_id = $1 AND time >= $2`, [ch1.id, runStart]);
  ok('CH-02 (status=maintenance) draws 0 kW', Number(ch2v?.v) === 0, `${ch2v?.v} kW`);
  ok('CH-01 (operational) draws power', Number(ch1v?.v) > 0, `${Number(ch1v?.v).toFixed(1)} kW`);

  const { rows: [meter] } = await pool.query(
    `SELECT id FROM sensors WHERE is_cumulative AND metric = 'energy_kwh' LIMIT 1`);
  const { rows: [mono] } = await pool.query(
    `SELECT count(*) AS breaks, count(*) OVER () AS _ FROM (
       SELECT value - lag(value) OVER (ORDER BY time) AS d
         FROM telemetry WHERE sensor_id = $1 AND time >= $2
     ) t WHERE d < 0`, [meter.id, runStart]);
  const { rows: [monoN] } = await pool.query(
    `SELECT count(*) AS n FROM telemetry WHERE sensor_id = $1 AND time >= $2`,
    [meter.id, runStart]);
  ok('energy meter counter is monotonic across a process restart',
     Number(mono.breaks) === 0 && Number(monoN.n) > 1,
     `${mono.breaks} decreases over ${monoN.n} readings`);

  // ------------------------------------------------------- fault injection
  console.log('\n[5] Fault injection');
  const faultRes = await postJson(`${BASE}/simulator/fault`,
    { sensorId: probe.id, kind: 'flatline' });
  ok('fault accepted', faultRes.status === 200);
  ok('fault on an unknown sensor is a 404',
     (await postJson(`${BASE}/simulator/fault`,
       { externalId: 'nope', kind: 'flatline' })).status === 404);

  await sleep(1500);
  const { rows: [flat] } = await pool.query(
    `SELECT count(DISTINCT value) AS distinct_values, count(*) AS n
       FROM telemetry WHERE sensor_id = $1 AND time > now() - INTERVAL '1 second'`, [probe.id]);
  ok('flatlined sensor stops changing',
     Number(flat.n) === 0 || Number(flat.distinct_values) <= 1,
     `${flat.distinct_values} distinct across ${flat.n} readings`);
  await del(`${BASE}/simulator/fault`);

  // ----------------------------------------------------------------- alerts
  console.log('\n[6] Alert rule engine');

  // Synthetic data only: start from a clean alert list so counts are meaningful.
  await pool.query('DELETE FROM alert_rules WHERE name LIKE $1', ['smoke:%']);
  await pool.query('DELETE FROM alerts');

  const healthA = await getJson<Health & { alerts: { rules: number; targets: number } }>(
    `${BASE}/healthz`);
  ok('rules loaded and expanded to sensors',
     healthA.alerts.rules === 7 && healthA.alerts.targets > 7,
     `${healthA.alerts.rules} rules -> ${healthA.alerts.targets} targets`);
  ok('a quiet building raises no alerts',
     (await liveAlerts()).alerts.length === 0);

  // Watch the alert stream.
  const alertWs = await openSocket();
  const alertInbox: ServerMessage[] = [];
  // Already open and authenticated — see the note at the first openSocket call.
  alertWs.on('message', (d) => {
    const p = parseServerMessage(d.toString());
    if (p.ok) alertInbox.push(p.message);
  });
  alertWs.send(JSON.stringify({ type: 'subscribe', topics: [topics.tenantAlerts(TENANT)] }));
  await sleep(300);

  // -- debounce: a rule needing many consecutive breaches must not fire early --
  const patientRule = await createRule({
    name: 'patient threshold', sensorId: probe.id,
    condition: 'threshold_above', threshold: -100, consecutive: 10_000,
  });
  await sleep(1500);
  const patientAlerts = (await liveAlerts()).alerts.filter((a) => a.ruleId === patientRule);
  ok('debounce holds back a rule that has not met its breach count',
     patientAlerts.length === 0);

  // -- threshold_above fires on a sustained breach --
  const hotRule = await createRule({
    name: 'zone too hot', sensorId: probe.id,
    condition: 'threshold_above', threshold: 27, consecutive: 3, severity: 'critical',
  });
  await sleep(900); // let the engine pick the new rule up
  await postJson(`${BASE}/simulator/fault`,
    { sensorId: probe.id, kind: 'spike', magnitude: 1.4 });

  const raised = await until(liveAlerts, (r) => r.alerts.some((a) => a.ruleId === hotRule));
  const hot = raised.alerts.find((a) => a.ruleId === hotRule);
  ok('threshold_above opens an alert', hot !== undefined);
  ok('alert carries the rule severity', hot?.severity === 'critical', hot?.severity);
  ok('alert snapshots the threshold', hot?.threshold === 27, String(hot?.threshold));
  ok('trigger value is above the threshold',
     (hot?.triggerValue ?? 0) > 27, String(hot?.triggerValue));
  ok('alert message names the point and the limit',
     hot?.message.includes('above 27') === true, hot?.message);
  ok('alert is joined to spatial context',
     hot?.zoneName != null && hot?.floorName != null,
     `${hot?.zoneName} / ${hot?.floorName}`);

  ok('alert.raised was pushed over the WebSocket',
     alertInbox.some((m) => m.type === 'alert.raised' && m.alert.ruleId === hotRule));

  await sleep(1200);
  const { rows: [dupes] } = await pool.query(
    `SELECT count(*) AS n FROM alerts WHERE rule_id = $1 AND state <> 'resolved'`, [hotRule]);
  ok('a sustained breach yields exactly one open alert, not one per reading',
     Number(dupes.n) === 1, `${dupes.n} open`);

  // -- acknowledge --
  const acked = await postJson(`${BASE}/alerts/ack`, { alertId: hot!.id });
  ok('acknowledge succeeds', acked.status === 200);
  const ackState = (await liveAlerts()).alerts.find((a) => a.id === hot!.id);
  // `acknowledged_by` holds the acting user's id, not a free-text name. The
  // server stopped taking `by` from the body precisely so the trail could not
  // be forged, so the value to expect here is the user the header named.
  ok('acknowledged alert stays live but changes state',
     ackState?.state === 'acknowledged' && ackState.acknowledgedBy === ACTING_USER,
     `state=${ackState?.state} by=${ackState?.acknowledgedBy}`);
  ok('alert.acknowledged was pushed',
     alertInbox.some((m) => m.type === 'alert.acknowledged'));

  // -- resolution when the condition clears --
  alertInbox.length = 0;
  await del(`${BASE}/simulator/fault?sensorId=${probe.id}`);
  const cleared = await until(liveAlerts, (r) => !r.alerts.some((a) => a.id === hot!.id));
  ok('alert resolves once the condition clears',
     !cleared.alerts.some((a) => a.id === hot!.id));
  ok('alert.resolved was pushed', alertInbox.some((m) => m.type === 'alert.resolved'));

  const { rows: [resolved] } = await pool.query(
    `SELECT state, resolved_at FROM alerts WHERE id = $1`, [hot!.id]);
  ok('resolved row has both state and timestamp set',
     resolved.state === 'resolved' && resolved.resolved_at !== null);

  ok('acknowledging a resolved alert is a 409, not a 404',
     (await postJson(`${BASE}/alerts/ack`, { alertId: hot!.id })).status === 409);

  // -- no_data: the condition nothing can trigger --
  const deadRule = await createRule({
    name: 'point offline', sensorId: probe.id,
    condition: 'no_data', windowS: 2, severity: 'critical',
  });
  await sleep(900);
  await postJson(`${BASE}/simulator/fault`, { sensorId: probe.id, kind: 'offline' });
  const dead = await until(liveAlerts, (r) => r.alerts.some((a) => a.ruleId === deadRule));
  ok('no_data fires when a sensor stops reporting',
     dead.alerts.some((a) => a.ruleId === deadRule));
  await del(`${BASE}/simulator/fault?sensorId=${probe.id}`);
  const revived = await until(liveAlerts, (r) => !r.alerts.some((a) => a.ruleId === deadRule));
  ok('no_data resolves when readings return',
     !revived.alerts.some((a) => a.ruleId === deadRule));

  // -- flatline --
  const stuckRule = await createRule({
    name: 'stuck sensor', sensorId: probe.id, condition: 'flatline', windowS: 2,
  });
  await sleep(900);
  await postJson(`${BASE}/simulator/fault`, { sensorId: probe.id, kind: 'flatline' });
  const stuck = await until(liveAlerts, (r) => r.alerts.some((a) => a.ruleId === stuckRule));
  ok('flatline fires on a sensor whose value stops moving',
     stuck.alerts.some((a) => a.ruleId === stuckRule));
  await del(`${BASE}/simulator/fault?sensorId=${probe.id}`);
  await until(liveAlerts, (r) => !r.alerts.some((a) => a.ruleId === stuckRule));

  // -- rate_of_change: must catch a real trend and ignore sensor noise --
  const { rows: [steady] } = await pool.query(
    `SELECT s.id FROM sensors s WHERE s.metric = 'temperature_c' AND s.id <> $1 LIMIT 1`,
    [probe.id]);
  const driftRule = await createRule({
    name: 'thermal drift', sensorId: probe.id,
    condition: 'rate_of_change', threshold: 500, windowS: 4,
  });
  const noiseRule = await createRule({
    name: 'drift on a steady point', sensorId: steady.id,
    condition: 'rate_of_change', threshold: 500, windowS: 4,
  });
  await sleep(900);
  // 3600 units/hour = 1 unit/second, an unmistakable trend at this timescale.
  await postJson(`${BASE}/simulator/fault`,
    { sensorId: probe.id, kind: 'drift', magnitude: 3600 });
  const drifting = await until(liveAlerts, (r) => r.alerts.some((a) => a.ruleId === driftRule));
  ok('rate_of_change catches a genuine trend',
     drifting.alerts.some((a) => a.ruleId === driftRule));
  ok('rate_of_change does NOT fire on a steady, noisy sensor',
     !drifting.alerts.some((a) => a.ruleId === noiseRule));
  await del(`${BASE}/simulator/fault?sensorId=${probe.id}`);

  // -- a flagged reading must not drive a value rule --
  const rangeRule = await createRule({
    name: 'implausible reading', sensorId: probe.id, condition: 'out_of_range',
  });
  const noisyRule = await createRule({
    name: 'hot from bad data', sensorId: probe.id,
    condition: 'threshold_above', threshold: 27, consecutive: 1,
  });
  await sleep(900);
  for (let i = 0; i < 3; i++) {
    await postJson(`${BASE}/ingest`, {
      readings: [{ externalId: probe.externalId, ts: Date.now() + i, value: 9999 }],
    });
  }
  const badData = await until(liveAlerts, (r) => r.alerts.some((a) => a.ruleId === rangeRule));
  ok('out_of_range fires on an implausible reading',
     badData.alerts.some((a) => a.ruleId === rangeRule));
  ok('a flagged reading does not raise a thermal alarm',
     !badData.alerts.some((a) => a.ruleId === noisyRule));

  // ------------------------------------------------ notification delivery
  console.log('\n[7] Alert notifications');

  // The SSRF guard is checked directly: the end-to-end test below has to open
  // loopback to reach its own receiver, so it cannot also prove the guard works.
  const blockedLoopback = await checkDestination('http://127.0.0.1:9/hook', false);
  ok('a loopback webhook is blocked by default',
     !blockedLoopback.ok && blockedLoopback.reason.includes('private'),
     blockedLoopback.ok ? 'allowed' : blockedLoopback.reason);
  const blockedMetadata = await checkDestination('http://169.254.169.254/latest/meta-data', false);
  ok('the cloud metadata address is blocked',
     !blockedMetadata.ok, 'the classic SSRF target');
  const blockedScheme = await checkDestination('file:///etc/passwd', false);
  ok('a non-HTTP scheme is rejected', !blockedScheme.ok);
  ok('a public destination is allowed',
     (await checkDestination('https://example.com/hook', false)).ok);
  ok('parseTargets reads the notify config shape',
     parseTargets({ webhook: 'https://x/y', email: ['a@b'], log: true }).length === 3);
  ok('parseTargets ignores malformed config',
     parseTargets({ webhook: 42, email: 'not-an-email' }).length === 0);

  // A local receiver so delivery can be observed rather than assumed.
  const received: Array<{ event: string; alert: { id: string; message: string } }> = [];
  const receiver: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { received.push(JSON.parse(body)); } catch { /* ignore */ }
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(9711, '127.0.0.1', () => r()));

  const notifyRule = await createRule({
    name: 'notified breach', sensorId: probe.id,
    condition: 'threshold_above', threshold: 27, consecutive: 2, severity: 'critical',
  });
  await pool.query(
    `UPDATE alert_rules SET notify = $2::jsonb WHERE id = $1`,
    [notifyRule, JSON.stringify({
      webhook: 'http://127.0.0.1:9711/hook', email: ['fm@example.com'], log: true,
    })],
  );
  await sleep(900);
  await postJson(`${BASE}/simulator/fault`,
    { sensorId: probe.id, kind: 'spike', magnitude: 1.4 });

  const notified = await until(
    async () => received.length, (n) => n > 0, 15_000,
  );
  ok('the webhook received the alert', notified > 0, `${notified} call(s)`);
  ok('the payload carries the alert',
     received[0]?.event === 'alert.raised' && !!received[0]?.alert?.message,
     received[0]?.alert?.message?.slice(0, 50));

  const delivery = await until(
    async () => (await pool.query(
      `SELECT channel, status, attempts, last_error FROM alert_notifications n
         JOIN alerts a ON a.id = n.alert_id WHERE a.rule_id = $1 ORDER BY channel`,
      [notifyRule])).rows,
    (rows) => rows.length >= 3,
  );
  const webhookRow = delivery.find((r) => r.channel === 'webhook');
  const emailRow = delivery.find((r) => r.channel === 'email');
  const logRow = delivery.find((r) => r.channel === 'log');

  ok('every configured channel is recorded', delivery.length === 3,
     delivery.map((r) => r.channel).join(', '));
  ok('the webhook is recorded delivered', webhookRow?.status === 'delivered');
  ok('the log channel is recorded delivered', logRow?.status === 'delivered');
  ok('email records WHY it was not sent rather than vanishing',
     emailRow?.status === 'failed' && String(emailRow.last_error).includes('transport'),
     String(emailRow?.last_error));

  const deliveredSoFar = received.length;
  await sleep(1500);
  ok('a delivered webhook is not re-sent by the retry sweep',
     received.length === deliveredSoFar,
     `${received.length - deliveredSoFar} extra call(s)`);

  await del(`${BASE}/simulator/fault?sensorId=${probe.id}`);
  await new Promise<void>((r) => receiver.close(() => r()));

  // ------------------------------------------------- simulation broadcast
  console.log('\n[8] Simulation event relay');
  const simWs = await openSocket();
  const simInbox: ServerMessage[] = [];
  // Already open and authenticated — see the note at the first openSocket call.
  simWs.on('message', (d) => {
    const parsed = parseServerMessage(d.toString());
    if (parsed.ok) simInbox.push(parsed.message);
  });

  const { rows: [bldg] } = await pool.query<{ id: string }>(
    'SELECT id FROM buildings LIMIT 1');
  const buildingId = bldg!.id;
  // `fakeRunId` never gets a row in simulation_runs, and does not need one:
  // the topic is keyed by building (§45), so the run id travels in the payload
  // and is the client's business, not the authorisation's.
  const fakeRunId = '00000000-0000-4000-8000-000000000abc';
  simWs.send(JSON.stringify({ type: 'subscribe', topics: [topics.sim(buildingId)] }));
  await sleep(300);

  // Re-keying the topic must not have turned the whole `sim:` scope into a
  // wildcard. A building id this tenant does not own resolves to no owner, and
  // an unknown owner is refused — the same rule every other scope obeys.
  const strangerWs = await openSocket();
  const strangerInbox: ServerMessage[] = [];
  strangerWs.on('message', (d) => {
    const parsed = parseServerMessage(d.toString());
    if (parsed.ok) strangerInbox.push(parsed.message);
  });
  strangerWs.send(JSON.stringify({
    type: 'subscribe', topics: [topics.sim(randomUUID())],
  }));
  await sleep(300);
  ok('a sim topic for an unknown building is refused',
     strangerInbox.some((m) => m.type === 'subscribe.denied'),
     strangerInbox.map((m) => m.type).join(',') || 'nothing received');
  strangerWs.close();

  const unauthorised = await fetch(`${BASE}/internal/sim-event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'sim.progress', runId: fakeRunId, buildingId, progressPct: 10 }),
  });
  ok('the internal endpoint rejects a missing key', unauthorised.status === 401);

  // A device key carries `ingest:write`, not `sim:notify`. Scope is checked
  // separately from authenticity, so a real key for the right tenant is still
  // refused on a route it was not issued for.
  const wrongScope = await fetch(`${BASE}/internal/sim-event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${deviceKey}` },
    body: JSON.stringify({ type: 'sim.progress', runId: fakeRunId, buildingId, progressPct: 10 }),
  });
  ok('a key without the sim:notify scope is refused with 403',
     wrongScope.status === 403, String(wrongScope.status));

  const relayed = await fetch(`${BASE}/internal/sim-event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({
      type: 'sim.progress', runId: fakeRunId, buildingId, progressPct: 42,
    }),
  });
  ok('a valid sim event is accepted', relayed.status === 202, String(relayed.status));

  await sleep(500);
  const progress = simInbox.find((m) => m.type === 'sim.progress');
  ok('sim.progress reaches a subscriber over the WebSocket',
     progress?.type === 'sim.progress' && progress.progressPct === 42,
     progress?.type === 'sim.progress' ? `${progress.progressPct}%` : 'not received');

  const malformed = await fetch(`${BASE}/internal/sim-event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ type: 'sim.progress', runId: 'nope', progressPct: 999 }),
  });
  ok('a malformed sim event is rejected', malformed.status === 400);

  simWs.close();
  alertWs.close();

  // ------------------------------------------------------- auth and tenancy
  console.log('\n[9] Authentication and tenant isolation');

  ok('an unauthenticated POST /ingest is refused',
     (await fetch(`${BASE}/ingest`, {
       method: 'POST',
       headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ readings: [{ externalId: probe.externalId, value: 1 }] }),
     })).status === 401);

  ok('an unauthenticated GET /alerts is refused',
     (await fetch(`${BASE}/alerts`)).status === 401);

  ok('a garbage bearer token is refused',
     (await fetch(`${BASE}/alerts`, {
       headers: { authorization: 'Bearer not-a-real-key' },
     })).status === 401);

  ok('/healthz stays open, since a load balancer has no key',
     (await fetch(`${BASE}/healthz`)).ok);

  // A second tenant with its own device key. Its key must not be able to write
  // to, or even resolve, tenant A's points.
  const otherTenant = await createTenant(`smoke-b-${Date.now().toString(36)}`, 'Smoke Tenant B');
  const otherKey = (await createApiKey(otherTenant, 'device', 'smoke-b-device',
    ['ingest:write'])).key;

  const crossIngest = (await (await fetch(`${BASE}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${otherKey}` },
    body: JSON.stringify({
      readings: [{ externalId: probe.externalId, value: 42, ts: Date.now() }],
    }),
  })).json()) as IngestResponse;
  // Reported as UNKNOWN rather than forbidden. From tenant B's position that is
  // simply true — the point does not exist for it — and an explicit 403 would
  // confirm that some other tenant owns that external id.
  ok('another tenant\'s external id resolves as unknown, not accepted',
     crossIngest.accepted === 0 && crossIngest.unknownIds[0] === probe.externalId,
     JSON.stringify(crossIngest));

  ok('another tenant sees none of these alerts',
     (await getJson<AlertsResponse>(`${BASE}/alerts`, {
       headers: { authorization: `Bearer ${otherKey}` },
     })).alerts.length === 0);

  // Topic authorisation on the socket: a valid ticket for tenant B, asking for
  // tenant A's floor topic by its real UUID.
  const denied = await new Promise<ServerMessage | null>((resolve) => {
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const timer = setTimeout(() => { sock.close(); resolve(null); }, 5000);
    sock.on('open', () => sock.send(JSON.stringify({
      type: 'auth', ticket: signWsTicket({ tenantId: otherTenant, userId: ACTING_USER }),
    })));
    sock.on('message', (data: Buffer) => {
      const parsed = parseServerMessage(data.toString());
      if (!parsed.ok) return;
      if (parsed.message.type === 'authenticated') {
        sock.send(JSON.stringify({
          type: 'subscribe', topics: [topics.floor(probe.floorId) as Topic],
        }));
      }
      if (parsed.message.type === 'subscribe.denied') {
        clearTimeout(timer);
        sock.close();
        resolve(parsed.message);
      }
    });
    sock.on('error', () => { clearTimeout(timer); resolve(null); });
  });
  ok('subscribing to another tenant\'s floor topic is explicitly DENIED, not ignored',
     denied?.type === 'subscribe.denied',
     denied ? 'got subscribe.denied' : 'no denial frame received');

  ok('an unauthenticated socket cannot subscribe', await new Promise<boolean>((resolve) => {
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const timer = setTimeout(() => { sock.close(); resolve(false); }, 5000);
    sock.on('open', () => sock.send(JSON.stringify({
      type: 'subscribe', topics: [topics.floor(probe.floorId) as Topic],
    })));
    sock.on('message', (data: Buffer) => {
      const parsed = parseServerMessage(data.toString());
      if (parsed.ok && parsed.message.type === 'error'
          && parsed.message.code === 'unauthenticated') {
        clearTimeout(timer);
        sock.close();
        resolve(true);
      }
    });
    sock.on('error', () => { clearTimeout(timer); resolve(false); });
  }));

  ok('a forged WebSocket ticket is rejected', await new Promise<boolean>((resolve) => {
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const timer = setTimeout(() => { sock.close(); resolve(false); }, 5000);
    sock.on('open', () => sock.send(JSON.stringify({
      type: 'auth',
      ticket: Buffer.from(JSON.stringify({
        tenantId: TENANT, userId: ACTING_USER, exp: Date.now() + 60_000,
      })).toString('base64url') + '.forged-signature',
    })));
    sock.on('message', (data: Buffer) => {
      const parsed = parseServerMessage(data.toString());
      if (parsed.ok && parsed.message.type === 'error'
          && parsed.message.code === 'auth_failed') {
        clearTimeout(timer);
        sock.close();
        resolve(true);
      }
    });
    sock.on('error', () => { clearTimeout(timer); resolve(false); });
  }));

  await pool.query('DELETE FROM tenants WHERE id = $1', [otherTenant]);
  await pool.query('DELETE FROM alert_rules WHERE name LIKE $1', ['smoke:%']);

  // --------------------------------------------------------------- shutdown
  console.log('\n[10] Graceful shutdown');
  // Put known rows in the buffer and signal before they can be flushed on the
  // interval, so the shutdown path is what carries them.
  //
  // Counting all of `telemetry` either side of the signal does not work. `>=`
  // passes on a server that ignored SIGTERM and dropped its whole buffer — that
  // is how CI reported `18192 -> 18192` as a success. `>` then fails whenever
  // the periodic flush happens to have just run and left the buffer empty,
  // which is how CI reported `19311 -> 19311` as a failure. The quantity the
  // check is about is these specific readings, so it asks about these specific
  // readings.
  const shutdownTs = Date.now() + 86_400_000; // future, so nothing else writes here
  const shutdownBatch = Array.from({ length: 5 }, (_, i) => ({
    externalId: probe.externalId, ts: shutdownTs + i, value: 21.5 + i / 100,
  }));
  const queued = await postJson(`${BASE}/ingest`, {
    readings: shutdownBatch, source: 'smoke-shutdown',
  });
  ok('the shutdown batch was accepted into the buffer',
     queued.status === 202, String(queued.status));

  ws.close();
  server.kill('SIGTERM');
  const exitCode = await new Promise<number | null>(
    (r) => server!.once('exit', (code) => r(code)),
  );
  await sleep(300);

  const { rows: [landed] } = await pool.query<{ n: number }>(
    `SELECT count(*) AS n FROM telemetry WHERE sensor_id = $1 AND "time" >= $2`,
    [probe.id, new Date(shutdownTs)],
  );
  ok('buffered readings were flushed on SIGTERM, not lost',
     Number(landed?.n) === shutdownBatch.length,
     `${landed?.n ?? 0}/${shutdownBatch.length} rows landed`);
  ok('the server exited on SIGTERM rather than being left running',
     exitCode === 0, `exit code ${exitCode}`);

  await pool.query('DELETE FROM telemetry WHERE sensor_id = $1 AND "time" >= $2',
                   [probe.id, new Date(shutdownTs)]);
  ok('port released', await waitForPortFree(PORT));

} finally {
  server?.kill('SIGKILL');
  await closePool();
}

async function isPortFree(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
    return false;
  } catch {
    return true;
  }
}

/**
 * Poll rather than probe once.
 *
 * The process has already exited by the time this runs, so the listener is
 * going away — but "has exited" and "the kernel has released the socket" are
 * not the same instant, and how far apart they are depends on the machine. A
 * single check after a fixed sleep passed consistently on a developer laptop
 * and failed on a CI runner, which makes it a measure of the runner rather than
 * of the shutdown path. What the check is actually for is that the port does
 * not stay held, so it waits for that and fails only if it never happens.
 */
async function waitForPortFree(port: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isPortFree(port)) return true;
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
