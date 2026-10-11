'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { STATUS, STATUS_TEXT } from '@/lib/colors';
import { DEFAULT_LIMITS } from '@/lib/copilot/limits';
import type { CopilotEvent, PendingPlan } from '@/lib/copilot/protocol';
import {
  KIND_LABEL, MODEL_ESTIMATE, answerFallback, cardFacts, citationOrder, formatInstant, paragraphPieces, planBasis,
  type Card, type Cite, type Piece,
} from '@/lib/copilot-panel/answer';
import { clockSkewMs, countdown, planHighlight } from '@/lib/copilot-panel/countdown';
import {
  EMPTY, activeNodes, activityLines, applyEvents, applyTurn, beginDecision, beginMessage, chips, currentTurn,
  endStream, evidenceCards, hiddenSimRuns, isRunning, refuse, simRows, splitDialogue,
  type ChipTone, type PanelState, type SocketRun,
} from '@/lib/copilot-panel/run';
import { NDJSON, errorText, parseTurn, readEvents } from '@/lib/copilot-panel/wire';
import { GraphDiagram } from './GraphDiagram';

/**
 * The copilot: it investigates, simulates and proposes; a person approves
 * (docs/decisions.md §63, §64; design §9.4).
 *
 * Everything drawn here is a CopilotTurn or a streamed event, parsed through
 * the protocol's schemas. No model message reaches this component, and
 * every number in an answer is a segment the server verified against the
 * evidence it cites — this panel only decides where it goes, which citation
 * chip opens its evidence, and whether it is tinted as a model estimate.
 *
 * The PLAN CARD is the loudest thing on screen when there is one: the
 * commands with their fresh dry-run verdicts, a countdown to the moment the
 * route stops accepting a decision, "Simulated as …" only when plan_check
 * found the plan to be exactly what was simulated, and two unambiguous
 * buttons. The zones it would touch glow in the 3D view for as long as it is
 * up — including while a zone panel covers this one, which is why the
 * dashboard hides this panel rather than unmounting it.
 *
 * The answer streams as NDJSON (`application/x-ndjson`): read with a reader
 * loop, split on newlines, parsed line by line, and folded into state once
 * per animation frame rather than once per event. A JSON answer (the route
 * before its streaming branch) is read too. A dropped connection does not
 * stop the run — the route never aborts on disconnect — so the panel says
 * so and catches up from `GET ?threadId`.
 */

type Availability =
  | { state: 'checking' }
  | { state: 'ready'; models: { lead: string; specialist: string } | null }
  | { state: 'unavailable'; reason: string; signIn: boolean };

const AvailabilityBody = z.object({
  available: z.boolean().optional(),
  models: z.object({ lead: z.string(), specialist: z.string() }).optional(),
  reason: z.string().nullable().optional(),
  error: z.string().optional(),
});

/** One diagnostic, one analytic, one what-if (design §9.4). OFF-305 is a seeded office. */
const EXAMPLES = [
  'Why has OFF-305 been warm since 9?',
  'Which floor used the most energy last week, and what drove it?',
  'If we raise setpoints 1 K on a 46 °C day, what do we save and who gets uncomfortable?',
];

const PLACEHOLDER = 'Ask why, how much, what if, or what to change';

/**
 * GET ?threadId while a run this tab is not reading holds the thread: every
 * 2 s, for a minute longer than a run's deadline. Derived from the limit, not
 * written beside it: the deadline moved (180 s → 300 s) after the first real
 * runs, and a copy of it here would have given up on a run still in date.
 */
const POLL_MS = 2_000;
const POLL_LIMIT = Math.ceil(((DEFAULT_LIMITS.deadlineS + 60) * 1000) / POLL_MS);

