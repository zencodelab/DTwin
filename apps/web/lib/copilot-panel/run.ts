import type { CopilotEvent, CopilotNode, CopilotTurn } from '../copilot/protocol.ts';

/**
 * The panel's state, folded from the copilot's events and turns (design
 * §9.2–9.4). Pure reducers and derivations — the component only stores the
 * result and draws it.
 *
 * TWO SOURCES, ONE RULE. While a run streams, `live` accumulates what the
 * events said: which tasks are running, what they have read, simulation
 * progress, where the graph has got to. When the run's `turn` arrives it is
 * the truth for everything it carries — task statuses included — and `live`
 * keeps only what a turn does not carry (activity counts, simulation rows).
 * A turn from `GET ?threadId` (a reload, a lost stream) replaces everything:
 * there is no event history behind it to keep.
 *
 * The panel renders ONLY these: a CopilotTurn and the events. Never a model
 * message.
 */

type Ev<T extends CopilotEvent['t']> = Extract<CopilotEvent, { t: T }>;
export type Task = CopilotTurn['tasks'][number];
export type TaskStatus = Task['status'];
export type Specialist = Task['specialist'];
export type EvidenceMeta = Omit<Ev<'evidence'>, 't'>;
export type SimMeta = Omit<Ev<'sim'>, 't'>;
export type PlanMarker = Omit<Ev<'plan'>, 't'>;

/** What the tools module classes each tool as; asserted equal to `TOOL_CLASS` by test. */
export const ACTIVITY_CLASS = {
  zone_conditions: 'read', zone_history: 'read', zone_timeline: 'read', equipment_status: 'read', list_alerts: 'read',
  control_history: 'read', energy_by_end_use: 'read', meter_consumption: 'read', compare_zones: 'read',
  list_zones: 'read', control_envelope: 'read', dry_run_setpoint: 'dry_run', simulate_scenarios: 'scratch',
  propose_plan: 'propose', report_finding: 'report',
} as const;
type ActivityClass = (typeof ACTIVITY_CLASS)[keyof typeof ACTIVITY_CLASS];

const FINISHED: ReadonlySet<TaskStatus> = new Set(['done', 'answered', 'partial', 'cannot_answer', 'failed', 'refused']);
const SPECIALISTS: ReadonlySet<string> = new Set<Specialist>(['diagnose', 'analyse', 'simulate', 'control']);
const isSpecialist = (n: string): n is Specialist => SPECIALISTS.has(n);

export interface Activity {
  taskId: string;
  counts: Partial<Record<ActivityClass | 'other', number>>;
  /** The server's label for the latest call (built from the directory, never model text). */
  last: string;
}

export interface LiveRun {
  /** What started it: the operator's words (shown at once), or a decision on a plan. */
  kind: 'message' | 'decision';
  asked: string | null;
  decision: 'approved' | 'declined' | null;
  requestId: string | null;
  /** A response body is being read. */
  streaming: boolean;
  /** How the stream ended, once it has: its turn, its error event, or neither. */
  ended: 'turn' | 'error' | 'lost' | null;
  lastStep: CopilotNode | null;
  /**
   * Specialists whose task has ended but whose own step has not arrived: a
   * specialist writes its task's end BEFORE its node finishes (found by
   * folding a real run), so it is still running until then.
   */
  finishing: Partial<Record<Specialist, number>>;
  tasks: Task[];
  activity: Activity[];
  evidence: EvidenceMeta[];
  sims: SimMeta[];
  plan: PlanMarker | null;
  /** The run this one replaced on screen, restored if the route refuses this one before it starts. */
  previous: LiveRun | null;
}

export interface PanelState {
  /** The latest whole turn: the end of a stream, a JSON answer, or `GET ?threadId`. */
  turn: CopilotTurn | null;
  live: LiveRun | null;
}

export const EMPTY: PanelState = { turn: null, live: null };

