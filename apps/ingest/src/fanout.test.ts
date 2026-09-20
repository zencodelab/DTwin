import { describe, expect, it } from 'vitest';
import { topics, type ServerMessage, type Topic } from '@dtwin/types';
import type { Config } from './config.ts';
import { Fanout, type Socket } from './fanout.ts';
import type { RegisteredSensor } from './registry.ts';

const BUILDING = '018f0000-0000-7000-8000-000000000001';
const TENANT = '018f0000-0000-7000-8000-0000000000aa';
const LIMIT = 1_000;

class FakeSocket implements Socket {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closed: { code: number | undefined; reason: string | undefined } | null = null;
  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void { this.closed = { code, reason }; this.readyState = 3; }
}

function setup() {
  const fanout = new Fanout(
    { INGEST_CLIENT_BUFFER_MAX_BYTES: LIMIT, INGEST_FANOUT_INTERVAL_MS: 1_000 } as Config,
    () => true,
  );
  const join = (id: string, topic: Topic) => {
    const socket = new FakeSocket();
    fanout.add({ id, socket, topics: new Set(), tenantId: null });
    fanout.authenticate(id, TENANT);
    fanout.subscribe(id, [topic]);
    return socket;
  };
  return { fanout, join };
}

const alertRaised = { type: 'alert.raised', alert: { id: 'a1' } } as unknown as ServerMessage;
const progress = { type: 'sim.progress', runId: 'r1', progressPct: 40 } as unknown as ServerMessage;

describe('Fanout delivery to a backlogged client', () => {
  it('skips a telemetry frame, because the next one supersedes it', () => {
    const { fanout, join } = setup();
    const topic = topics.building(BUILDING);
    const slow = join('slow', topic);
    const fast = join('fast', topic);
    slow.bufferedAmount = LIMIT + 1;

    fanout.publish(
      { id: 's1', buildingId: BUILDING, floorId: null, zoneId: null } as unknown as RegisteredSensor,
      { sensorId: 's1', ts: 1, value: 1, quality: 0 } as never,
    );
    fanout.tick();

    expect(slow.sent).toHaveLength(0);
    expect(slow.closed).toBeNull();
    expect(fast.sent).toHaveLength(1);
    expect(fanout.stats).toMatchObject({ framesSkipped: 1, backloggedClosed: 0 });
  });

  it('skips simulation progress too — it has a successor, and HTTP polling behind it', () => {
    const { fanout, join } = setup();
    const topic = topics.sim(BUILDING);
    const slow = join('slow', topic);
    slow.bufferedAmount = LIMIT + 1;

    fanout.send(topic, progress);
    expect(slow.closed).toBeNull();
    expect(fanout.stats.framesSkipped).toBe(1);
  });

  it('never skips an alert: the socket is closed so the client reconciles over HTTP', () => {
    const { fanout, join } = setup();
    const topic = topics.tenantAlerts(TENANT);
    const slow = join('slow', topic);
    const fast = join('fast', topic);
    slow.bufferedAmount = LIMIT + 1;

    fanout.send(topic, alertRaised, { mustDeliver: true });

    expect(slow.sent).toHaveLength(0);
    expect(slow.closed?.code).toBe(1013);
    expect(fast.sent).toHaveLength(1);
    expect(fast.closed).toBeNull();
    expect(fanout.stats).toMatchObject({ framesSkipped: 0, backloggedClosed: 1 });
  });

  it('does not queue behind the slow client either — nothing is sent to it at all', () => {
    const { fanout, join } = setup();
    const topic = topics.tenantAlerts(TENANT);
    const slow = join('slow', topic);
    slow.bufferedAmount = LIMIT + 1;

    for (let i = 0; i < 50; i += 1) fanout.send(topic, alertRaised, { mustDeliver: true });
    expect(slow.sent).toHaveLength(0);
    // Closed once: after the first, readyState is no longer OPEN.
    expect(fanout.stats.backloggedClosed).toBe(1);
  });
});