/** Simulated figures, runs and cards share one tint, so a model estimate is recognisable at a glance. */
const SIM_TINT = 'rgba(139,92,246,0.16)';
const SIM_BAR = 'rgba(139,92,246,0.7)';
const SIM_CARD = 'rgba(139,92,246,0.06)';
const DROPPED = 'The connection dropped. The copilot carries on; this panel will catch up.';
const FAILED = 'The copilot could not complete this turn.';
const TONE: Record<ChipTone, string> = {
  running: STATUS.warning, done: STATUS.good, warn: STATUS.serious, failed: STATUS.critical, waiting: 'var(--text-muted)',
};

export function CopilotPanel({
  threadId, onNewThread, onHighlight, simRuns,
}: {
  /** Null until the dashboard has read sessionStorage. */
  threadId: string | null;
  onNewThread: () => void;
  onHighlight: (zoneIds: string[]) => void;
  /** The dashboard socket's simulation progress, merged into this panel's sim rows by run id. */
  simRuns: ReadonlyMap<string, SocketRun>;
}) {
  const [availability, setAvailability] = useState<Availability>({ state: 'checking' });
  const [panel, setPanel] = useState<PanelState>(EMPTY);
  const [input, setInput] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [polling, setPolling] = useState(false);
  const [showGraph, setShowGraph] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [focusedCard, setFocusedCard] = useState<string | null>(null);
  const [skewMs, setSkewMs] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const threadRef = useRef(threadId);
  const queue = useRef<CopilotEvent[]>([]);
  const frame = useRef<{ kind: 'frame' | 'timer'; id: number } | null>(null);
  const aborter = useRef<AbortController | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const transcriptRef = useRef<HTMLDivElement>(null);

  // ------------------------------------------------------------ events in

  const cancelFrame = useCallback(() => {
    const f = frame.current;
    if (f === null) return;
    if (f.kind === 'frame') window.cancelAnimationFrame(f.id);
    else window.clearTimeout(f.id);
    frame.current = null;
  }, []);

  const flush = useCallback(() => {
    cancelFrame();
    const batch = queue.current;
    queue.current = [];
    if (batch.length > 0) setPanel((p) => applyEvents(p, batch));
  }, [cancelFrame]);

  /**
   * Every event of a frame lands in ONE state update: a busy stream does not
   * re-render per line. A hidden tab runs no animation frames at all, so
   * there a short timer stands in — the run is current when the operator
   * comes back, rather than arriving in one burst.
   */
  const enqueue = useCallback((events: CopilotEvent[]) => {
    queue.current.push(...events);
    if (frame.current !== null) return;
    const run = () => { frame.current = null; flush(); };
    frame.current = document.visibilityState === 'hidden'
      ? { kind: 'timer', id: window.setTimeout(run, 250) }
      : { kind: 'frame', id: window.requestAnimationFrame(run) };
  }, [flush]);

  const rehydrate = useCallback(async (tid: string) => {
    try {
      const r = await fetch(`/api/copilot?threadId=${encodeURIComponent(tid)}`, { cache: 'no-store' });
      if (threadRef.current !== tid) return; // a newer conversation took over
      setSkewMs(clockSkewMs(r.headers.get('date'), Date.now()));
      if (!r.ok) { setPolling(false); return; }
      const turn = parseTurn(await r.json());
      if (!turn || threadRef.current !== tid) return;
      setPanel((p) => applyTurn(p, turn));
      setPolling(turn.running);
      // Caught up with a run whose stream was lost: the warning has done its job.
      if (!turn.running) setProblem((p) => (p === DROPPED ? null : p));
    } catch {
      // The next poll, or the next action, tries again.
    }
  }, []);

  // ------------------------------------------------------------ lifetime

  useEffect(() => {
    let cancelled = false;
    fetch('/api/copilot', { cache: 'no-store' })
      .then(async (r) => {
        const parsed = AvailabilityBody.safeParse(await r.json());
        if (cancelled) return;
        const body = parsed.success ? parsed.data : {};
        if (r.status === 401 || r.status === 403) {
          setAvailability({ state: 'unavailable', signIn: true, reason: body.error ?? 'Sign in to use the copilot.' });
        } else if (body.available) {
          setAvailability({ state: 'ready', models: body.models ?? null });
        } else {
          setAvailability({ state: 'unavailable', signIn: false, reason: body.reason ?? body.error ?? 'unavailable' });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setAvailability({ state: 'unavailable', signIn: false, reason: (err as Error).message });
      });
    return () => { cancelled = true; };
  }, []);

  // A conversation (a reload, or New conversation): start clean and read back what the server holds.
  const ready = availability.state === 'ready';
  useEffect(() => {
    threadRef.current = threadId;
    aborter.current?.abort();
    queue.current = [];
    setPanel(EMPTY);
    setProblem(null);
    setPolling(false);
    setEvidenceOpen(false);
    setFocusedCard(null);
    if (threadId && ready) void rehydrate(threadId);
  }, [threadId, ready, rehydrate]);

  useEffect(() => () => {
    aborter.current?.abort();
    cancelFrame();
  }, [cancelFrame]);

  // A run this tab is not reading (a lost stream, a reload mid-run): catch up until it ends.
  useEffect(() => {
    if (!polling || !threadId) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      if (tries > POLL_LIMIT) {
        setPolling(false);
        setProblem('The copilot has not finished this turn. Reload to check on it.');
        return;
      }
      void rehydrate(threadId);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [polling, threadId, rehydrate]);

  // ------------------------------------------------------------ derived

  const current = currentTurn(panel);
  const plan = current?.pendingPlan ?? null;
  const running = isRunning(panel) || posting;
  const { history, asked } = splitDialogue(panel);
  const cards = evidenceCards(panel);
  const { cards: orderedCards, number } = citationOrder(current?.answer ?? null, cards);
  const lit = activeNodes(panel);

  // The building shows what is being decided, for exactly as long as it is:
  // `now` ticks every second while a plan is up, so the glow goes within a
  // second of expiry.
  const planZones = planHighlight(plan, now, skewMs).join(',');
  useEffect(() => {
    onHighlight(planZones ? planZones.split(',') : []);
    return () => onHighlight([]);
  }, [planZones, onHighlight]);

  // The countdown ticks only while there is something to count down.
  useEffect(() => {
    if (!plan) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [plan]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [panel]);

  useEffect(() => {
    if (focusedCard) cardRefs.current.get(focusedCard)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focusedCard, evidenceOpen]);

  // No verified answer: the evidence is the answer, so it opens by itself (and can still be closed).
  const unverified = current !== null && answerFallback(current) !== null;
  useEffect(() => { if (unverified) setEvidenceOpen(true); }, [unverified]);

  // -------------------------------------------------------------- actions

  const post = useCallback(async (
    body: Record<string, unknown>, begin: (p: PanelState) => PanelState, restoreText: string | null,
  ) => {
    const tid = threadRef.current;
    if (!tid) return;
    setPosting(true);
    setProblem(null);
    setStopping(false);
    setPolling(false);
    setPanel(begin);
    const controller = new AbortController();
    aborter.current = controller;
    try {
      const res = await fetch('/api/copilot', {
        method: 'POST',
        // A refusal still comes back as JSON with a status; only a run streams.
        headers: { 'content-type': 'application/json', accept: NDJSON },
        body: JSON.stringify({ threadId: tid, ...body }),
        signal: controller.signal,
      });
      setSkewMs(clockSkewMs(res.headers.get('date'), Date.now()));
      const type = res.headers.get('content-type') ?? '';
      if (res.ok && type.includes(NDJSON) && res.body) {
        const end = await readEvents(res.body, enqueue);
        flush();
        setPanel((p) => endStream(p, end));
        if (end === 'lost' && !controller.signal.aborted) {
          setProblem(DROPPED);
          setPolling(true);
        }
        if (end === 'error') {
          // Fixed words, as the route sent them; then what the run checkpointed (its notices, its cards).
          setProblem(FAILED);
          void rehydrate(tid);
        }
      } else if (res.ok) {
        const turn = parseTurn(await res.json());
        if (turn) setPanel((p) => endStream(applyEvents(p, [{ t: 'turn', turn }]), 'turn'));
        else { setPanel((p) => endStream(p, 'error')); setProblem('The copilot answered in a shape this panel does not read.'); }
      } else {
        // Refused before any run began: nothing ran, so put back what was on screen.
        const json: unknown = await res.json().catch(() => null);
        setPanel(refuse);
        setProblem(errorText(res.status, json));
        if (restoreText) setInput((i) => (i === '' ? restoreText : i));
        // A 409 means the thread moved on (a decision raced, a plan expired, a run holds it): read it again.
        if (res.status === 409) void rehydrate(tid);
      }
    } catch {
      if (controller.signal.aborted) return;
      // No response at all: the request may or may not have reached the server.
      setPanel((p) => endStream(p, 'lost'));
      setProblem('Could not reach the copilot. Checking whether it is working on this…');
      void rehydrate(tid);
    } finally {
      if (aborter.current === controller) aborter.current = null;
      setPosting(false);
    }
  }, [enqueue, flush, rehydrate]);

  const send = (text: string) => {
    const t = text.trim();
    if (!t || running || !ready || !threadRef.current) return;
    setInput('');
    void post({ message: t }, (p) => beginMessage(p, t), t);
  };

  const decide = (p: PendingPlan, decision: 'approved' | 'declined') => {
    if (running) return;
    void post(
      { decision, interruptId: p.interruptId, planId: p.planId, planHash: p.planHash },
      (s) => beginDecision(s, decision), null,
    );
  };

  const stop = () => {
    const tid = threadRef.current;
    if (!tid || stopping) return;
    setStopping(true);
    // Cooperative: the run notices at its next model call or tool and ends with a 'stopped' notice.
    fetch('/api/copilot', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: tid, stop: true }),
    }).catch(() => setStopping(false));
  };

  const openCard = (id: string) => { setEvidenceOpen(true); setFocusedCard(id); };

  // --------------------------------------------------------------- render

  const graph = (
    <div className="px-4 text-xs">
      <button
        type="button"
        onClick={() => setShowGraph((v) => !v)}
        className="mb-1"
        style={{ color: 'var(--text-muted)', textDecoration: 'underline dotted' }}
        aria-expanded={showGraph}
      >
        {showGraph ? 'Hide' : 'Show'} how it works
      </button>
      {showGraph && (
        <div className="mb-2 rounded p-2" style={{ border: '1px solid var(--border)' }}>
          <GraphDiagram activeNodes={lit} />
        </div>
      )}
    </div>
  );

  if (availability.state === 'checking') {
    return <>{graph}<p className="px-4 pb-3 text-xs" style={{ color: 'var(--text-muted)' }}>…</p></>;
  }
  if (availability.state === 'unavailable') {
    return (
      <>
        {graph}
        <p className="px-4 pb-3 text-xs" style={{ color: 'var(--text-muted)' }}>
          {availability.reason}
          {availability.signIn && (
            <> <a href="/login" style={{ color: STATUS_TEXT.warning, textDecoration: 'underline' }}>Sign in</a></>
          )}
        </p>
      </>
    );
  }

  const models = current?.models ?? panel.turn?.models ?? availability.models;
  const chipList = chips(panel, simRuns);
  const activity = activityLines(panel);
  const sims = simRows(panel, simRuns);
  const moreSims = hiddenSimRuns(panel);
  const fallback = current ? answerFallback(current) : null;
  const empty = history.length === 0 && asked === null && !panel.live;

  return (
    <>
      {graph}
      <div className="flex flex-col px-4 pb-3 text-xs" style={{ gap: 8 }}>
        <div ref={transcriptRef} className="flex flex-col gap-2 overflow-y-auto" style={{ maxHeight: 420 }}>
          {empty && <EmptyState onPick={(t) => setInput(t)} />}

          {history.map((e, i) => (e.role === 'operator'
            ? <Bubble key={i} who="operator">{e.text}</Bubble>
            : (
              <Bubble key={i} who="copilot">
                {e.text ?? <span style={{ color: 'var(--text-muted)' }}>(no verified written answer)</span>}
              </Bubble>
            )))}

          {asked !== null && <Bubble who="operator">{asked}</Bubble>}

          {current?.interpretation && (
            <p style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Read as: {current.interpretation}</p>
          )}

          {chipList.length > 0 && (
            <div className="flex flex-wrap items-center" style={{ gap: 4 }} role="status" aria-live="polite">
              {chipList.map((c) => (
                <span
                  key={c.key}
                  title={c.title ?? undefined}
                  className="rounded px-1.5 py-0.5"
                  style={{ border: `1px solid ${TONE[c.tone]}`, color: c.tone === 'waiting' ? 'var(--text-muted)' : 'var(--text-primary)' }}
                >
                  {c.text}
                </span>
              ))}
            </div>
          )}

          {activity.length > 0 && (
            <ul style={{ color: 'var(--text-muted)', fontSize: 11 }}>
              {activity.map((a) => (
                <li key={a.key} title={a.last}>· {a.text}{panel.live?.streaming ? ` — ${a.last}` : ''}</li>
              ))}
            </ul>
          )}

          {sims.length > 0 && (
            <div className="flex flex-col" style={{ gap: 3 }}>
              {sims.map((r) => (
                <div key={r.runId} className="flex items-center" style={{ gap: 6 }}>
                  <span className="truncate" style={{ width: 84, color: 'var(--text-secondary)' }}>sim · {r.label}</span>
                  <span className="relative h-1.5 flex-1 overflow-hidden rounded" style={{ background: 'var(--grid)' }}>
                    <span
                      className="absolute inset-y-0 left-0"
                      style={{
                        width: `${r.progressPct}%`,
                        background: r.status === 'failed' || r.status === 'cancelled' ? STATUS.critical : SIM_BAR,
                      }}
                    />
                  </span>
                  <span className="tnum" style={{ width: 58, textAlign: 'right', color: 'var(--text-muted)' }}>
                    {r.status === 'running' || r.status === 'queued' ? `${Math.floor(r.progressPct)}%` : r.status}
                  </span>
                </div>
              ))}
              {moreSims > 0 && <p style={{ color: 'var(--text-muted)' }}>and {moreSims} more run{moreSims === 1 ? '' : 's'}</p>}
            </div>
          )}

          {current?.message && <Bubble who="copilot">{current.message}</Bubble>}

          {current?.answer && (
            <div
              className="rounded px-2 py-1.5"
              style={{ background: 'var(--surface-1)', border: '1px solid var(--border)', lineHeight: 1.5 }}
            >
              {current.answer.paragraphs.map((p, i) => (
                <p key={i} style={{ marginTop: i === 0 ? 0 : 6 }}>
                  {paragraphPieces(p, number).map((piece, j) => <PieceView key={j} piece={piece} onCite={openCard} />)}
                </p>
              ))}
              {current.answer.caveatLines.length > 0 && (
                <ul className="mt-2" style={{ color: 'var(--text-muted)', fontSize: 10.5 }}>
                  {current.answer.caveatLines.map((line) => <li key={line}>⚠ {line}</li>)}
                </ul>
              )}
            </div>
          )}

          {fallback && <p style={{ color: STATUS_TEXT.warning }}>{fallback}</p>}

          {current && current.notices.length > 0 && (
            <ul style={{ color: STATUS_TEXT.warning }}>
              {current.notices.map((n) => <li key={`${n.code}:${n.text}`}>{n.text}</li>)}
            </ul>
          )}

          {orderedCards.length > 0 && (
            <Evidence
              cards={orderedCards}
              number={number}
              open={evidenceOpen}
              onToggle={() => setEvidenceOpen((v) => !v)}
              focused={focusedCard}
              cardRefs={cardRefs.current}
              provisional={!current}
            />
          )}

          {current && current.outcomes.length > 0 && (
            <ul style={{ color: 'var(--text-secondary)' }} aria-label="What was issued">
              {current.outcomes.map((o, i) => (
                <li key={i} className="tnum">
                  {o.zoneName} → {o.setpointTempC.toFixed(1)} °C:{' '}
                  <span style={{ color: o.result.ok ? STATUS_TEXT.good : STATUS_TEXT.critical }}>
                    {o.result.ok ? o.result.state : `${o.result.refusal} — ${o.result.message}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {plan && (
          <PlanCard
            plan={plan}
            now={now}
            skewMs={skewMs}
            busy={running}
            deciding={panel.live?.kind === 'decision' && panel.live.streaming ? panel.live.decision : null}
            onDecide={(d) => decide(plan, d)}
            onCite={openCard}
            number={number}
          />
        )}

        {problem && <p role="alert" style={{ color: STATUS_TEXT.critical }}>{problem}</p>}

        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); send(input); }}>
          <input
            type="text"
            value={input}
            disabled={running}
            onChange={(e) => setInput(e.target.value)}
            placeholder={PLACEHOLDER}
            aria-label="Message to the copilot"
            className="min-w-0 flex-1 rounded border px-2 py-1"
            style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
          />
          {running ? (
            <button
              type="button"
              onClick={stop}
              disabled={stopping || (!panel.live?.streaming && !panel.turn?.running)}
              className="rounded border px-3 py-1"
              style={{ borderColor: STATUS.critical, color: STATUS_TEXT.critical, opacity: stopping ? 0.6 : 1 }}
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          ) : (
            <button
              type="submit"
              disabled={input.trim().length === 0}
              className="rounded border px-3 py-1"
              style={{ borderColor: 'var(--border)', opacity: input.trim().length === 0 ? 0.5 : 1 }}
            >
              Send
            </button>
          )}
        </form>
        {plan && !running && (
          <p style={{ color: 'var(--text-muted)', fontSize: 10 }}>
            A new message sets this plan aside; nothing is issued without Approve.
          </p>
        )}

        <div className="flex items-baseline justify-between" style={{ gap: 8, color: 'var(--text-muted)', fontSize: 10 }}>
          {/* Wraps rather than truncates: a model id cut short is a different model. */}
          <span style={{ overflowWrap: 'anywhere' }}>
            {models && <>lead {models.lead} · specialist {models.specialist}</>}
            {current?.usage && <> · {current.usage.modelCalls} model call{current.usage.modelCalls === 1 ? '' : 's'}</>}
          </span>
          <button
            type="button"
            onClick={onNewThread}
            disabled={running}
            style={{ textDecoration: 'underline dotted', opacity: running ? 0.5 : 1, whiteSpace: 'nowrap' }}
          >
            New conversation
          </button>
        </div>
      </div>
    </>
  );
}

// ================================================================ pieces

function Bubble({ who, children }: { who: 'operator' | 'copilot'; children: ReactNode }) {
  return (
    <div
      className="rounded px-2 py-1.5"
      style={{
        alignSelf: who === 'operator' ? 'flex-end' : 'flex-start',
        maxWidth: '92%',
        background: who === 'operator' ? 'var(--grid)' : 'var(--surface-1)',
        border: '1px solid var(--border)',
        whiteSpace: 'pre-wrap',
      }}
    >
      {children}
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div style={{ color: 'var(--text-muted)' }}>
      <p>
        Ask why something happened, how much was used, what a change would do, or what to change.
        Every figure in an answer is checked against the data it cites; nothing is applied until you approve it.
      </p>
      <ul className="mt-2 flex flex-col" style={{ gap: 4 }}>
        {EXAMPLES.map((e) => (
          <li key={e}>
            <button
              type="button"
              onClick={() => onPick(e)}
              className="rounded px-2 py-1 text-left"
              style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            >
              {e}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CiteChips({ cites, onCite }: { cites: readonly Cite[]; onCite: (id: string) => void }) {
  return (
    <>
      {cites.map((c) => (
        <sup key={c.id}>
          <button
            type="button"
            onClick={() => onCite(c.id)}
            aria-label={`evidence ${c.n} (${c.id})`}
            className="rounded px-0.5"
            style={{ color: 'var(--accent)', fontSize: 9, marginLeft: 1 }}
          >
            {c.n}
          </button>
        </sup>
      ))}
    </>
  );
}

function PieceView({ piece, onCite }: { piece: Piece; onCite: (id: string) => void }) {
  if (piece.kind === 'text') return <>{piece.text}</>;
  if (piece.kind === 'cite') return <CiteChips cites={piece.cites} onCite={onCite} />;
  return (
    <>
      <span
        className="tnum rounded"
        title={piece.simulated ? `${MODEL_ESTIMATE}: simulator output, not a measurement` : piece.basis}
        style={piece.simulated ? { background: SIM_TINT, padding: '0 2px', fontWeight: 500 } : { fontWeight: 500 }}
      >
        {piece.text}
      </span>
      {piece.simulated && (
        <span style={{ color: 'var(--text-muted)', fontSize: 9, marginLeft: 2 }}>{MODEL_ESTIMATE}</span>
      )}
      <CiteChips cites={piece.cites} onCite={onCite} />
    </>
  );
}

function Evidence({
  cards, number, open, onToggle, focused, cardRefs, provisional,
}: {
  cards: readonly Card[];
  number: ReadonlyMap<string, number>;
  open: boolean;
  onToggle: () => void;
  focused: string | null;
  cardRefs: Map<string, HTMLElement>;
  provisional: boolean;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{ color: 'var(--text-secondary)', textDecoration: 'underline dotted' }}
      >
        Evidence ({cards.length}){provisional ? ' · gathering' : ''}
      </button>
      {open && (
        <ol className="mt-1 flex flex-col" style={{ gap: 6 }}>
          {cards.map((c) => {
            const facts = cardFacts(c);
            return (
              <li
                key={c.id}
                ref={(el) => { if (el) cardRefs.set(c.id, el); else cardRefs.delete(c.id); }}
                className="rounded px-2 py-1.5"
                style={{
                  border: `1px solid ${focused === c.id ? 'var(--accent)' : 'var(--border)'}`,
                  background: c.kind === 'simulated' ? SIM_CARD : 'var(--surface-1)',
                }}
              >
                <div className="flex items-baseline justify-between" style={{ gap: 6 }}>
                  <span className="font-medium">
                    <span style={{ color: 'var(--accent)' }}>{number.get(c.id)}</span> {c.label}
                  </span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 9.5, whiteSpace: 'nowrap' }}>{KIND_LABEL[c.kind]}</span>
                </div>
                <p style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                  {[c.source, ...facts].join(' · ')} · {c.id}
                </p>
                {c.headline.length > 0 && (
                  <dl className="mt-1 grid" style={{ gridTemplateColumns: 'auto 1fr', columnGap: 8 }}>
                    {c.headline.map((h) => (
                      <HeadlineRow key={h.label} label={h.label} text={h.text} />
                    ))}
                  </dl>
                )}
                {c.caveatLines.length > 0 && (
                  <ul className="mt-1 flex flex-col" style={{ gap: 2, color: 'var(--text-secondary)', fontSize: 10 }}>
                    {c.caveatLines.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function HeadlineRow({ label, text }: { label: string; text: string }) {
  return (
    <>
      <dt style={{ color: 'var(--text-secondary)' }}>{label}</dt>
      <dd className="tnum" style={{ textAlign: 'right' }}>{text}</dd>
    </>
  );
}

function PlanCard({
  plan, now, skewMs, busy, deciding, onDecide, onCite, number,
}: {
  plan: PendingPlan;
  now: number;
  skewMs: number;
  busy: boolean;
  deciding: 'approved' | 'declined' | null;
  onDecide: (d: 'approved' | 'declined') => void;
  onCite: (id: string) => void;
  number: ReadonlyMap<string, number>;
}) {
  const clock = countdown(plan.expiresAt, now, skewMs);
  const basis = planBasis(plan);
  const allAllowed = plan.commands.every((c) => c.verdict.allowed);
  const n = plan.commands.length;
  const checked = formatInstant(plan.checkedAt);
  return (
    <section
      className="rounded p-3"
      style={{ border: `1.5px solid ${STATUS.warning}`, background: 'rgba(250,178,25,0.08)' }}
      aria-label="Plan awaiting your approval"
    >
      <div className="mb-1 flex items-baseline justify-between" style={{ gap: 8 }}>
        <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: STATUS_TEXT.warning }}>
          Awaiting your approval
        </span>
        <span
          className="tnum"
          role="timer"
          aria-live="off"
          style={{ color: clock.urgent ? STATUS_TEXT.critical : 'var(--text-secondary)', fontWeight: clock.urgent ? 600 : 400 }}
        >
          {clock.text}
        </span>
      </div>
      <p className="mb-2 font-medium">{plan.summary}</p>

      <table className="w-full">
        <tbody>
          {plan.commands.map((c) => (
            <tr key={c.zoneId} style={{ verticalAlign: 'top' }}>
              <td className="py-0.5 pr-2 font-medium">{c.zoneName}</td>
              <td className="tnum py-0.5 pr-2" style={{ whiteSpace: 'nowrap' }}>
                {c.verdict.allowed && c.verdict.previousTempC !== null ? `${c.verdict.previousTempC.toFixed(1)} → ` : ''}
                {c.setpointTempC.toFixed(1)} °C
              </td>
              <td className="tnum py-0.5 pr-2" style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                {c.verdict.allowed ? `${Math.round(c.verdict.durationS / 60)} min` : '—'}
              </td>
              <td className="py-0.5" style={{ color: c.verdict.allowed ? STATUS_TEXT.good : STATUS_TEXT.critical }}>
                {c.verdict.allowed ? 'allowed' : c.verdict.refusal}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="mt-1" style={{ color: 'var(--text-secondary)', fontSize: 10.5 }}>
        {plan.commands.map((c) => <li key={c.zoneId}>{c.zoneName}: {c.reason}</li>)}
      </ul>
      <p className="mt-1" style={{ color: 'var(--text-muted)', fontSize: 10 }}>
        Each command was dry-run against the envelope at {checked}. Each override lapses on its own when its
        window ends, and is checked again when issued and when the gateway collects it.
      </p>

      {basis.kind === 'simulated' && (
        <div className="mt-2 rounded px-2 py-1" style={{ background: SIM_TINT }}>
          <p className="font-medium">
            Simulated as {basis.scenario}
            {number.has(basis.evidenceId) && <CiteChips cites={[{ n: number.get(basis.evidenceId)!, id: basis.evidenceId }]} onCite={onCite} />}
          </p>
          <ul style={{ color: 'var(--text-secondary)', fontSize: 10 }}>
            {basis.lines.map((l) => <li key={l}>{l}</li>)}
          </ul>
        </div>
      )}
      {basis.kind === 'mismatch' && (
        <p className="mt-2" style={{ color: 'var(--text-muted)', fontSize: 10 }}>
          It cites the simulation “{basis.scenario}”, but {basis.zonesMatch ? 'its setpoints differ from' : 'its zones differ from'} what
          was simulated, so the simulation is not shown as its basis.
        </p>
      )}

      {clock.expired ? (
        <p className="mt-2" style={{ color: STATUS_TEXT.critical }}>
          This plan has expired and can no longer be approved; nothing was issued. Ask again for a fresh plan.
        </p>
      ) : (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={busy || !allAllowed}
            onClick={() => onDecide('approved')}
            className="rounded border px-3 py-1 font-semibold"
            style={{ borderColor: STATUS.warning, color: STATUS_TEXT.warning, opacity: busy || !allAllowed ? 0.6 : 1 }}
          >
            {deciding === 'approved' ? 'Approving…' : `Approve ${n} command${n === 1 ? '' : 's'}`}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide('declined')}
            className="rounded border px-3 py-1"
            style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', opacity: busy ? 0.6 : 1 }}
          >
            {deciding === 'declined' ? 'Declining…' : 'Decline'}
          </button>
        </div>
      )}
    </section>
  );
}

