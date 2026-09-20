import { describe, expect, it } from 'vitest';
import type { AlertWithContext } from '@dtwin/types';
import { MAX_ALERT_EVENTS, appendAlertEvent, reconcileAlerts, type AlertEvent } from './alerts.ts';

const alert = (id: string, state = 'open'): AlertWithContext =>
  ({ id, state } as unknown as AlertWithContext);
const upsert = (id: string, at: number, state = 'open'): AlertEvent =>
  ({ kind: 'upsert', alert: alert(id, state), at });
const resolved = (id: string, at: number): AlertEvent =>
  ({ kind: 'resolved', alert: alert(id, 'resolved'), at });
const ids = (list: AlertWithContext[]) => list.map((a) => a.id).sort();

describe('reconcileAlerts', () => {
  it('removes an alert that was in the snapshot when it resolves — the original defect', () => {
    expect(ids(reconcileAlerts([alert('a'), alert('b')], 1_000, [resolved('a', 2_000)]))).toEqual(['b']);
  });

  it('adds an alert raised after the snapshot', () => {
    expect(ids(reconcileAlerts([alert('a')], 1_000, [upsert('b', 2_000)]))).toEqual(['a', 'b']);
  });

  it('does not resurrect an alert raised before a refetch and resolved during a gap', () => {
    // Raised at 500 while connected; the socket dropped; it resolved unseen;
    // the snapshot requested at 1_000 correctly does not contain it.
    expect(ids(reconcileAlerts([alert('a')], 1_000, [upsert('gone', 500)]))).toEqual(['a']);
  });

  it('lets a newer snapshot overrule an older resolve — the alert re-opened in a gap', () => {
    expect(ids(reconcileAlerts([alert('a')], 1_000, [resolved('a', 500)]))).toEqual(['a']);
  });

  it('applies events in order, so raise-then-resolve ends closed and the reverse ends open', () => {
    expect(ids(reconcileAlerts([], 0, [upsert('a', 10), resolved('a', 20)]))).toEqual([]);
    expect(ids(reconcileAlerts([], 0, [resolved('a', 10), upsert('a', 20)]))).toEqual(['a']);
  });

  it('takes the acknowledged state from the event over the snapshot', () => {
    const merged = reconcileAlerts([alert('a', 'open')], 1_000, [upsert('a', 2_000, 'acknowledged')]);
    expect(merged.map((a) => a.state)).toEqual(['acknowledged']);
  });

  it('applies an event from the request window rather than dropping it', () => {
    // at === snapshotAt: the rows may or may not include it, and applying twice
    // is harmless where dropping would lose it.
    expect(ids(reconcileAlerts([], 1_000, [upsert('a', 1_000)]))).toEqual(['a']);
  });

  it('orders by severity then newest, whichever path delivered the alert', () => {
    const at = (id: string, severity: string, openedAt: string) =>
      ({ id, state: 'open', severity, openedAt } as unknown as AlertWithContext);
    const merged = reconcileAlerts(
      [at('old-warning', 'warning', '2026-09-20T08:00:00Z'), at('info', 'info', '2026-09-20T09:00:00Z')],
      1_000,
      [{ kind: 'upsert', at: 2_000, alert: at('live-critical', 'critical', '2026-09-20T10:00:00Z') },
       { kind: 'upsert', at: 2_001, alert: at('new-warning', 'warning', '2026-09-20T10:30:00Z') }],
    );
    expect(merged.map((a) => a.id)).toEqual(['live-critical', 'new-warning', 'old-warning', 'info']);
  });

  it('shows live events before any snapshot has landed', () => {
    expect(ids(reconcileAlerts([], null, [upsert('a', 5)]))).toEqual(['a']);
  });
});

describe('appendAlertEvent', () => {
  it('keeps only the latest event per alert, which loses nothing', () => {
    let events: AlertEvent[] = [];
    for (const e of [upsert('a', 1), upsert('b', 2), upsert('a', 3, 'acknowledged'), resolved('b', 4)]) {
      events = appendAlertEvent(events, e);
    }
    expect(events.map((e) => `${e.alert.id}:${e.kind}@${e.at}`)).toEqual(['a:upsert@3', 'b:resolved@4']);
    expect(reconcileAlerts([], 0, events).map((a) => a.state)).toEqual(['acknowledged']);
  });

  it('is sized by distinct alerts, not by traffic', () => {
    let events: AlertEvent[] = [];
    for (let i = 0; i < 10_000; i += 1) events = appendAlertEvent(events, upsert(`a${i % 3}`, i));
    expect(events).toHaveLength(3);
  });

  it('keeps the most recent events once past the ceiling', () => {
    let events: AlertEvent[] = [];
    for (let i = 0; i < MAX_ALERT_EVENTS + 25; i += 1) events = appendAlertEvent(events, upsert(`a${i}`, i));
    expect(events).toHaveLength(MAX_ALERT_EVENTS);
    expect(events[0]!.alert.id).toBe('a25');
    expect(events.at(-1)!.alert.id).toBe(`a${MAX_ALERT_EVENTS + 24}`);
  });
});
