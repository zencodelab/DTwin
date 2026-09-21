'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ControlSettings } from '@dtwin/types';
import { STATUS } from '@/lib/colors';

interface CommandRow {
  id: string;
  zoneId: string;
  zoneName: string | null;
  setpointTempC: number;
  previousTempC: number | null;
  state: string;
  reason: string;
  requestedByName: string | null;
  effectiveUntil: string;
  outcomeDetail: string | null;
}

interface ControlState {
  settings: ControlSettings;
  commands: CommandRow[];
}

/**
 * The operator's control surface for one zone.
 *
 * Two deliberate choices about the interaction, both of which exist because
 * this is the one panel in the application that changes the building rather
 * than describing it:
 *
 * **Nothing is sent until a dry run has answered.** The button says "Check"
 * first and only becomes "Apply" once the server has evaluated the whole
 * envelope and said yes — so the refusal an operator is most likely to meet (a
 * faulted AHU, a dead sensor, a limit they did not know about) arrives before
 * they have committed to anything, not after.
 *
 * **The expiry is shown next to the value, always.** An override that lapses
 * is the safety property the whole design rests on (§62), and an operator who
 * does not know it lapses will assume it holds and stop watching.
 */
export function ControlPanel({
  zoneId, zoneName, designedSetpointC,
}: {
  zoneId: string;
  zoneName: string;
  designedSetpointC: number | null;
}) {
  const [state, setState] = useState<ControlState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState<{ previousTempC: number; durationS: number } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch('/api/control', { cache: 'no-store' })
      .then(async (r) => {
        // The server's own words, not the status code. Every refusal here
        // names something an operator can act on — sign in, switch control on,
        // fix the AHU — and "control 403" names none of them.
        const body = await r.json() as ControlState & { error?: string };
        if (!r.ok) throw new Error(body.error ?? `control ${r.status}`);
        return body;
      })
      .then((d: ControlState) => { setState(d); setError(null); })
      .catch((err: unknown) => setError((err as Error).message));
  }, []);

  useEffect(() => {
    load();
    // Commands settle asynchronously — a gateway collects them on its own
    // schedule — so the panel re-reads rather than assuming its POST was the
    // last word on the matter.
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  // A new zone invalidates a check made against the previous one.
  useEffect(() => { setChecked(null); setRefusal(null); setTarget(''); }, [zoneId]);

  const active = state?.commands.find(
    (c) => c.zoneId === zoneId && c.state === 'applied'
      && new Date(c.effectiveUntil).getTime() > Date.now(),
  );
  const inFlight = state?.commands.find(
    (c) => c.zoneId === zoneId && (c.state === 'pending' || c.state === 'dispatched'),
  );

  const send = async (dryRun: boolean) => {
    setBusy(true);
    setRefusal(null);
    try {
      const response = await fetch('/api/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          zoneId, setpointTempC: Number(target), reason: reason.trim(), dryRun,
        }),
      });
      const body = await response.json() as {
        error?: string; allowed?: boolean; previousTempC?: number; durationS?: number;
      };
      if (!response.ok) {
        setRefusal(body.error ?? `refused (${response.status})`);
        setChecked(null);
        return;
      }
      if (dryRun) {
        setChecked({ previousTempC: body.previousTempC ?? 0, durationS: body.durationS ?? 0 });
      } else {
        setChecked(null);
        setTarget('');
        setReason('');
        load();
      }
    } catch (err) {
      setRefusal((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <p className="px-4 pb-3 text-xs" style={{ color: STATUS.critical }}>
        Control unavailable — {error}
      </p>
    );
  }
  if (!state) {
    return <p className="px-4 pb-3 text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</p>;
  }

  if (!state.settings.enabled) {
    return (
      <p className="px-4 pb-3 text-xs" style={{ color: 'var(--text-muted)' }}>
        Supervisory control is switched off for this tenant. An owner or admin can
        enable it; it is off by default because it writes to the building.
      </p>
    );
  }

  const valid = target !== '' && Number.isFinite(Number(target)) && reason.trim().length >= 3;

  return (
    <div className="px-4 pb-3 text-xs">
      <div className="mb-2" style={{ color: 'var(--text-secondary)' }}>
        Designed setpoint{' '}
        <span className="tnum">{designedSetpointC?.toFixed(1) ?? '—'} °C</span>
        {active && (
          <>
            {' · '}
            <span className="tnum" style={{ color: STATUS.warning }}>
              overridden to {active.setpointTempC.toFixed(1)} °C
            </span>
            {' until '}
            <span className="tnum">
              {new Date(active.effectiveUntil).toLocaleTimeString([], {
                hour: '2-digit', minute: '2-digit',
              })}
            </span>
          </>
        )}
      </div>

      {inFlight ? (
        <p style={{ color: STATUS.warning }}>
          A command to {inFlight.setpointTempC.toFixed(1)} °C is waiting for the gateway
          ({inFlight.state}).
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <input
              type="number"
              step="0.1"
              value={target}
              onChange={(e) => { setTarget(e.target.value); setChecked(null); setRefusal(null); }}
              placeholder="°C"
              aria-label={`New setpoint for ${zoneName}`}
              className="w-20 rounded border px-2 py-1"
              style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
            />
            <input
              type="text"
              value={reason}
              onChange={(e) => { setReason(e.target.value); setChecked(null); }}
              placeholder="why (recorded)"
              aria-label="Reason for this command"
              className="flex-1 rounded border px-2 py-1"
              style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
            />
            <button
              type="button"
              disabled={!valid || busy}
              onClick={() => void send(checked !== null)}
              className="rounded border px-2 py-1"
              style={{
                borderColor: checked ? STATUS.warning : 'var(--border)',
                color: checked ? STATUS.warning : 'var(--text-primary)',
                opacity: valid && !busy ? 1 : 0.5,
              }}
            >
              {checked ? 'Apply' : 'Check'}
            </button>
          </div>

          {checked && (
            <p className="mt-2" style={{ color: STATUS.warning }}>
              Allowed: {checked.previousTempC.toFixed(1)} → {Number(target).toFixed(1)} °C for{' '}
              {Math.round(checked.durationS / 60)} min, then it lapses back on its own.
            </p>
          )}
          {refusal && <p className="mt-2" style={{ color: STATUS.critical }}>{refusal}</p>}
        </>
      )}

      <p className="mt-2" style={{ color: 'var(--text-muted)' }}>
        Within ±{state.settings.maxDeviationK} K of the designed setpoint, at most{' '}
        {state.settings.maxStepK} K per command.
      </p>
    </div>
  );
}
