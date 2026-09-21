import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { closePool, verifyWsTicket } from '@dtwin/db';
import {
  RawTelemetryBatch, SimEvent, clientAddress, parseClientMessage, topics, type ServerMessage,
} from '@dtwin/types';
import { listAlerts } from './rules/store.ts';
import { authenticate, type AuthFailure } from './auth.ts';
import { createLimits } from './limits.ts';
import { ingestMetrics, renderMetrics } from './metrics.ts';
import { loadConfig } from './config.ts';
import { Pipeline } from './pipeline.ts';
import { DeviceSimulator, FAULT_KINDS, isFaultKind } from './simulator/index.ts';

/**
 * Ingest service.
 *
 * Devices push over HTTP POST /ingest; browsers subscribe over the WebSocket
 * and only receive. Splitting the directions this way is why `ClientMessage`
 * has no telemetry variant — a browser is never a data source, and keeping the
 * inbound surface to one authenticated HTTP route is simpler than policing
 * message kinds on a socket open to the dashboard.
 *
 * EVERY ROUTE HERE IS AUTHENTICATED except /healthz, and the tenant always
 * comes from the credential, never from the request. `/healthz` is deliberately
 * open and deliberately reports only process-level counters — no tenant names,
 * no per-tenant figures — because it is the one thing a load balancer must be
 * able to reach without a key.
 */

const config = loadConfig();
const pipeline = new Pipeline(config);
const limits = createLimits(config);

const simulator = new DeviceSimulator(config, pipeline.registry, (readings) => {
  pipeline.ingestResolved(readings);
});

// ---------------------------------------------------------------------- HTTP

/**
 * Read and parse a JSON body, reporting a bad one as a bad request.
 *
 * Returns a result rather than throwing, in the same shape `authenticate` uses,
 * because throwing sent every malformed body to the generic 500 handler —
 * straight past the careful Zod 400 each route builds below. A caller sending
 * `{` learned that the server had an internal error, which is both wrong and
 * the kind of wrong that gets retried.
 *
 * An oversized body is 413 for the same reason: the size is the caller's to
 * fix, and 500 invites a retry of exactly the payload that caused it.
 */
type JsonResult =
  | { ok: true; value: unknown }
  | { ok: false; status: number; error: string };

async function readJson(
  req: IncomingMessage,
  limitBytes = config.INGEST_MAX_BODY_BYTES,
): Promise<JsonResult> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      // Bound before buffering, not after: an unbounded body is a trivial way
      // to exhaust memory on an endpoint that accepts batches by design.
      if (size > limitBytes) {
        return { ok: false, status: 413, error: `body exceeds ${limitBytes} bytes` };
      }
      chunks.push(chunk as Buffer);
    }
  } catch {
    // A connection that dies mid-body is the client's problem, not a fault.
    return { ok: false, status: 400, error: 'request body could not be read' };
  }

  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch (err) {
    return { ok: false, status: 400, error: `invalid JSON: ${(err as Error).message}` };
  }
}

