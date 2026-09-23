'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type Anthropic from '@anthropic-ai/sdk';
import { STATUS } from '@/lib/colors';
import type { PlanForReview } from '@/lib/copilot/tools';

/**
 * A conversation that ends in a decision, not an action.
 *
 * The copilot proposes; the person approves. Everything about this panel is
 * arranged around that one moment — the plan card is the loudest thing on
 * screen when it exists, the two buttons are unambiguous, and the zones it
 * would touch glow in the 3D view while the card is up, so what is being
 * decided is visible on the building and not only in a list
 * (docs/decisions.md §63).
 *
 * Tool activity is shown as quiet activity lines rather than hidden: an
 * operator who watches the copilot dry-run six zones before proposing three
 * learns what it checks, and learns to trust the three.
 */

interface Outcome {
  zoneName: string;
  setpointTempC: number;
  result: { ok: true; commandId: string; state: string } | { ok: false; refusal: string; message: string };
}

interface Turn {
  messages: Anthropic.MessageParam[];
  pendingPlan: PlanForReview | null;
  outcomes: Outcome[];
  notice: string | null;
}

type Availability =
  | { state: 'checking' }
  | { state: 'ready'; model: string }
  | { state: 'unavailable'; reason: string; signIn: boolean };

/** One line of the rendered transcript. */
type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'activity'; text: string };

/**
 * Turn the SDK's message list into what a person should read.
 *
 * Tool results and the graph's own `[system]` prompts are not shown: they are
 * the copilot's working, not its conversation. Tool CALLS are shown, briefly,
 * because they are the evidence that it looked before it proposed.
 */
export function renderTranscript(messages: Anthropic.MessageParam[]): Entry[] {
  const out: Entry[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      if (!m.content.startsWith('[system]')) out.push({ kind: 'user', text: m.content });
      continue;
    }
    if (m.role === 'user') continue; // tool results
    const calls: string[] = [];
    for (const block of m.content) {
      if (block.type === 'text' && block.text.trim()) out.push({ kind: 'assistant', text: block.text });
      if (block.type === 'tool_use') calls.push(describeCall(block.name, block.input));
    }
    if (calls.length > 0) out.push({ kind: 'activity', text: calls.join(' · ') });
  }
  return out;
}

function describeCall(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'list_zones': return 'read every zone';
    case 'control_envelope': return 'read the control envelope';
    case 'dry_run_setpoint':
      return `dry-ran ${typeof i.setpointTempC === 'number' ? `${i.setpointTempC.toFixed(1)} °C` : 'a setpoint'}`;
    case 'propose_plan': {
      const n = Array.isArray(i.commands) ? i.commands.length : 0;
      return `proposed ${n} command${n === 1 ? '' : 's'}`;
    }
    default: return name;
  }
}

