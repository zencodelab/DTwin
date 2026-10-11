import type {
  ControlProbe, GraphDeps, Issuer, ReaderMethod, TwinReader,
} from './deps.ts';
import { TWIN_READER_METHODS } from './deps.ts';

/**
 * Dependencies for a graph that is built to be DRAWN, never run: the
 * `/api/copilot/graph` route, `scripts/copilot-graph.ts` and the structure
 * tests (§6). The graph's shape depends on none of these, so each one refuses
 * — a rejected promise naming what was asked for — rather than answering with
 * an empty building or a disabled envelope that would read as a real, if
 * dull, answer if anything ever did invoke it.
 *
 * No I/O: nothing here imports the database or reads the environment.
 * `scenarios` is null, which is also how a real deployment without
 * COPILOT_SIM_API_KEY looks.
 */

export class InertDepsError extends Error {
  constructor(what: string) {
    super(`inert copilot dependencies: ${what} is not available — this graph is built to be drawn, not run`);
    this.name = 'InertDepsError';
  }
}

const NIL_ID = '00000000-0000-0000-0000-000000000000';

export function inertDeps(): GraphDeps {
  const refuse = (what: string) => () => Promise.reject(new InertDepsError(what));

  const reader = Object.fromEntries(
    TWIN_READER_METHODS.map((m: ReaderMethod) => [m, refuse(`reader.${m}`)]),
  ) as unknown as TwinReader;
  const probe: ControlProbe = { settings: refuse('probe.settings'), dryRun: refuse('probe.dryRun') };
  const issuer: Issuer = { issue: refuse('issuer.issue') };

  return {
    reader,
    probe,
    issuer,
    scenarios: null,
    callModel: refuse('the model'),
    models: { lead: 'none', specialist: 'none' },
    identity: { tenantId: NIL_ID, userId: NIL_ID },
  };
}
