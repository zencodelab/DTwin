import { topics, type ServerMessage, type Topic, type Reading } from '@dtwin/types';
import type { Config } from './config.ts';
import type { RegisteredSensor } from './registry.ts';

/** The slice of a WebSocket this module needs — kept narrow so it is testable. */
export interface Socket {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const OPEN = 1;

export interface Subscriber {
  id: string;
  socket: Socket;
  topics: Set<Topic>;
  /**
   * Null until the connection authenticates.
   *
   * An unauthenticated socket may hold no subscriptions at all, so this being
   * null is not "subscribe to nothing yet" — `subscribe` refuses outright.
   */
  tenantId: string | null;
}

export interface FanoutStats {
  subscribers: number;
  /** Of those, how many have completed the auth handshake. */
  authenticated: number;
  topics: number;
  framesSent: number;
  readingsSent: number;
  framesSkipped: number;
  /**
   * Sockets closed because they were too backlogged to take a frame that may
   * not be skipped. Non-zero means clients are being made to reconcile.
   */
  backloggedClosed: number;
  /** Subscribe requests refused because the topic belongs to another tenant. */
  subscribesDenied: number;
}

/**
 * Topic subscription registry and outbound coalescing.
 *
 * Two things matter here. First, a frame per reading would be ~190 frames a
 * second per client; readings are accumulated per topic and emitted as one
 * batch per tick instead. Second, a client that stops reading must not become
 * the server's memory problem — if its socket already has a backlog, its next
 * frame is dropped rather than queued. Telemetry is the right thing to drop:
 * newer data supersedes it, and the client will see the current value on the
 * next tick regardless.
 */
export class Fanout {
  #byTopic = new Map<Topic, Set<Subscriber>>();
  #subscribers = new Map<string, Subscriber>();
  #pending = new Map<Topic, Reading[]>();
  #timer: NodeJS.Timeout | null = null;
  #stats = {
    framesSent: 0, readingsSent: 0, framesSkipped: 0, backloggedClosed: 0, subscribesDenied: 0,
  };

  /**
   * Decides whether a tenant may subscribe to a topic. Injected rather than
   * imported so the fanout stays testable without a database, and so the one
   * place that answers "who owns this topic" is the registry.
   */
  constructor(
    private readonly config: Config,
    private readonly maySubscribe: (tenantId: string, topic: Topic) => boolean,
  ) {}