export function CopilotPanel({ onHighlight }: { onHighlight: (zoneIds: string[]) => void }) {
  const [availability, setAvailability] = useState<Availability>({ state: 'checking' });
  const [threadId] = useState(() =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now()));
  const [turn, setTurn] = useState<Turn | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/copilot', { cache: 'no-store' })
      .then(async (r) => {
        const body = await r.json() as { available?: boolean; model?: string; reason?: string | null; error?: string };
        if (cancelled) return;
        if (r.status === 401 || r.status === 403) {
          setAvailability({ state: 'unavailable', signIn: true,
            reason: body.error ?? 'Sign in to use the copilot.' });
        } else if (body.available) {
          setAvailability({ state: 'ready', model: body.model ?? '' });
        } else {
          setAvailability({ state: 'unavailable', signIn: false, reason: body.reason ?? 'unavailable' });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setAvailability({ state: 'unavailable', signIn: false, reason: (err as Error).message });
      });
    return () => { cancelled = true; };
  }, []);

  // The building shows what is being decided, for exactly as long as it is
  // being decided.
  useEffect(() => {
    onHighlight(turn?.pendingPlan ? turn.pendingPlan.commands.map((c) => c.zoneId) : []);
  }, [turn?.pendingPlan, onHighlight]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [turn]);

  const post = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/copilot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId, ...body }),
      });
      const data = await r.json() as Turn & { error?: string };
      if (!r.ok) { setError(data.error ?? `copilot ${r.status}`); return; }
      setTurn(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [threadId]);

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    // Show the message at once; the server's copy arrives with the reply.
    setTurn((t) => ({
      messages: [...(t?.messages ?? []), { role: 'user', content: text }],
      pendingPlan: null, outcomes: t?.outcomes ?? [], notice: null,
    }));
    void post({ message: text });
  };

  if (availability.state === 'checking') {
    return <p className="px-4 pb-3 text-xs" style={{ color: 'var(--text-muted)' }}>…</p>;
  }
  if (availability.state === 'unavailable') {
    return (
      <p className="px-4 pb-3 text-xs" style={{ color: 'var(--text-muted)' }}>
        {availability.reason}
        {availability.signIn && (
          <> <a href="/login" style={{ color: STATUS.warning, textDecoration: 'underline' }}>Sign in</a></>
        )}
      </p>
    );
  }

  const entries = turn ? renderTranscript(turn.messages) : [];
  const plan = turn?.pendingPlan ?? null;

  return (
    <div className="flex flex-col px-4 pb-3 text-xs" style={{ gap: 8 }}>
      <div ref={transcriptRef} className="flex flex-col gap-2 overflow-y-auto" style={{ maxHeight: 280 }}>
        {entries.length === 0 && (
          <p style={{ color: 'var(--text-muted)' }}>
            Ask for a change in plain words — “pre-cool the Level 3 offices for the afternoon peak”.
            The copilot checks every zone against the safety envelope and proposes; nothing is
            applied until you approve it.
          </p>
        )}
        {entries.map((e, i) => (
          e.kind === 'activity' ? (
            <p key={i} style={{ color: 'var(--text-muted)', fontSize: 11 }}>· {e.text}</p>
          ) : (
            <div
              key={i}
              className="rounded px-2 py-1.5"
              style={{
                alignSelf: e.kind === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '92%',
                background: e.kind === 'user' ? 'var(--grid)' : 'var(--surface-1)',
                border: '1px solid var(--border)',
                whiteSpace: 'pre-wrap',
              }}
            >
              {e.text}
            </div>
          )
        ))}
        {busy && <p style={{ color: 'var(--text-muted)' }}>thinking…</p>}
        {turn?.notice && <p style={{ color: STATUS.warning }}>{turn.notice}</p>}
        {error && <p style={{ color: STATUS.critical }}>{error}</p>}
      </div>

      {plan && (
        <div
          className="rounded p-3"
          style={{ border: `1px solid ${STATUS.warning}`, background: 'rgba(250,178,25,0.08)' }}
          role="region"
          aria-label="Plan awaiting approval"
        >
          <p className="mb-2 font-medium">{plan.summary}</p>
          <table className="w-full">
            <tbody>
              {plan.commands.map((c) => (
                <tr key={c.zoneId}>
                  <td className="py-0.5 pr-2 font-medium">{c.zoneName}</td>
                  <td className="tnum py-0.5 pr-2">
                    {c.verdict.allowed ? `${c.verdict.previousTempC.toFixed(1)} → ` : ''}
                    {c.setpointTempC.toFixed(1)} °C
                  </td>
                  <td className="tnum py-0.5 pr-2" style={{ color: 'var(--text-secondary)' }}>
                    {c.verdict.allowed ? `${Math.round(c.verdict.durationS / 60)} min` : '—'}
                  </td>
                  <td className="py-0.5" style={{ color: c.verdict.allowed ? STATUS.good : STATUS.critical }}>
                    {c.verdict.allowed ? 'allowed' : c.verdict.refusal}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2" style={{ color: 'var(--text-muted)' }}>
            Each override lapses on its own when its window ends. Every command is re-checked by
            the envelope at the moment it is issued, and again when the gateway collects it.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void post({ decision: 'approved' })}
              className="rounded border px-3 py-1 font-medium"
              style={{ borderColor: STATUS.warning, color: STATUS.warning }}
            >
              Approve {plan.commands.length} command{plan.commands.length === 1 ? '' : 's'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void post({ decision: 'declined' })}
              className="rounded border px-3 py-1"
              style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
            >
              Decline
            </button>
          </div>
        </div>
      )}

      {turn && turn.outcomes.length > 0 && !plan && (
        <ul style={{ color: 'var(--text-secondary)' }}>
          {turn.outcomes.map((o, i) => (
            <li key={i} className="tnum">
              {o.zoneName} → {o.setpointTempC.toFixed(1)} °C:{' '}
              <span style={{ color: o.result.ok ? STATUS.good : STATUS.critical }}>
                {o.result.ok ? o.result.state : o.result.refusal}
              </span>
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e) => { e.preventDefault(); send(); }}
      >
        <input
          type="text"
          value={input}
          disabled={busy || plan !== null}
          onChange={(e) => setInput(e.target.value)}
          placeholder={plan ? 'Approve or decline the plan first' : 'What should change?'}
          aria-label="Message to the copilot"
          className="flex-1 rounded border px-2 py-1"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
        />
        <button
          type="submit"
          disabled={busy || plan !== null || input.trim().length === 0}
          className="rounded border px-3 py-1"
          style={{ borderColor: 'var(--border)', opacity: busy || plan ? 0.5 : 1 }}
        >
          Send
        </button>
      </form>
      <p style={{ color: 'var(--text-muted)', fontSize: 10 }}>{availability.model}</p>
    </div>
  );
}