function freshRun(kind: LiveRun['kind'], asked: string | null, decision: LiveRun['decision'], previous: LiveRun | null): LiveRun {
  return {
    kind, asked, decision, requestId: null, streaming: true, ended: null, lastStep: null, finishing: {},
    tasks: [], activity: [], evidence: [], sims: [], plan: null,
    // One level only: a refusal restores the run it replaced, never a chain.
    previous: previous ? { ...previous, previous: null } : null,
  };
}

/** A message starts a fresh run. */
export function beginMessage(state: PanelState, text: string): PanelState {
  return { ...state, live: freshRun('message', text, null, state.live) };
}

/**
 * A decision resumes the SAME request, so what that request's run already
 * showed (its tasks, reads and simulations) stays; only the progress resets.
 */
export function beginDecision(state: PanelState, decision: 'approved' | 'declined'): PanelState {
  const prev = state.live;
  const next = freshRun('decision', null, decision, prev);
  return {
    ...state,
    live: prev ? { ...next, requestId: prev.requestId, tasks: prev.tasks, activity: prev.activity, evidence: prev.evidence, sims: prev.sims } : next,
  };
}

function upsert<T>(list: readonly T[], key: (t: T) => string, item: T, merge: (old: T, inc: T) => T = (_o, i) => i): T[] {
  const k = key(item);
  const i = list.findIndex((x) => key(x) === k);
  if (i === -1) return [...list, item];
  const out = list.slice();
  out[i] = merge(list[i]!, item);
  return out;
}

/** The turn's tasks are authoritative; order is the order they were first seen. */
function mergeTasks(live: readonly Task[], turn: readonly Task[]): Task[] {
  let out = live.slice();
  for (const t of turn) out = upsert(out, (x) => x.taskId, t);
  return out;
}

function foldEvent(state: PanelState, e: CopilotEvent): PanelState {
  if (e.t === 'turn') {
    const live = state.live ? { ...state.live, tasks: mergeTasks(state.live.tasks, e.turn.tasks), ended: 'turn' as const } : null;
    return { turn: e.turn, live };
  }
  const live = state.live;
  if (!live) return state; // an event with no run to belong to
  switch (e.t) {
    case 'accepted':
      return { ...state, live: { ...live, requestId: e.requestId ?? live.requestId } };
    case 'step': {
      const finishing = { ...live.finishing };
      if (isSpecialist(e.node) && finishing[e.node]) finishing[e.node] = finishing[e.node]! - 1;
      return { ...state, live: { ...live, lastStep: e.node, finishing } };
    }
    case 'task': {
      const task: Task = { taskId: e.taskId, specialist: e.specialist, goal: e.goal, status: e.status, reason: null };
      const before = live.tasks.find((t) => t.taskId === e.taskId);
      const finishing = { ...live.finishing };
      if (FINISHED.has(e.status) && !(before && FINISHED.has(before.status))) {
        finishing[e.specialist] = (finishing[e.specialist] ?? 0) + 1;
      }
      // An end event carries no goal; the dispatch did.
      const tasks = upsert(live.tasks, (t) => t.taskId, task, (old, inc) => ({ ...inc, goal: inc.goal ?? old.goal }));
      return { ...state, live: { ...live, tasks, finishing } };
    }
    case 'activity': {
      const cls: ActivityClass | 'other' = (ACTIVITY_CLASS as Record<string, ActivityClass>)[e.tool] ?? 'other';
      const prev = live.activity.find((a) => a.taskId === e.taskId);
      const counts = { ...(prev?.counts ?? {}), [cls]: (prev?.counts[cls] ?? 0) + 1 };
      const activity = upsert(live.activity, (a) => a.taskId, { taskId: e.taskId, counts, last: e.label });
      return { ...state, live: { ...live, activity } };
    }
    case 'evidence': {
      if (live.evidence.some((x) => x.id === e.id)) return state;
      const { t: _t, ...meta } = e;
      return { ...state, live: { ...live, evidence: [...live.evidence, meta] } };
    }
    case 'sim': {
      const { t: _t, ...meta } = e;
      return { ...state, live: { ...live, sims: upsert(live.sims, (s) => s.runId, meta) } };
    }
    case 'plan': {
      const { t: _t, ...meta } = e;
      return { ...state, live: { ...live, plan: meta } };
    }
    case 'error':
      return { ...state, live: { ...live, ended: 'error', requestId: e.requestId ?? live.requestId } };
    case 'ping':
      return state;
  }
}

