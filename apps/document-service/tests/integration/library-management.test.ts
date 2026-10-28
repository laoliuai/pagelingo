import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { bootstrapAdmin } from '../../src/cli/bootstrap-admin.js';
import { createServiceTestApp } from '../helpers/app.js';
import { createTestDatabase } from '../helpers/database.js';
import { login } from '../helpers/session.js';
import { buildPdfFixture } from '../../../../tests/fixtures/pdf.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup() {
  let modelCalls = 0;
  const t = await createServiceTestApp({ outboundFetch: async () => { modelCalls++; throw new Error('Unexpected model/network call'); } }); cleanup.push(t.close);
  const password = 'correct password 123456';
  await bootstrapAdmin(t.db, { username: 'admin', password });
  await t.db.pool.query(`INSERT INTO users (username,password_hash,role) SELECT name,password_hash,'user'
    FROM users CROSS JOIN (VALUES ('alice'),('bob')) AS f(name) WHERE username='admin'`);
  const admin = await login(t.app, 'admin', password), alice = await login(t.app, 'alice', password), bob = await login(t.app, 'bob', password);
  const headers = (s = alice) => ({ cookie: s.cookie, origin: t.config.publicOrigin, 'x-csrf-token': s.csrfToken });
  const request = (method: 'GET'|'POST'|'PATCH'|'DELETE', url: string, payload?: Record<string, unknown>, s = alice) => t.app.inject({ method, url, headers: headers(s), ...(payload === undefined ? {} : { payload }) });
  const save = async (url: string, extra = {}, s = alice) => {
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/documents/links', headers: { ...headers(s), 'idempotency-key': randomUUID() }, payload: { url, translationIntent: 'none', ...extra } });
    expect(r.statusCode, r.body).toBe(201); return r.json().documentId as string;
  };
  const taxonomy = async (type: 'collections'|'tags', name: string, s = alice) => { const r = await request('POST', `/api/v1/${type}`, { name }, s); expect(r.statusCode, r.body).toBe(201); return r.json().id as string; };
  const pdf = async () => {
    const { createDocumentsService } = await import('../../src/documents/service.js');
    const { createLocalObjectStore } = await import('../../src/storage/local-object-store.js');
    const sessionHash = (await t.db.pool.query('SELECT token_hash FROM sessions WHERE user_id=$1', [alice.user.id])).rows[0].token_hash as string;
    return createDocumentsService({ db: t.db, store: createLocalObjectStore(t.config.dataDir) }).savePdf({ userId: alice.user.id, role: alice.user.role, authVersion: 1, sessionHash }, { idempotencyKey: randomUUID(), originalFilename: 'book.pdf', body: (async function* () { yield Buffer.from(buildPdfFixture()); })() });
  };
  return { ...t, alice, bob, admin, headers, request, save, taxonomy, pdf, modelCalls: () => modelCalls };
}

