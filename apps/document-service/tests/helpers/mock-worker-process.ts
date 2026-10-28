import { setTimeout as sleep } from 'node:timers/promises';
import { ProviderError, type TranslationProvider } from '@pagelingo/translation-core';
import { openDatabase } from '../../src/db/database.js';
import { readConfig } from '../../src/config.js';
import { createLocalObjectStore } from '../../src/storage/local-object-store.js';
import { runWorker } from '../../src/worker/main.js';
import { arxivTransport, atom } from './arxiv-fixture.js';
import { fixtureTransport, githubFixture } from './github-fixture.js';
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
const arxiv = arxivTransport({ feed: atom('2401.12345', Number(process.env.TEST_WORKER_ARXIV_LATEST ?? 1)) });
const configuredSourceTransport = process.env.TEST_WORKER_ARXIV_FIXTURES === '1' ? { ...arxiv,
  readSmall(...args: Parameters<typeof arxiv.readSmall>) { process.send?.({ type: 'source-request', pid: process.pid, url: args[0] }); return arxiv.readSmall(...args); },
  async downloadPdf<T>(...args: Parameters<typeof arxiv.downloadPdf<T>>) {
    process.send?.({ type: 'source-request', pid: process.pid, url: args[0] });
    const result = await arxiv.downloadPdf<T>(...args);
    if (process.env.TEST_WORKER_ARXIV_HOLD_PDF === '1') { process.send?.({ type: 'pdf-acquired', pid: process.pid }); await sleep(86400000, undefined, { signal: controller.signal }); }
    return result;
  },
} : fixtureTransport(process.env.TEST_WORKER_GITHUB_FIXTURES === '1' ? githubFixture() : {});
let sourceVersion = 1;
let sourcePdf: Uint8Array | undefined;
if (process.env.TEST_WORKER_SOURCE_FIXTURES === '1') process.on('message', (message: { type?: string; version?: number; pdf?: string }) => {
  if (message.type !== 'source-fixture') return;
  sourceVersion = message.version ?? 1;
  sourcePdf = message.pdf ? Buffer.from(message.pdf, 'base64') : undefined;
  process.send?.({ type: 'source-fixture-ack' });
});
const fixtures = githubFixture();
for (const alias of ['Renamed', 'Edited']) fixtures[`https://api.github.com/repos/${alias}/Repo`] = fixtures['https://api.github.com/repos/Org/Repo']!;
const github = fixtureTransport(fixtures);
const paper = () => arxivTransport({ version: sourceVersion, pdf: sourcePdf });
const sourceTransport = process.env.TEST_WORKER_SOURCE_FIXTURES === '1' ? {
  readSmall: (url: string, input: Parameters<typeof github.readSmall>[1]) => url.startsWith('https://export.arxiv.org/') ? paper().readSmall(url, input) : github.readSmall(url, input),
  downloadPdf<T>(...args: Parameters<typeof arxiv.downloadPdf<T>>) { return paper().downloadPdf<T>(...args); },
  downloadResource: github.downloadResource,
} : configuredSourceTransport;
try {
  await runWorker({ db, config, store, signal: controller.signal, provider,
    sourceTransport,
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