/** Every event of one animation frame, in order. */
export function applyEvents(state: PanelState, events: readonly CopilotEvent[]): PanelState {
  return events.reduce(foldEvent, state);
}

/** The body has been read to its end, however it ended. */
export function endStream(state: PanelState, how: 'turn' | 'error' | 'lost'): PanelState {
  if (!state.live) return state;
  return { ...state, live: { ...state.live, streaming: false, ended: state.live.ended ?? how } };
}

/**
 * A turn read whole (JSON, or a rehydrate). If it answers the run on
 * screen, that run's activity stays beside it; otherwise it is a different
 * picture and the run is dropped.
 */
export function applyTurn(state: PanelState, turn: CopilotTurn): PanelState {
  const live = state.live;
  if (live && !live.streaming && live.requestId !== null && live.requestId === turn.requestId) {
    return { turn, live: { ...live, tasks: mergeTasks(live.tasks, turn.tasks) } };
  }
  if (live?.streaming) return { ...state, turn };
  return { turn, live: null };
}

/**
 * The route refused the request before any run began (a 4xx, a 409): put
 * back what was on screen. Nothing ran, so nothing the refused run showed —
 * the operator's words included — is part of the conversation.
 */
export function refuse(state: PanelState): PanelState {
  return { ...state, live: state.live?.previous ?? null };
}

/**
 * The turn that belongs to the run on screen, or null while a NEW message's
 * turn has not arrived — the previous request's answer, plan and cards are
 * then history, not the current answer (and a plan a new message sets aside
 * stops glowing at once). A decision resumes the same request, so its turn
 * stays current.
 */
export function currentTurn(state: PanelState): CopilotTurn | null {
  const { turn, live } = state;
  if (!turn) return null;
  if (!live || live.kind === 'decision') return turn;
  return live.requestId !== null && live.requestId === turn.requestId ? turn : null;
}

export type DialogueEntry = CopilotTurn['dialogue'][number];

/**
 * The conversation before the current request, and the current request's
 * words. The current request's own answer is NOT taken from the dialogue —
 * the dialogue holds its plain text, and the panel draws the structured,
 * cited answer from the turn instead.
 */
export function splitDialogue(state: PanelState): { history: DialogueEntry[]; asked: string | null } {
  const dialogue = state.turn?.dialogue ?? [];
  const current = currentTurn(state);
  if (state.live?.kind === 'message' && current === null) return { history: dialogue, asked: state.live.asked };
  let i = dialogue.length - 1;
  while (i >= 0 && dialogue[i]!.role !== 'operator') i -= 1;
  if (i < 0) return { history: dialogue, asked: null };
  return { history: dialogue.slice(0, i), asked: dialogue[i]!.text };
}

export type Card = CopilotTurn['cards'][number];

/**
 * The evidence to list: the turn's cards once it has arrived; before that,
 * the stream's evidence events as provisional cards (their headlines and
 * caveats come with the turn).
 */
export function evidenceCards(state: PanelState): Card[] {
  const current = currentTurn(state);
  if (current) return current.cards;
  return (state.live?.evidence ?? []).map((e) => ({
    id: e.id, label: e.label, source: e.source, kind: e.kind, window: e.window, coverage: e.coverage,
    flaggedExcluded_count: e.flaggedExcluded_count, truncated: e.truncated, headline: [], caveatLines: [],
  }));
}

/** A run is going on: a stream is open, or the server says one holds the thread. */
export function isRunning(state: PanelState): boolean {
  return Boolean(state.live?.streaming) || Boolean(state.turn?.running);
}

// ============================================================ where it is

/**
 * Which node the run is most likely in, from the last node that FINISHED
 * (the stream reports ends, not starts). Where the edge list leaves more
 * than one way on, the guess is the one that takes long enough to watch:
 * after the planner, compose if the request has findings and the
 * controller if not (`finish` would be over before a frame is drawn); after
 * verify or control the stream does not say, so null. A test checks each
 * guess against the compiled graph's edges.
 */
