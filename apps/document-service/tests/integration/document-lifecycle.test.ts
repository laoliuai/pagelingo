import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { readerTestApp, headers } from '../helpers/readers.js';
import { jobFixture, eventually } from '../helpers/web-jobs.js';
import { startWorker } from '../helpers/worker-process.js';
import { createDocumentsService } from '../../src/documents/service.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it('rejects a deleted document without a purge deadline', async () => {
  const t = await readerTestApp(cleanup); const f = await t.ingest();
  await expect(t.db.pool.query('UPDATE documents SET deleted_at=clock_timestamp() WHERE id=$1', [f.imported.documentId])).rejects.toMatchObject({ code: '23514' });
});
it('revokes all read and publication paths when trashed', async () => {
  const t = await readerTestApp(cleanup); const f = await t.ingest();
  const descriptor = (await t.app.inject({ url: `${f.base}/reader`, headers: headers(t.alice) })).json();
  const deleted = await t.app.inject({ method: 'POST', url: `${f.base}/trash`, headers: headers(t.alice), payload: { expectedEpoch: 1 } });
  expect(deleted.statusCode, deleted.body).toBe(200);
  for (const path of ['', '/source', '/reader', '/reader-versions', '/progress', `/readers/${f.version}/bundle`, `/readers/${f.version}/chunks/${descriptor.index.chunks[0].id}`, `/readers/${f.version}/assets/${Object.values(descriptor.assetMap)[0]}`]) {
    for (const method of ['GET', 'HEAD'] as const) {
      const response = await t.app.inject({ method, url: `${f.base}${path}`, headers: { ...headers(t.alice), range: 'bytes=0-4' } });
      expect(response.statusCode, `${method} ${path} ${response.body}`).toBe(404);
    }
  }
  expect((await t.app.inject({ url: `/api/v1/assets/${descriptor.source.assetId}/content`, headers: headers(t.alice) })).statusCode).toBe(404);
  expect((await t.app.inject({ url: `${f.base}/reader`, headers: headers(t.bob) })).statusCode).toBe(404);
  expect((await t.app.inject({ url: '/api/v1/documents', headers: headers(t.alice) })).json().total).toBe(0);
  const row = (await t.db.pool.query('SELECT lifecycle_epoch,purge_after-deleted_at AS retention FROM documents WHERE id=$1', [f.imported.documentId])).rows[0];
  expect(row.lifecycle_epoch).toBe('2'); expect(row.retention.days).toBe(30);
  // Task 4 replaces this owned-DB helper with material-verified restoration.
  await t.db.pool.query('UPDATE documents SET deleted_at=NULL,purge_after=NULL,lifecycle_epoch=lifecycle_epoch+1 WHERE id=$1', [f.imported.documentId]);
  expect((await t.app.inject({ url: `${f.base}/reader?versionId=${f.version}`, headers: headers(t.alice) })).statusCode).toBe(200);
});
it('rejects delete-restore ABA publication from an independent worker', async () => {
  const t = await jobFixture(); cleanup.push(t.close); const saved = await t.save();
  const worker = await startWorker(t, { delay: 10000 }); cleanup.push(worker.stop);
  await eventually(async () => worker.messages, values => values.some(v => v.type === 'request'));
  const deleted = await t.request(`/api/v1/documents/${saved.documentId}/trash`, 'POST', { expectedEpoch: 1 });
  expect(deleted.statusCode, deleted.body).toBe(200);
  await t.db.pool.query('UPDATE documents SET deleted_at=NULL,purge_after=NULL,lifecycle_epoch=lifecycle_epoch+1 WHERE id=$1', [saved.documentId]);
  await eventually(async () => worker.messages, values => values.some(v => v.type === 'aborted'));
  expect((await t.db.pool.query('SELECT current_web_reader_version_id FROM documents WHERE id=$1', [saved.documentId])).rows[0].current_web_reader_version_id).toBe(saved.readerVersionId);
  expect((await t.db.pool.query('SELECT id FROM web_translation_runs WHERE job_id=$1', [saved.jobId])).rowCount).toBe(0);
  expect((await t.db.pool.query('SELECT job_id FROM web_worker_slots WHERE job_id=$1', [saved.jobId])).rowCount).toBe(0);
  expect((await t.db.pool.query('SELECT status,finalized_epoch=epoch AS finalized FROM web_jobs WHERE id=$1', [saved.jobId])).rows[0]).toMatchObject({ status: 'cancelled', finalized: true });
});
it('fences an untargeted upload across retirement', async () => {
  const t = await jobFixture(); cleanup.push(t.close);
  const service = createDocumentsService(t); const bytes = Buffer.from('%PDF-1.7\nretirement fixture');
  const input = () => ({ idempotencyKey: randomUUID(), originalFilename: 'book.pdf', body: (async function* () { yield bytes; })() });
  const doc = await service.savePdf(t.actor, input());
  let release!: () => void; let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); const reached = new Promise<void>(resolve => { entered = resolve; });
  const pending = service.savePdf(t.actor, { ...input(), body: (async function* () { entered(); await held; yield bytes; })() }).then(value => ({ value }), error => ({ error }));
  await reached;
  try {
    const deleted = await t.request(`/api/v1/documents/${doc.id}/trash`, 'POST', { expectedEpoch: 1 }); expect(deleted.statusCode, deleted.body).toBe(200);
    await t.db.pool.query('UPDATE documents SET deleted_at=NULL,purge_after=NULL,lifecycle_epoch=lifecycle_epoch+1 WHERE id=$1', [doc.id]);
  } finally { release(); }
  expect(await pending).toMatchObject({ error: { code: 'DOCUMENT_RETIRED' } });
  expect((await t.db.pool.query('SELECT id FROM documents WHERE kind=\'pdf\'')).rowCount).toBe(1);
});
it('does not admit a new translation at a restored epoch after its authorization read', async () => {
  const t = await jobFixture(); cleanup.push(t.close); const saved = await t.save();
  const { createWebJobsService } = await import('../../src/web-jobs/service.js');
  const descriptor = (await t.request(`/api/v1/documents/${saved.documentId}/web-reader`)).json();
  let entered!: () => void; let release!: () => void;
  const reached = new Promise<void>(r => { entered = r; }); const held = new Promise<void>(r => { release = r; });
  const service = createWebJobsService({ db: t.db, store: { ...t.store, async *read(key, range) { entered(); await held; yield* t.store.read(key, range); } } });
  const pending = service.create(t.actor, saved.documentId, { sourceVersionId: saved.sourceVersionId, parseId: descriptor.parseId, profileRevision: 1, glossaryRevision: 0, requestId: randomUUID() }).then(value => ({ value }), error => ({ error }));
  await reached;
  try {
    expect((await t.request(`/api/v1/documents/${saved.documentId}/trash`, 'POST', { expectedEpoch: 1 })).statusCode).toBe(200);
    await t.db.pool.query('UPDATE documents SET deleted_at=NULL,purge_after=NULL,lifecycle_epoch=lifecycle_epoch+1 WHERE id=$1', [saved.documentId]);
  } finally { release(); }
  expect(await pending).toMatchObject({ error: { code: 'DOCUMENT_EPOCH_CONFLICT' } });
  expect((await t.db.pool.query('SELECT id FROM web_jobs WHERE document_id=$1', [saved.documentId])).rowCount).toBe(1);
});
it('revokes Web source, Reader, progress and job reads including HEAD', async () => {
  const t = await jobFixture(); cleanup.push(t.close); const saved = await t.save();
  const base = `/api/v1/documents/${saved.documentId}`;
  const descriptor = (await t.request(`${base}/web-reader`)).json();
  const paths = [`${base}/web-reader`, `${base}/web-reader/versions`, `${base}/web-reader/versions/${saved.readerVersionId}/chunks/${descriptor.index.chunks[0].id}`, `${base}/web-snapshots/${saved.sourceVersionId}/manifest`, `${base}/web-snapshots/${saved.sourceVersionId}/files/html`, `${base}/web-progress`, `${base}/web-jobs`, `/api/v1/web-jobs/${saved.jobId}`];
  expect((await t.request(`${base}/trash`, 'POST', { expectedEpoch: 1 })).statusCode).toBe(200);
  for (const url of paths) for (const method of ['GET','HEAD'] as const) expect((await t.app.inject({ url, method, headers: t.headers })).statusCode, `${method} ${url}`).toBe(404);
});
it('records cache ownership for completed work without changing SDK cache identity', async () => {
  const t = await jobFixture(); cleanup.push(t.close); const saved = await t.save();
  const worker = await startWorker(t); cleanup.push(worker.stop);
  await eventually(async () => (await t.db.pool.query('SELECT status FROM web_jobs WHERE id=$1', [saved.jobId])).rows[0].status, status => status === 'completed');
  const entries = (await t.db.pool.query('SELECT cache_key FROM web_owner_cache WHERE owner_id=$1', [t.actor.userId])).rows;
  expect(entries.length).toBeGreaterThan(0);
  const refs = (await t.db.pool.query('SELECT cache_key,document_epoch FROM web_cache_document_refs WHERE owner_id=$1 AND document_id=$2', [t.actor.userId,saved.documentId])).rows;
  expect(refs.map(v => v.cache_key).sort()).toEqual(entries.map(v => v.cache_key).sort());
  expect(refs.every(v => v.document_epoch === '1')).toBe(true);
});
it('dates ingress at admission after lock acquisition rather than transaction start', async () => {
  const t = await jobFixture(); cleanup.push(t.close); const saved = await t.save();
  const { claimIngestion } = await import('../../src/documents/repository.js');
  const { assertActorCurrent } = await import('../../src/auth/guards.js');
  const client = await t.db.pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SELECT now()');
    expect((await t.request(`/api/v1/documents/${saved.documentId}/trash`, 'POST', { expectedEpoch: 1 })).statusCode).toBe(200);
    await assertActorCurrent(client, t.actor);
    const key = randomUUID(); await claimIngestion(client, t.actor.userId, key);
    const row = (await client.query('SELECT i.created_at>d.deleted_at AS after FROM ingestions i CROSS JOIN documents d WHERE i.idempotency_key=$1 AND d.id=$2', [key,saved.documentId])).rows[0];
    expect(row.after).toBe(true);
  } finally { await client.query('ROLLBACK'); client.release(); }
});
it('rechecks raw asset reads after object I/O before sending headers', async () => {
  const { vi } = await import('vitest');
  const storage = await import('../../src/storage/local-object-store.js');
  const original = storage.createLocalObjectStore;
  let reached!: () => void; let release!: () => void; let key = '';
  const arrived = new Promise<void>(r => { reached = r; }); const held = new Promise<void>(r => { release = r; });
  const spy = vi.spyOn(storage, 'createLocalObjectStore').mockImplementation(root => {
    const store = original(root);
    return { ...store, async *read(id, range) { if (id === key) { reached(); await held; } yield* store.read(id, range); } };
  });
  try {
    const t = await readerTestApp(cleanup); const f = await t.ingest();
    const source = (await t.db.pool.query('SELECT a.id,a.object_key FROM assets a JOIN source_versions s ON s.asset_id=a.id WHERE s.document_id=$1', [f.imported.documentId])).rows[0]; key = source.object_key;
    const pending = t.app.inject({ url: `/api/v1/assets/${source.id}/content`, headers: { ...headers(t.alice), range: 'bytes=0-4' } }).then(v => v);
    await arrived;
    try { expect((await t.app.inject({ method: 'POST', url: `${f.base}/trash`, headers: headers(t.alice), payload: { expectedEpoch: 1 } })).statusCode).toBe(200); }
    finally { release(); }
    const response = await pending; expect(response.statusCode).toBe(404); expect(response.headers.etag).toBeUndefined();
  } finally { release?.(); spy.mockRestore(); }
});
it('fences targeted and untargeted captures after validation, independent of capturedAt', async () => {
  const t = await jobFixture(); cleanup.push(t.close); const saved = await t.save();
  const { capture } = await import('../helpers/web-capture.js');
  const { createWebCapturesService } = await import('../../src/web-captures/service.js');
  for (const targeted of [false,true]) {
    const value = capture('<p>A late capture cannot revive the retired article.</p>'); value.manifest.metadata.capturedAt = '2099-01-01T00:00:00.000Z';
    let entered!: () => void; let release!: () => void; let first = true;
    const reached = new Promise<void>(r => { entered = r; }); const held = new Promise<void>(r => { release = r; });
    const service = createWebCapturesService({ ...t, store: { ...t.store, async putImmutable(...args) { const stored = await t.store.putImmutable(...args); if (first) { first = false; entered(); await held; } return stored; } } });
    const principal = { kind: 'session' as const, actor: t.actor };
    const row = await service.create(principal, { manifest: value.manifest, translationIntent: 'none', ...(targeted ? { targetDocumentId: saved.documentId } : {}) }, value.manifest.captureId);
    await service.receiveFile(principal, row.id, 'html', (async function* () { yield value.body; })(), 'text/html');
    const pending = service.commit(principal, row.id).then(value => ({ value }), error => ({ error }));
    await reached;
    try {
      const epoch = targeted ? 3 : 1;
      expect((await t.request(`/api/v1/documents/${saved.documentId}/trash`, 'POST', { expectedEpoch: epoch })).statusCode).toBe(200);
      await t.db.pool.query('UPDATE documents SET deleted_at=NULL,purge_after=NULL,lifecycle_epoch=lifecycle_epoch+1 WHERE id=$1', [saved.documentId]);
    } finally { release(); }
    expect(await pending).toHaveProperty('error');
    expect((await t.db.pool.query('SELECT id FROM web_reader_versions WHERE document_id=$1', [saved.documentId])).rowCount).toBe(1);
  }
});
it('compares retirement admission cutoffs at PostgreSQL microsecond precision', async () => {
  const t = await jobFixture(); cleanup.push(t.close);
  const { claimIngestion } = await import('../../src/documents/repository.js');
  const { assertIdentityNotRetired, identityDigest } = await import('../../src/document-lifecycle/retired-identities.js');
  const key = randomUUID(); const sha = 'a'.repeat(64);
  await t.db.transaction(async c => {
    await claimIngestion(c, t.actor.userId, key);
    await c.query(`INSERT INTO retired_document_identities(owner_id,identity_kind,identity_digest,retired_at,document_id)
      SELECT owner_id,'source-sha256',$2,created_at+interval '1 microsecond',$3 FROM ingestions WHERE idempotency_key=$1`, [key,identityDigest(sha),randomUUID()]);
  });
  await expect(t.db.transaction(c => assertIdentityNotRetired(c, t.actor.userId, 'source-sha256', sha, { table: 'ingestions',key }))).rejects.toMatchObject({ code: 'DOCUMENT_RETIRED' });
  await t.db.pool.query("UPDATE retired_document_identities SET retired_at=retired_at-interval '2 microseconds'");
  await expect(t.db.transaction(c => assertIdentityNotRetired(c, t.actor.userId, 'source-sha256', sha, { table: 'ingestions',key }))).resolves.toBeUndefined();
});
it('allows read-only accepted replay after trash but rejects a new save of the same retired link', async () => {
  const t = await jobFixture(); cleanup.push(t.close); const key = randomUUID();
  const input = { url: 'https://www.zhihu.com/question/retired', translationIntent: 'none' };
  const save = (id: string) => t.app.inject({ method: 'POST', url: '/api/v1/documents/links', headers: { ...t.headers, 'idempotency-key': id }, payload: input });
  const accepted = await save(key); expect(accepted.statusCode).toBe(201);
  const id = accepted.json().documentId;
  expect((await t.request(`/api/v1/documents/${id}/trash`, 'POST', { expectedEpoch: 1 })).statusCode).toBe(200);
  const replay = await save(key.toUpperCase()); expect(replay.statusCode).toBe(201); expect(replay.json()).toEqual(accepted.json());
  expect((await save(randomUUID())).statusCode).toBe(404);
});
it('actively aborts a targeted capture file upload when the document is trashed', async () => {
  const t = await jobFixture(); cleanup.push(t.close); const saved = await t.save();
  const { capture } = await import('../helpers/web-capture.js');
  const { createWebCapturesService } = await import('../../src/web-captures/service.js');
  const value = capture(); const service = createWebCapturesService(t); const principal = { kind: 'session' as const, actor: t.actor };
  const created = await service.create(principal, { manifest: value.manifest, translationIntent: 'none', targetDocumentId: saved.documentId }, value.manifest.captureId);
  let release!: () => void; let entered!: () => void;
  const held = new Promise<void>(r => { release = r; }); const reached = new Promise<void>(r => { entered = r; });
  const pending = service.receiveFile(principal, created.id, 'html', (async function* () { entered(); await held; yield value.body; })(), 'text/html').then(value => ({ value }), error => ({ error }));
  await reached;
  try {
    expect((await t.request(`/api/v1/documents/${saved.documentId}/trash`, 'POST', { expectedEpoch: 1 })).statusCode).toBe(200);
    const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('upload still blocked'), 1500))]);
    expect(result).toHaveProperty('error');
  } finally { release(); await pending; }
});
it('rejects purged operation keys while preserving opaque PDF key case', async () => {
  const t = await jobFixture(); cleanup.push(t.close);
  const { createHash } = await import('node:crypto');
  const key = randomUUID(); const doc = randomUUID();
  const digest = (kind: string, identity: string) => createHash('sha256').update(JSON.stringify([kind,identity])).digest('hex');
  await t.db.pool.query(`INSERT INTO retired_operations(owner_id,operation_kind,key_digest,document_id,accepted_at,retired_at) VALUES
    ($1,'document-link',$2,$3,clock_timestamp(),clock_timestamp()),($1,'pdf-upload',$4,$3,clock_timestamp(),clock_timestamp())`, [t.actor.userId,digest('document-link', key.toLowerCase()),doc,digest('pdf-upload','Opaque-Key')]);
  const result = await t.app.inject({ method: 'POST', url: '/api/v1/documents/links', headers: { ...t.headers, 'idempotency-key': key.toUpperCase() }, payload: { url: 'https://www.zhihu.com/question/new', translationIntent: 'none' } });
  expect(result.statusCode).toBe(410); expect(result.json().error.code).toBe('DOCUMENT_PURGED');
  const service = createDocumentsService(t); const input = (idempotencyKey: string) => ({ idempotencyKey, originalFilename: 'book.pdf', body: (async function* () { yield Buffer.from('%PDF-1.7\nnew'); })() });
  await expect(service.savePdf(t.actor, input('Opaque-Key'))).rejects.toMatchObject({ code: 'DOCUMENT_PURGED' });
  await expect(service.savePdf(t.actor, input('opaque-key'))).resolves.toHaveProperty('id');
});
it('fences a completed checkpoint held at an independent worker object-publication boundary', async () => {
  const t = await jobFixture(); cleanup.push(t.close);
  const worker = await startWorker(t, { publicationControl: true }); cleanup.push(worker.stop);
  worker.child.send({ type: 'publication-control', hold: true });
  await eventually(async () => worker.messages, messages => messages.some(m => m.type === 'publication-control-ack'), 3000);
  const saved = await t.save();
  await eventually(async () => worker.messages, messages => messages.some(m => m.type === 'publication-held'));
  const checkpoint = (await t.db.pool.query('SELECT checkpoint FROM web_job_checkpoints WHERE job_id=$1', [saved.jobId])).rows[0].checkpoint;
  expect(checkpoint.units.some((u: { status: string }) => u.status === 'completed')).toBe(true);
  expect((await t.request(`/api/v1/documents/${saved.documentId}/trash`, 'POST', { expectedEpoch: 1 })).statusCode).toBe(200);
  await t.db.pool.query('UPDATE documents SET deleted_at=NULL,purge_after=NULL,lifecycle_epoch=lifecycle_epoch+1 WHERE id=$1', [saved.documentId]);
  worker.child.send({ type: 'publication-control', hold: false });
  await eventually(async () => worker.messages.filter(m => m.type === 'publication-control-ack').length, count => count === 2);
  await worker.stop();
  const { finalizeWebJob } = await import('../../src/web-jobs/finalize.js');
  const { readFinalizerCandidates } = await import('../../src/worker/finalizer-schedule.js');
  await finalizeWebJob(saved.jobId, { db: t.db, store: t.store, generationKind: 'mock' });
  expect(await readFinalizerCandidates(t.db, null, [])).toEqual([]);
  expect((await t.db.pool.query('SELECT id FROM web_translation_runs WHERE job_id=$1', [saved.jobId])).rowCount).toBe(0);
  expect((await t.db.pool.query('SELECT current_web_reader_version_id FROM documents WHERE id=$1', [saved.documentId])).rows[0].current_web_reader_version_id).toBe(saved.readerVersionId);
});
it('releases the owner lock during PDF descriptor validation and denies a deleted result', async () => {
  const t = await readerTestApp(cleanup); const f = await t.ingest();
  const { createReadersService } = await import('../../src/readers/service.js');
  const { createLocalObjectStore } = await import('../../src/storage/local-object-store.js');
  const sessionHash = (await t.db.pool.query('SELECT token_hash FROM sessions WHERE user_id=$1', [t.alice.user.id])).rows[0].token_hash;
  const actor = { userId: t.alice.user.id, role: t.alice.user.role, authVersion: 1, sessionHash };
  const store = createLocalObjectStore(t.config.dataDir); let entered!: () => void; let release!: () => void;
  const reached = new Promise<void>(r => { entered = r; }); const held = new Promise<void>(r => { release = r; });
  const service = createReadersService({ db: t.db, store: { ...store, async *read(key, range) { entered(); await held; yield* store.read(key, range); } } });
  const pending = service.descriptor(actor, f.imported.documentId).then(value => ({ value }), error => ({ error })); await reached;
  try {
    await expect(t.db.transaction(c => c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT', [actor.userId]))).resolves.toHaveProperty('rowCount', 1);
    expect((await t.app.inject({ method: 'POST', url: `${f.base}/trash`, headers: headers(t.alice), payload: { expectedEpoch: 1 } })).statusCode).toBe(200);
  } finally { release(); }
  expect(await pending).toMatchObject({ error: { statusCode: 404 } });
});
it('actively aborts source acquisition in an independent worker across delete and restore', async () => {
  const t = await jobFixture(); cleanup.push(t.close);
  const accepted = await t.app.inject({ method: 'POST', url: '/api/v1/documents/links', headers: { ...t.headers, 'idempotency-key': randomUUID() }, payload: { url: 'https://site-link-fixture.example/en', translationIntent: 'none' } });
  expect(accepted.statusCode).toBe(201); const saved = accepted.json();
  const worker = await startWorker(t, { fetchDelay: 10000 }); cleanup.push(worker.stop);
  await eventually(async () => worker.messages, messages => messages.some(m => m.type === 'fetch-request'));
  expect((await t.request(`/api/v1/documents/${saved.documentId}/trash`, 'POST', { expectedEpoch: 1 })).statusCode).toBe(200);
  await t.db.pool.query('UPDATE documents SET deleted_at=NULL,purge_after=NULL,lifecycle_epoch=lifecycle_epoch+1 WHERE id=$1', [saved.documentId]);
  await eventually(async () => worker.messages, messages => messages.some(m => m.type === 'fetch-aborted'), 1500);
  expect((await t.db.pool.query('SELECT job_id FROM web_fetch_acquisitions WHERE job_id=$1', [saved.jobId])).rowCount).toBe(0);
  expect((await t.db.pool.query('SELECT id FROM assets WHERE document_id=$1', [saved.documentId])).rowCount).toBe(0);
});
it('admits fresh automatic work after restoration without reactivating the old job', async () => {
  const t = await jobFixture(); cleanup.push(t.close); const old = await t.save();
  expect((await t.request(`/api/v1/documents/${old.documentId}/trash`, 'POST', { expectedEpoch: 1 })).statusCode).toBe(200);
  await t.db.pool.query('UPDATE documents SET deleted_at=NULL,purge_after=NULL,lifecycle_epoch=lifecycle_epoch+1 WHERE id=$1', [old.documentId]);
  const fresh = await t.save(); expect(fresh.documentId).toBe(old.documentId); expect(fresh.jobId).not.toBe(old.jobId);
  const rows = (await t.db.pool.query('SELECT document_epoch,status FROM web_jobs WHERE document_id=$1 ORDER BY document_epoch', [old.documentId])).rows;
  expect(rows).toEqual([{ document_epoch: '1', status: 'cancelled' },{ document_epoch: '3', status: 'queued' }]);
});
it('canonicalizes capture operation keys without rewriting the accepted manifest hash', async () => {
  const t = await jobFixture(); cleanup.push(t.close);
  const { capture } = await import('../helpers/web-capture.js'); const value = capture();
  const create = (key: string) => t.app.inject({ method: 'POST', url: '/api/v1/captures', headers: { ...t.headers, 'idempotency-key': key }, payload: { manifest: value.manifest, translationIntent: 'none' } });
  const first = await create(value.manifest.captureId); expect(first.statusCode).toBe(201);
  const before = (await t.db.pool.query('SELECT request_hash,manifest FROM web_captures WHERE id=$1', [first.json().id])).rows[0];
  const replay = await create(value.manifest.captureId.toUpperCase()); expect(replay.statusCode, replay.body).toBe(201); expect(replay.json()).toEqual(first.json());
  expect((await t.db.pool.query('SELECT request_hash,manifest FROM web_captures WHERE id=$1', [first.json().id])).rows[0]).toEqual(before);
});
it('fences an untargeted capture file acknowledgement that completes before the cancellation poll', async () => {
  const t = await jobFixture(); cleanup.push(t.close); const saved = await t.save();
  const { capture } = await import('../helpers/web-capture.js'); const value = capture();
  const { createWebCapturesService } = await import('../../src/web-captures/service.js');
  const principal = { kind: 'session' as const, actor: t.actor };
  const service = createWebCapturesService(t);
  const row = await service.create(principal, { manifest: value.manifest, translationIntent: 'none' }, value.manifest.captureId);
  let release!: () => void; let entered!: () => void;
  const held = new Promise<void>(r => { release = r; }); const reached = new Promise<void>(r => { entered = r; });
  const pending = service.receiveFile(principal, row.id, 'html', (async function* () { entered(); await held; yield value.body; })(), 'text/html').then(value => ({ value }), error => ({ error }));
  await reached;
  try {
    expect((await t.request(`/api/v1/documents/${saved.documentId}/trash`, 'POST', { expectedEpoch: 1 })).statusCode).toBe(200);
    await t.db.pool.query('UPDATE documents SET deleted_at=NULL,purge_after=NULL,lifecycle_epoch=lifecycle_epoch+1 WHERE id=$1', [saved.documentId]);
  } finally { release(); }
  expect(await pending).toMatchObject({ error: { code: 'DOCUMENT_RETIRED' } });
  expect((await t.db.pool.query('SELECT received_at FROM web_capture_files WHERE capture_id=$1', [row.id])).rows[0].received_at).toBeNull();
});
