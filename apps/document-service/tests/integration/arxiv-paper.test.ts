import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapAdmin } from '../../src/cli/bootstrap-admin.js';
import { createServiceTestApp } from '../helpers/app.js';
import { login } from '../helpers/session.js';
import { startWebJobLease } from '../../src/web-jobs/repository.js';
import { runWebJob } from '../../src/web-jobs/translation-runner.js';
import { createLocalObjectStore } from '../../src/storage/local-object-store.js';
import { arxivTransport, pdf } from '../helpers/arxiv-fixture.js';
import { bundleFixture } from '../helpers/bundles.js';
import { runMetadataBackfill } from '../../src/document-management/metadata-projection.js';
import type { CreateBundleImportRequest } from '@pagelingo/document-contracts';
import { startWorker } from '../helpers/worker-process.js';
import { atom } from '../helpers/arxiv-fixture.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runDocumentMaintenance } from '../../src/document-lifecycle/maintenance.js';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
async function setup() {
  const t = await createServiceTestApp(); closes.push(t.close);
  await bootstrapAdmin(t.db, { username: 'admin', password: 'correct password 123456' });
  const session = await login(t.app, 'admin', 'correct password 123456');
  const headers = { cookie: session.cookie, origin: t.config.publicOrigin, 'x-csrf-token': session.csrfToken };
  const store = createLocalObjectStore(t.config.dataDir);
  const save = async (url = 'https://arxiv.org/abs/2401.12345') => { const r = await t.app.inject({ method: 'POST', url: '/api/v1/documents/links', headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { url, translationIntent: 'auto' } }); expect(r.statusCode, r.body).toBe(201); return r.json() as { documentId: string; jobId: string }; };
  const run = async (jobId: string, options: Parameters<typeof arxivTransport>[0] = {}) => {
    // Owned disposable limiter clock only; independent worker tests use the actual cooldown.
    await t.db.pool.query("UPDATE external_request_limits SET next_request_at='-infinity'");
    await t.db.pool.query("UPDATE web_jobs SET next_request_at=clock_timestamp() WHERE id=$1", [jobId]);
    const lease = (await t.db.transaction(c => startWebJobLease(c, { ownerId: session.user.id, jobId, slotId: 1, leaseOwner: randomUUID() })))!;
    expect(lease).not.toBeNull(); const requests: string[] = [];
    await runWebJob(lease, { db: t.db, store, config: t.config, signal: new AbortController().signal, sourceTransport: arxivTransport({ ...options, requests }) }); return requests;
  };
  const details = async (id: string) => (await t.app.inject({ url: `/api/v1/documents/${id}/source-details`, headers })).json();
  const summary = async (id: string) => (await t.app.inject({ url: `/api/v1/documents/${id}`, headers })).json();
  const refresh = async (id: string, ref: string) => { const r = await t.app.inject({ method: 'POST', url: `/api/v1/documents/${id}/source-refresh`, headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { ref, translationIntent: 'none' } }); expect(r.statusCode, r.body).toBe(202); return r.json().jobId as string; };
  const collect = async (jobId: string, options: Parameters<typeof arxivTransport>[0] = {}) => { await run(jobId, options); await run(jobId, options); };
  return { ...t, headers, store, save, run, collect, details, summary, refresh, ownerId: session.user.id };
}
it('resolves latest once then resumes the fixed version', async () => {
  const t = await setup(); const saved = await t.save();
  expect(await t.run(saved.jobId)).toEqual(['https://export.arxiv.org/api/query?id_list=2401.12345']);
  expect(await t.details(saved.documentId)).toMatchObject({ latestAttempt: { status: 'queued', resolvedRevision: expect.any(String) } });
  // The upstream latest can move; the next invocation must reuse the retained Atom.
  expect(await t.run(saved.jobId)).toEqual(['https://arxiv.org/pdf/2401.12345v1']);
  expect(await t.summary(saved.documentId)).toMatchObject({ kind: 'paper', processingStatus: 'awaiting-local-processing', source: { sha256: createHash('sha256').update(pdf).digest('hex'), bytes: pdf.length }, reader: null });
  expect((await t.db.pool.query('SELECT id FROM parse_runs UNION ALL SELECT id::text FROM translation_runs')).rows).toHaveLength(0);
});
it('records separate paper versions for identical PDF bytes', async () => {
  const t = await setup(); const saved = await t.save(); await t.collect(saved.jobId);
  const first = (await t.details(saved.documentId)).current;
  const next = await t.refresh(saved.documentId, '2401.12345v2'); await t.collect(next, { version: 2 });
  const second = (await t.details(saved.documentId)).current;
  expect(second).toMatchObject({ version: 2, sourceVersionId: first.sourceVersionId }); expect(second.id).not.toBe(first.id);
  expect((await t.db.pool.query('SELECT id FROM source_versions WHERE document_id=$1', [saved.documentId])).rows).toHaveLength(1);
});

