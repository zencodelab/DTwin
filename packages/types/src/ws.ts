import { z } from 'zod';
import { AlertWithContext } from './alerts.ts';
import { EquipmentId, SensorId, SimulationRunId } from './ids.ts';
import { EquipmentStatus } from './enums.ts';
import { ReadingTuple } from './telemetry.ts';
import { SimulationSummary } from './simulation.ts';

/**
 * WebSocket protocol.
 *
 * Both directions are discriminated unions on `type`, so a switch over a parsed
 * message is exhaustively checked by the compiler — adding a message kind and
 * forgetting to handle it becomes a build error rather than a runtime no-op.
 *
 * Everything crossing this boundary is parsed, not cast. A cast on untrusted
 * input is a type-level lie; these payloads come off a socket.
 */

/**
 * Topics. The 3D view subscribes to the floor currently in frame and drops the
 * rest — streaming all ~190 points to a client showing one floor wastes both
 * bandwidth and the client's main thread.
 *
 * A topic name is a UUID and nothing else, so it is NOT a capability: knowing
 * one must not grant access to it. Every subscribe is checked against the
 * connection's tenant (see `AuthedMessage` below and the fanout's topic owner
 * map). `alerts:all` used to exist and was removed — a single global alert
 * topic is a cross-tenant broadcast by construction, and no amount of
 * subscribe-time checking fixes a topic that is shared on purpose. It is now
 * `alerts:<tenantId>`.
 */
export const Topic = z
  .string()
  .regex(
    /^(building|floor|zone|sensor|alerts|sim):[0-9a-fA-F-]{36}$/,
    'topic must be <scope>:<uuid>',
  );
export type Topic = z.infer<typeof Topic>;

export const topics = {
  building: (id: string) => `building:${id}` as Topic,
  floor: (id: string) => `floor:${id}` as Topic,
  zone: (id: string) => `zone:${id}` as Topic,
  sensor: (id: string) => `sensor:${id}` as Topic,
  sim: (id: string) => `sim:${id}` as Topic,
  /** Every alert for one tenant. Replaces the old global `alerts:all`. */
  tenantAlerts: (tenantId: string) => `alerts:${tenantId}` as Topic,
} as const;

/** The scope half of a topic, used when resolving who may subscribe to it. */
export function topicScope(topic: Topic): string {
  return topic.slice(0, topic.indexOf(':'));
}

export function topicId(topic: Topic): string {
  return topic.slice(topic.indexOf(':') + 1);
}

// ---------------------------------------------------------------- client -> server

export const ClientMessage = z.discriminatedUnion('type', [
  /**
   * First frame on every connection. The socket is unauthenticated until this
   * is accepted, and `subscribe` is refused before it.
   *
   * A ticket rather than the session cookie: ingest is a different origin from
   * the dashboard, so the cookie is not sent, and it is HttpOnly so the page
   * cannot read it to send one. The dashboard mints a short-lived ticket from
   * its own session instead. It is not in the URL because query strings end up
   * in access logs and proxy traces.
   */
  z.object({ type: z.literal('auth'), ticket: z.string().min(1) }),
  z.object({ type: z.literal('subscribe'), topics: z.array(Topic).min(1).max(64) }),
  z.object({ type: z.literal('unsubscribe'), topics: z.array(Topic).min(1).max(64) }),
  z.object({ type: z.literal('ping'), ts: z.number().int() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---------------------------------------------------------------- server -> client

export const ServerMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('telemetry.batch'),
    topic: Topic,
    /** Compact tuples; expand with `expandReading`. */
    readings: z.array(ReadingTuple),
    /** Server send time, for measuring client-perceived lag. */
    sentAt: z.number().int(),
  }),
  z.object({ type: z.literal('alert.raised'), alert: AlertWithContext }),
  z.object({ type: z.literal('alert.resolved'), alert: AlertWithContext }),
  z.object({ type: z.literal('alert.acknowledged'), alert: AlertWithContext }),
  z.object({
    type: z.literal('equipment.status'),
    equipmentId: EquipmentId,
    status: EquipmentStatus,
    ts: z.number().int(),
  }),
  z.object({
    type: z.literal('sensor.offline'),
    sensorId: SensorId,
    lastSeenAt: z.number().int().nullable(),
  }),
  z.object({
    type: z.literal('sim.progress'),
    runId: SimulationRunId,
    progressPct: z.number().min(0).max(100),
  }),
  z.object({ type: z.literal('sim.complete'), summary: SimulationSummary }),
  z.object({
    type: z.literal('sim.failed'),
    runId: SimulationRunId,
    error: z.string(),
  }),
  /** Acknowledgement of a subscribe/unsubscribe, echoing the effective set. */
  z.object({ type: z.literal('subscribed'), topics: z.array(Topic) }),
  /**
   * Authentication succeeded. The tenant is echoed so the client can assert it
   * matches the session it thinks it has, rather than silently rendering
   * another tenant's building if the two ever disagree.
   */
  z.object({ type: z.literal('authenticated'), tenantId: z.string().uuid() }),
  /**
   * Some requested topics were refused. Named explicitly rather than dropped:
   * silence from a topic looks identical to a quiet building, and an operator
   * would wait for data that is never coming.
   */
  z.object({
    type: z.literal('subscribe.denied'),
    topics: z.array(Topic),
    reason: z.string(),
  }),
  z.object({ type: z.literal('pong'), ts: z.number().int() }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export type ServerMessageType = ServerMessage['type'];

/**
 * Parse an inbound frame. Returns a discriminated result rather than throwing:
 * a malformed frame is an expected condition on a public socket, not an
 * exceptional one, and the connection should survive it.
 */
export function parseServerMessage(
  raw: string,
): { ok: true; message: ServerMessage } | { ok: false; error: string } {
  try {
    const parsed = ServerMessage.safeParse(JSON.parse(raw));
    return parsed.success
      ? { ok: true, message: parsed.data }
      : { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
}

export function parseClientMessage(
  raw: string,
): { ok: true; message: ClientMessage } | { ok: false; error: string } {
  try {
    const parsed = ClientMessage.safeParse(JSON.parse(raw));
    return parsed.success
      ? { ok: true, message: parsed.data }
      : { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
}
