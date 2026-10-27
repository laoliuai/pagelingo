import { setTimeout as sleep } from 'node:timers/promises';
import { ProviderError, type TranslationProvider } from '@pagelingo/translation-core';
import { openDatabase } from '../../src/db/database.js';
import { readConfig } from '../../src/config.js';
import { createLocalObjectStore } from '../../src/storage/local-object-store.js';
import { runWorker } from '../../src/worker/main.js';
const config = readConfig(process.env);
if (config.mode !== 'test') throw new Error('Mock worker is test-only');
const db = openDatabase(config.databaseUrl, process.argv[2] || undefined);
const controller = new AbortController();
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, () => controller.abort());
let calls = 0;
let holdPublication = false;
const releases = new Set<() => void>();
if (process.env.TEST_WORKER_PUBLICATION_CONTROL === '1') process.on('message', (message: { type?: string; hold?: boolean }) => {
  if (message.type !== 'publication-control') return;
  holdPublication = message.hold === true;
  if (!holdPublication) { for (const release of releases) release(); releases.clear(); }
  process.send?.({ type: 'publication-control-ack', hold: holdPublication });
});
const provider: TranslationProvider = {
  async generate(request, signal) { return (await this.generateDetailed!(request,signal)).output; },
  async generateDetailed(request, signal) {
    calls++;
    process.send?.({ type: 'request', documentId: request.data.document.id, units: request.data.blocks.map(b => b.id), pid: process.pid });
    if (process.env.TEST_WORKER_429 === '1' && calls === 1) throw new ProviderError('http','Mock rate limit',429,2500);
    try { await sleep(Number(process.env.TEST_WORKER_DELAY ?? 0),undefined,{signal}); }
    catch (error) { process.send?.({ type: 'aborted', pid: process.pid }); throw error; }
    return { output: { translations: request.data.blocks.map(b => ({ id: b.id, text: b.protectedText })) }, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
  },
};
const baseStore=createLocalObjectStore(config.dataDir);
const store={...baseStore,async putImmutable(...args:Parameters<typeof baseStore.putImmutable>) {
  const stored=await baseStore.putImmutable(...args);
  if (holdPublication) { process.send?.({ type: 'publication-held' }); await new Promise<void>(resolve => { releases.add(resolve); controller.signal.addEventListener('abort', () => { releases.delete(resolve); resolve(); }, { once: true }); }); }
  if(process.env.TEST_WORKER_HOLD_PUBLICATION === '1') { process.send?.({type:'publication',pid:process.pid}); await sleep(86400000,undefined,{signal:controller.signal}); }
  return stored;
}};
try {
  await runWorker({ db, config, store, signal: controller.signal, provider,
    captureFetch: async () => { throw new Error('No external fetch in mock worker'); } });
} finally { await db.close(); }