it('imports a bundle into the explicitly selected paper source and keeps provider metadata', async () => {
  const t = await setup(); const fixture = await bundleFixture(t.config.dataDir, { status: 'completed' });
  const saved = await t.save(); await t.collect(saved.jobId, { pdf: fixture.files.get('source.pdf')! });
  const first = (await t.details(saved.documentId)).current;
  const key = randomUUID();
  const input = { targetDocumentId: saved.documentId.toUpperCase(), targetSourceVersionId: first.sourceVersionId.toUpperCase(), targetPaperVersion: 1 };
  const result = await importPaper(t, fixture.bytes, input, key);
  expect(await t.summary(saved.documentId)).toMatchObject({ kind: 'paper', title: 'Paper version 1', reader: { versionId: result.readerVersionId } });
  const reader = await t.app.inject({ url: `/api/v1/documents/${saved.documentId}/reader`, headers: t.headers });
  expect(reader.statusCode, reader.body).toBe(200); expect(reader.json()).toMatchObject({ source: { sourceVersionId: first.sourceVersionId }, parseId: fixture.manifest.parse.id });
  expect((await t.db.pool.query('SELECT arxiv_version_id,source_version_id,reader_version_id FROM paper_reader_bindings')).rows).toEqual([{ arxiv_version_id: first.id, source_version_id: first.sourceVersionId, reader_version_id: result.readerVersionId }]);
  const replay = await admit(t, { ...input, targetDocumentId: saved.documentId, targetSourceVersionId: first.sourceVersionId }, key); expect(replay.statusCode, replay.body).toBe(201); expect(replay.json().id).toBe(result.id);
  const row = (await t.db.pool.query('SELECT admitted_request,request_hash FROM bundle_imports WHERE id=$1', [result.id])).rows[0];
  expect(row.admitted_request).toEqual({ targetDocumentId: saved.documentId, targetSourceVersionId: first.sourceVersionId, targetPaperVersion: 1 });
  expect(row.request_hash).toBe(createHash('sha256').update(JSON.stringify(row.admitted_request, ['targetDocumentId','targetSourceVersionId','targetPaperVersion'])).digest('hex'));
  await runMetadataBackfill({ db: t.db, store: t.store, signal: new AbortController().signal });
  expect(await t.summary(saved.documentId)).toMatchObject({ title: 'Paper version 1' });
});
it('keeps v1 translation separate from a changed v2 PDF and historical imports cannot promote current', async () => {
  const t = await setup(); const fixture = await bundleFixture(t.config.dataDir, { status: 'completed' });
  const saved = await t.save(); await t.collect(saved.jobId, { pdf: fixture.files.get('source.pdf')! }); const v1 = (await t.details(saved.documentId)).current;
  const imported = await importPaper(t, fixture.bytes, { targetDocumentId: saved.documentId, targetPaperVersion: 1, targetSourceVersionId: v1.sourceVersionId });
  const next = await t.refresh(saved.documentId, '2401.12345v2'); await t.collect(next, { version: 2 }); const v2 = (await t.details(saved.documentId)).current;
  expect(v2.sourceVersionId).not.toBe(v1.sourceVersionId); expect(await t.summary(saved.documentId)).toMatchObject({ title: 'Paper version 2', reader: null, processingStatus: 'awaiting-local-processing' });
  expect((await t.app.inject({ url: `/api/v1/documents/${saved.documentId}/reader?versionId=${imported.readerVersionId}`, headers: t.headers })).json()).toMatchObject({ source: { sourceVersionId: v1.sourceVersionId } });
  const original = await t.app.inject({ url: `/api/v1/assets/${v1.pdf.assetId}/content`, headers: { ...t.headers, range: 'bytes=0-4' } }); expect(original.statusCode, original.body).toBe(206); expect(original.body).toBe('%PDF-');
  const later = await bundleFixture(t.config.dataDir, { status: 'completed' });
  await importPaper(t, later.bytes, { targetDocumentId: saved.documentId, targetPaperVersion: 1 });
  expect(await t.summary(saved.documentId)).toMatchObject({ title: 'Paper version 2', reader: null, source: { sourceVersionId: v2.sourceVersionId } });
});
it('explicitly associates an existing Reader with a same-byte paper version', async () => {
  const t = await setup(); const fixture = await bundleFixture(t.config.dataDir);
  const saved = await t.save(); await t.collect(saved.jobId, { pdf: fixture.files.get('source.pdf')! }); const v1 = (await t.details(saved.documentId)).current;
  const imported = await importPaper(t, fixture.bytes, { targetDocumentId: saved.documentId, targetPaperVersion: 1 });
  const next = await t.refresh(saved.documentId, '2401.12345v2'); await t.collect(next, { version: 2, pdf: fixture.files.get('source.pdf')! }); const v2 = (await t.details(saved.documentId)).current;
  expect(v2.sourceVersionId).toBe(v1.sourceVersionId); expect(await t.summary(saved.documentId)).toMatchObject({ title: 'Paper version 2', reader: { versionId: imported.readerVersionId } });
  expect((await t.db.pool.query('SELECT arxiv_version_id FROM paper_reader_bindings ORDER BY arxiv_version_id')).rows.map(r => r.arxiv_version_id).sort()).toEqual([v1.id, v2.id].sort());
  // Delete only the test-owned association with current temporarily detached: selecting a shared source is insufficient.
  await t.db.pool.query('UPDATE documents SET current_reader_version_id=NULL WHERE id=$1', [saved.documentId]);
  await t.db.pool.query('DELETE FROM paper_reader_bindings WHERE arxiv_version_id=$1', [v2.id]);
  await expect(t.db.pool.query('UPDATE documents SET current_reader_version_id=$2 WHERE id=$1', [saved.documentId, imported.readerVersionId])).rejects.toMatchObject({ code: '23503' });
  const reused = await importPaper(t, fixture.bytes, { targetDocumentId: saved.documentId, targetSourceVersionId: v2.sourceVersionId, targetPaperVersion: 2 }); expect(reused.readerVersionId).toBe(imported.readerVersionId);
  expect((await t.db.pool.query('SELECT 1 FROM paper_reader_bindings WHERE arxiv_version_id=$1', [v2.id])).rowCount).toBe(1);
});
it('requires paired authorized targets and rejects wrong bytes or packages belonging to another document', async () => {
  const t = await setup(); const fixture = await bundleFixture(t.config.dataDir); const saved = await t.save(); await t.collect(saved.jobId);
  const v1 = (await t.details(saved.documentId)).current;
  for (const input of [{ targetDocumentId: saved.documentId }, { targetDocumentId: saved.documentId, targetPaperVersion: 99 }, { targetDocumentId: saved.documentId, targetPaperVersion: 1, targetSourceVersionId: randomUUID() }]) expect((await admit(t, input)).statusCode).toBeGreaterThanOrEqual(400);
  const bad = await admit(t, { targetDocumentId: saved.documentId, targetPaperVersion: 1 }); expect(bad.statusCode).toBe(201);
  const received = await receive(t, bad.json().id, fixture.bytes); expect(received.statusCode, received.body).toBe(409); expect(received.json().error.code).toBe('SOURCE_MISMATCH');
  const other = await t.save('https://arxiv.org/abs/2401.54321'); await t.collect(other.jobId, { baseId: '2401.54321', pdf: fixture.files.get('source.pdf')! });
  await importPaper(t, fixture.bytes, { targetDocumentId: other.documentId, targetPaperVersion: 1 });
  const next = await t.refresh(saved.documentId, '2401.12345v2'); await t.collect(next, { version: 2, pdf: fixture.files.get('source.pdf')! });
  const duplicate = await admit(t, { targetDocumentId: saved.documentId, targetPaperVersion: 2 }); expect(duplicate.statusCode).toBe(201);
  const rejected = await receive(t, duplicate.json().id, fixture.bytes); expect(rejected.statusCode).toBe(409); expect(rejected.json().error.code).toBe('BUNDLE_IDENTITY_CONFLICT');
  expect((await t.db.pool.query('SELECT id FROM arxiv_versions WHERE document_id=$1 AND source_version_id=$2', [saved.documentId, v1.sourceVersionId])).rows).toHaveLength(1);
});
type TestApp = Awaited<ReturnType<typeof setup>>;
async function admit(t: TestApp, input: CreateBundleImportRequest, key = randomUUID()) { return t.app.inject({ method: 'POST', url: '/api/v1/bundle-imports', headers: { ...t.headers, 'idempotency-key': key }, payload: input }); }
async function receive(t: TestApp, id: string, bytes: Buffer) { return t.app.inject({ method: 'PUT', url: `/api/v1/bundle-imports/${id}/content`, headers: { ...t.headers, 'content-type': 'application/zip' }, payload: bytes }); }
async function importPaper(t: TestApp, bytes: Buffer, input: CreateBundleImportRequest, key = randomUUID()) { const created = await admit(t, input, key); expect(created.statusCode, created.body).toBe(201); const result = await receive(t, created.json().id, bytes); expect(result.statusCode, result.body).toBe(200); return result.json(); }

