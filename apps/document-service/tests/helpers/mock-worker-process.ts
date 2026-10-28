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
    captureFetch: async (input, init) => {
      const url = new URL(String(input));
      if (process.env.TEST_WORKER_LINK_FIXTURES !== '1' || url.origin !== 'https://site-link-fixture.example') throw new Error('No external fetch in mock worker');
      if (Number(process.env.TEST_WORKER_FETCH_DELAY ?? 0)) {
        process.send?.({ type: 'fetch-request', pid: process.pid });
        try { await sleep(Number(process.env.TEST_WORKER_FETCH_DELAY), undefined, { signal: init?.signal ?? undefined }); }
        catch (error) { process.send?.({ type: 'fetch-aborted', pid: process.pid }); throw error; }
      }
      const paragraph = url.pathname === '/zh'
        ? '这是已保存的中文原文。读者可以离线阅读文章，保留来源和阅读位置，无需调用模型翻译。本文介绍如何归档资料并在不同设备上继续阅读。'
        : 'The reader can save this original article and read the source. The software system has several useful features and the following documentation explains how the application works.';
      return new Response(`<html><title>Saved article</title><article><h1>Saved article</h1>${`<p>${paragraph}</p>`.repeat(8)}</article></html>`, { headers: { 'content-type': 'text/html' } });
    } });
} finally { await db.close(); if (process.connected) process.disconnect?.(); }
