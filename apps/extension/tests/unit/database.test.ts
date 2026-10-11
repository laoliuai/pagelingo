// @vitest-environment node
import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { openDB } from 'idb';
import { makeCacheEntry, CheckpointConflictError } from '@pagelingo/translation-core';
import * as storage from '../../src/background/database';
import { defaultSettings } from '../../src/settings/schema';

function create(bytes = 100000) {
  expect(typeof storage.TranslationDatabase).toBe('function');
  return new storage.TranslationDatabase({ name: `test-${crypto.randomUUID()}`, maxBytes: bytes });
}
const job = () => ({ id: crypto.randomUUID(), tabId: 1, status: 'running' as const, epoch: 1, configSignature: 'config',
  settings: { ...defaultSettings, apiKey: undefined }, createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 30000 });

it('persists cached entries, documents and jobs across adapters with real IDB transactions', async () => {
  const db = create(); const entry = makeCacheEntry('key', '译文'); const record = job();
  await db.putJob(record); await db.putMany([entry]);
  await db.putDocument({ key: 'url', fingerprint: 'hash', updatedAt: Date.now(), total: 1 });
  const again = new storage.TranslationDatabase({ name: db.name });
  expect((await again.get('key'))?.text).toBe('译文');
  expect((await again.getJob(record.id))?.epoch).toBe(1);
  expect(await again.stats()).toMatchObject({ translations: 1, documents: 1, jobs: 1 });
  await again.close(); await db.close();
});

it('fences a cancelled or claimed job and atomically saves checkpoint plus cache', async () => {
  const db = create(); const record = job(); await db.putJob(record);
  const state = db.stateStore(record.id, 1);
  const checkpoint = { version: 1 as const, fingerprint: 'f', units: [], blocks: {},
    metrics: { requests: 1, retries: 0, cacheHits: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, usageRequests: 0, startedAt: Date.now(), elapsedMs: 0 } };
  await state.save(checkpoint, [makeCacheEntry('complete', '结果')]);
  expect((await state.load())?.metrics.requests).toBe(1);
  await db.cancelJob(record.id);
  await expect(state.save(checkpoint, [makeCacheEntry('late', '迟到')])).rejects.toBeInstanceOf(CheckpointConflictError);
  expect(await db.get('late')).toBeUndefined();
  expect((await db.get('complete'))?.text).toBe('结果'); await db.close();
});

it('evicts by application budget and clears cache without deleting running job checkpoints', async () => {
  const db = create(550); const record = job(); await db.putJob(record);
  await db.putMany([makeCacheEntry('old', 'one')]);
  await new Promise((r) => setTimeout(r, 5)); await db.putMany([makeCacheEntry('new', 'two')]);
  // Each entry reserves 256 bytes of metadata, plus actual encoded text.
  await db.putMany([makeCacheEntry('third', 'three')]);
  expect((await db.stats()).bytes).toBeLessThanOrEqual(550);
  expect(await db.get('old')).toBeUndefined();
  await db.putDocument({ key: 'url', fingerprint: 'f', updatedAt: Date.now(), total: 1 });
  await db.clear('translations'); expect((await db.stats()).documents).toBe(1);
  await db.clear('all'); expect(await db.stats()).toMatchObject({ translations: 0, documents: 0, jobs: 1 });
  await db.close();
});

it('degrades quota failures to a visible memory fallback instead of dropping valid results', async () => {
  const db = create(); await db.putMany([makeCacheEntry('open', 'ok')]);
  const backing = await openDB(db.name);
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function () { throw new DOMException('quota', 'QuotaExceededError'); };
  try {
    await db.putMany([makeCacheEntry('quota', '可显示')]);
    expect((await db.get('quota'))?.text).toBe('可显示');
    expect((await db.stats()).warning).toBeTruthy();
  } finally { IDBObjectStore.prototype.put = original; backing.close(); await db.close(); }
});

it('adds missing stores during migration and ignores old invalid cache records', async () => {
  const db = create(); const legacy = await openDB(db.name, 0 + 1, { upgrade(d) { d.createObjectStore('translations', { keyPath: 'key' }); } });
  await legacy.put('translations', { key: 'bad', schemaVersion: 0, text: 'unsafe' }); legacy.close();
  const current = new storage.TranslationDatabase({ name: db.name });
  expect(await current.get('bad')).toBeUndefined();
  expect(await current.stats()).toMatchObject({ documents: 0, jobs: 0 }); await current.close();
});

it('clears completed job results with all cache but retains running recovery checkpoints', async () => {
  const db = create(); const running = job(); const completed = { ...job(), status: 'completed' as const };
  await db.putJob(running); await db.putJob(completed);
  await db.clear('all');
  expect(await db.getJob(completed.id)).toBeUndefined();
  expect((await db.getJob(running.id))?.status).toBe('running'); await db.close();
});

it('prunes expired grants and document metadata while retaining a paused resumable job', async () => {
  const db = create(); const expired = { ...job(), status: 'granted' as const, expiresAt: Date.now() - 1 };
  const paused = { ...job(), status: 'paused' as const };
  await db.putJob(expired); await db.putJob(paused);
  await db.putDocument({ key: 'expired-doc', fingerprint: 'f', total: 1, updatedAt: Date.now() - 31 * 86400000 });
  await db.putMany([makeCacheEntry('trigger', 'text')]);
  expect(await db.getJob(expired.id)).toBeUndefined();
  expect((await db.getJob(paused.id))?.status).toBe('paused');
  expect((await db.stats()).documents).toBe(0); await db.close();
});

it('clears persistent data after quota degradation and reports persistent clear failure truthfully', async () => {
  const db = create(); const completed = { ...job(), status: 'completed' as const };
  await db.putMany([makeCacheEntry('persisted', 'original')]); await db.putJob(completed);
  await db.putDocument({ key: 'persisted-document', fingerprint: 'f', total: 1, updatedAt: Date.now() });
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function () { throw new DOMException('quota', 'QuotaExceededError'); };
  try { await db.putMany([makeCacheEntry('failed-write', 'temporary')]); } finally { IDBObjectStore.prototype.put = put; }
  const clear = IDBObjectStore.prototype.clear;
  IDBObjectStore.prototype.clear = function () { throw new DOMException('blocked', 'UnknownError'); };
  try { await expect(db.clear('all')).rejects.toThrow(); } finally { IDBObjectStore.prototype.clear = clear; }
  await db.clear('all');
  const reopened = new storage.TranslationDatabase({ name: db.name });
  expect(await reopened.get('persisted')).toBeUndefined(); expect(await reopened.getJob(completed.id)).toBeUndefined();
  expect((await reopened.stats()).documents).toBe(0); await reopened.close(); await db.close();
});