it('retains the fixed Atom across independent worker processes and does not call a model', async () => {
  const t = await setup(); const saved = await t.save(); const first = await startWorker(t, { arxiv: true });
  try {
    await expect.poll(async () => (await t.db.pool.query("SELECT count(*)::int AS n FROM source_acquisitions WHERE job_id=$1 AND role='arxiv-atom'", [saved.jobId])).rows[0].n, { timeout: 8000, interval: 50 }).toBe(1);
    await expect.poll(async () => (await t.details(saved.documentId)).latestAttempt.status, { timeout: 2000, interval: 30 }).toBe('queued');
  } finally { await first.stop(); }
  const second = await startWorker(t, { arxiv: true, arxivLatest: 2, arxivHoldPdf: true });
  try {
    await expect.poll(() => second.messages.some(m => m.type === 'pdf-acquired'), { timeout: 9000, interval: 50 }).toBe(true);
  } finally { await second.stop('SIGKILL'); }
  // Test-owned crash recovery clock: the persisted limiter reservation stays intact.
  await t.db.pool.query("UPDATE web_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [saved.jobId]);
  await t.db.pool.query("UPDATE web_worker_slots SET lease_until=clock_timestamp()-interval '1 second' WHERE job_id=$1", [saved.jobId]);
  const third = await startWorker(t, { arxiv: true, arxivLatest: 2 });
  try {
    await expect.poll(async () => (await t.details(saved.documentId)).latestAttempt.status, { timeout: 9000 }).toBe('completed');
    expect((await t.details(saved.documentId)).current).toMatchObject({ version: 1, pdf: { sha256: createHash('sha256').update(pdf).digest('hex') } });
    expect(first.messages.filter(m => m.type === 'source-request').map(m => m.url)).toEqual(['https://export.arxiv.org/api/query?id_list=2401.12345']);
    expect(second.messages.filter(m => m.type === 'source-request').map(m => m.url)).toEqual(['https://arxiv.org/pdf/2401.12345v1']);
    expect(third.messages.filter(m => m.type === 'source-request')).toEqual([]);
    expect([...first.messages, ...second.messages, ...third.messages].filter(m => m.type === 'request')).toEqual([]);
    expect(new Set([first.child.pid, second.child.pid, third.child.pid, process.pid]).size).toBe(4);
  } finally {
    await third.stop();
    const directory = process.env.PAGELINGO_TEST_ARXIV_EVIDENCE_DIR ?? join(t.config.dataDir, 'arxiv-evidence'); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `worker-restart-${randomUUID()}.json`), JSON.stringify({ parentPid: process.pid, processes: [first, second, third].map(worker => ({ pid: worker.child.pid, messages: worker.messages, output: worker.output() })), inputs: { atomSha256: createHash('sha256').update(atom()).digest('hex'), pdfSha256: createHash('sha256').update(pdf).digest('hex') } }));
  }
}, 25000);