it('isolates organization and combines filters without duplicate rows', async () => {
  const t = await setup();
  const collection = await t.taxonomy('collections', '  中文书架  ');
  const tagA = await t.taxonomy('tags', '机器学习'), tagB = await t.taxonomy('tags', '阅读');
  const foreignTag = await t.taxonomy('tags', '秘密', t.bob);
  const first = await t.save('https://www.zhihu.com/question/1', { title: '100%_\\手册', organization: { collectionId: collection, tagIds: [tagA, tagB] } });
  await t.save('https://mp.weixin.qq.com/s/2', { title: 'ordinary', organization: { collectionId: collection, tagIds: [tagA] } });
  const pdf = await t.pdf();
  const initial = await t.request('GET', `/api/v1/documents/${pdf.id}/organization`);
  expect(initial.statusCode, initial.body).toBe(200);
  expect(initial.json()).toMatchObject({ revision: 0, lifecycleEpoch: 1, tagIds: [], collectionId: null, readingStatus: 'unread' });
  const patch = await t.request('PATCH', `/api/v1/documents/${first}/organization`, { expectedRevision: 0, note: '收藏笔记', readingStatus: 'reading' }); expect(patch.statusCode, patch.body).toBe(200);
  const query = `collectionId=${collection}&tagIds=${tagA}&tagIds=${tagB}&kind=article&origin=zhihu&readingStatus=reading`;
  const result = await t.request('GET', `/api/v1/library?${query}`);
  expect(result.statusCode, result.body).toBe(200); expect(result.json()).toMatchObject({ total: 1, page: 1, pageSize: 20, items: [{ document: { id: first }, organization: { documentId: first, note: '收藏笔记' }, origin: 'zhihu' }] });
  expect(new Set(result.json().items.map((v: {document:{id:string}}) => v.document.id)).size).toBe(result.json().total);
  for (const q of ['%', '_', '\\', '收藏笔记', '手册', 'zhihu.com']) {
    const matches = (await t.request('GET', `/api/v1/library?q=${encodeURIComponent(q)}`)).json();
    expect(matches.total).toBe(1); expect(matches.items.map((v: {document:{id:string}}) => v.document.id)).toEqual([first]);
  }
  const byTagName = (await t.request('GET', '/api/v1/library?q=机器学习')).json();
  expect(byTagName.total).toBe(2); expect(new Set(byTagName.items.map((v: {document:{id:string}}) => v.document.id)).size).toBe(2);
  for (const session of [t.bob, t.admin]) {
    expect((await t.request('GET', `/api/v1/documents/${first}/organization`, undefined, session)).statusCode).toBe(404);
    expect((await t.request('GET', `/api/v1/library?collectionId=${collection}`, undefined, session)).statusCode).toBe(404);
  }
  expect((await t.request('GET', `/api/v1/library?tagIds=${foreignTag}`)).statusCode).toBe(404);
  expect((await t.request('GET', `/api/v1/library?tagIds=${tagA},${tagB}`)).statusCode).toBe(400);
  expect((await t.request('GET', `/api/v1/library?tagIds=${tagA}&tagIds=${tagA.toUpperCase()}`)).statusCode).toBe(400);
  expect((await t.request('POST', '/api/v1/collections', { name: '中文书架' })).statusCode).toBe(409);
  const latin = await t.taxonomy('tags', 'ＡＢＣ'); expect((await t.request('POST', '/api/v1/tags', { name: 'abc' })).statusCode).toBe(409);
  expect((await t.request('GET', '/api/v1/tags?limit=101')).statusCode).toBe(400);
  expect((await t.request('GET', '/api/v1/tags?q=机器')).json().items.map((v:{id:string}) => v.id)).toEqual([tagA]);
  const page = (await t.request('GET', '/api/v1/tags?limit=1')).json(); expect(page.items).toHaveLength(1); expect(page.nextCursor).toBe(page.items[0].id);
  const next = (await t.request('GET', `/api/v1/tags?limit=100&cursor=${page.nextCursor}`)).json(); expect(next.items.map((v:{id:string}) => v.id)).not.toContain(page.nextCursor);
  expect((await t.request('PATCH', `/api/v1/tags/${latin}`, { name: '新标签' })).statusCode).toBe(200);
  const before = (await t.db.pool.query('SELECT row_to_json(o) AS row FROM document_organization o ORDER BY document_id')).rows;
  await t.db.pool.query(`CREATE FUNCTION reject_management_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'GET wrote data'; END; $$`);
  for (const table of ['documents', 'document_organization', 'document_search_metadata', 'document_tags']) await t.db.pool.query(`CREATE TRIGGER no_get_write BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION reject_management_write()`);
  expect((await t.request('GET', '/api/v1/library?q=手册')).statusCode).toBe(200);
  expect((await t.request('GET', `/api/v1/documents/${first}/organization`)).statusCode).toBe(200);
  expect((await t.db.pool.query('SELECT row_to_json(o) AS row FROM document_organization o ORDER BY document_id')).rows).toEqual(before);
  for (const table of ['documents', 'document_organization', 'document_search_metadata', 'document_tags']) await t.db.pool.query(`DROP TRIGGER no_get_write ON ${table}`);
  expect((await t.request('DELETE', `/api/v1/tags/${tagA}`)).statusCode).toBe(204);
  expect((await t.request('DELETE', `/api/v1/collections/${collection}`)).statusCode).toBe(204);
  expect((await t.request('GET', `/api/v1/documents/${first}/organization`)).json()).toMatchObject({ collectionId: null, tagIds: [tagB], revision: 3 });
  expect((await t.request('GET', `/api/v1/documents/${first}`)).statusCode).toBe(200);
  expect(t.modelCalls()).toBe(0);
});