/** A JSON object, or nothing. Guards the `as { … }` casts the routes make. */
function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function send(
  res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/**
 * 429 always carries Retry-After. A gateway that is told "no" and not "until
 * when" retries immediately, and a rate limit that provokes a retry storm has
 * made the thing it was for worse.
 */
function tooMany(res: ServerResponse, error: string, retryAfterS: number): void {
  const seconds = Number.isFinite(retryAfterS) ? Math.max(1, retryAfterS) : 3600;
  send(res, 429, { error, retryAfterS: seconds }, { 'retry-after': String(seconds) });
}

function refuse(res: ServerResponse, failure: AuthFailure): void {
  if (failure.status === 429) return tooMany(res, failure.error, failure.retryAfterS ?? 60);
  send(res, failure.status, { error: failure.error });
}

/** `authenticate`, with failures rationed per calling address. */
function auth(req: IncomingMessage, scope: Parameters<typeof authenticate>[1]) {
  return authenticate(req, scope, {
    limiter: limits.authFailures,
    address: clientAddress(
      req.socket.remoteAddress, req.headers['x-forwarded-for'], config.INGEST_TRUSTED_PROXY_HOPS,
    ),
  });
}

const httpServer = createServer((req, res) => {
  void handle(req, res).catch((err: unknown) => {
    // Log the detail, return none of it. The message can name a table, a
    // constraint or a connection string, and a caller that could not be
    // trusted with the request cannot be trusted with the post-mortem.
    console.error('[ingest] unhandled error', err);
    // Writing a second time throws inside this catch, which is how a response
    // that had already started became an unhandled rejection rather than a
    // logged fault.
    if (res.headersSent) return res.destroy();
    send(res, 500, { error: 'internal error' });
  });
});

/**
 * Ready means the write path is actually draining. A service that accepts
 * readings and silently fails to persist them looks fine on a liveness check
 * and is useless.
 */
function isReady(): boolean {
  const stats = pipeline.stats();
  return stats.sensors > 0
    && stats.writer.buffered < config.INGEST_BUFFER_MAX_ROWS
    && stats.writer.lastError === null;
}

function limiterStats() {
  return {
    authFailures: limits.authFailures.stats,
    requests: limits.requests.stats,
    readings: limits.readings.stats,
    frames: limits.frames.stats,
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  switch (route) {
    // Liveness: the process is up and its event loop is turning. Nothing else.
    // It must NOT consult the database — an orchestrator restarts a container
    // that fails liveness, and restarting ingest because Postgres blipped turns
    // a database outage into a database outage plus a restart loop, discarding
    // the write buffer that exists to ride the outage out (decisions.md §58).
    case 'GET /livez':
      return send(res, 200, { status: 'alive' });

    // Readiness: should traffic be sent here? The same judgement as /healthz
    // without the detail, so a probe every few seconds is not serialising the
    // whole stats tree to read one boolean.
    case 'GET /readyz': {
      const ready = isReady();
      return send(res, ready ? 200 : 503, { status: ready ? 'ready' : 'degraded' });
    }

    case 'GET /metrics': {
      const stats = pipeline.stats();
      const body = renderMetrics(ingestMetrics({
        ready: isReady(),
        uptimeS: process.uptime(),
        sensors: stats.sensors,
        writer: stats.writer,
        fanout: stats.fanout,
        alerts: 'enabled' in stats.alerts ? null : stats.alerts,
        limits: limiterStats(),
      }));
      res.writeHead(200, {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    case 'GET /healthz': {
      const stats = pipeline.stats();
      const healthy = isReady();
      return send(res, healthy ? 200 : 503, {
        status: healthy ? 'ok' : 'degraded',
        ...stats,
        // Refusals are counted where shed load already is. A limit nobody can
        // see firing is indistinguishable from one set too high to matter.
        limits: limiterStats(),
        simulator: config.SIM_ENABLED ? simulator.stats : { enabled: false as const },
      });
    }

    case 'POST /ingest': {
      const who = await auth(req, 'ingest:write');
      if (!who.ok) return refuse(res, who.failure);

      // Requests per key, checked before the body is read: parsing is the cost
      // this one rations, so it has to come before the parse.
      const keyId = who.principal.kind === 'api_key' ? who.principal.apiKeyId : who.principal.tenantId;
      const request = limits.requests.take(keyId);
      if (!request.ok) return tooMany(res, 'request rate exceeded for this key', request.retryAfterS);

      // Authenticate BEFORE parsing. Parsing an 8 MB body for a caller with no
      // valid key is work an unauthenticated stranger gets to make us do.
      const json = await readJson(req);
      if (!json.ok) return send(res, json.status, { error: json.error });

      const parsed = RawTelemetryBatch.safeParse(json.value);
      if (!parsed.success) {
        return send(res, 400, {
          error: 'invalid batch',
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
      }
      // Readings per TENANT, weighted by the batch. The write buffer sheds its
      // oldest rows on overflow without asking whose they are, so without this
      // one tenant's flood is every other tenant's data loss. The whole batch
      // is refused rather than part of it admitted: a gateway can retry a
      // batch, but cannot know which half of one was kept.
      const budget = limits.readings.take(who.principal.tenantId, parsed.data.readings.length);
      if (!budget.ok) {
        return tooMany(res, 'reading rate exceeded for this tenant', budget.retryAfterS);
      }
      const result = pipeline.ingestRaw(who.principal.tenantId, parsed.data);
      // 202, not 200: the readings are buffered, not yet durable. Claiming
      // otherwise would be a lie the writer cannot back up.
      return send(res, 202, result);
    }

    case 'POST /internal/sim-event': {
      const who = await auth(req, 'sim:notify');
      if (!who.ok) return refuse(res, who.failure);

      const json = await readJson(req);
      if (!json.ok) return send(res, json.status, { error: json.error });

      const parsed = SimEvent.safeParse(json.value);
      if (!parsed.success) {
        return send(res, 400, {
          error: 'invalid sim event',
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
      }

      const event = parsed.data;

      // The worker names a building; the key names a tenant. If they disagree,
      // refuse — a service key must not be usable to push a fabricated event
      // into someone else's dashboard by naming their building id.
      const owner = pipeline.registry.ownerOf(topics.building(event.buildingId));
      if (owner !== who.principal.tenantId) {
        return send(res, 403, { error: 'building does not belong to this tenant' });
      }

      // One destination. `sim:` is keyed by building (§45) and authorises
      // through the same owner map as `building:`, so the check above guards
      // it, and a client holds it for the whole session without taking the
      // telemetry firehose with it.
      //
      // The building topic is deliberately NOT a second destination any more:
      // it was only ever carrying these events because sim topics could not be
      // subscribed to, and every subscriber that wants them is now on the sim
      // topic. Sending to both would deliver twice to the root view.
      pipeline.fanout.send(topics.sim(event.buildingId), event as ServerMessage);
      return send(res, 202, { forwarded: true });
    }

    case 'POST /internal/notify-sweep': {
      const who = await auth(req, 'ingest:write');
      if (!who.ok) return refuse(res, who.failure);

      // Run the notification sweep now rather than at the next interval.
      //
      // An operator action, not test scaffolding: after fixing a webhook
      // receiver that has been refusing deliveries, the alternative is waiting
      // out ALERT_NOTIFY_RETRY_MS with no way to tell whether the fix worked.
      //
      // Safe to call concurrently, and worth calling that out — the claim uses
      // FOR UPDATE SKIP LOCKED, so two of these take disjoint sets rather than
      // both sending the same row. That is the same property that makes a
      // second ingest replica safe.
      const delivered = await pipeline.alerts.notifier.retryPending();
      return send(res, 200, { delivered });
    }

    case 'GET /alerts': {
      const who = await auth(req, 'ingest:write');
      if (!who.ok) return refuse(res, who.failure);

      const state = url.searchParams.get('state');
      const filter = state === 'live' || state === 'resolved' ? state : undefined;
      return send(res, 200, {
        ...await listAlerts(who.principal.tenantId, filter, config.ALERT_LIST_LIMIT),
      });
    }

    case 'POST /alerts/ack': {
      const who = await auth(req, 'ingest:write');
      if (!who.ok) return refuse(res, who.failure);

      // `by` is no longer accepted from the body. It used to be, which made the
      // acknowledgement trail worth nothing: anyone could acknowledge an alert
      // as anyone. The acting user now travels in a header the web service sets
      // from its own session, and the column is a foreign key to `users`, so a
      // fabricated id fails rather than being recorded.
      const actingUser = req.headers['x-acting-user'];
      const json = await readJson(req);
      if (!json.ok) return send(res, json.status, { error: json.error });

      // `asObject` rather than a cast: a body of `null` or `"nope"` used to
      // make `body.alertId` throw a TypeError into the 500 handler, three
      // lines above a 400 written for exactly this.
      const body = asObject(json.value);
      const alertId = typeof body?.alertId === 'string' ? body.alertId : null;
      if (!alertId || typeof actingUser !== 'string') {
        return send(res, 400, { error: 'alertId and an acting user are required' });
      }

      const alert = await pipeline.alerts.acknowledge(
        who.principal.tenantId, alertId, actingUser);
      // 409, not 404: the alert exists but is no longer open, which is a
      // different thing for a caller to handle than a bad id. An alert in
      // ANOTHER tenant also lands here rather than 404 — deliberately, since
      // distinguishing the two would confirm the id exists.
      return alert
        ? send(res, 200, { alert })
        : send(res, 409, { error: 'alert is not open' });
    }

    case 'POST /simulator/fault': {
      const who = await auth(req, 'ingest:write');
      if (!who.ok) return refuse(res, who.failure);

      const json = await readJson(req);
      if (!json.ok) return send(res, json.status, { error: json.error });
      const body = asObject(json.value);
      if (!body) return send(res, 400, { error: 'body must be a JSON object' });

      const sensorIdArg = typeof body.sensorId === 'string' ? body.sensorId : null;
      const externalIdArg = typeof body.externalId === 'string' ? body.externalId : null;
      const found = sensorIdArg
        ? pipeline.registry.byId(sensorIdArg)
        : externalIdArg
          ? pipeline.registry.lookup(who.principal.tenantId, externalIdArg)
          : undefined;
      // A sensor id from another tenant reads as unknown, not forbidden: this
      // route must not become a way to probe which ids exist elsewhere.
      const sensor = found?.tenantId === who.principal.tenantId ? found : undefined;
      if (!sensor) return send(res, 404, { error: 'unknown sensor' });

      if (!isFaultKind(body.kind)) {
        return send(res, 400, { error: `kind must be one of ${FAULT_KINDS.join(', ')}` });
      }
      const magnitude = typeof body.magnitude === 'number' && Number.isFinite(body.magnitude)
        ? body.magnitude
        : 1;

      simulator.injectFault(sensor.id, body.kind, magnitude);
      return send(res, 200, { sensorId: sensor.id, kind: body.kind });
    }

    case 'DELETE /simulator/fault': {
      const who = await auth(req, 'ingest:write');
      if (!who.ok) return refuse(res, who.failure);

      const sensorId = url.searchParams.get('sensorId');
      if (!sensorId) {
        simulator.clearFaultsForTenant(who.principal.tenantId, pipeline.registry);
        return send(res, 200, { cleared: 'all for tenant' });
      }
      const sensor = pipeline.registry.byId(sensorId);
      if (sensor?.tenantId !== who.principal.tenantId) {
        return send(res, 404, { error: 'unknown sensor' });
      }
      return send(res, 200, { cleared: simulator.clearFault(sensorId) });
    }

    default:
      return send(res, 404, { error: `no route for ${route}` });
  }
}

// ----------------------------------------------------------------- WebSocket

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

/**
 * A connection starts unauthenticated and can do nothing but authenticate.
 *
 * The first frame must be `auth` carrying a ticket the web service minted from
 * the user's session. Until that succeeds the socket holds no subscriptions, so
 * there is no window in which a frame could be delivered to an unidentified
 * client.
 *
 * Unauthenticated sockets are closed after a short grace period. Without it,
 * opening connections and never authenticating is a free way to hold server
 * memory — the one thing a socket lets a stranger do before proving anything.
 */
const AUTH_GRACE_MS = config.INGEST_AUTH_GRACE_MS;

wss.on('connection', (socket: WebSocket) => {
  const id = randomUUID();
  pipeline.fanout.add({ id, socket, topics: new Set(), tenantId: null });

  // Guarded: a socket that closed between the handler starting and this line
  // throws from inside an event handler, where there is no caller to catch it.
  const reply = (message: ServerMessage) => {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch (err) {
      console.error('[ingest] failed to reply on socket', err);
    }
  };

  let tenantId: string | null = null;
  const authDeadline = setTimeout(() => {
    if (!tenantId) {
      reply({ type: 'error', code: 'auth_timeout', message: 'no auth frame received' });
      socket.close();
    }
  }, AUTH_GRACE_MS);

  socket.on('message', (data) => {
    // Rationed before it is parsed, and before the auth gate: an unauthenticated
    // socket can send frames for the whole grace period, and a `subscribe` frame
    // carries up to 64 topics to authorise. The connection is CLOSED rather than
    // the frame dropped — a dashboard sends a handful of frames per session, so
    // a socket over this rate is not a dashboard, and a silently dropped
    // `subscribe` would leave a real client waiting on data that is not coming.
    if (!limits.frames.take(id).ok) {
      reply({ type: 'error', code: 'rate_limited', message: 'too many frames; closing' });
      socket.close(1008, 'rate limit');
      return;
    }

    const parsed = parseClientMessage(data.toString());
    if (!parsed.ok) {
      // A malformed frame is an expected condition on a public socket, not a
      // reason to drop a working connection.
      reply({ type: 'error', code: 'bad_message', message: parsed.error });
      return;
    }

    const message = parsed.message;

    if (message.type === 'auth') {
      const ticket = verifyWsTicket(message.ticket);
      if (!ticket) {
        // Expired and forged are reported identically. The client's remedy is
        // the same either way — fetch a fresh ticket — and telling a forger
        // that their signature was fine but stale is free information.
        reply({ type: 'error', code: 'auth_failed', message: 'invalid or expired ticket' });
        socket.close();
        return;
      }
      // A ticket is signed rather than stored, so it cannot be single-use, and
      // within its minute it opens as many sockets as its holder cares to.
      // Each one is a subscriber the fan-out walks on every tick.
      if (pipeline.fanout.connectionsFor(ticket.tenantId) >= config.WS_MAX_CONNECTIONS_PER_TENANT) {
        reply({
          type: 'error', code: 'too_many_connections',
          message: `this tenant already holds ${config.WS_MAX_CONNECTIONS_PER_TENANT} connections`,
        });
        socket.close(1013, 'too many connections');
        return;
      }
      tenantId = ticket.tenantId;
      clearTimeout(authDeadline);
      pipeline.fanout.authenticate(id, ticket.tenantId);
      reply({ type: 'authenticated', tenantId: ticket.tenantId });
      return;
    }

    // Ping is answered before the auth check so a client can keep an
    // unauthenticated connection alive while it fetches a ticket.
    if (message.type === 'ping') {
      reply({ type: 'pong', ts: message.ts });
      return;
    }

    if (!tenantId) {
      reply({ type: 'error', code: 'unauthenticated', message: 'send an auth frame first' });
      return;
    }

    switch (message.type) {
      case 'subscribe': {
        const { topics: accepted, denied } = pipeline.fanout.subscribe(id, message.topics);
        reply({ type: 'subscribed', topics: accepted });
        // Denials are reported, never swallowed: a silently ignored topic is
        // indistinguishable from a topic with nothing happening on it, and an
        // operator would wait indefinitely for data that is not coming.
        if (denied.length > 0) {
          reply({
            type: 'subscribe.denied',
            topics: denied,
            reason: 'topic does not belong to this tenant, or is not known to this service',
          });
        }
        break;
      }
      case 'unsubscribe':
        reply({
          type: 'subscribed',
          topics: pipeline.fanout.unsubscribe(id, message.topics),
        });
        break;
    }
  });

  const cleanup = () => {
    clearTimeout(authDeadline);
    pipeline.fanout.remove(id);
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

// ------------------------------------------------------------------ lifecycle

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[ingest] ${signal} — draining`);
  simulator.stop();
  wss.close();
  httpServer.close();
  // Flush before the pool closes, or buffered readings are lost on every deploy.
  await pipeline.stop();
  await closePool();
  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => void shutdown(sig));
}

await pipeline.start();
if (config.SIM_ENABLED) {
  await simulator.start();
  console.log(`[ingest] simulator on — ${pipeline.registry.size} sensors, speedup ${config.SIM_SPEEDUP}x`);
}

httpServer.listen(config.INGEST_PORT, () => {
  console.log(`[ingest] http://localhost:${config.INGEST_PORT} · ws://localhost:${config.INGEST_PORT}/ws`);
});