it.each(['hep-th/9901001', '2401.12345'])('downloads fixed modern or legacy identity %s', async baseId => {
  const t = await setup(); const saved = await t.save(`https://arxiv.org/pdf/${baseId}v3.pdf`); await t.collect(saved.jobId, { baseId, version: 3 });
  expect((await t.details(saved.documentId)).current).toMatchObject({ baseId, version: 3, pdf: { bytes: pdf.length } });
});
it.each(['fake', 'interrupted', 'wrong-entry', 'doctype'])('does not publish rejected acquisition: %s', async failure => {
  const t = await setup(); const saved = await t.save();
  const options = failure === 'fake' ? { pdf: Buffer.from('not a pdf') } : failure === 'interrupted' ? { interrupt: true } : { feed: failure === 'wrong-entry' ? atom('2401.99999') : atom().replace('<?xml version="1.0"?>', '<!DOCTYPE feed>') };
  await t.run(saved.jobId, options); if (failure === 'fake' || failure === 'interrupted') await t.run(saved.jobId, options);
  expect((await t.details(saved.documentId)).latestAttempt.status).toBe('failed'); expect(await t.summary(saved.documentId)).toMatchObject({ source: null, reader: null });
  expect((await t.db.pool.query("SELECT id FROM source_acquisitions WHERE role='arxiv-pdf'")).rows).toHaveLength(0);
});
it('rejects changed bytes for a bound fixed version and keeps the selected original', async () => {
  const t = await setup(); const saved = await t.save(); await t.collect(saved.jobId); const before = (await t.details(saved.documentId)).current;
  const next = await t.refresh(saved.documentId, '2401.12345v1'); await t.collect(next, { pdf: Buffer.from('%PDF-1.7\nchanged bytes') });
  expect(await t.details(saved.documentId)).toMatchObject({ current: before, latestAttempt: { status: 'failed', errorCode: 'SOURCE_VERSION_CONFLICT', resolvedRevision: before.id } });
});
it('honors provider Retry-After after managed cleanup and releases deferred job slots', async () => {
  const t = await setup(); const saved = await t.save(); await t.run(saved.jobId);
  let closed = false; await t.run(saved.jobId, { status: 503, retryAfter: '15', closed: () => { closed = true; } }); expect(closed).toBe(true);
  expect((await t.db.pool.query("SELECT next_request_at>clock_timestamp()+interval '14 seconds' AS cooling FROM external_request_limits")).rows[0].cooling).toBe(true);
  expect((await t.db.pool.query('SELECT 1 FROM web_worker_slots WHERE job_id=$1', [saved.jobId])).rows).toHaveLength(0);
  expect((await t.details(saved.documentId)).latestAttempt).toMatchObject({ status: 'failed', errorCode: 'ARXIV_RATE_LIMITED' });
});
it('rejects cross-owner source, Reader and paper import targets', async () => {
  const t = await setup(); const saved = await t.save(); await t.collect(saved.jobId); const value = (await t.details(saved.documentId)).current;
  await t.db.pool.query("INSERT INTO users(username,password_hash,role) SELECT 'other',password_hash,'user' FROM users WHERE id=$1", [t.ownerId]);
  const other = await login(t.app, 'other', 'correct password 123456'); const headers = { cookie: other.cookie, origin: t.config.publicOrigin, 'x-csrf-token': other.csrfToken };
  for (const url of [`/api/v1/assets/${value.pdf.assetId}/content`, `/api/v1/documents/${saved.documentId}/source-details`, `/api/v1/documents/${saved.documentId}/source-versions`, `/api/v1/documents/${saved.documentId}/reader`]) expect((await t.app.inject({ url, headers })).statusCode).toBe(404);
  const result = await t.app.inject({ method: 'POST', url: '/api/v1/bundle-imports', headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { targetDocumentId: saved.documentId, targetSourceVersionId: value.sourceVersionId, targetPaperVersion: 1 } }); expect(result.statusCode, result.body).toBe(404);
});
it('proves stored target bytes outside publication and rejects same-size corruption', async () => {
  const t = await setup(); const fixture = await bundleFixture(t.config.dataDir); const saved = await t.save(); await t.collect(saved.jobId, { pdf: fixture.files.get('source.pdf')! });
  const source = (await t.db.pool.query("SELECT a.object_key FROM source_versions s JOIN assets a ON a.id=s.asset_id WHERE s.document_id=$1", [saved.documentId])).rows[0];
  const changed = Buffer.from(fixture.files.get('source.pdf')!); changed[changed.length - 1] ^= 1;
  await writeFile(join(t.config.dataDir, 'objects', source.object_key), changed);
  const created = await admit(t, { targetDocumentId: saved.documentId, targetPaperVersion: 1 }); const result = await receive(t, created.json().id, fixture.bytes);
  expect(result.statusCode).toBe(409); expect(result.json().error.code).toBe('SOURCE_MISMATCH'); expect((await t.db.pool.query('SELECT id FROM reader_versions')).rows).toHaveLength(0);
});
it('refuses to reuse a missing original even when a new version downloads identical bytes', async () => {
  const t = await setup(); const saved = await t.save(); await t.collect(saved.jobId); const before = (await t.details(saved.documentId)).current;
  const key = (await t.db.pool.query('SELECT object_key FROM assets WHERE id=$1', [before.pdf.assetId])).rows[0].object_key; await t.store.deleteUnreferenced(key);
  const next = await t.refresh(saved.documentId, '2401.12345v2'); await t.collect(next, { version: 2 });
  expect(await t.details(saved.documentId)).toMatchObject({ current: before, latestAttempt: { status: 'failed' } });
});
it('serves historical registered PDF identities and filenames even when versions share a source', async () => {
  const t = await setup(); const saved = await t.save(); await t.collect(saved.jobId); const before = (await t.details(saved.documentId)).current;
  const next = await t.refresh(saved.documentId, '2401.12345v2'); await t.collect(next, { version: 2 }); const after = (await t.details(saved.documentId)).current;
  for (const version of [before, after]) {
    const result = await t.app.inject({ url: `/api/v1/assets/${version.pdf.assetId}/content`, headers: { ...t.headers, range: 'bytes=0-4' } });
    expect(result.statusCode, result.body).toBe(206); expect(result.body).toBe('%PDF-'); expect(result.headers['content-disposition']).toContain(`2401.12345v${version.version}.pdf`);
  }
});
it('restores and purges the real paper, targeted imports, Reader and acquisition graph', async () => {
  const t = await setup(); const fixture = await bundleFixture(t.config.dataDir); const saved = await t.save(); await t.collect(saved.jobId, { pdf: fixture.files.get('source.pdf')! });
  const imported = await importPaper(t, fixture.bytes, { targetDocumentId: saved.documentId, targetPaperVersion: 1 });
  const base = `/api/v1/documents/${saved.documentId}`;
  const post = async (path: string, epoch: number) => t.app.inject({ method: 'POST', url: base + path, headers: t.headers, payload: { expectedEpoch: epoch } });
  expect((await post('/trash', 1)).statusCode).toBe(200); expect((await t.app.inject({ url: `${base}/reader`, headers: t.headers })).statusCode).toBe(404);
  expect((await post('/restore', 2)).statusCode).toBe(200); expect((await t.summary(saved.documentId)).reader.versionId).toBe(imported.readerVersionId);
  expect((await post('/trash', 3)).statusCode).toBe(200); const queued = await t.app.inject({ method: 'DELETE', url: `/api/v1/trash/${saved.documentId}`, headers: t.headers }); expect(queued.statusCode).toBe(202);
  for (let n = 0; n < 6; n++) { const result = await runDocumentMaintenance({ db: t.db, store: t.store, dataDir: t.config.dataDir, signal: new AbortController().signal }, { limit: 100 }); expect(result.rowsDeleted).toBeLessThanOrEqual(500); expect(result.objectsDeleted).toBeLessThanOrEqual(100); }
  for (const table of ['documents', 'source_acquisitions', 'arxiv_versions', 'paper_reader_bindings', 'bundle_imports', 'reader_versions', 'assets']) expect((await t.db.pool.query(`SELECT 1 FROM ${table}`)).rows, table).toHaveLength(0);
  expect((await t.db.pool.query('SELECT status FROM document_purges WHERE id=$1', [queued.json().id])).rows[0].status).toBe('completed');
});
it('rejects an unrepresentable paper version at admission without a database error', async () => {
  const t = await setup(); const saved = await t.save(); await t.collect(saved.jobId);
  const response = await admit(t, { targetDocumentId: saved.documentId, targetPaperVersion: Number.MAX_SAFE_INTEGER });
  expect(response.statusCode, response.body).toBe(409);
});

