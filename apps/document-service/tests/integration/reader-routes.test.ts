import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import * as objectStorage from '../../src/storage/local-object-store.js';
import { readerDescriptorSchema, readerChunkSchema, readerVersionListSchema } from '@pagelingo/document-contracts';
import { readerTestApp, headers } from '../helpers/readers.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function observeStorage(beforeRead: (key: string) => Promise<void> = async () => {}) {
  const reads = new Map<string, number>(); const original = objectStorage.createLocalObjectStore;
  vi.spyOn(objectStorage, 'createLocalObjectStore').mockImplementation(root => {
    const store = original(root);
    return { ...store, async *read(key, range) {
      reads.set(key, (reads.get(key) ?? 0) + 1); await beforeRead(key); yield* store.read(key, range);
    } };
  });
  return reads;
}
async function imageReferences(t: Awaited<ReturnType<typeof readerTestApp>>, version: string) {
  return (await t.db.pool.query(`SELECT a.id,a.object_key,ir.object_key AS ir_key,idx.object_key AS index_key
    FROM reader_versions r JOIN parse_runs p ON (p.owner_id,p.id)=(r.owner_id,r.parse_id)
    JOIN assets ir ON ir.id=p.ir_asset_id JOIN assets idx ON idx.id=r.index_asset_id
    JOIN bundle_files f ON f.reader_version_id=r.id JOIN assets a ON a.id=f.asset_id
    WHERE r.id=$1 AND a.media_type='image/png' LIMIT 1`, [version])).rows[0];
}
it('reuses only immutable image metadata across GET HEAD and Range while still authorizing and statting every request', async () => {
  const reads = observeStorage(); const t = await readerTestApp(cleanup); const f = await t.ingest();
  const refs = await imageReferences(t, f.version); reads.clear();
  const url = `${f.base}/readers/${f.version}/assets/${refs.id}`;
  for (const [method, range, status] of [['GET', undefined, 200], ['HEAD', undefined, 200], ['GET', 'bytes=0-4', 206]] as const) {
    const result = await t.app.inject({ method, url, headers: { ...headers(t.alice), ...(range ? { range } : {}) } }); expect(result.statusCode).toBe(status);
  }
  expect(reads.get(refs.ir_key)).toBe(1); expect(reads.get(refs.index_key) ?? 0).toBe(0);
  for (const session of [t.bob, t.admin]) expect((await t.app.inject({ url, headers: headers(session) })).statusCode).toBe(404);
  const { rm } = await import('node:fs/promises'); const { join } = await import('node:path'); await rm(join(t.config.dataDir, 'objects', refs.object_key));
  const missing = await t.app.inject({ method: 'HEAD', url, headers: headers(t.alice) }); expect(missing.statusCode).toBe(404); expect(missing.headers.etag).toBeUndefined();
  await t.db.pool.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [t.alice.user.id]);
  expect((await t.app.inject({ url, headers: headers(t.alice) })).statusCode).toBe(401);
  expect(reads.get(refs.ir_key)).toBe(1);
});
it('coalesces concurrent cold image reads without holding the user lock and rechecks revocation after validation', async () => {
  let irKey = ''; let release!: () => void; let entered!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; }); const reached = new Promise<void>(resolve => { entered = resolve; });
  const reads = observeStorage(async key => { if (key === irKey) { entered(); await paused; } });
  const t = await readerTestApp(cleanup); const f = await t.ingest(); const refs = await imageReferences(t, f.version); irKey = refs.ir_key; reads.clear();
  const url = `${f.base}/readers/${f.version}/assets/${refs.id}`;
  const pending = Promise.all(['GET', 'HEAD', 'GET'].map(method => t.app.inject({ method: method as 'GET' | 'HEAD', url, headers: { ...headers(t.alice), range: 'bytes=0-4' } })));
  await reached;
  let responses: Awaited<typeof pending> = [];
  try {
    // Other requests may briefly hold the guard lock; it must become available while IR remains paused.
    await expect.poll(async () => {
      try { await t.db.transaction(client => client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT', [t.alice.user.id])); return true; }
      catch (error) { if ((error as { code?: string }).code !== '55P03') throw error; return false; }
    }, { timeout: 1000, interval: 20 }).toBe(true);
  } finally { release(); responses = await pending; }
  expect(responses.map(response => response.statusCode)).toEqual([206, 206, 206]);
  expect(reads.get(irKey)).toBe(1); expect(reads.get(refs.index_key) ?? 0).toBe(0);
  // A fresh service instance starts cold; revoke while its immutable object read is paused.
  let releaseAgain!: () => void; let enteredAgain!: () => void;
  const pausedAgain = new Promise<void>(resolve => { releaseAgain = resolve; }); const reachedAgain = new Promise<void>(resolve => { enteredAgain = resolve; });
  vi.restoreAllMocks(); observeStorage(async key => { if (key === irKey) { enteredAgain(); await pausedAgain; } });
  const { createApp } = await import('../../src/app.js'); const cold = await createApp({ db: t.db, config: t.config }); cleanup.push(() => cold.close());
  const interrupted = cold.inject({ url, headers: headers(t.alice) }).then(response => response);
  await reachedAgain;
  try { await t.db.pool.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [t.alice.user.id]); }
  finally { releaseAgain(); }
  const revoked = await interrupted; expect(revoked.statusCode).toBe(401); expect(revoked.headers.etag).toBeUndefined();
});
it('imports privately and serves schema-validated descriptors, chunks and paginated historical versions', async () => {
  const t = await readerTestApp(cleanup); const first = await t.ingest({ status: 'completed' });
  const second = await t.ingest({ partialParse: true });
  const descriptor = await t.app.inject({ url: `${first.base}/reader`, headers: headers(t.alice) });
  expect(descriptor.statusCode).toBe(200); const dto = readerDescriptorSchema.parse(descriptor.json());
  expect(dto.versionId).toBe(first.version); expect(dto.progress).toBeNull();
  expect(dto.index.generationKind).toBe('mock');
  const expectedPages = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../../../../packages/document-contracts/fixtures/reader-v1/source-ir.json', import.meta.url), 'utf8')).pages;
  expect(descriptor.json().pages).toEqual(expectedPages);
  expect(readerDescriptorSchema.safeParse({ ...dto, pages: undefined }).success).toBe(false);
  expect(readerDescriptorSchema.safeParse({ ...dto, pages: [] }).success).toBe(false);
  expect(readerDescriptorSchema.safeParse({ ...dto, pages: [...expectedPages].reverse() }).success).toBe(false);
  const historical = await t.app.inject({ url: `${first.base}/reader?versionId=${second.version}`, headers: headers(t.alice) });
  expect(historical.statusCode).toBe(200); expect(historical.json().versionId).toBe(second.version);
  const otherVersionImage = Object.values(historical.json().assetMap)[0];
  expect((await t.app.inject({ url: `${first.base}/readers/${first.version}/assets/${otherVersionImage}`, headers: headers(t.alice) })).statusCode).toBe(404);
  const list = readerVersionListSchema.parse((await t.app.inject({ url: `${first.base}/reader-versions?page=2&pageSize=1`, headers: headers(t.alice) })).json());
  expect(list).toMatchObject({ total: 2, page: 2, pageSize: 1, items: [{ id: first.version }] });
  const chunk = await t.app.inject({ url: `${first.base}/readers/${first.version}/chunks/c_000001`, headers: headers(t.alice) });
  expect(chunk.statusCode).toBe(200); expect(readerChunkSchema.parse(chunk.json()).parseId).toBe(dto.parseId);
  for (const url of [`${first.base}/reader?ownerId=${t.bob.user.id}`, `${first.base}/reader-versions?pageSize=101`]) expect((await t.app.inject({ url, headers: headers(t.alice) })).statusCode).toBe(400);
  expect(JSON.stringify(dto)).not.toMatch(/object_key|objectKey|owner_id|ownerId/);
});
it('denies guessed IDs to other users and administrators before Range metadata and never exposes archive-only files as images', async () => {
  const t = await readerTestApp(cleanup); const f = await t.ingest();
  const d = (await t.app.inject({ url: `${f.base}/reader`, headers: headers(t.alice) })).json();
  const imageId = Object.values(d.assetMap)[0];
  const urls = [`/api/v1/bundle-imports/${f.imported.id}`, `${f.base}/reader`, `${f.base}/reader-versions`, `${f.base}/progress`, `${f.base}/readers/${f.version}/chunks/c_000001`, `${f.base}/readers/${f.version}/assets/${imageId}`, `${f.base}/readers/${f.version}/bundle`];
  for (const session of [t.bob, t.admin]) for (const url of urls) for (const method of ['GET', 'HEAD'] as const) {
    const r = await t.app.inject({ method, url, headers: { ...headers(session), range: 'bytes=0-4' } });
    expect(r.statusCode, url).toBe(404); expect(r.headers.etag).toBeUndefined(); expect(r.headers['content-range']).toBeUndefined(); expect(r.headers['cache-control']).toBe('no-store');
  }
  const archived = (await t.db.pool.query("SELECT asset_id FROM bundle_files WHERE reader_version_id=$1 AND path IN ('render/index.html','render/runtime.js','provenance/input-manifest.json')", [f.version])).rows;
  expect(archived.length).toBeGreaterThan(0);
  for (const row of archived) expect((await t.app.inject({ url: `${f.base}/readers/${f.version}/assets/${row.asset_id}`, headers: headers(t.alice) })).statusCode).toBe(404);
  const other = await t.ingest({}, t.bob);
  for (const suffix of [`assets/${imageId}`, 'chunks/c_000001', 'bundle']) expect((await t.app.inject({ url: `${other.base}/readers/${f.version}/${suffix}`, headers: headers(t.alice) })).statusCode).toBe(404);
});
it('serves exact verified ZIP and image bytes with private Range, HEAD, ETag and missing-object behavior', async () => {
  const t = await readerTestApp(cleanup); const f = await t.ingest();
  const d = (await t.app.inject({ url: `${f.base}/reader`, headers: headers(t.alice) })).json();
  const imageId = Object.values(d.assetMap)[0];
  for (const [suffix, bytes, type] of [['bundle', f.bytes, 'application/zip'], [`assets/${imageId}`, f.files.get('assets/figure.png') ?? [...f.files.entries()].find(([path]) => path.endsWith('.png'))![1], 'image/png']] as const) {
    const url = `${f.base}/readers/${f.version}/${suffix}`;
    const full = await t.app.inject({ url, headers: headers(t.alice) });
    expect(full.statusCode).toBe(200); expect(full.rawPayload).toEqual(bytes); expect(full.headers['content-type']).toBe(type); expect(full.headers['x-content-type-options']).toBe('nosniff');
    expect(full.headers.etag).toMatch(/^"[a-f0-9]{64}"$/); expect(full.headers['cache-control']).toBe('no-store');
    if (suffix === 'bundle') expect(full.headers['content-disposition']).toContain('attachment;');
    for (const [range, start, end] of [['bytes=0-4', 0, 4], ['bytes=-4', bytes.length - 4, bytes.length - 1], [`bytes=${bytes.length - 3}-999999`, bytes.length - 3, bytes.length - 1]] as const) {
      const r = await t.app.inject({ url, headers: { ...headers(t.alice), range } }); expect(r.statusCode).toBe(206); expect(r.rawPayload).toEqual(bytes.subarray(start, end + 1));
      const head = await t.app.inject({ method: 'HEAD', url, headers: { ...headers(t.alice), range } }); expect(head.statusCode).toBe(206); expect(head.body).toBe(''); expect(head.headers['content-length']).toBe(r.headers['content-length']);
    }
    const bad = await t.app.inject({ url, headers: { ...headers(t.alice), range: 'bytes=0-1,4-5' } }); expect(bad.statusCode).toBe(416); expect(bad.headers['content-range']).toBe(`bytes */${bytes.length}`);
    expect((await t.app.inject({ url, headers: { range: 'bytes=0-1,4-5' } })).statusCode).toBe(401);
  }
  const row = (await t.db.pool.query('SELECT object_key FROM assets WHERE id=$1', [imageId])).rows[0];
  const { rm } = await import('node:fs/promises'); const { join } = await import('node:path'); await rm(join(t.config.dataDir, 'objects', row.object_key));
  const missing = await t.app.inject({ url: `${f.base}/readers/${f.version}/assets/${imageId}`, headers: headers(t.alice) }); expect(missing.statusCode).toBe(404); expect(missing.headers.etag).toBeUndefined();
});
it('authenticates ZIP before body consumption and enforces write guards and completed import immutability', async () => {
  const t = await readerTestApp(cleanup);
  const url = `/api/v1/bundle-imports/${randomUUID()}/content`;
  let consumed = false; const stream = new Readable({ read() { consumed = true; this.push(Buffer.from('x')); this.push(null); } });
  const denied = await t.app.inject({ method: 'PUT', url, headers: { 'content-type': 'application/zip' }, payload: stream });
  expect(denied.statusCode).toBe(401); expect(consumed).toBe(false);
  const f = await t.ingest();
  for (const extra of [{ 'x-csrf-token': 'wrong' }, { origin: 'https://evil.example' }]) {
    for (const [method, endpoint, payload] of [['POST', '/api/v1/bundle-imports', {}], ['POST', `/api/v1/bundle-imports/${f.imported.id}/cancel`, {}], ['PUT', `${f.base}/progress`, {}]] as const) expect((await t.app.inject({ method, url: endpoint, headers: { ...headers(t.alice), ...extra, 'idempotency-key': randomUUID() }, payload })).statusCode).toBe(403);
  }
  const overwrite = await t.app.inject({ method: 'PUT', url: `/api/v1/bundle-imports/${f.imported.id}/content`, headers: { ...headers(t.alice), 'content-type': 'application/zip' }, payload: Buffer.from('invalid') });
  expect(overwrite.statusCode).toBe(409); expect(overwrite.json().error.code).toBe('BUNDLE_IMPORT_COMPLETED');
  expect((await t.app.inject({ url: '/api/v1/bundle-imports/limits', headers: headers(t.alice) })).json()).toEqual(t.config.bundleLimits);
  for (const [payload, session, status] of [[{ ownerId: t.bob.user.id }, t.alice, 400], [{ targetDocumentId: f.imported.documentId }, t.bob, 404], [{ targetDocumentId: f.imported.documentId }, t.admin, 404]] as const) expect((await t.app.inject({ method: 'POST', url: '/api/v1/bundle-imports', headers: { ...headers(session), 'idempotency-key': randomUUID() }, payload })).statusCode).toBe(status);
});
it('returns frozen missing-resource, identity and size errors while retaining the earlier Reader', async () => {
  const t = await readerTestApp(cleanup); const f = await t.ingest();
  const created = (await t.app.inject({ method: 'POST', url: '/api/v1/bundle-imports', headers: { ...headers(t.alice), 'idempotency-key': randomUUID() }, payload: {} })).json();
  const url = `/api/v1/bundle-imports/${created.id}/content`;
  const { ZipFile } = await import('yazl'); const zip = new ZipFile(); const parts: Buffer[] = [];
  const zipped = (async () => { for await (const chunk of zip.outputStream) parts.push(Buffer.from(chunk)); return Buffer.concat(parts); })();
  for (const [path, bytes] of f.files) if (path !== 'source.pdf') zip.addBuffer(bytes, path);
  zip.end();
  const missing = await t.app.inject({ method: 'PUT', url, headers: { ...headers(t.alice), 'content-type': 'application/zip' }, payload: await zipped });
  expect(missing.statusCode).toBe(400); expect(missing.json().error.code).toBe('BUNDLE_MISSING_RESOURCE');
  const { bundleFixture } = await import('../helpers/bundles.js');
  const changed = await bundleFixture(t.config.dataDir, { packageId: f.manifest.packageId, status: 'completed' });
  const conflict = await t.app.inject({ method: 'PUT', url, headers: { ...headers(t.alice), 'content-type': 'application/zip' }, payload: changed.bytes });
  expect(conflict.statusCode).toBe(409); expect(conflict.json().error.code).toBe('BUNDLE_IDENTITY_CONFLICT');
  const { createApp } = await import('../../src/app.js');
  const small = await createApp({ db: t.db, config: { ...t.config, bundleLimits: { ...t.config.bundleLimits, maxArchiveBytes: 4 } } }); cleanup.push(() => small.close());
  const oversized = await small.inject({ method: 'PUT', url, headers: { ...headers(t.alice), 'content-type': 'application/zip' }, payload: Buffer.from('12345') });
  expect(oversized.statusCode).toBe(413); expect(oversized.json().error.code).toBe('BUNDLE_TOO_LARGE');
  expect((await t.app.inject({ url: `${f.base}/reader`, headers: headers(t.alice) })).json().versionId).toBe(f.version);
  expect((await t.app.inject({ url: `/api/v1/bundle-imports/${created.id}`, headers: headers(t.alice) })).json()).toMatchObject({ status: 'failed', errorCode: 'BUNDLE_TOO_LARGE' });
});
it('maps source mismatch publicly, persists safe failures, lists only the newest 20 imports and isolates idempotency', async () => {
  const t = await readerTestApp(cleanup); const first = await t.ingest();
  const key = randomUUID();
  const create = (payload = {}, session = t.alice) => t.app.inject({ method: 'POST', url: '/api/v1/bundle-imports', headers: { ...headers(session), 'idempotency-key': key }, payload });
  const c = await create({ targetDocumentId: first.imported.documentId }); expect(c.statusCode).toBe(201);
  expect((await create({ targetDocumentId: first.imported.documentId })).json()).toEqual(c.json());
  expect((await create()).json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  expect((await create({}, t.bob)).json().id).not.toBe(c.json().id);
  const { bundleFixture } = await import('../helpers/bundles.js');
  const { createHash } = await import('node:crypto');
  const changed = await bundleFixture(t.config.dataDir, { edit(files) {
    const pdf = Buffer.from('%PDF-1.7\ndifferent original\n%%EOF\n'); files.set('source.pdf', pdf);
    const ir = JSON.parse(files.get('source-ir.json')!.toString()), translation = JSON.parse(files.get('translation.json')!.toString()), manifest = JSON.parse(files.get('manifest.json')!.toString());
    const sha256 = createHash('sha256').update(pdf).digest('hex'); ir.source.sha256 = sha256; ir.source.bytes = pdf.length;
    ir.parse.id = 'p_' + createHash('sha256').update(sha256 + ir.parse.inputManifestSha256 + ir.parse.projectorVersion + ir.parse.configSha256).digest('hex');
    translation.sourceSha256 = sha256; translation.parseId = ir.parse.id; manifest.source = { ...manifest.source, sha256, bytes: pdf.length }; manifest.parse.id = ir.parse.id;
    files.set('source-ir.json', Buffer.from(JSON.stringify(ir))); files.set('translation.json', Buffer.from(JSON.stringify(translation))); files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  } });
  const uploadUrl = `/api/v1/bundle-imports/${c.json().id}/content`;
  const mismatch = await t.app.inject({ method: 'PUT', url: uploadUrl, headers: { ...headers(t.alice), 'content-type': 'application/zip' }, payload: changed.bytes });
  expect(mismatch.statusCode).toBe(409); expect(mismatch.json().error.code).toBe('SOURCE_MISMATCH');
  expect((await t.app.inject({ url: `/api/v1/bundle-imports/${c.json().id}`, headers: headers(t.alice) })).json()).toMatchObject({ status: 'failed', errorCode: 'SOURCE_MISMATCH' });
  const invalid = await t.app.inject({ method: 'PUT', url: uploadUrl, headers: { ...headers(t.alice), 'content-type': 'application/zip' }, payload: Buffer.from('broken') });
  expect(invalid.statusCode).toBe(400); expect(invalid.json().error.code).toBe('INVALID_BUNDLE'); expect(invalid.body).not.toContain(t.config.dataDir);
  const rows = await t.db.pool.query(`INSERT INTO bundle_imports (owner_id,idempotency_key,request_hash,status) SELECT $1,'history-'||i,repeat('0',64),'cancelled' FROM generate_series(1,23) i RETURNING id`, [t.alice.user.id]);
  const listed = await t.app.inject({ url: '/api/v1/bundle-imports', headers: headers(t.alice) }); expect(listed.json()).toHaveLength(20); expect(listed.json().every((item: { id: string }) => rows.rows.some(row => row.id === item.id))).toBe(true);
  expect((await t.app.inject({ url: `${first.base}/reader`, headers: headers(t.alice) })).json().versionId).toBe(first.version);
});
it('records real HTTP disconnects as queryable failures without publishing a Reader', async () => {
  const t = await readerTestApp(cleanup);
  const created = (await t.app.inject({ method: 'POST', url: '/api/v1/bundle-imports', headers: { ...headers(t.alice), 'idempotency-key': randomUUID() }, payload: {} })).json();
  const address = await t.app.listen({ host: '127.0.0.1', port: 0 });
  const { request } = await import('node:http');
  const req = request(`${address}/api/v1/bundle-imports/${created.id}/content`, { method: 'PUT', headers: { ...headers(t.alice), 'content-type': 'application/zip', 'content-length': 100000 } });
  req.on('error', () => {}); req.write(Buffer.from('PK'));
  async function status() { return (await t.app.inject({ url: `/api/v1/bundle-imports/${created.id}`, headers: headers(t.alice) })).json(); }
  try { await expect.poll(async () => (await status()).status).toBe('receiving'); }
  finally { req.destroy(); }
  await expect.poll(async () => (await status()).status).toBe('failed');
  expect((await status()).errorCode).toBe('BUNDLE_ABORTED');
  expect((await t.db.pool.query('SELECT id FROM reader_versions')).rows).toEqual([]);
});
it('keeps already published versions readable after upload byte budgets are tightened', async () => {
  const t = await readerTestApp(cleanup); const f = await t.ingest();
  const { createApp } = await import('../../src/app.js');
  const restarted = await createApp({ db: t.db, config: { ...t.config, bundleLimits: { ...t.config.bundleLimits, maxIrBytes: 1, maxExpandedBytes: 1 } } });
  cleanup.push(() => restarted.close());
  for (const suffix of ['reader', `readers/${f.version}/chunks/c_000001`]) expect((await restarted.inject({ url: `${f.base}/${suffix}`, headers: headers(t.alice) })).statusCode).toBe(200);
});
it('upgrades a populated S1 schema without changing original references and migrates an empty database', async () => {
  const { createTestDatabase } = await import('../helpers/database.js');
  const { migrateDatabase, verifyDatabaseSchema } = await import('../../src/db/migrate.js');
  const { readFile, readdir } = await import('node:fs/promises'); const { createHash } = await import('node:crypto');
  // Resolve from tests/integration to the service's migration directory.
  const directory = new URL('../../migrations/', import.meta.url);
  for (const upgrade of [false, true]) {
    const test = await createTestDatabase(); cleanup.push(test.dispose);
    if (upgrade) {
      await test.db.pool.query('CREATE TABLE schema_migrations (id text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
      for (const name of (await readdir(directory)).filter(name => /^00[1-4]-.*\.sql$/.test(name)).sort()) {
        const sql = await readFile(new URL(name, directory), 'utf8'); await test.db.pool.query(sql);
        await test.db.pool.query('INSERT INTO schema_migrations (id,checksum) VALUES ($1,$2)', [name.slice(0, -4), createHash('sha256').update(sql).digest('hex')]);
      }
      const owner = (await test.db.pool.query("INSERT INTO users (username,password_hash) VALUES ('s1-user','hash') RETURNING id")).rows[0].id;
      const document = (await test.db.pool.query("INSERT INTO documents (owner_id,title,original_filename) VALUES ($1,'old','old.pdf') RETURNING id", [owner])).rows[0].id;
      const asset = (await test.db.pool.query("INSERT INTO assets (owner_id,document_id,object_key,sha256,bytes,media_type) VALUES ($1,$2,$3,repeat('a',64),7,'application/pdf') RETURNING id", [owner, document, randomUUID()])).rows[0].id;
      const source = (await test.db.pool.query("INSERT INTO source_versions (owner_id,document_id,asset_id,sha256,bytes) VALUES ($1,$2,$3,repeat('a',64),7) RETURNING id", [owner, document, asset])).rows[0].id;
      await test.db.pool.query('UPDATE documents SET current_source_version_id=$1 WHERE id=$2', [source, document]);
      await migrateDatabase(test.db);
      expect((await test.db.pool.query('SELECT current_source_version_id,current_reader_version_id FROM documents WHERE id=$1', [document])).rows[0]).toEqual({ current_source_version_id: source, current_reader_version_id: null });
      expect((await test.db.pool.query('SELECT asset_id FROM source_versions WHERE id=$1', [source])).rows[0].asset_id).toBe(asset);
    } else await migrateDatabase(test.db);
    await verifyDatabaseSchema(test.db); await migrateDatabase(test.db);
    expect((await test.db.pool.query('SELECT count(*)::int AS total FROM schema_migrations')).rows[0].total).toBe(6);
  }
});
