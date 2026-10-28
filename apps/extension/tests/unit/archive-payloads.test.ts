import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { openDB } from 'idb';
import { ArchiveDatabase, type ArchiveEntry } from '../../src/archive/database';
import { partition, type SiteBinding } from '../../src/archive/binding';
const binding: SiteBinding = { siteOrigin: 'https://own.example', siteId: crypto.randomUUID(), ownerId: crypto.randomUUID(), deviceId: crypto.randomUUID(), generation: crypto.randomUUID() };
function entry(): ArchiveEntry { return { id: crypto.randomUUID(), partition: partition(binding), kind: 'link', state: 'retry', linkRequest: { url: 'https://source.example/own', title: 'Own content', translationIntent: 'none' }, resources: [], warnings: [], attempts: 1, nextAttemptAt: 0, createdAt: 1 }; }
it('upgrades a real v1 entry without losing its immutable request or file bytes and lists only bounded headers', async () => {
  const name = `v1-${crypto.randomUUID()}`; const original = entry();
  const old = await openDB(name, 1, { upgrade(db) { db.createObjectStore('entries', { keyPath: ['partition','id'] }).createIndex('partition', 'partition'); db.createObjectStore('files', { keyPath: ['partition','captureId','descriptor.id'] }).createIndex('capture', ['partition','captureId']); } });
  await old.put('entries', original); const file = { partition: original.partition, captureId: original.id, descriptor: { id: 'own', path: 'own.png', role: 'image', mediaType: 'image/png', bytes: 3, sha256: 'a'.repeat(64) }, bytes: new Uint8Array([9,8,7]) }; await old.put('files', file); old.close();
  const db = new ArchiveDatabase(name); expect(await db.get(binding, original.id)).toMatchObject(original); expect(Array.from((await db.files(binding, original.id))[0].bytes)).toEqual([9,8,7]);
  const headers = await db.list(binding); expect(headers[0]).not.toHaveProperty('linkRequest'); expect(headers[0]).not.toHaveProperty('resources');
  expect(headers[0]).toMatchObject({ id: original.id, title: 'Own content' });
});
it('limits polling to 50 headers within the selected owner partition', async () => {
  const db = new ArchiveDatabase(`bounded-${crypto.randomUUID()}`);
  for (let i = 0; i < 53; i++) await db.put(binding, entry());
  expect(await db.list(binding)).toHaveLength(50);
  expect(await db.list({ ...binding, ownerId: crypto.randomUUID() })).toEqual([]);
});

it.each(['readerVersionId', 'saveStatus', 'missingFileIds', 'receivedFileIds', 'warnings', 'identity', 'binding'])('retains payload for a malformed completed receipt (%s)', async field => {
  const db = new ArchiveDatabase(`invalid-proof-${crypto.randomUUID()}`); const original = entry(); original.kind = 'capture'; original.state = 'completed'; original.completedBinding = binding; original.ingestionId = crypto.randomUUID();
  original.result = { id: original.ingestionId, captureId: original.id, status: 'completed', receivedFileIds: [], missingFileIds: [], documentId: crypto.randomUUID(), sourceVersionId: crypto.randomUUID(), readerVersionId: crypto.randomUUID(), jobId: null, saveStatus: 'original-saved', errorCode: null, warnings: [], createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z' };
  if (field === 'readerVersionId') original.result.readerVersionId = null;
  if (field === 'saveStatus') original.result.saveStatus = null;
  if (field === 'missingFileIds') original.result.missingFileIds = ['html'];
  if (field === 'receivedFileIds') original.result.receivedFileIds = ['x'.repeat(241)];
  if (field === 'warnings') original.result.warnings = [...Array.from({ length: 20 }, () => 'valid'), ''];
  if (field === 'identity') original.result.documentId = 'invalid-uuid';
  if (field === 'binding') original.completedBinding = { ...binding, generation: 'invalid-generation' };
  await db.put(binding, original);
  const accepted = await db.compactCompletedEntry(field === 'binding' ? original.completedBinding! : binding, original.id);
  expect(accepted).toBe(false); expect((await db.get(binding, original.id))?.linkRequest).toEqual(original.linkRequest);
});

it('retains a malformed link ACK rather than compacting a truthy document identity', async () => {
  const db = new ArchiveDatabase(`invalid-link-${crypto.randomUUID()}`); const original = entry(); original.state = 'completed'; original.completedBinding = binding; original.linkResult = { documentId: 'not-a-uuid', jobId: null };
  await db.put(binding, original); expect(await db.compactCompletedEntry(binding, original.id)).toBe(false); expect((await db.get(binding, original.id))?.linkRequest).toEqual(original.linkRequest);
});

it('migrates an old capture request byte-for-byte without adding omitted save hints or replacing its UUID', async () => {
  const original = entry(); const html = '<article data-pl-node-id="n1">Own original.</article>';
  const metadata = { title: 'Own content', author: null, publishedAt: null, capturedAt: '2026-10-28T00:00:00.000Z' };
  const scope = { kind: 'article' as const, rootNodeId: 'n1', completeWithinScope: true, warnings: [] };
  original.kind = 'capture'; delete original.linkRequest;
  original.draft = { captureId: original.id, snapshot: { html, sourceUrl: 'https://source.example/own', scope, nodeIds: ['n1'], resources: [], warnings: [] }, metadata, canonicalUrl: null, kind: 'article', pendingResources: [], existingTranslation: null };
  original.request = { translationIntent: 'none', manifest: { schemaVersion: 'web-capture/1', captureId: original.id, source: { url: 'https://source.example/own', canonicalUrl: null, kind: 'article', method: 'extension' }, metadata, scope, htmlFileId: 'html', files: [{ id: 'html', path: 'source.html', bytes: new TextEncoder().encode(html).length, sha256: 'a'.repeat(64), mediaType: 'text/html', role: 'html' }], resources: [], stylesheetFileIds: [], snapshots: { previews: [], nodeLocations: {} }, existingTranslation: null } };
  const encoded = JSON.stringify(original.request); const name = `old-request-${crypto.randomUUID()}`;
  const old = await openDB(name, 1, { upgrade(db) { db.createObjectStore('entries', { keyPath: ['partition','id'] }).createIndex('partition', 'partition'); db.createObjectStore('files', { keyPath: ['partition','captureId','descriptor.id'] }).createIndex('capture', ['partition','captureId']); } });
  await old.put('entries', original); old.close();
  const db = new ArchiveDatabase(name); const migrated = (await db.get(binding, original.id))!;
  expect(JSON.stringify(migrated.request)).toBe(encoded); expect(migrated.draft).toEqual(original.draft); expect(migrated.id).toBe(original.id); expect(migrated).not.toHaveProperty('translationIntent');
});