export function likelyNext(
  last: CopilotNode | null, opts: { hasFindings: boolean; decision: LiveRun['decision'] },
): CopilotNode | null {
  switch (last) {
    // A decision resumes the run inside confirm; a message starts it at intake.
    case null: return opts.decision !== null ? 'confirm' : 'intake';
    case 'intake': return 'orient';
    case 'orient': return 'planner';
    case 'planner': return opts.hasFindings ? 'compose' : 'control';
    case 'diagnose': case 'analyse': case 'simulate': return 'join';
    case 'join': return 'planner';
    case 'compose': return 'verify';
    case 'confirm': return opts.decision === 'approved' ? 'apply' : opts.decision === 'declined' ? 'declined' : null;
    case 'apply': case 'declined': return 'finish';
    case 'verify': case 'control': case 'plan_check': case 'finish': return null;
  }
}

/** The nodes to light on the diagram. */
export function activeNodes(state: PanelState): Set<string> {
  const live = state.live;
  // Suspended at the interrupt, waiting for a person.
  if (!isRunning(state)) return new Set(state.turn?.pendingPlan ? ['confirm'] : []);
  if (!live?.streaming) return new Set(); // the server says running; this tab is not watching it
  if (live.plan) return new Set(['confirm']); // the interrupt fired; the turn is on its way
  const running = [
    ...live.tasks.filter((t) => t.status === 'running').map((t) => t.specialist),
    ...(Object.keys(live.finishing) as Specialist[]).filter((k) => (live.finishing[k] ?? 0) > 0),
  ];
  // The planner writes its dispatches BEFORE its own step arrives (found by
  // folding a real run): until then it is still finishing, beside the tasks
  // it just sent.
  const planning = live.lastStep === 'orient' || live.lastStep === 'join';
  if (running.length > 0) return new Set(planning ? ['planner', ...running] : running);
  const next = likelyNext(live.lastStep, {
    hasFindings: live.tasks.some((t) => t.specialist !== 'control' && FINISHED.has(t.status)),
    decision: live.decision,
  });
  return new Set(next ? [next] : []);
}

// ================================================================ chips

const VERB: Readonly<Record<Specialist, string>> = {
  diagnose: 'Diagnosing', analyse: 'Analysing', simulate: 'Simulating',
  // It reads zones and the envelope and dry-runs setpoints, in either mode.
  control: 'Dry-running',
};

const PHASE: Readonly<Partial<Record<CopilotNode, string>>> = {
  intake: 'Starting', orient: 'Reading the building', join: 'Planning', planner: 'Planning', compose: 'Composing',
  verify: 'Checking figures', control: 'Dry-running', plan_check: 'Re-checking the plan',
  confirm: 'Recording your decision', apply: 'Issuing',
  declined: 'Setting the plan aside', finish: 'Finishing',
};

const ENDING: Readonly<Record<TaskStatus, string>> = {
  pending: ' · waiting', running: '', done: ' ✓', answered: ' ✓', partial: ' · partial',
  cannot_answer: ' · no answer', failed: ' · failed', refused: ' · refused',
};

export type ChipTone = 'running' | 'done' | 'warn' | 'failed' | 'waiting';

export interface Chip {
  key: string;
  text: string;
  tone: ChipTone;
  /** The planner's goal (verified wording) or the reason a task stopped. */
  title: string | null;
}

const toneOf = (s: TaskStatus): ChipTone => (s === 'running' ? 'running'
  : s === 'done' || s === 'answered' ? 'done'
  : s === 'failed' || s === 'refused' ? 'failed'
  : s === 'pending' ? 'waiting' : 'warn');

/** A socket's view of a run, as `lib/ws.ts` keeps it. */
export interface SocketRun { progressPct: number; status: 'running' | 'completed' | 'failed' }

/**
 * One chip per task, keyed by its id — so a task's inner churn changes its
 * chip's text, never the row — then, while nothing is running as a task,
 * one chip for where the graph is: "Diagnosing ✓ · Analysing ✓ · Simulating
 * 38% · Composing".
 */
