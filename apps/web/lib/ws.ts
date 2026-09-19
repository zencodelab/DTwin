'use client';

import { useEffect, useRef, useState } from 'react';
import {
  expandReading, parseServerMessage,
  type AlertWithContext, type SimulationSummary, type Topic,
} from '@dtwin/types';

export interface SimRunState {
  progressPct: number;
  status: 'running' | 'completed' | 'failed';
  summary?: SimulationSummary;
  error?: string;
}

export interface LiveState {
  /** Latest value per sensor id. */
  values: Map<string, number>;
  alerts: AlertWithContext[];
  /** Simulation runs the worker has reported on, keyed by run id. */
  simRuns: Map<string, SimRunState>;
  connected: boolean;
}

/**
 * Live telemetry and alerts over the ingest WebSocket.
 *
 * Subscribes to exactly the topics the current view needs — the floor in frame
 * rather than the whole building — because the server fans out per topic and a
 * building-wide subscription would ship every point to a view showing one floor.
 *
 * Incoming frames are parsed through the shared Zod schema, never cast. This is
 * a socket: the payload is untrusted by definition, and a cast would be a
 * type-level assertion with nothing behind it.
 */
export function useLiveData(url: string, topics: Topic[]): LiveState {
  const [values, setValues] = useState<Map<string, number>>(new Map());
  const [alerts, setAlerts] = useState<AlertWithContext[]>([]);
  const [simRuns, setSimRuns] = useState<Map<string, SimRunState>>(new Map());
  const [connected, setConnected] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const topicKey = topics.join('|');

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = async () => {
      if (closed) return;

      // The ticket is fetched before the socket is opened, not after. It is
      // spent on the first frame and lives about a minute, so minting it while
      // a connection already waits would burn part of that on a round trip —
      // and a socket that never presents one is refused anyway.
      let ticket: string;
      try {
        const response = await fetch('/api/ws-ticket', { cache: 'no-store' });
        if (!response.ok) throw new Error(`ticket request failed: ${response.status}`);
        ticket = (await response.json()).ticket as string;
      } catch {
        // Usually the session has expired. Retrying on the same cadence as a
        // dropped socket is right — both mean "come back in a moment", and the
        // dashboard should recover on its own either way.
        if (!closed) retry = setTimeout(connect, 2000);
        return;
      }
      if (closed) return;

      const socket = new WebSocket(url);
      socketRef.current = socket;

      // `connected` stays false until the server accepts the ticket. An open
      // but unauthenticated socket receives nothing, so reporting it as
      // connected would put a green light over a dead feed.
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'auth', ticket }));
      };

      socket.onmessage = (event) => {
        const parsed = parseServerMessage(String(event.data));
        if (!parsed.ok) return;
        const message = parsed.message;

        switch (message.type) {
          // Subscribing is refused before this arrives, so the subscribe is
          // sent from here rather than from `onopen`.
          case 'authenticated':
            setConnected(true);
            if (topics.length > 0) {
              socket.send(JSON.stringify({ type: 'subscribe', topics }));
            }
            break;

          case 'telemetry.batch':
            // One state update per frame, not per reading: the server already
            // coalesced a tick's readings into this batch, and re-rendering per
            // reading would undo that saving on the client.
            setValues((prev) => {
              const next = new Map(prev);
              for (const tuple of message.readings) {
                const r = expandReading(tuple);
                next.set(r.sensorId, r.value);
              }
              return next;
            });
            break;

          case 'alert.raised':
          case 'alert.acknowledged':
            setAlerts((prev) => [
              message.alert,
              ...prev.filter((a) => a.id !== message.alert.id),
            ]);
            break;

          case 'alert.resolved':
            setAlerts((prev) => prev.filter((a) => a.id !== message.alert.id));
            break;

          // The worker reports through ingest rather than holding its own
          // socket, so progress arrives here instead of being polled.
          case 'sim.progress':
            setSimRuns((prev) => new Map(prev).set(message.runId, {
              progressPct: message.progressPct,
              status: 'running',
            }));
            break;

          case 'sim.complete':
            setSimRuns((prev) => new Map(prev).set(message.summary.run.id, {
              progressPct: 100,
              status: 'completed',
              summary: message.summary,
            }));
            break;

          case 'sim.failed':
            setSimRuns((prev) => new Map(prev).set(message.runId, {
              progressPct: 0,
              status: 'failed',
              error: message.error,
            }));
            break;
        }
      };

      socket.onclose = () => {
        setConnected(false);
        // The ingest service restarts on deploy; a dashboard left open should
        // recover on its own rather than silently going stale.
        if (!closed) retry = setTimeout(connect, 2000);
      };
      socket.onerror = () => socket.close();
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socketRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, topicKey]);

  return { values, alerts, simRuns, connected };
}