it('protects concurrent metadata edits and user titles', async () => {
  const t = await setup(); const id = await t.save('https://www.zhihu.com/question/3');
  const updates = await Promise.all(['First', 'Second'].map(title => t.request('PATCH', `/api/v1/documents/${id}/organization`, { expectedRevision: 0, title })));
  expect(updates.map(r => r.statusCode).sort()).toEqual([200, 409]); expect(updates.find(r => r.statusCode === 409)!.json().error.code).toBe('METADATA_CONFLICT');
  expect((await t.db.pool.query('SELECT title_origin FROM documents WHERE id=$1', [id])).rows[0].title_origin).toBe('user');
  const { projectSearchMetadata } = await import('../../src/document-management/metadata-projection.js');
  expect(await t.db.transaction(c => projectSearchMetadata(c, { ownerId: t.alice.user.id, documentId: id, sourceVersionId: null, parseId: null, sourceSha256: null, metadata: { title: 'Incoming source', authors: ['Someone'], url: 'https://www.zhihu.com/question/3' } }))).toBe(true);
  const current = (await t.request('GET', `/api/v1/documents/${id}/organization`)).json(); expect(['First', 'Second']).toContain(current.title);
  expect((await t.request('PATCH', `/api/v1/documents/${id}/organization`, { expectedRevision: 1, lifecycleEpoch: 2, note: 'bad' })).statusCode).toBe(400);
  await t.db.pool.query("UPDATE documents SET title=$2,title_origin='legacy' WHERE id=$1", [id, '旧'.repeat(2100)]);
  await t.db.transaction(c => projectSearchMetadata(c, { ownerId:t.alice.user.id,documentId:id,sourceVersionId:null,parseId:null,sourceSha256:null,metadata:{title:'Incoming legacy replacement'} }));
  expect((await t.request('GET', `/api/v1/library?q=${encodeURIComponent('旧旧')}`)).json().items[0].organization.title).toHaveLength(2100);
  expect((await t.request('PATCH', `/api/v1/documents/${id}/organization`, { expectedRevision: 1, note: 'keep long title' })).statusCode).toBe(200);
  expect((await t.request('PATCH', `/api/v1/documents/${id}/organization`, { expectedRevision: 2, title: 'x'.repeat(501) })).statusCode).toBe(400);
  expect((await t.app.inject({ method: 'PATCH', url: `/api/v1/documents/${id}/organization`, headers: { cookie: t.alice.cookie }, payload: { expectedRevision: 2, note: 'unauthorized' } })).statusCode).toBe(403);
});

it('only relates two owned active documents', async () => {
  const t = await setup(); const a = await t.save('https://x.com/a/status/1'), b = await t.save('https://github.com/org/repo'), foreign = await t.save('https://arxiv.org/abs/1234.12345', {}, t.bob);
  const relation = { fromDocumentId: a, toDocumentId: b, kind: 'related' };
  for (let n = 0; n < 2; n++) expect((await t.request('POST', '/api/v1/document-relations', relation)).statusCode).toBe(200);
  expect((await t.request('GET', `/api/v1/documents/${a}/relations`)).json().items).toHaveLength(1);
  expect((await t.request('GET', `/api/v1/documents/${b}/relations`)).json().items).toHaveLength(1);
  expect((await t.request('POST', '/api/v1/document-relations', { ...relation, toDocumentId: a.toUpperCase() })).statusCode).toBe(400);
  expect((await t.request('POST', '/api/v1/document-relations', { ...relation, toDocumentId: foreign })).statusCode).toBe(404);
  expect((await t.request('POST', '/api/v1/document-relations', relation, t.admin)).statusCode).toBe(404);
  await t.db.pool.query("UPDATE documents SET deleted_at=now(),purge_after=now()+interval '30 days' WHERE id=$1", [b]);
  expect((await t.request('POST', '/api/v1/document-relations', relation)).statusCode).toBe(404);
  expect((await t.request('GET', `/api/v1/documents/${a}/relations`)).json().items).toHaveLength(0);
  expect((await t.request('GET', '/api/v1/documents')).json().items.map((d:{id:string}) => d.id)).not.toContain(b);
  expect((await t.request('GET', '/api/v1/library')).json().items.map((v:{document:{id:string}}) => v.document.id)).not.toContain(b);
  await expect(t.db.pool.query('INSERT INTO document_relations (owner_id,from_document_id,to_document_id,kind) VALUES ($1,$2,$3,$4)', [t.bob.user.id, a, foreign, 'related'])).rejects.toMatchObject({ code: '23503' });
});