  start(): void {
    this.#timer ??= setInterval(() => this.tick(), this.config.INGEST_FANOUT_INTERVAL_MS);
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  get stats(): FanoutStats {
    let authenticated = 0;
    for (const sub of this.#subscribers.values()) if (sub.tenantId) authenticated++;
    return {
      ...this.#stats,
      subscribers: this.#subscribers.size,
      authenticated,
      topics: this.#byTopic.size,
    };
  }

  /** Authenticated connections a tenant holds right now. */
  connectionsFor(tenantId: string): number {
    let count = 0;
    for (const sub of this.#subscribers.values()) if (sub.tenantId === tenantId) count++;
    return count;
  }

  /** Bind an authenticated identity to a connection. */
  authenticate(subId: string, tenantId: string): boolean {
    const sub = this.#subscribers.get(subId);
    if (!sub) return false;
    sub.tenantId = tenantId;
    return true;
  }

  add(sub: Subscriber): void {
    this.#subscribers.set(sub.id, sub);
  }

  remove(subId: string): void {
    const sub = this.#subscribers.get(subId);
    if (!sub) return;
    for (const t of sub.topics) {
      const set = this.#byTopic.get(t);
      set?.delete(sub);
      // Drop empty topic sets so `publish` stays a cheap membership test.
      if (set && set.size === 0) this.#byTopic.delete(t);
    }
    this.#subscribers.delete(subId);
  }

  /**
   * Subscribe to the topics this connection is allowed, and report the rest.
   *
   * Denials are RETURNED, not silently dropped. A topic that is quietly ignored
   * looks to the client exactly like a topic with nothing happening on it, and
   * an operator would sit watching a floor that is never going to update. The
   * caller turns `denied` into an explicit `subscribe.denied` frame.
   *
   * An unauthenticated connection is refused everything. Fail closed here too:
   * the alternative is a race where a frame lands between connect and auth.
   */
  subscribe(subId: string, wanted: Topic[]): { topics: Topic[]; denied: Topic[] } {
    const sub = this.#subscribers.get(subId);
    if (!sub) return { topics: [], denied: [] };
    if (!sub.tenantId) return { topics: [...sub.topics], denied: wanted };

    const denied: Topic[] = [];
    for (const t of wanted) {
      if (!this.maySubscribe(sub.tenantId, t)) {
        denied.push(t);
        this.#stats.subscribesDenied++;
        continue;
      }
      sub.topics.add(t);
      let set = this.#byTopic.get(t);
      if (!set) {
        set = new Set();
        this.#byTopic.set(t, set);
      }
      set.add(sub);
    }
    return { topics: [...sub.topics], denied };
  }

  unsubscribe(subId: string, unwanted: Topic[]): Topic[] {
    const sub = this.#subscribers.get(subId);
    if (!sub) return [];
    for (const t of unwanted) {
      sub.topics.delete(t);
      const set = this.#byTopic.get(t);
      set?.delete(sub);
      if (set && set.size === 0) this.#byTopic.delete(t);
    }
    return [...sub.topics];
  }

  /**
   * Queue a reading for the topics it belongs to.
   *
   * Only topics that currently have a subscriber are accumulated. With nobody
   * watching — the common case for most of the building — this costs four map
   * lookups and allocates nothing.
   */
  publish(sensor: RegisteredSensor, reading: Reading): void {
    for (const topic of topicsFor(sensor)) {
      if (!this.#byTopic.has(topic)) continue;
      const list = this.#pending.get(topic);
      if (list) list.push(reading);
      else this.#pending.set(topic, [reading]);
    }
  }

  /**
   * Send a non-telemetry message immediately (alerts, simulation progress).
   *
   * `mustDeliver` is for a frame with no successor. Telemetry can be skipped
   * for a slow client because the next batch carries newer values; simulation
   * progress likewise. An alert cannot: "raised" is said once. This method used
   * to push alerts through the same backlog-skipping path as telemetry, so the
   * rule "alerts are never shed" held for the queue and not for the socket — a
   * client slow enough to skip a telemetry frame silently never heard that an
   * alert had opened.
   *
   * Neither of the obvious repairs is acceptable. Sending anyway queues without
   * bound behind a client that is not reading (decisions.md §12). Skipping is
   * the defect. So the socket is CLOSED: the client reconnects, and on every
   * accepted subscription the dashboard refetches the open alerts over HTTP,
   * which is the one source that cannot have missed anything (§56). The slow
   * client loses its connection, not its alert.
   */
  send(topic: Topic, message: ServerMessage, options: { mustDeliver?: boolean } = {}): void {
    const subs = this.#byTopic.get(topic);
    if (!subs || subs.size === 0) return;
    this.#deliver(subs, JSON.stringify(message), options.mustDeliver === true);
  }

  tick(): void {
    if (this.#pending.size === 0) return;
    const batches = this.#pending;
    this.#pending = new Map();

    const sentAt = Date.now();
    for (const [topic, readings] of batches) {
      const subs = this.#byTopic.get(topic);
      // The last subscriber may have left mid-window.
      if (!subs || subs.size === 0) continue;

      const message: ServerMessage = {
        type: 'telemetry.batch',
        topic,
        readings: readings.map((r) => [r.sensorId, r.ts, r.value, r.quality] as const) as never,
        sentAt,
      };
      // Serialised once per topic, not once per subscriber.
      this.#deliver(subs, JSON.stringify(message));
      this.#stats.readingsSent += readings.length * subs.size;
    }
  }

  #deliver(subs: Set<Subscriber>, payload: string, mustDeliver = false): void {
    for (const sub of subs) {
      if (sub.socket.readyState !== OPEN) continue;
      if (sub.socket.bufferedAmount > this.config.INGEST_CLIENT_BUFFER_MAX_BYTES) {
        if (mustDeliver) {
          this.#stats.backloggedClosed++;
          // 1013 "try again later": the client did nothing wrong, and the
          // dashboard's reconnect is what carries it to the snapshot.
          sub.socket.close(1013, 'backlogged; reconnect and reconcile');
        } else {
          this.#stats.framesSkipped++;
        }
        continue;
      }
      sub.socket.send(payload);
      this.#stats.framesSent++;
    }
  }
}

/**
 * Every topic a reading belongs to: its own sensor, and the zone, floor and
 * building containing it. A dashboard watching one floor and a detail panel
 * watching one point both receive it without either needing to know the other's
 * subscription.
 */
export function topicsFor(sensor: RegisteredSensor): Topic[] {
  const out: Topic[] = [topics.sensor(sensor.id)];
  if (sensor.zoneId) out.push(topics.zone(sensor.zoneId));
  if (sensor.floorId) out.push(topics.floor(sensor.floorId));
  if (sensor.buildingId) out.push(topics.building(sensor.buildingId));
  return out;
}
