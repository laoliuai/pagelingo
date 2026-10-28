/// <reference types="chrome" />
import 'fake-indexeddb/auto';
import type { CreateWebCaptureRequest, WebCaptureResult } from '@pagelingo/document-contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { sanitizeNodeSnapshot } from '@pagelingo/web-capture/node';
import { bootstrapAdmin } from '../../src/cli/bootstrap-admin.js';
import { createServiceTestApp } from '../helpers/app.js';
import { login } from '../helpers/session.js';
import { ArchiveDatabase } from '../../../extension/src/archive/database.js';
import { createArchiveOutbox } from '../../../extension/src/archive/outbox.js';
import { exchangeSite, createArchiveClient } from '../../../extension/src/archive/client.js';
import { storeConnection, readConnection } from '../../../extension/src/archive/binding.js';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const close of closes.splice(0)) await close(); });
it('real extension client pairs, saves Chinese source, and replays one durable document without models', async () => {
  let modelCalls = 0;
  const test = await createServiceTestApp({ outboundFetch: async () => { modelCalls++; throw new Error('No models allowed'); } }); closes.push(test.close);
  await bootstrapAdmin(test.db, { username: 'admin', password: 'correct password 123456' });
  const session = await login(test.app, 'admin', 'correct password 123456');
  const code = await test.app.inject({ method: 'POST', url: '/api/v1/devices/pairing-codes', headers: { cookie: session.cookie, origin: test.config.publicOrigin, 'x-csrf-token': session.csrfToken }, payload: {} });
  expect(code.statusCode, code.body).toBe(201);
  const origin = await test.app.listen({ host: '127.0.0.1', port: 0 });
  const storage: Record<string, unknown> = {};
  vi.stubGlobal('chrome', { runtime: { id: 'extension-protocol-test', getManifest: () => ({ version: '0.4.5' }) }, permissions: { contains: async () => true }, storage: { local: { setAccessLevel: async () => {}, get: async (key: string) => ({ [key]: storage[key] }), set: async (value: object) => Object.assign(storage, value) } } });
  const exchanged = await exchangeSite(origin, code.json().code); const connection = await storeConnection(origin, exchanged);
  const database = new ArchiveDatabase(`protocol-${crypto.randomUUID()}`);
  let submitted: CreateWebCaptureRequest | undefined; let completedAck: WebCaptureResult | undefined;
  const outbox = createArchiveOutbox({ database, current: async () => (await readConnection())?.binding ?? null, client: (binding,signal) => {
    const client=createArchiveClient(binding,signal);
    return {...client, async create(input,key) { submitted=structuredClone(input); return client.create(input,key); },
      async commit(id) { const result=await client.commit(id); completedAck=structuredClone(result); return result; } };
  }, acquire: async () => { throw new Error('No resources in source'); } });
  const snapshot = sanitizeNodeSnapshot({ html: '<article><h1>中文资料</h1><p>这是无需翻译的中文原文，直接保存和阅读，不调用模型。</p></article>', url: 'https://example.com/chinese', scope: { kind: 'article', rootNodeId: 'root', completeWithinScope: true, warnings: [] } });
  const captureId = crypto.randomUUID();
  await outbox.enqueueCapture(connection.binding, { captureId, snapshot, metadata: { title: '中文资料', author: null, publishedAt: null, capturedAt: new Date().toISOString() }, canonicalUrl: null, kind: 'article', pendingResources: [], existingTranslation: null });
  await outbox.resumeOutbox(connection.binding);
  const entry = await database.get(connection.binding, captureId);
  expect(entry?.state, JSON.stringify({ state: entry?.state, error: entry?.error })).toBe('completed');
  expect(entry?.result).toMatchObject({ captureId, saveStatus: 'original-saved', status: 'completed' });
  const client = createArchiveClient(connection.binding, new AbortController().signal);
  expect(entry!.request).toBeUndefined(); expect(await database.files(connection.binding,captureId)).toEqual([]);
  expect(submitted).toBeDefined(); expect(completedAck?.status).toBe('completed');
  expect(await client.create(submitted!, captureId)).toEqual(completedAck);
  expect(await client.status(entry!.ingestionId!)).toEqual(completedAck);
  expect((await test.db.pool.query('SELECT id FROM documents')).rows).toHaveLength(1);
  expect((await test.db.pool.query('SELECT id FROM source_versions')).rows).toHaveLength(1);
  expect((await test.db.pool.query('SELECT id FROM web_jobs')).rows).toHaveLength(0);
  expect(modelCalls).toBe(0);
});
