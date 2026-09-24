/**
 * Record one REAL copilot run, node by node, for the explainer video.
 *
 * Same graph, same model, same backend as the web route — bound to one real
 * user, so every dry run and the final issue carry that person's
 * `x-acting-user` exactly as a click would. The only additions are two
 * wrappers that note what happened and when; neither changes what is sent.
 *
 *   npx tsx --tsconfig apps/web/tsconfig.json video/capture.ts \
 *     <tenantId> <userId> "<operator request>" [approved|declined]
 *
 * Writes video/run.json. Approving issues real, EXPIRING overrides to the
 * tenant it is pointed at — point it at a development database only.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from '@langchain/langgraph';
import {
  buildCopilotGraph, realModelCaller, resolveModel, type ModelCaller,
} from '../apps/web/lib/copilot/graph.ts';
import { realBackend, type CopilotBackend } from '../apps/web/lib/copilot/backend.ts';

const [tenantId, userId, request, decision = 'approved'] = process.argv.slice(2);
if (!tenantId || !userId || !request) {
  console.error('usage: capture.ts <tenantId> <userId> "<request>" [approved|declined]');
  process.exit(2);
}

const t0 = Date.now();
const at = () => Date.now() - t0;
const events: Array<Record<string, unknown>> = [];

const real = realModelCaller();
const callModel: ModelCaller = async (params) => {
  const started = at();
  const res = await real(params);
  events.push({ kind: 'model', started, ended: at(), stopReason: res.stop_reason,
    usage: res.usage });
  return res;
};

const inner = realBackend(tenantId, userId);
const backend: CopilotBackend = {
  listZones: async () => { const r = await inner.listZones(); events.push({ kind: 'backend', verb: 'listZones', t: at(), n: r.length }); return r; },
  settings: async () => { const r = await inner.settings(); events.push({ kind: 'backend', verb: 'settings', t: at(), result: r }); return r; },
  dryRun: async (c) => { const r = await inner.dryRun(c); events.push({ kind: 'backend', verb: 'dryRun', t: at(), command: c, result: r }); return r; },
  issue: async (c) => { const r = await inner.issue(c); events.push({ kind: 'backend', verb: 'issue', t: at(), command: c, result: r }); return r; },
};

const model = resolveModel();
const graph = buildCopilotGraph({ backend, callModel, model });
const config = { configurable: { thread_id: `video-${t0}` }, recursionLimit: 60 };

async function drain(stream: AsyncIterable<Record<string, unknown>>, phase: string) {
  for await (const chunk of stream) {
    for (const [node, update] of Object.entries(chunk)) {
      events.push({ kind: 'node', phase, node, t: at(), update });
      console.log(`${String(at()).padStart(6)} ms  ${phase.padEnd(8)} ${node}`);
    }
  }
}

(async () => {
  await drain(await graph.stream(
    { messages: [{ role: 'user', content: request }] }, { ...config, streamMode: 'updates' },
  ) as AsyncIterable<Record<string, unknown>>, 'propose');

  const suspended = at();
  await drain(await graph.stream(
    new Command({ resume: decision }), { ...config, streamMode: 'updates' },
  ) as AsyncIterable<Record<string, unknown>>, 'resume');

  const final = await graph.getState(config);
  writeFileSync(join(process.cwd(), 'video', 'run.json'), JSON.stringify({
    capturedAt: new Date(t0).toISOString(), model, request, decision, suspendedAtMs: suspended,
    events, messages: final.values.messages,
  }, null, 2));
  console.log(`done in ${at()} ms — wrote video/run.json`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