export function chips(state: PanelState, socket: ReadonlyMap<string, SocketRun> = new Map()): Chip[] {
  const tasks = state.live?.tasks ?? state.turn?.tasks ?? [];
  const rows = simRows(state, socket, Infinity);
  const out: Chip[] = tasks.map((t) => {
    let text = `${VERB[t.specialist]}${ENDING[t.status]}`;
    if (t.specialist === 'simulate' && t.status === 'running') {
      const mine = rows.filter((r) => r.taskId === t.taskId);
      if (mine.length > 0) text += ` ${Math.floor(mine.reduce((a, r) => a + r.progressPct, 0) / mine.length)}%`;
    }
    return { key: t.taskId, text, tone: toneOf(t.status), title: t.reason ? `${t.goal ?? ''} (${t.reason.replace(/_/g, ' ')})`.trim() : t.goal };
  });
  const lit = activeNodes(state);
  // A running or finishing specialist is its own chip; the phase chip is for the nodes between.
  if (isRunning(state) && state.live?.streaming && ![...lit].some(isSpecialist)) {
    const [node] = [...lit];
    const text = state.live.plan ? 'Awaiting your decision' : (node && PHASE[node as CopilotNode]) ?? 'Working';
    out.push({ key: 'phase', text, tone: 'running', title: null });
  }
  return out;
}

// ============================================================= activity

const NOUN: Readonly<Record<ActivityClass | 'other', [string, string] | null>> = {
  read: ['read', 'reads'], dry_run: ['dry run', 'dry runs'], scratch: ['simulation', 'simulations'],
  propose: ['proposal', 'proposals'], report: null, other: ['other call', 'other calls'],
};

/** "diagnose: 5 reads", per task, with the latest call's label. */
export function activityLines(state: PanelState): Array<{ key: string; text: string; last: string }> {
  const live = state.live;
  if (!live) return [];
  return live.activity.flatMap((a) => {
    const task = live.tasks.find((t) => t.taskId === a.taskId);
    const parts = (Object.keys(NOUN) as Array<keyof typeof NOUN>).flatMap((cls) => {
      const n = a.counts[cls] ?? 0;
      const noun = NOUN[cls];
      return n > 0 && noun ? [`${n} ${n === 1 ? noun[0] : noun[1]}`] : [];
    });
    if (parts.length === 0) return [];
    return [{ key: a.taskId, text: `${task?.specialist ?? a.taskId}: ${parts.join(', ')}`, last: a.last }];
  });
}

// ============================================================ sim rows

export interface SimRow {
  runId: string;
  taskId: string;
  label: string;
  status: SimMeta['status'];
  progressPct: number;
}

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/**
 * Simulation rows: the copilot's `sim` events, each merged with the
 * dashboard socket's report on the same run id — the socket hears the
 * worker's progress as it happens; the copilot polls. A finished status wins
 * over a running one, else the further progress. Running runs first, and at
 * most `limit` (two, in the panel).
 */
export function simRows(state: PanelState, socket: ReadonlyMap<string, SocketRun>, limit = 2): SimRow[] {
  const rows = (state.live?.sims ?? []).map((s): SimRow => {
    const w = socket.get(s.runId);
    let status = s.status;
    let progressPct = s.progressPct;
    if (w && !TERMINAL.has(status)) {
      if (TERMINAL.has(w.status)) { status = w.status; progressPct = w.status === 'completed' ? 100 : progressPct; }
      else progressPct = Math.max(progressPct, w.progressPct);
    }
    return {
      runId: s.runId, taskId: s.taskId, status, progressPct: status === 'completed' ? 100 : progressPct,
      label: s.role === 'baseline' ? 'baseline' : s.scenario,
    };
  });
  const running = rows.filter((r) => !TERMINAL.has(r.status));
  const done = rows.filter((r) => TERMINAL.has(r.status));
  return [...running, ...done].slice(0, limit);
}

/** How many simulation runs the rows leave out. */
export function hiddenSimRuns(state: PanelState, limit = 2): number {
  return Math.max(0, (state.live?.sims.length ?? 0) - limit);
}
