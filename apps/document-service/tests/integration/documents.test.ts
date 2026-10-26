import { createHash, randomUUID } from 'node:crypto';
import { readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapAdmin } from '../../src/cli/bootstrap-admin.js';
import { createServiceTestApp } from '../helpers/app.js';
import { login } from '../helpers/session.js';
import { buildPdfFixture } from '../../../../tests/fixtures/pdf.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const password = 'correct password 123456';
const origin = 'http://127.0.0.1:5174';
const pdf = Buffer.from(buildPdfFixture());
function headers(session: { cookie: string; csrfToken: string }) { return { cookie: session.cookie, origin, 'x-csrf-token': session.csrfToken }; }
function multipart(parts: Array<{ name: string; value: string | Buffer; filename?: string }>) {
  const boundary = 'pgl-test-boundary';
  return { contentType: `multipart/form-data; boundary=${boundary}`, payload: Buffer.concat(parts.flatMap(part => [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename === undefined ? '' : `; filename="${part.filename}"`}\r\n${part.filename === undefined ? '' : 'Content-Type: application/pdf\r\n'}\r\n`),
    Buffer.from(part.value), Buffer.from('\r\n'),
  ]).concat(Buffer.from(`--${boundary}--\r\n`))) };
}
async function setup() {
  const test = await createServiceTestApp(); cleanup.push(test.close);
  await bootstrapAdmin(test.db, { username: 'admin', password });
  await test.db.pool.query(`INSERT INTO users (username, password_hash, role) SELECT name, password_hash, 'user'
    FROM users CROSS JOIN (VALUES ('alice'), ('bob')) AS fixture(name) WHERE username = 'admin'`);
  const admin = await login(test.app, 'admin', password); const alice = await login(test.app, 'alice', password); const bob = await login(test.app, 'bob', password);
  const upload = (session = alice, key = randomUUID(), bytes = pdf, title = '100%_source', extra: Array<{name:string;value:string|Buffer;filename?:string}> = []) => {
    const body = multipart([{ name: 'file', filename: '../folder/book.pdf', value: bytes }, { name: 'title', value: title }, ...extra]);
    return test.app.inject({ method: 'POST', url: '/api/v1/documents/pdf', headers: { ...headers(session), 'idempotency-key': key, 'content-type': body.contentType }, payload: body.payload });
  };
  return { ...test, admin, alice, bob, upload };
}

describe('private PDF documents', () => {
  it('preserves PDF identity and denies every other owner including administrators', async () => {
    const { app, alice, bob, admin, upload } = await setup();
    const saved = await upload(); expect(saved.statusCode).toBe(201); const document = saved.json();
    expect(document).toMatchObject({ title: '100%_source', originalFilename: 'book.pdf', saveStatus: 'original-saved', processingStatus: 'awaiting-local-processing', source: { bytes: pdf.length, sha256: createHash('sha256').update(pdf).digest('hex') } });
    const list = await app.inject({ url: '/api/v1/documents', headers: headers(alice) }); expect(list.json().items).toEqual([document]);
    for (const url of [`/api/v1/documents/${document.id}`, `/api/v1/documents/${document.id}/source`, `/api/v1/assets/${document.source.assetId}/content`]) {
      for (const session of [bob, admin]) for (const method of ['GET', 'HEAD'] as const) for (const range of [undefined, 'bytes=0-4']) {
        const denied = await app.inject({ method, url, headers: { ...headers(session), ...(range ? { range } : {}) } });
        expect(denied.statusCode).toBe(404); expect(denied.headers.etag).toBeUndefined(); expect(denied.headers['content-range']).toBeUndefined(); expect(denied.headers['cache-control']).toBe('no-store');
      }
    }
    const downloaded = await app.inject({ url: `/api/v1/documents/${document.id}/source?download=true`, headers: headers(alice) });
    expect(downloaded.rawPayload).toEqual(pdf); expect(downloaded.headers['content-disposition']).toContain("filename*=UTF-8''book.pdf");
    expect(createHash('sha256').update(downloaded.rawPayload).digest('hex')).toBe(document.source.sha256);
    expect((await app.inject({ url: '/api/v1/documents', headers: headers(bob) })).json().total).toBe(0);
  });
  it('serves suffix, open, clamped ranges, HEAD and authenticated 416 metadata', async () => {
    const { app, alice, upload } = await setup(); const document = (await upload()).json(); const url = `/api/v1/assets/${document.source.assetId}/content`;
    for (const [range, start, end] of [['bytes=0-4', 0, 4], ['bytes=-4', pdf.length - 4, pdf.length - 1], [`bytes=${pdf.length - 3}-`, pdf.length - 3, pdf.length - 1], [`bytes=${pdf.length - 3}-99999`, pdf.length - 3, pdf.length - 1]] as const) {
      const response = await app.inject({ url, headers: { ...headers(alice), range } }); expect(response.statusCode).toBe(206); expect(response.rawPayload).toEqual(pdf.subarray(start, end + 1)); expect(response.headers['content-length']).toBe(String(end - start + 1));
      const head = await app.inject({ method: 'HEAD', url, headers: { ...headers(alice), range } }); expect(head.statusCode).toBe(206); expect(head.body).toBe(''); expect(head.headers['content-length']).toBe(response.headers['content-length']);
    }
    const head = await app.inject({ method: 'HEAD', url, headers: headers(alice) }); expect(head.headers['content-length']).toBe(String(pdf.length));
    const invalid = await app.inject({ url, headers: { ...headers(alice), range: 'bytes=0-1,4-5' } }); expect(invalid.statusCode).toBe(416); expect(invalid.headers['content-range']).toBe(`bytes */${pdf.length}`);
    const unauthenticated = await app.inject({ url, headers: { range: 'bytes=0-1,4-5' } }); expect(unauthenticated.statusCode).toBe(401); expect(unauthenticated.headers.etag).toBeUndefined();
  });
  it('isolates idempotency by owner, compares retry bytes and deduplicates only within an owner', async () => {
    const { upload, alice, bob, db } = await setup(); const key = randomUUID();
    const first = (await upload(alice, key)).json(); expect((await upload(alice, key)).json()).toEqual(first);
    expect((await upload(alice, key, Buffer.from(buildPdfFixture(1)))).statusCode).toBe(409);
    expect((await upload(alice)).json()).toEqual(first);
    const other = (await upload(bob, key)).json(); expect(other.id).not.toBe(first.id); expect(other.source.assetId).not.toBe(first.source.assetId);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM documents')).rows[0].n).toBe(2);
  });
  it('validates trailing fields, duplicate titles, extra files, unknown fields and part limits before publication', async () => {
    const { upload, db } = await setup();
    for (const extra of [[{ name: 'ownerId', value: randomUUID() }], [{ name: 'title', value: 'twice' }], [{ name: 'file', filename: 'extra.pdf', value: pdf }], Array.from({ length: 4 }, () => ({ name: 'unknown', value: 'x' }))]) {
      expect((await upload(undefined, undefined, undefined, undefined, extra)).statusCode).toBe(400);
      expect((await db.pool.query('SELECT id FROM documents')).rows).toEqual([]);
    }
  });
  it('rejects invalid PDFs, enforces lower configured size limits and guards write requests', async () => {
    const { app, config, db, alice, upload } = await setup();
    expect((await upload(alice, randomUUID(), Buffer.from('not a pdf'))).statusCode).toBe(400);
    const { createApp } = await import('../../src/app.js'); const small = await createApp({ config: { ...config, maxPdfBytes: 10 }, db }); cleanup.push(() => small.close());
    const body = multipart([{ name: 'file', filename: 'book.pdf', value: pdf }]);
    expect((await small.inject({ method: 'POST', url: '/api/v1/documents/pdf', headers: { ...headers(alice), 'idempotency-key': randomUUID(), 'content-type': body.contentType }, payload: body.payload })).statusCode).toBe(413);
    for (const extra of [{ 'x-csrf-token': 'wrong' }, { origin: 'https://evil.example' }, { 'idempotency-key': '' }]) expect((await app.inject({ method: 'POST', url: '/api/v1/documents/pdf', headers: { ...headers(alice), 'content-type': body.contentType, 'idempotency-key': randomUUID(), ...extra }, payload: body.payload })).statusCode).toBe(extra['idempotency-key'] === '' ? 400 : 403);
    expect((await db.pool.query('SELECT id FROM documents')).rows).toEqual([]);
  });
  it('treats search wildcards literally and rejects unknown list fields', async () => {
    const { app, alice, upload } = await setup(); await upload(); await upload(alice, randomUUID(), Buffer.from(buildPdfFixture(1)), 'ordinary');
    for (const q of ['%', '_', '100%_']) expect((await app.inject({ url: `/api/v1/documents?q=${encodeURIComponent(q)}`, headers: headers(alice) })).json().total).toBe(1);
    expect((await app.inject({ url: '/api/v1/documents?ownerId=evil', headers: headers(alice) })).statusCode).toBe(400);
  });
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function direct(test: Awaited<ReturnType<typeof setup>>, session = test.alice) {
  const { createLocalObjectStore } = await import('../../src/storage/local-object-store.js');
  const { createDocumentsService } = await import('../../src/documents/service.js');
  const actor = { userId: session.user.id, role: session.user.role, authVersion: 1,
    sessionHash: (await test.db.pool.query('SELECT token_hash FROM sessions WHERE user_id = $1', [session.user.id])).rows[0].token_hash as string };
  const store = createLocalObjectStore(test.config.dataDir);
  const service = createDocumentsService({ db: test.db, store });
  const input = (key = randomUUID(), bytes = pdf) => ({ idempotencyKey: key, originalFilename: '..\\folder\\book\r\n.pdf', body: (async function* () { yield bytes; })() });
  return { actor, store, service, input, createDocumentsService };
}

describe('upload failures and lease recovery', () => {
  it('recovers failed storage and commit attempts without publishing bad references or overwriting an existing PDF', async () => {
    const test = await setup(); const { actor, store, service, input, createDocumentsService } = await direct(test);
    const key = randomUUID();
    const failing = createDocumentsService({ db: test.db, store: { ...store, async putImmutable() { throw new Error('storage unavailable'); } } });
    await expect(failing.savePdf(actor, input(key))).rejects.toThrow('storage unavailable');
    expect((await test.db.pool.query('SELECT status, epoch FROM ingestions')).rows).toEqual([{ status: 'failed', epoch: '1' }]);
    const saved = await service.savePdf(actor, input(key)); expect(saved.originalFilename).toBe('book.pdf');
    const original = await test.db.pool.query('SELECT object_key FROM assets WHERE id = $1', [saved.source.assetId]);
    const originalKey = original.rows[0].object_key;
    await test.db.pool.query(`CREATE FUNCTION fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled commit failure'; END; $$`);
    await test.db.pool.query(`CREATE CONSTRAINT TRIGGER fail_document_commit AFTER INSERT ON documents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_commit()`);
    const failedKey = randomUUID();
    await expect(service.savePdf(actor, input(failedKey, Buffer.from(buildPdfFixture(1))))).rejects.toThrow('controlled commit failure');
    expect((await test.db.pool.query('SELECT count(*)::int AS n FROM documents')).rows[0].n).toBe(1);
    expect((await test.db.pool.query('SELECT count(*)::int AS n FROM assets')).rows[0].n).toBe(1);
    expect((await test.db.pool.query('SELECT status FROM ingestions WHERE idempotency_key = $1', [failedKey])).rows[0].status).toBe('failed');
    expect((await store.stat(originalKey)).bytes).toBe(pdf.length);
    await test.db.pool.query('DROP TRIGGER fail_document_commit ON documents');
    await service.savePdf(actor, input(failedKey, Buffer.from(buildPdfFixture(1))));
    expect((await test.db.pool.query('SELECT epoch FROM ingestions WHERE idempotency_key = $1', [failedKey])).rows[0].epoch).toBe('2');
  });
  it('rejects simultaneous retries with Retry-After and prevents stale epochs from committing', async () => {
    const test = await setup(); const { actor, service, input } = await direct(test); const key = randomUUID();
    const reached = deferred(); const release = deferred();
    const first = service.savePdf(actor, { ...input(key), body: (async function* () { yield pdf.subarray(0, 20); reached.resolve(); await release.promise; yield pdf.subarray(20); })() });
    await reached.promise;
    try {
      const conflict = await test.upload(test.alice, key); expect(conflict.statusCode).toBe(409); expect(conflict.headers['retry-after']).toBe('1');
      await test.db.pool.query("UPDATE ingestions SET updated_at = now() - interval '16 minutes' WHERE idempotency_key = $1", [key]);
      const recovered = await service.savePdf(actor, input(key)); expect(recovered.source.sha256).toBe(createHash('sha256').update(pdf).digest('hex'));
    } finally { release.resolve(); }
    await expect(first).rejects.toMatchObject({ statusCode: 409, code: 'UPLOAD_SUPERSEDED' });
    expect((await test.db.pool.query('SELECT status, epoch FROM ingestions')).rows).toEqual([{ status: 'completed', epoch: '2' }]);
    expect((await test.db.pool.query('SELECT id FROM documents')).rows).toHaveLength(1);
  });
  it('rechecks account state after upload and finalize, leaving no readable reference after deactivation', async () => {
    const test = await setup(); const { actor, service, input } = await direct(test);
    const reached = deferred(); const release = deferred();
    const pending = service.savePdf(actor, { ...input(), finalize: async () => { reached.resolve(); await release.promise; return {}; } });
    await reached.promise;
    try { expect((await test.app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${test.alice.user.id}`, headers: headers(test.admin), payload: { active: false } })).statusCode).toBe(200); }
    finally { release.resolve(); }
    await expect(pending).rejects.toMatchObject({ statusCode: 401 });
    expect((await test.db.pool.query('SELECT id FROM documents')).rows).toEqual([]);
  });
  it('fails interrupted streams and finalized validation before creating documents and permits a fresh retry', async () => {
    const test = await setup(); const { actor, service, input } = await direct(test); const key = randomUUID();
    await expect(service.savePdf(actor, { ...input(key), body: (async function* () { yield pdf.subarray(0, 20); throw new Error('stream interrupted'); })() })).rejects.toThrow('stream interrupted');
    let finalized = 0;
    await expect(service.savePdf(actor, { ...input(key), finalize: async () => { finalized++; throw new Error('invalid trailing part'); } })).rejects.toThrow('invalid trailing part');
    expect(finalized).toBe(1); expect((await test.db.pool.query('SELECT id FROM documents')).rows).toEqual([]);
    expect(await readdir(join(test.config.dataDir, 'staging'))).toEqual([]);
    await service.savePdf(actor, input(key));
  });
  it('returns a private 404 when the original file is missing', async () => {
    const test = await setup(); const saved = (await test.upload()).json(); const key = (await test.db.pool.query('SELECT object_key FROM assets WHERE id = $1', [saved.source.assetId])).rows[0].object_key;
    await rm(join(test.config.dataDir, 'objects', key));
    const response = await test.app.inject({ url: `/api/v1/documents/${saved.id}/source`, headers: headers(test.alice) }); expect(response.statusCode).toBe(404); expect(response.headers.etag).toBeUndefined(); expect(response.headers['cache-control']).toBe('no-store');
  });
  it('cleans only day-old unreferenced objects and temporary files', async () => {
    const test = await setup(); const { actor, service, input } = await direct(test); const saved = await service.savePdf(actor, input());
    const key = (await test.db.pool.query('SELECT object_key FROM assets WHERE id = $1', [saved.source.assetId])).rows[0].object_key;
    const old = new Date(Date.now() - 25 * 3600_000); const stale = randomUUID(); const fresh = randomUUID(); const temporary = randomUUID();
    for (const name of [stale, fresh]) await writeFile(join(test.config.dataDir, 'objects', name), 'orphan');
    await writeFile(join(test.config.dataDir, 'staging', temporary), 'partial');
    for (const path of [join(test.config.dataDir, 'objects', stale), join(test.config.dataDir, 'objects', key), join(test.config.dataDir, 'staging', temporary)]) await utimes(path, old, old);
    const { cleanupStaging } = await import('../../src/cli/cleanup-staging.js');
    expect(await cleanupStaging({ db: test.db, dataDir: test.config.dataDir })).toEqual({ objects: 1, staging: 1 });
    expect((await readdir(join(test.config.dataDir, 'objects'))).sort()).toEqual([key, fresh].sort());
    expect(await readdir(join(test.config.dataDir, 'staging'))).toEqual([]);
  });
});

it('accepts title before the file, handles Unicode filenames safely and paginates owner-scoped results', async () => {
  const test = await setup();
  const body = multipart([{ name: 'title', value: 'First title' }, { name: 'file', filename: '中文.pdf', value: pdf }]);
  const saved = await test.app.inject({ method: 'POST', url: '/api/v1/documents/pdf', headers: { ...headers(test.alice), 'idempotency-key': randomUUID(), 'content-type': body.contentType }, payload: body.payload });
  expect(saved.statusCode).toBe(201); expect(saved.json().title).toBe('First title');
  const file = await test.app.inject({ url: `/api/v1/documents/${saved.json().id}/source`, headers: headers(test.alice) });
  expect(file.headers['content-disposition']).toContain("filename*=UTF-8''%E4%B8%AD%E6%96%87.pdf");
  await test.upload(test.alice, randomUUID(), Buffer.from(buildPdfFixture(1)), 'Second title');
  const page = await test.app.inject({ url: '/api/v1/documents?page=2&pageSize=1', headers: headers(test.alice) });
  expect(page.json()).toMatchObject({ total: 2, page: 2, pageSize: 1, items: [{ id: saved.json().id }] });
});

it('rejects unknown detail and upload query fields rather than accepting client ownership hints', async () => {
  const test = await setup(); const saved = (await test.upload()).json();
  expect((await test.app.inject({ url: `/api/v1/documents/${saved.id}?ownerId=${test.bob.user.id}`, headers: headers(test.alice) })).statusCode).toBe(400);
  const body = multipart([{ name: 'file', filename: 'book.pdf', value: pdf }]);
  expect((await test.app.inject({ method: 'POST', url: '/api/v1/documents/pdf?ownerId=evil', headers: { ...headers(test.alice), 'idempotency-key': randomUUID(), 'content-type': body.contentType }, payload: body.payload })).statusCode).toBe(400);
});

it('recognizes a PDF header only within the first 1024 bytes without requiring parser success', async () => {
  const test = await setup(); const { actor, service, input } = await direct(test);
  const accepted = Buffer.concat([Buffer.alloc(1019, 32), Buffer.from('%PDF-')]);
  expect((await service.savePdf(actor, input(randomUUID(), accepted))).processingStatus).toBe('awaiting-local-processing');
  await expect(service.savePdf(actor, input(randomUUID(), Buffer.concat([Buffer.alloc(1020, 32), Buffer.from('%PDF-')])))).rejects.toMatchObject({ statusCode: 400 });
});
