import type { KeyedLimiter } from '@dtwin/types';
import type { TwinReader } from '../deps.ts';
import { resolveLimits, type Limits } from '../limits.ts';
import { RunRegistry } from '../registry.ts';
import {
  evidenceAllocator, makeSimLimiter, runSpecialistTools, toolRun, type SimEventPayload, type SpecialistRole,
  type ToolCall, type ToolContext, type ToolOrient, type ToolTask, type ToolTurnResult,
} from '../tools/index.ts';
import type { SpecialistToolResult } from '../tools/index.ts';
import { fakeDeps, orientFixture, type FakeDeps, type FakeScenarioMode, type Script } from './fakes.ts';

/**
 * A tool runner for tests: the tools exactly as the specialist `tools` node
 * runs them, against the fakes, with a real `RunRegistry` holding one open
 * request — and nothing of the graph around them.
 *
 * Excluded from the source scan (§10): nothing here is production code.
 */

export interface ToolHarnessOptions {
  scenarios?: FakeScenarioMode | null;
  reader?: Partial<TwinReader>;
  limits?: Partial<Limits>;
  settingsThrows?: boolean;
  /** Per-person run limiter; a fresh one on the fake clock by default. */
  simLimiter?: KeyedLimiter;
  taskId?: string;
  inputEvidenceIds?: string[];
  mode?: 'propose' | 'check';
  orient?: Partial<ToolOrient>;
  script?: Script;
  /** Called on every sleep, after the fake clock has advanced (e.g. to press Stop mid-poll). */
  onSleep?: (ms: number) => void | Promise<void>;
}

export interface ToolHarness {
  fake: FakeDeps;
  registry: RunRegistry;
  threadId: string;
  ctx: ToolContext;
  task: ToolTask;
  events: SimEventPayload[];
  logs: Array<{ event: string; fields: Record<string, unknown> }>;
  /** One call, as its own turn. Accepted evidence is added to the task's produced ids. */
  call(role: SpecialistRole, name: string, input: unknown): Promise<SpecialistToolResult>;
  /** One model turn's calls. */
  turn(role: SpecialistRole, calls: ToolCall[]): Promise<ToolTurnResult>;
  /** Close this request and open the next one on the same thread (a new budget, the same limiter). */
  nextRequest(): void;
}

export function toolHarness(opts: ToolHarnessOptions = {}): ToolHarness {
  const fake = fakeDeps({
    scenarios: opts.scenarios ?? null,
    ...(opts.reader ? { reader: opts.reader } : {}),
    ...(opts.limits ? { limits: opts.limits } : {}),
    ...(opts.settingsThrows ? { settingsThrows: true } : {}),
    ...(opts.script ? { script: opts.script } : {}),
    ...(opts.onSleep ? { onSleep: opts.onSleep } : {}),
  });
  const now = () => fake.clock.now();
  const limits = resolveLimits(opts.limits);
  const registry = new RunRegistry({ limits: opts.limits ?? {}, clock: now });
  const threadId = 'thread-1';
  let requestSeq = 1;
  registry.begin(threadId, `request-${requestSeq}`);

  const snapshot = orientFixture(now());
  const orient: ToolOrient = {
    building: { id: snapshot.building!.id, name: snapshot.building!.name, timezone: snapshot.building!.timezone },
    directory: snapshot.directory,
    availability: { forecastWeather: false },
    envelope: fake.probe.settings,
    sim: { available: fake.deps.scenarios !== null },
    ...opts.orient,
  };

  const task: ToolTask = {
    taskId: opts.taskId ?? 'T1',
    inputEvidenceIds: opts.inputEvidenceIds ?? [],
    producedEvidenceIds: [],
    mode: opts.mode,
  };
  const produced: string[] = [];
  task.producedEvidenceIds = produced;
  const allocator = evidenceAllocator({ taskId: task.taskId, after: 0, claim: () => registry.claimEvidence(threadId) });

  const events: SimEventPayload[] = [];
  const logs: ToolHarness['logs'] = [];
  const ctx: ToolContext = {
    deps: { reader: fake.deps.reader, probe: fake.deps.probe, scenarios: fake.deps.scenarios },
    orient,
    identity: fake.deps.identity,
    requestId: `request-${requestSeq}`,
    run: toolRun(registry, threadId),
    limits,
    now,
    sleep: fake.deps.sleep!,
    allocateEvidenceId: allocator.next,
    simLimiter: opts.simLimiter ?? makeSimLimiter({ runsPerHour: limits.simRunsPerUserPerHour, now }),
    emit: (e) => events.push(e),
    log: (event, fields) => logs.push({ event, fields }),
  };

  const turn = async (role: SpecialistRole, calls: ToolCall[]) => {
    const r = await runSpecialistTools({ role, task, ctx, calls });
    for (const e of r.evidence) produced.push(e.id);
    return r;
  };
  return {
    fake, registry, threadId, ctx, task, events, logs,
    turn,
    call: async (role, name, input) => (await turn(role, [{ id: 'call', name, input }])).results[0]!,
    nextRequest: () => {
      registry.end(threadId);
      requestSeq += 1;
      ctx.requestId = `request-${requestSeq}`;
      registry.begin(threadId, ctx.requestId);
    },
  };
}
