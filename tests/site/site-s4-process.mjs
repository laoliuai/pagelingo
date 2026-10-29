// Explicit disposable acceptance process; no dotenv or ambient provider configuration.
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { openDatabase } from '../../apps/document-service/src/db/database.ts';
import { createApp } from '../../apps/document-service/src/app.ts';
import { readConfig } from '../../apps/document-service/src/config.ts';
import { createLocalObjectStore } from '../../apps/document-service/src/storage/local-object-store.ts';
import { claimWebJob, reconcileWebJobs } from '../../apps/document-service/src/web-jobs/lease.ts';
import { runWebJob } from '../../apps/document-service/src/web-jobs/translation-runner.ts';
import { runDocumentMaintenance } from '../../apps/document-service/src/document-lifecycle/maintenance.ts';
import { runMetadataBackfill } from '../../apps/document-service/src/document-management/metadata-projection.ts';
import { verifiedInput } from '../../scripts/site-s4-inputs.mjs';
const [mode, configPath, planPath, sampleId] = process.argv.slice(2);
const env = JSON.parse(await readFile(configPath, 'utf8')), config = readConfig(env);
const db = openDatabase(config.databaseUrl), local = createLocalObjectStore(config.dataDir);
const controller = new AbortController();
const send = value => process.send?.({ ...value, pid: process.pid });
let app;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { controller.abort(); if (app) void app.close(); });
const hold = async value => { send({ type: 'held', ...value }); await new Promise(() => {}); };
let reads = 0;
const store = {
  ...local,
  async *read(key, range) {
    if (mode === 'hold-export') await hold({ boundary: 'durable-export-before-publication', key });
    yield* local.read(key, range);
  },
  async deleteUnreferenced(key) {
    await local.deleteUnreferenced(key);
    if (mode === 'hold-purge' && ++reads === 1) await hold({ boundary: 'physical-delete-before-queue-ack', key });
  },
};
try {
  if (mode === 'api') {
    app = await createApp({ db, config, outboundFetch: async () => { send({ type: 'unexpected-model' }); throw new Error('No model requests authorized'); } });
    const origin = await app.listen({ host: '127.0.0.1', port: config.port }); send({ type: 'ready', origin });
    await new Promise(resolve => app.server.once('close', resolve));
  } else if (mode === 'maintenance' || mode === 'hold-purge') {
    send({ type: 'result', result: await runDocumentMaintenance({ db, store, dataDir: config.dataDir, signal: controller.signal }) });
  } else if (mode === 'backfill') {
    send({ type: 'result', result: await runMetadataBackfill({ db, store, signal: controller.signal }, { limit: 100 }) });
  } else {
    const plan = JSON.parse(await readFile(planPath, 'utf8')), sample = plan.samples.find(s => s.id === sampleId);
    const available = sample ? [{ ...sample, input: sample.input, url: sample.responseUrl ?? sample.url, mediaType: sample.mediaType ?? 'application/json', accept: sample.accept }, ...sample.resources] : [];
    async function response(url, accept) {
      const entry = available.find(item => item.url === url && (!item.accept || item.accept === accept));
      if (mode === 'hold-acquisition' && reads++ === 1) await hold({ boundary: 'first-acquisition-committed-before-next-response', url });
      send({ type: 'source-read', url, accept, declared: !!entry });
      if (!entry) return new Response('Undeclared source resource', { status: 404 });
      const body = Readable.toWeb(Readable.from(verifiedInput(entry.input)));
      return new Response(body, { status: 200, headers: { 'content-type': entry.mediaType } });
    }
    const sourceTransport = {
      readSmall: (url, input) => response(url, input.accept),
      downloadPdf: async (url, input, consume) => { const r = await response(url, 'application/pdf'); return consume(r.body, { status: r.status, url, headers: r.headers }); },
      downloadResource: async (url, input, consume) => { const r = await response(url, input.accept); return consume(r.body, { status: r.status, url, headers: r.headers }); },
    };
    await reconcileWebJobs(db);
    const lease = await claimWebJob(`s4-${process.pid}`, db); send({ type: 'lease', lease });
    if (lease) await runWebJob(lease, { db, store, config, signal: controller.signal, sourceTransport,
      captureFetch: async url => response(url, 'text/html'),
      provider: { generate: async () => { send({ type: 'unexpected-model' }); throw new Error('No model calls authorized'); } },
    });
    send({ type: 'result' });
  }
} catch (error) { console.error(error.stack); process.exitCode = 1; }
finally { await app?.close(); await db.close(); process.disconnect?.(); }