it('upgrades 001–006 without changing existing owner, source, Reader or reading progress', async () => {
  const fixture = await createTestDatabase(); cleanup.push(fixture.dispose); const db = fixture.db;
  const directory = new URL('../../migrations/', import.meta.url);
  const names = (await readdir(directory)).filter(n => /^00[1-6]-.*\.sql$/.test(n)).sort();
  await db.pool.query('CREATE TABLE schema_migrations (id text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of names) { const sql = await readFile(new URL(name, directory), 'utf8'); await db.transaction(async c => { await c.query(sql); await c.query('INSERT INTO schema_migrations(id,checksum) VALUES($1,$2)', [name.slice(0,-4),createHash('sha256').update(sql).digest('hex')]); }); }
  const owner = (await db.pool.query("INSERT INTO users(username,password_hash) VALUES('legacy','hash') RETURNING id")).rows[0].id;
  const id = (await db.pool.query("INSERT INTO documents(owner_id,title,original_filename) VALUES($1,$2,'legacy.pdf') RETURNING id", [owner,'古'.repeat(2500)])).rows[0].id;
  const asset = (await db.pool.query("INSERT INTO assets(owner_id,document_id,object_key,sha256,bytes,media_type) VALUES($1,$2,'old',repeat('a',64),5,'application/pdf') RETURNING id", [owner,id])).rows[0].id;
  const source = (await db.pool.query("INSERT INTO source_versions(owner_id,document_id,asset_id,sha256,bytes) VALUES($1,$2,$3,repeat('a',64),5) RETURNING id", [owner,id,asset])).rows[0].id;
  await db.pool.query('UPDATE documents SET current_source_version_id=$2 WHERE id=$1', [id,source]);
  const parse = `p_${'b'.repeat(64)}`, translation = randomUUID(), reader = randomUUID();
  await db.pool.query("INSERT INTO parse_runs(id,owner_id,document_id,source_version_id,ir_asset_id,ir_sha256,status,coverage,warnings) VALUES($1,$2,$3,$4,$5,repeat('a',64),'complete','full','[]')", [parse,owner,id,source,asset]);
  await db.pool.query("INSERT INTO translation_runs(id,owner_id,document_id,source_version_id,parse_id,translation_asset_id,sha256,status) VALUES($1,$2,$3,$4,$5,$6,repeat('a',64),'completed')", [translation,owner,id,source,parse,asset]);
  await db.pool.query("INSERT INTO reader_versions(id,owner_id,document_id,source_version_id,parse_id,translation_id,package_id,manifest_sha256,archive_asset_id,index_asset_id) VALUES($1,$2,$3,$4,$5,$6,$7,repeat('c',64),$8,$8)", [reader,owner,id,source,parse,translation,randomUUID(),asset]);
  await db.pool.query('UPDATE documents SET current_reader_version_id=$2 WHERE id=$1', [id,reader]);
  const position = { readerVersionId:reader,sourceVersionId:source,parseId:parse,blockId:null,blockOffset:0.5,pdfPageIndex:0,view:'split',contentMode:'source' };
  await db.pool.query('INSERT INTO reading_state(owner_id,document_id,revision,source_version_id,parse_id,reader_version_id,position) VALUES($1,$2,7,$3,$4,$5,$6)', [owner,id,source,parse,reader,JSON.stringify(position)]);
  await db.pool.query('INSERT INTO reading_positions(owner_id,document_id,source_version_id,parse_id,reader_version_id,position) VALUES($1,$2,$3,$4,$5,$6)', [owner,id,source,parse,reader,JSON.stringify(position)]);
  const snapshot = async () => ({ documents: (await db.pool.query('SELECT id,owner_id,kind,title,original_filename,current_source_version_id,current_reader_version_id,created_at,updated_at FROM documents')).rows, sources: (await db.pool.query('SELECT * FROM source_versions')).rows, readers: (await db.pool.query('SELECT * FROM reader_versions')).rows, progress: (await db.pool.query('SELECT * FROM reading_state')).rows, history: (await db.pool.query('SELECT * FROM reading_positions')).rows });
  const before = await snapshot(); const { migrateDatabase } = await import('../../src/db/migrate.js'); await migrateDatabase(db); expect(await snapshot()).toEqual(before);
  expect((await db.pool.query('SELECT revision,reading_status FROM document_organization')).rows).toEqual([{ revision: '0', reading_status: 'unread' }]);
  expect((await db.pool.query('SELECT title_origin,lifecycle_epoch,origin FROM documents')).rows).toEqual([{ title_origin: 'legacy', lifecycle_epoch: '1', origin: 'upload' }]);
  await migrateDatabase(db); expect((await db.pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n).toBe(7);
});

it('binds backfill to the selected source when a new capture wins during object reads', async () => {
  const t = await setup();
  const { capture } = await import('../helpers/web-capture.js');
  const { createLocalObjectStore } = await import('../../src/storage/local-object-store.js');
  const { runMetadataBackfill } = await import('../../src/document-management/metadata-projection.js');
  const store = createLocalObjectStore(t.config.dataDir);
  const collection = await t.taxonomy('collections', '资料');
  const saveCapture = async (title: string, author: string, capturedAt: string) => {
    const value = capture(`<article><h1>${title}</h1><p>这是可以直接阅读的中文原文，内容${title}无需翻译。</p></article>`);
    value.manifest.metadata = { ...value.manifest.metadata, title, author, capturedAt };
    const created = await t.app.inject({ method: 'POST', url: '/api/v1/captures', headers: { ...t.headers(), 'idempotency-key': value.manifest.captureId }, payload: { manifest: value.manifest, translationIntent: 'none', organization: { collectionId: collection, tagIds: [] } } });
    expect(created.statusCode, created.body).toBe(201);
    expect((await t.app.inject({ method: 'PUT', url: `/api/v1/captures/${created.json().id}/files/html`, headers: { ...t.headers(), 'content-type': 'text/html' }, payload: value.body })).statusCode).toBe(200);
    const committed = await t.request('POST', `/api/v1/captures/${created.json().id}/commit`, {}); expect(committed.statusCode, committed.body).toBe(200); return committed.json();
  };
  const first = await saveCapture('旧源', 'Old author', '2026-10-27T00:00:00.000Z');
  expect((await t.request('GET', `/api/v1/documents/${first.documentId}/organization`)).json()).toMatchObject({ collectionId: collection, revision: 0 });
  expect((await t.request('GET', '/api/v1/library?q=Old%20author')).json().total).toBe(1);
  await t.db.pool.query('DELETE FROM document_search_metadata');
  let newer: Awaited<ReturnType<typeof saveCapture>> | undefined;
  const racingStore = { ...store, async *read(key: string) {
    // Any transaction spanning object I/O would prevent this NOWAIT owner lock.
    await t.db.transaction(async c => {
      await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT', [t.alice.user.id]);
      await c.query('SELECT singleton FROM document_metadata_backfill_cursor WHERE singleton FOR UPDATE NOWAIT');
    });
    newer = await saveCapture('新源', 'Fresh author', '2026-10-28T00:00:00.000Z');
    yield* store.read(key);
  } };
  const result = await runMetadataBackfill({ db: t.db, store: racingStore, signal: new AbortController().signal }, { limit: 20 });
  expect(result).toEqual({ selected: 1, projected: 0, skipped: 1, failed: 0 });
  expect(newer!.sourceVersionId).not.toBe(first.sourceVersionId);
  expect((await t.db.pool.query('SELECT source_version_id,authors FROM document_search_metadata')).rows).toEqual([{ source_version_id: newer!.sourceVersionId, authors: 'Fresh author' }]);
  expect((await t.request('GET', '/api/v1/library?q=Old%20author')).json().total).toBe(0);
  expect((await t.request('GET', '/api/v1/library?q=Fresh%20author')).json().total).toBe(1);
  expect((await t.request('GET', `/api/v1/documents/${first.documentId}/organization`)).json().title).toBe('新源');
  await t.db.pool.query('DELETE FROM document_search_metadata');
  const bounded = await runMetadataBackfill({ db: t.db, store, signal: new AbortController().signal }, { limit: 1 });
  expect(bounded).toEqual({ selected: 1, projected: 1, skipped: 0, failed: 0 });
  expect((await t.request('GET', '/api/v1/library?q=Fresh%20author')).json().total).toBe(1);
  await expect(runMetadataBackfill({ db: t.db, store, signal: new AbortController().signal }, { limit: 101 })).rejects.toThrow(/limit/);
});

it('initializes only new saves and rolls back documents when organization initialization fails', async () => {
  const t = await setup(); const a = await t.taxonomy('collections', 'Original'), b = await t.taxonomy('collections', 'Retry');
  const source = await t.save('https://x.com/u/status/100');
  const id = await t.save('https://github.com/a/b', { title: 'My repository', organization: { collectionId: a, tagIds: [] }, discoveredFromDocumentId: source });
  expect((await t.request('GET', `/api/v1/documents/${id}/relations`)).json().items).toMatchObject([{ fromDocumentId: id, toDocumentId: source, kind: 'discovered-from' }]);
  expect(await t.save('https://github.com/a/b', { title: 'Replacement', organization: { collectionId: b, tagIds: [] } })).toBe(id);
  expect((await t.request('GET', `/api/v1/documents/${id}/organization`)).json()).toMatchObject({ title: 'My repository', collectionId: a, revision: 0 });
  const foreign = await t.taxonomy('collections', 'Foreign', t.bob);
  const response = await t.app.inject({ method: 'POST', url: '/api/v1/documents/links', headers: { ...t.headers(), 'idempotency-key': randomUUID() }, payload: { url: 'https://x.com/u/status/200', translationIntent: 'none', organization: { collectionId: foreign, tagIds: [] } } }); expect(response.statusCode).toBe(404);
  const rel = { fromDocumentId: id, toDocumentId: source, kind: 'discovered-from' };
  expect((await t.request('DELETE', '/api/v1/document-relations', rel)).statusCode).toBe(200);
  expect((await t.request('GET', `/api/v1/documents/${id}/relations`)).json().items).toEqual([]);
  await t.db.pool.query(`CREATE FUNCTION fail_initial_organization() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled organization initialization failure'; END; $$`);
  await t.db.pool.query('CREATE TRIGGER fail_initial_organization BEFORE INSERT ON document_organization FOR EACH ROW EXECUTE FUNCTION fail_initial_organization()');
  const failed = await t.app.inject({ method: 'POST', url: '/api/v1/documents/links', headers: { ...t.headers(), 'idempotency-key': randomUUID() }, payload: { url: 'https://x.com/u/status/300', translationIntent: 'none' } }); expect(failed.statusCode).toBe(500);
  await expect(t.pdf()).rejects.toThrow('controlled organization initialization failure');
  expect((await t.db.pool.query('SELECT id FROM documents')).rows).toHaveLength(2);
  expect((await t.db.pool.query('SELECT d.id FROM documents d LEFT JOIN document_organization o ON(o.owner_id,o.document_id)=(d.owner_id,d.id) WHERE o.document_id IS NULL')).rows).toEqual([]);
});

it('rejects foreign relation cursors and bounds relation pages', async () => {
  const t = await setup(); const a = await t.save('https://x.com/a/status/101'), b = await t.save('https://x.com/a/status/102');
  const foreignA = await t.save('https://x.com/b/status/101', {}, t.bob), foreignB = await t.save('https://x.com/b/status/102', {}, t.bob);
  expect((await t.request('POST', '/api/v1/document-relations', { fromDocumentId: foreignA, toDocumentId: foreignB, kind: 'related' }, t.bob)).statusCode).toBe(200);
  const foreignId = (await t.request('GET', `/api/v1/documents/${foreignA}/relations`, undefined, t.bob)).json().items[0].id;
  expect((await t.request('GET', `/api/v1/documents/${a}/relations?cursor=${foreignId}`)).statusCode).toBe(404);
  expect((await t.request('GET', `/api/v1/documents/${a}/relations?limit=51`)).statusCode).toBe(400);
  expect((await t.request('POST', '/api/v1/document-relations', { fromDocumentId: a, toDocumentId: b, kind: 'related' })).statusCode).toBe(200);
  expect((await t.request('GET', `/api/v1/documents/${a}/relations?limit=1`)).json().items).toHaveLength(1);
});

it('persists authoritative immutable document epochs and ownership in lifecycle infrastructure', async () => {
  const t = await setup(); const id = await t.save('https://public.example/epoch');
  const initial = (await t.db.pool.query('SELECT * FROM web_jobs WHERE document_id=$1', [id])).rows[0]; expect(initial.document_epoch).toBe('1');
  await t.db.pool.query('UPDATE documents SET lifecycle_epoch=2 WHERE id=$1', [id]);
  const next = randomUUID();
  // A supplied epoch is replaced with the server-selected document fence.
  await t.db.pool.query("INSERT INTO web_jobs(id,owner_id,document_id,auth_version,kind,input_sha256,url,document_epoch) VALUES($1,$2,$3,1,'fetch-link',$4,'https://public.example/epoch',999)", [next,t.alice.user.id,id,initial.input_sha256]);
  expect((await t.db.pool.query('SELECT document_epoch FROM web_jobs WHERE id=$1', [next])).rows[0].document_epoch).toBe('2');
  await expect(t.db.pool.query('UPDATE web_jobs SET document_epoch=3 WHERE id=$1', [next])).rejects.toThrow('Immutable document epoch');
  const other = await t.save('https://x.com/other/status/1', {}, t.bob);
  await t.db.pool.query("INSERT INTO web_owner_cache(owner_id,cache_key,entry) VALUES($1,'test-cache','{}')", [t.bob.user.id]);
  await expect(t.db.pool.query("INSERT INTO web_cache_document_refs(owner_id,document_id,document_epoch,cache_key) VALUES($1,$2,1,'test-cache')", [t.bob.user.id,id])).rejects.toMatchObject({ code:'23503' });
  await t.db.pool.query("INSERT INTO web_cache_document_refs(owner_id,document_id,document_epoch,cache_key) VALUES($1,$2,1,'test-cache')", [t.bob.user.id,other]);
  for (const table of ['document_purges','object_deletion_queue','retired_operations','retired_document_identities','document_tombstones','document_cache_cleanup_state']) expect((await t.db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
});

it('does not fall back from bearer credentials to a session on session-only management routes', async () => {
  const t = await setup();
  for (const method of ['GET','POST'] as const) {
    const response = await t.app.inject({ method, url: method==='GET'?'/api/v1/library':'/api/v1/tags', headers: { ...t.headers(), authorization:'Bearer invalid' }, ...(method==='POST'?{payload:{name:'not authorized'}}:{}) });
    expect(response.statusCode).toBe(401);
  }
  expect((await t.db.pool.query('SELECT id FROM tags')).rows).toEqual([]);
});

it('fails readiness when management persistence is missing', async () => {
  const t = await setup(); expect((await t.app.inject('/health/ready')).statusCode).toBe(200);
  await t.db.pool.query('DROP TABLE document_search_metadata');
  expect((await t.app.inject('/health/ready')).statusCode).toBe(503);
});

it('keeps a legal long PDF bundle title through publication and organization note edits', async () => {
  const t = await setup();
  const { bundleFixture, body } = await import('../helpers/bundles.js');
  const { createLocalObjectStore } = await import('../../src/storage/local-object-store.js');
  const { createBundleImportsService } = await import('../../src/bundle-imports/service.js');
  const title = '长'.repeat(2500);
  const fixture = await bundleFixture(t.config.dataDir, { edit(files) {
    for (const path of ['manifest.json','source-ir.json']) {
      const value = JSON.parse(files.get(path)!.toString()); if (path==='manifest.json') value.title=title; else value.metadata.title=title;
      files.set(path, Buffer.from(JSON.stringify(value)));
    }
  } });
  const actor = { userId:t.alice.user.id,role:t.alice.user.role,authVersion:1,sessionHash:(await t.db.pool.query('SELECT token_hash FROM sessions WHERE user_id=$1',[t.alice.user.id])).rows[0].token_hash as string };
  const service = createBundleImportsService({ db:t.db,store:createLocalObjectStore(t.config.dataDir),config:t.config });
  const created = await service.create(actor,{},randomUUID()); const imported=await service.receive(actor,created.id,body(fixture.bytes)); expect(imported.status).toBe('completed');
  const organization = (await t.request('GET',`/api/v1/documents/${imported.documentId}/organization`)).json(); expect(organization.title).toBe(title);
  expect((await t.request('PATCH',`/api/v1/documents/${imported.documentId}/organization`,{expectedRevision:organization.revision,note:'Long legal source title remains readable'})).json().title).toBe(title);
});

it('hashes new save hints by authorized UUID identity and preserves accepted replay after taxonomy deletion', async () => {
  const t = await setup(); const collection = await t.taxonomy('collections', 'Identity'), tag = await t.taxonomy('tags', 'Identity');
  const discovered = await t.save('https://x.com/u/status/identity'); const key = randomUUID();
  const legacyHash = createHash('sha256').update('{"translationIntent":"none","url":"https://x.com/u/status/identity"}').digest('hex');
  expect((await t.db.pool.query('SELECT request_hash FROM web_link_requests WHERE document_id=$1', [discovered])).rows[0].request_hash).toBe(legacyHash);
  const save = (upper: boolean) => t.app.inject({ method:'POST',url:'/api/v1/documents/links',headers:{...t.headers(),'idempotency-key':key},payload:{url:'https://public.example/identity',translationIntent:'none',organization:{collectionId:upper?collection.toUpperCase():collection,tagIds:[upper?tag.toUpperCase():tag]},discoveredFromDocumentId:upper?discovered.toUpperCase():discovered} });
  const first = await save(true); expect(first.statusCode,first.body).toBe(201);
  await t.db.pool.query("UPDATE web_jobs SET status='cancelled' WHERE id=$1", [first.json().jobId]);
  await t.db.pool.query('UPDATE documents SET requested_web_job_id=NULL WHERE id=$1', [first.json().documentId]);
  const replay = await save(false); expect(replay.statusCode,replay.body).toBe(201); expect(replay.json()).toEqual(first.json());
  expect((await t.request('DELETE',`/api/v1/tags/${tag}`)).statusCode).toBe(204);
  expect((await t.request('DELETE',`/api/v1/collections/${collection}`)).statusCode).toBe(204);
  expect((await t.request('PATCH',`/api/v1/documents/${first.json().documentId}/organization`,{expectedRevision:2,note:'Edited after acceptance'})).statusCode).toBe(200);
  const afterDelete = await save(true); expect(afterDelete.statusCode,afterDelete.body).toBe(201); expect(afterDelete.json()).toEqual(first.json());
  expect((await t.request('GET',`/api/v1/documents/${first.json().documentId}/organization`)).json()).toMatchObject({revision:3,collectionId:null,tagIds:[],note:'Edited after acceptance'});
  expect((await t.db.pool.query('SELECT status FROM web_jobs')).rows).toEqual([{status:'cancelled'}]);
  expect((await t.db.pool.query('SELECT requested_web_job_id FROM documents WHERE id=$1',[first.json().documentId])).rows[0].requested_web_job_id).toBeNull();
  const { capture } = await import('../helpers/web-capture.js'); const value = capture();
  const captureTag = await t.taxonomy('tags','Capture identity');
  const saveCapture = (upper:boolean) => t.app.inject({method:'POST',url:'/api/v1/captures',headers:{...t.headers(),'idempotency-key':value.manifest.captureId},payload:{manifest:value.manifest,translationIntent:'none',organization:{collectionId:null,tagIds:[upper?captureTag.toUpperCase():captureTag]},discoveredFromDocumentId:upper?discovered.toUpperCase():discovered}});
  const accepted = await saveCapture(true); expect(accepted.statusCode,accepted.body).toBe(201);
  const retried = await saveCapture(false); expect(retried.statusCode,retried.body).toBe(201); expect(retried.json()).toEqual(accepted.json());
  expect((await t.request('DELETE',`/api/v1/tags/${captureTag}`)).statusCode).toBe(204);
  expect((await saveCapture(true)).json()).toEqual(accepted.json());
  expect((await t.db.pool.query('SELECT count(*)::int AS n FROM web_captures')).rows[0].n).toBe(1);
});

it('advances backfill past a persistent oldest failure across worker processes and retries after wraparound', async () => {
  const t = await setup();
  const { capture } = await import('../helpers/web-capture.js');
  const { metadataBackfillProcess } = await import('../helpers/metadata-backfill-process.js');
  const value = capture(); value.manifest.metadata.author = 'Recovered author';
  const created = await t.app.inject({ method:'POST',url:'/api/v1/captures',headers:{...t.headers(),'idempotency-key':value.manifest.captureId},payload:{manifest:value.manifest,translationIntent:'none'} });
  expect(created.statusCode,created.body).toBe(201);
  expect((await t.app.inject({method:'PUT',url:`/api/v1/captures/${created.json().id}/files/html`,headers:{...t.headers(),'content-type':'text/html'},payload:value.body})).statusCode).toBe(200);
  const committed = await t.request('POST',`/api/v1/captures/${created.json().id}/commit`,{}); expect(committed.statusCode,committed.body).toBe(200);
  const oldest = committed.json().documentId as string;
  const later = await t.save('https://x.com/u/status/later-valid');
  await t.db.pool.query(`UPDATE documents SET created_at=CASE WHEN id=$1 THEN '2026-10-28T00:00:00.123456Z'::timestamptz
    ELSE '2026-10-28T00:00:00.123457Z'::timestamptz END WHERE id IN($1,$2)`,[oldest,later]);
  const key = (await t.db.pool.query(`SELECT a.object_key FROM web_parse_runs p JOIN assets a
    ON(a.owner_id,a.document_id,a.id)=(p.owner_id,p.document_id,p.ir_asset_id) WHERE p.document_id=$1`,[oldest])).rows[0].object_key as string;
  const schema = (await t.db.pool.query('SELECT current_schema() AS name')).rows[0].name as string;
  await t.db.pool.query('DELETE FROM document_search_metadata');
  expect(await metadataBackfillProcess(schema,t.config.dataDir,key)).toEqual({selected:1,projected:0,skipped:0,failed:1});
  expect(await metadataBackfillProcess(schema,t.config.dataDir,key)).toEqual({selected:1,projected:1,skipped:0,failed:0});
  expect((await t.db.pool.query('SELECT document_id FROM document_search_metadata')).rows).toEqual([{document_id:later}]);
  // The failed source remains eligible after the durable cursor wraps, rather than being abandoned.
  expect(await metadataBackfillProcess(schema,t.config.dataDir,key)).toEqual({selected:1,projected:0,skipped:0,failed:1});
  expect(await metadataBackfillProcess(schema,t.config.dataDir)).toEqual({selected:1,projected:1,skipped:0,failed:0});
  expect((await t.request('GET','/api/v1/library?q=Recovered%20author')).json().items.map((item:{document:{id:string}})=>item.document.id)).toEqual([oldest]);
});