it('resolves Reader metadata only from owned registered paper bindings, including ambiguous same-byte versions', async () => {
  const t = await setup();
  const fixture = await bundleFixture(t.config.dataDir);
  const saved = await t.save();
  await t.collect(saved.jobId, { pdf: fixture.files.get('source.pdf')! });
  const first = (await t.details(saved.documentId)).current;
  const imported = await importPaper(t, fixture.bytes, { targetDocumentId: saved.documentId, targetPaperVersion: 1 });
  const get = (reader: string, revision?: string) => t.app.inject({
    url: `/api/v1/documents/${saved.documentId}/source-details?readerVersionId=${reader}${revision ? `&revisionId=${revision}` : ''}`, headers: t.headers,
  });
  const unique = await get(imported.readerVersionId);
  expect(unique.statusCode, unique.body).toBe(200);
  expect(unique.json().current.id).toBe(first.id);
  const next = await t.refresh(saved.documentId, '2401.12345v2');
  await t.collect(next, { version: 2, pdf: fixture.files.get('source.pdf')! });
  const second = (await t.details(saved.documentId)).current;
  expect(second.sourceVersionId).toBe(first.sourceVersionId);
  const ambiguous = await get(imported.readerVersionId);
  expect(ambiguous.statusCode, ambiguous.body).toBe(200);
  expect(ambiguous.json()).toMatchObject({ status: 'source-saved', current: null, warnings: expect.arrayContaining(['SOURCE_READER_REVISION_AMBIGUOUS']) });
  for (const revision of [first, second]) {
    const exact = await get(imported.readerVersionId, revision.id);
    expect(exact.statusCode, exact.body).toBe(200);
    expect(exact.json().current.id).toBe(revision.id);
  }
  const thirdJob = await t.refresh(saved.documentId, '2401.12345v3');
  await t.collect(thirdJob, { version: 3 });
  const third = (await t.details(saved.documentId)).current;
  expect((await get(imported.readerVersionId, third.id)).statusCode).toBe(404);
  expect((await get(randomUUID(), first.id)).statusCode).toBe(404);
  const other = await t.save('https://arxiv.org/abs/2401.54321');
  expect((await t.app.inject({ url: `/api/v1/documents/${other.documentId}/source-details?readerVersionId=${imported.readerVersionId}`, headers: t.headers })).statusCode).toBe(404);
  await t.app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: t.headers, payload: { username: 'other-reader', password: 'correct password 123456' } });
  const foreign = await login(t.app, 'other-reader', 'correct password 123456');
  expect((await t.app.inject({ url: `/api/v1/documents/${saved.documentId}/source-details?readerVersionId=${imported.readerVersionId}`, headers: { cookie: foreign.cookie } })).statusCode).toBe(404);
});
describe('HTML reading version of a fixed paper', () => {
  const html = `<html><head><title>[2401.12345] site title</title></head><body><nav>Site navigation</nav>
    <article class="ltx_document"><h1 class="ltx_title ltx_title_document">Paper version 1</h1>
    <div class="ltx_authors"><span class="ltx_personname">Alice</span> <span class="ltx_personname">Bob</span></div>
    <section><p>Earlier work <cite>[<a href="#bib1">1</a>]</cite> studied <math><annotation encoding="application/x-tex">x^2</annotation></math> in depth, which this paper extends with new evidence.</p></section>
    <table class="ltx_equation"><tr><td><math><annotation encoding="application/x-tex">E=mc^2</annotation></math></td><td>(1)</td></tr></table>
    </article></body></html>`;
  const fetcher = (status = 200) => (async (_url: string | URL | Request, init?: RequestInit) => init?.method === 'HEAD'
    ? new Response(null, { status, headers: { 'content-type': 'text/html' } })
    : new Response(html, { status, headers: { 'content-type': 'text/html' } })) as typeof fetch;
  async function runJob(t: Awaited<ReturnType<typeof setup>>, jobId: string, captureFetch: typeof fetch) {
    await t.db.pool.query("UPDATE external_request_limits SET next_request_at='-infinity'");
    await t.db.pool.query('UPDATE web_jobs SET next_request_at=clock_timestamp() WHERE id=$1', [jobId]);
    const lease = await t.db.transaction(c => startWebJobLease(c, { ownerId: t.ownerId, jobId, slotId: 1, leaseOwner: randomUUID() }));
    // A job that already finished offers no lease; its retained material can complete it in one run.
    if (lease) await runWebJob(lease, { db: t.db, store: t.store, config: t.config, signal: new AbortController().signal, sourceTransport: arxivTransport(), captureFetch });
  }
  const articles = async (t: Awaited<ReturnType<typeof setup>>) => (await t.db.pool.query("SELECT id,source_url,title,requested_web_job_id,deleted_at FROM documents WHERE kind='article' ORDER BY created_at")).rows;
  async function savedPaper(t: Awaited<ReturnType<typeof setup>>, captureFetch: typeof fetch) {
    const saved = await t.save();
    await runJob(t, saved.jobId, captureFetch);
    await runJob(t, saved.jobId, captureFetch);
    expect((await t.db.pool.query('SELECT status FROM web_jobs WHERE id=$1', [saved.jobId])).rows[0].status).toBe('completed');
    return saved;
  }
  it('saves the fixed HTML version as an article linked to the paper, without any model request', async () => {
    const t = await setup();
    const saved = await savedPaper(t, fetcher());
    const [reading] = await articles(t);
    expect(reading).toMatchObject({ source_url: 'https://arxiv.org/html/2401.12345v1', title: 'Paper version 1' });
    expect((await t.db.pool.query('SELECT from_document_id,to_document_id,kind FROM document_relations')).rows).toEqual([{ from_document_id: reading.id, to_document_id: saved.documentId, kind: 'related' }]);
    await runJob(t, reading.requested_web_job_id, fetcher());
    const summary = await t.summary(reading.id);
    expect(summary).toMatchObject({ kind: 'article', saveStatus: 'original-saved', reader: { translationStatus: 'pending' } });
    const version = summary.reader.versionId;
    const descriptor = (await t.app.inject({ url: `/api/v1/documents/${reading.id}/web-reader?versionId=${version}`, headers: t.headers })).json();
    const manifest = (await t.app.inject({ url: `/api/v1/documents/${reading.id}/web-snapshots/${descriptor.source.sourceVersionId}/manifest`, headers: t.headers })).json();
    expect(manifest.metadata).toMatchObject({ title: 'Paper version 1', author: 'Alice, Bob' });
    const original = (await t.app.inject({ url: `/api/v1/documents/${reading.id}/web-snapshots/${descriptor.source.sourceVersionId}/files/${manifest.htmlFileId}`, headers: t.headers })).body;
    expect(original).toContain('Earlier work');
    expect(original).toContain('[<a');
    expect(original).toContain('x^2');
    expect(original).not.toContain('Site navigation');
    expect(await t.summary(saved.documentId)).toMatchObject({ kind: 'paper', source: { bytes: pdf.length } });
  });
  it.each([
    ['arXiv has no HTML version', fetcher(404)],
    ['the check fails', (async () => { throw new Error('offline'); }) as typeof fetch],
  ])('keeps the saved paper and adds nothing when %s', async (_name, captureFetch) => {
    const t = await setup();
    await savedPaper(t, captureFetch);
    expect(await articles(t)).toEqual([]);
  });
  it('does not duplicate the reading version when the same paper version is fetched again', async () => {
    const t = await setup();
    const saved = await savedPaper(t, fetcher());
    const again = await t.refresh(saved.documentId, '2401.12345v1');
    await runJob(t, again, fetcher());
    await runJob(t, again, fetcher());
    expect((await t.db.pool.query('SELECT status FROM web_jobs WHERE id=$1', [again])).rows[0].status).toBe('completed');
    expect(await articles(t)).toHaveLength(1);
  });
  it('leaves a reading version the owner deleted in the trash', async () => {
    const t = await setup();
    const saved = await savedPaper(t, fetcher());
    const [reading] = await articles(t);
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/documents/${reading.id}/trash`, headers: t.headers, payload: { expectedEpoch: 1 } })).statusCode).toBe(200);
    const again = await t.refresh(saved.documentId, '2401.12345v1');
    await runJob(t, again, fetcher());
    await runJob(t, again, fetcher());
    expect((await t.db.pool.query('SELECT status FROM web_jobs WHERE id=$1', [again])).rows[0].status).toBe('completed');
    const after = await articles(t);
    expect(after).toHaveLength(1);
    expect(after[0].deleted_at).not.toBeNull();
  });
});
