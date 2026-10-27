import { afterEach, expect, it } from 'vitest';
import { bootstrapAdmin } from '../../src/cli/bootstrap-admin.js';
import { createServiceTestApp } from '../helpers/app.js';
import { login } from '../helpers/session.js';
import { capture } from '../helpers/web-capture.js';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
async function setup() {
  let modelCalls = 0;
  const test = await createServiceTestApp({ outboundFetch: async () => { modelCalls++; throw new Error('No network'); } }); closes.push(test.close);
  await bootstrapAdmin(test.db, { username: 'admin', password: 'correct password 123456' });
  const session = await login(test.app, 'admin', 'correct password 123456');
  const headers = { cookie: session.cookie, origin: test.config.publicOrigin, 'x-csrf-token': session.csrfToken };
  const create = (value = capture(), extra = {}) => test.app.inject({ method: 'POST', url: '/api/v1/captures', headers: { ...headers, 'idempotency-key': value.manifest.captureId }, payload: { manifest: value.manifest, translationIntent: 'none', ...extra } });
  const put = (id: string, body: Buffer) => test.app.inject({ method: 'PUT', url: `/api/v1/captures/${id}/files/html`, headers: { ...headers, 'content-type': 'text/html' }, payload: body });
  const commit = (id: string) => test.app.inject({ method: 'POST', url: `/api/v1/captures/${id}/commit`, headers, payload: {} });
  async function save(value: ReturnType<typeof capture> & { translation?: Buffer }, capturedAt: string) {
    value.manifest.metadata.capturedAt = capturedAt;
    const created = await create(value); expect(created.statusCode, created.body).toBe(201); const id = created.json().id;
    expect((await put(id, value.body)).statusCode).toBe(200);
    if (value.translation) expect((await test.app.inject({ method: 'PUT', url: `/api/v1/captures/${id}/files/translation`, headers: { ...headers, 'content-type': 'application/json' }, payload: value.translation })).statusCode).toBe(200);
    const result = await commit(id); expect(result.statusCode, result.body).toBe(200); return result.json();
  }
  return { ...test, session, headers, create, put, commit, save, modelCalls: () => modelCalls };
}
it('promotes a completed retained newer source and ignores retry timestamps for late older imports', async () => {
  const { withCandidates } = await import('../helpers/web-capture.js'); const t = await setup();
  const aHtml = '<p>The first original English source has a useful completed translation.</p>';
  const bHtml = '<p>The newer English source waits until its imported translation arrives.</p>';
  const a = await t.save(await withCandidates(aHtml), '2026-10-27T00:00:00.000Z');
  const b = await t.save(capture(bHtml), '2026-10-27T01:00:00.000Z');
  const current = async () => (await t.app.inject({ url: `/api/v1/documents/${a.documentId}/web-reader`, headers: t.headers })).json();
  expect((await current()).versionId).toBe(a.readerVersionId);
  const imported = await t.save(await withCandidates(bHtml), '2026-10-26T00:00:00.000Z');
  expect(imported.sourceVersionId).toBe(b.sourceVersionId);
  expect(await current()).toMatchObject({ versionId: imported.readerVersionId, source: { sourceVersionId: b.sourceVersionId }, translationStatus: 'completed' });
  expect((await t.db.pool.query('SELECT current_source_version_id,current_web_reader_version_id FROM documents WHERE id=$1', [a.documentId])).rows[0]).toEqual({ current_source_version_id: b.sourceVersionId, current_web_reader_version_id: imported.readerVersionId });
  const late = await t.save(await withCandidates(aHtml), '2026-10-28T00:00:00.000Z');
  expect(late.sourceVersionId).toBe(a.sourceVersionId); expect((await current()).versionId).toBe(imported.readerVersionId);
  expect((await t.app.inject({ url: `/api/v1/documents/${a.documentId}/web-reader?versionId=${late.readerVersionId}`, headers: t.headers })).statusCode).toBe(200);
  expect(t.modelCalls()).toBe(0);
});
it.each(['scope', 'resources'] as const)('keeps complete current coverage when a retained %s-degraded source receives a completed import', async reason => {
  const { withCandidates } = await import('../helpers/web-capture.js'); const t = await setup();
  const a = await t.save(await withCandidates('<p>The current complete source retains its useful translated content.</p>'), '2026-10-27T00:00:00.000Z');
  const html = `<p>The newer original has degraded coverage despite its valid translation.${reason === 'resources' ? '<img src="https://example.com/missing.png" alt="Missing image">' : ''}</p>`;
  const value = capture(html);
  if (reason === 'scope') value.manifest.scope = { ...value.manifest.scope, completeWithinScope: false, warnings: ['Only the visible excerpt was captured'] };
  const b = await t.save(value, '2026-10-27T01:00:00.000Z');
  const imported = await t.save(await withCandidates(html, false, value.manifest.scope), '2026-10-28T00:00:00.000Z');
  expect(imported.sourceVersionId).toBe(b.sourceVersionId);
  const history = (await t.app.inject({ url: `/api/v1/documents/${a.documentId}/web-reader?versionId=${imported.readerVersionId}`, headers: t.headers })).json();
  expect(history.translationStatus).toBe('completed');
  expect((await t.db.pool.query('SELECT metadata FROM web_sources WHERE source_version_id=$1', [b.sourceVersionId])).rows[0].metadata.coverage).toBe('partial');
  expect((await t.app.inject({ url: `/api/v1/documents/${a.documentId}/web-reader`, headers: t.headers })).json().versionId).toBe(a.readerVersionId);
});
it('reserves uploaded file IDs for server-only originals before accepting a manifest', async () => {
  const t = await setup(); const value = capture(); value.manifest.files[0].id = 'uploaded:hostile'; value.manifest.htmlFileId = 'uploaded:hostile';
  expect((await t.create(value)).statusCode).toBe(400);
  expect((await t.db.pool.query('SELECT id FROM web_captures')).rows).toHaveLength(0);
});
it('resumes missing files, preserves stable capture identity and retrieves completed results after lost acknowledgement', async () => {
  const t = await setup(); const value = capture();
  const created = await t.create(value); expect(created.statusCode).toBe(201);
  const first = created.json(); expect(first.missingFileIds).toEqual(['html']);
  expect((await t.create(value)).json().id).toBe(first.id);
  expect((await t.create({ ...value, manifest: { ...value.manifest, metadata: { ...value.manifest.metadata, title: 'changed' } } })).statusCode).toBe(409);
  expect((await t.put(first.id, value.body.subarray(0, 15))).statusCode).toBe(400);
  expect((await t.app.inject({ url: `/api/v1/captures/${first.id}`, headers: t.headers })).json().missingFileIds).toEqual(['html']);
  expect((await t.put(first.id, value.body)).statusCode).toBe(200);
  expect((await t.put(first.id, Buffer.from('different received retry'))).statusCode).toBe(400);
  const complete = await t.commit(first.id); expect(complete.statusCode, complete.body).toBe(200);
  expect(complete.json()).toMatchObject({ status: 'completed', missingFileIds: [], saveStatus: 'original-saved' });
  expect((await t.commit(first.id)).json()).toEqual(complete.json());
  expect((await t.create(value)).json()).toEqual(complete.json());
  expect(t.modelCalls()).toBe(0);
});
it('reuses same-content sources, creates changed sources, and refuses PDF targets', async () => {
  const t = await setup();
  async function save(value: ReturnType<typeof capture>) { const c = await t.create(value); expect(c.statusCode).toBe(201); const id = c.json().id; expect((await t.put(id, value.body)).statusCode).toBe(200); const result = await t.commit(id); expect(result.statusCode, result.body).toBe(200); return result.json(); }
  const first = await save(capture()); const again = await save(capture());
  expect(again.documentId).toBe(first.documentId); expect(again.sourceVersionId).toBe(first.sourceVersionId);
  const changed = await save(capture('<article><p>这是完全变化的中文正文，保存到新的原文版本。</p></article>'));
  expect(changed.documentId).toBe(first.documentId); expect(changed.sourceVersionId).not.toBe(first.sourceVersionId);
  const pdf = (await t.db.pool.query("INSERT INTO documents (owner_id,kind,title,original_filename) VALUES ($1,'pdf','PDF','x.pdf') RETURNING id", [t.session.user.id])).rows[0].id;
  expect((await t.create(capture(), { targetDocumentId: pdf })).statusCode).toBe(404);
  expect((await t.db.pool.query('SELECT id FROM source_versions')).rows).toHaveLength(2);
  expect(t.modelCalls()).toBe(0);
});
it('keeps the user lock available during real worker validation and fences cancel before object publication', async () => {
  const t = await setup(); const value = capture('<article>' + '<p>This is the captured source paragraph with sufficient original English text.</p>'.repeat(500) + '</article>');
  const created = await t.create(value); const id = created.json().id; await t.put(id, value.body);
  const pending = t.commit(id).then(result => result);
  let validating = false;
  for (let i = 0; i < 200; i++) {
    const row = (await t.db.pool.query('SELECT status FROM web_captures WHERE id=$1', [id])).rows[0]; if (row.status === 'validating') { validating = true; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(validating).toBe(true);
  await t.db.transaction(async client => { await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT', [t.session.user.id]); });
  const cancelled = await t.app.inject({ method: 'POST', url: `/api/v1/captures/${id}/cancel`, headers: t.headers, payload: {} });
  expect(cancelled.statusCode).toBe(200); expect(cancelled.json().status).toBe('cancelled');
  expect((await pending).statusCode).toBe(409);
  expect((await t.db.pool.query('SELECT id FROM source_versions')).rows).toHaveLength(0);
  expect((await t.app.inject({ url: `/api/v1/captures/${id}`, headers: t.headers })).json().status).toBe('cancelled');
});
it('sanitizes hostile HTML and records undeclared hotlinks as missing without network requests', async () => {
  const t = await setup(); const value = capture('<article><script>fetch("https://evil.example")</script><form><input value="secret"></form><p onclick="alert(1)">This paragraph remains readable and never executes scripts.</p><img src="https://evil.example/image.png"></article>');
  const id = (await t.create(value)).json().id; await t.put(id, value.body);
  const saved = await t.commit(id); expect(saved.statusCode, saved.body).toBe(200);
  const result = saved.json(); const html = await t.app.inject({ url: `/api/v1/documents/${result.documentId}/web-snapshots/${result.sourceVersionId}/files/html`, headers: t.headers });
  expect(html.body).not.toMatch(/<script|<form|<input|onclick|secret|src="https:/);
  expect(t.modelCalls()).toBe(0);
});
it('persists replayed import proofs without a model job and preserves translated current over a new pending source', async () => {
  const { withCandidates } = await import('../helpers/web-capture.js');
  const t = await setup();
  const value = await withCandidates('<article><p>The original <strong>protected format</strong> remains bound to the source document for a valid imported translation.</p></article>');
  const id = (await t.create(value)).json().id; await t.put(id, value.body);
  expect((await t.app.inject({ method: 'PUT', url: `/api/v1/captures/${id}/files/translation`, headers: { ...t.headers, 'content-type': 'application/json' }, payload: value.translation })).statusCode).toBe(200);
  const first = await t.commit(id); expect(first.statusCode, first.body).toBe(200);
  const saved = first.json();
  const imported = (await t.db.pool.query('SELECT generation_kind,job_id FROM web_translation_runs')).rows;
  expect(imported).toEqual([{ generation_kind: 'import', job_id: null }]);
  const descriptor = await t.app.inject({ url: `/api/v1/documents/${saved.documentId}/web-reader`, headers: t.headers });
  expect(descriptor.json().index.generationKind).toBe('import'); expect(descriptor.json().translationStatus).toBe('completed');
  const next = capture('<article><p>This new English source is waiting for translation and must not replace the useful previous translated version.</p></article>');
  const nextId = (await t.create(next)).json().id; await t.put(nextId, next.body); const nextSaved = (await t.commit(nextId)).json();
  expect((await t.app.inject({ url: `/api/v1/documents/${saved.documentId}/web-reader`, headers: t.headers })).json().versionId).toBe(saved.readerVersionId);
  expect((await t.app.inject({ url: `/api/v1/documents/${saved.documentId}/web-reader?versionId=${nextSaved.readerVersionId}`, headers: t.headers })).json().translationStatus).toBe('pending');
  expect((await t.db.pool.query('SELECT id FROM web_jobs')).rows).toHaveLength(0); expect(t.modelCalls()).toBe(0);
});
it('skips candidate marker mismatches with a warning while keeping original publication pending', async () => {
  const { withCandidates } = await import('../helpers/web-capture.js'); const t = await setup();
  const value = await withCandidates('<article><p>The original <code>protected</code> code must survive an invalid imported translation candidate.</p></article>', true);
  const id = (await t.create(value)).json().id; await t.put(id, value.body);
  await t.app.inject({ method: 'PUT', url: `/api/v1/captures/${id}/files/translation`, headers: { ...t.headers, 'content-type': 'application/json' }, payload: value.translation });
  const result = await t.commit(id); expect(result.statusCode, result.body).toBe(200); expect(result.json().warnings.length).toBeGreaterThan(0);
  expect((await t.db.pool.query('SELECT id FROM web_translation_runs')).rows).toHaveLength(0);
  const descriptor = await t.app.inject({ url: `/api/v1/documents/${result.json().documentId}/web-reader`, headers: t.headers }); expect(descriptor.json().translationStatus).toBe('pending');
});
it('adds a later valid imported translation to the same immutable source identity', async () => {
  const { withCandidates } = await import('../helpers/web-capture.js'); const t = await setup();
  const html = '<article><p>The original <strong>source proof</strong> is archived first, then a translated capture arrives later for the same content.</p></article>';
  const firstValue = capture(html), firstId = (await t.create(firstValue)).json().id; await t.put(firstId, firstValue.body);
  const first = (await t.commit(firstId)).json();
  const value = await withCandidates(html), id = (await t.create(value)).json().id; await t.put(id, value.body);
  await t.app.inject({ method: 'PUT', url: `/api/v1/captures/${id}/files/translation`, headers: { ...t.headers, 'content-type': 'application/json' }, payload: value.translation });
  const result = await t.commit(id); expect(result.statusCode, result.body).toBe(200); const second = result.json();
  expect(second.sourceVersionId).toBe(first.sourceVersionId); expect(second.readerVersionId).not.toBe(first.readerVersionId);
  expect((await t.db.pool.query('SELECT id FROM source_versions')).rows).toHaveLength(1);
  const rows = (await t.db.pool.query(`SELECT p.ir_sha256,a.object_key FROM web_translation_runs t JOIN web_parse_runs p ON (p.owner_id,p.document_id,p.source_version_id,p.id)=(t.owner_id,t.document_id,t.source_version_id,t.parse_id) JOIN assets a ON a.id=t.translation_asset_id`)).rows;
  const { createLocalObjectStore } = await import('../../src/storage/local-object-store.js');
  const store = createLocalObjectStore(t.config.dataDir);
  for (const row of rows) { const buffers: Buffer[] = []; for await (const part of store.read(row.object_key)) buffers.push(Buffer.from(part)); expect(JSON.parse(Buffer.concat(buffers).toString()).readerIrSha256).toBe(row.ir_sha256); }
  expect((await t.app.inject({ url: `/api/v1/documents/${first.documentId}/web-reader`, headers: t.headers })).json().translationStatus).toBe('completed');
});
it('retains a complete current source when a later Chinese capture has missing resources', async () => {
  const t = await setup(); const firstValue = capture(); const firstId = (await t.create(firstValue)).json().id; await t.put(firstId, firstValue.body); const first = (await t.commit(firstId)).json();
  const partial = capture('<article><p>这篇新的中文原文尚未获取全部图片，应当保留已经完整的阅读版本。</p><img src="https://example.com/missing.png"></article>');
  const id = (await t.create(partial)).json().id; await t.put(id, partial.body); const result = await t.commit(id); expect(result.statusCode).toBe(200); expect(result.json().saveStatus).toBe('partial-resources');
  expect((await t.app.inject({ url: `/api/v1/documents/${first.documentId}/web-reader`, headers: t.headers })).json().versionId).toBe(first.readerVersionId);
});
it('reports readable pending originals honestly when a provider is configured without scheduling paid work', async () => {
  const t = await setup(); const value = capture('<article><p>This English document is saved for ordinary source reading without automatic paid translation.</p></article>');
  const id = (await t.create(value)).json().id; await t.put(id, value.body); const saved = (await t.commit(id)).json();
  const documentUrl = `/api/v1/documents/${saved.documentId}`;
  expect((await t.app.inject({ url: documentUrl, headers: t.headers })).json().processingStatus).toBe('awaiting-config');
  const profile = (await t.app.inject({ url: '/api/v1/settings/provider', headers: t.headers })).json();
  const settings = Object.fromEntries(Object.entries(profile).filter(([key]) => !['revision', 'hasApiKey'].includes(key)));
  const configured = await t.app.inject({ method: 'PUT', url: '/api/v1/settings/provider', headers: t.headers, payload: { expectedRevision: profile.revision, settings: { ...settings, baseUrl: 'https://provider.example/v1', model: 'test-model' }, key: { action: 'replace', value: 'isolated-test-key-only' } } });
  expect(configured.statusCode, configured.body).toBe(200);
  expect((await t.app.inject({ url: documentUrl, headers: t.headers })).json()).toMatchObject({ processingStatus: 'reader-ready', reader: { translationStatus: 'pending' } });
  expect(t.modelCalls()).toBe(0); expect((await t.db.pool.query('SELECT id FROM web_jobs')).rows).toHaveLength(0);
});
it('keeps a useful current Reader when a later capture contains no semantic blocks', async () => {
  const t = await setup(); const original = capture(); const firstId = (await t.create(original)).json().id; await t.put(firstId, original.body); const first = (await t.commit(firstId)).json();
  const empty = capture('<article></article>'); const id = (await t.create(empty)).json().id; await t.put(id, empty.body);
  const saved = await t.commit(id); expect(saved.statusCode, saved.body).toBe(200);
  expect((await t.app.inject({ url: `/api/v1/documents/${first.documentId}/web-reader`, headers: t.headers })).json().versionId).toBe(first.readerVersionId);
  expect((await t.app.inject({ url: `/api/v1/documents/${first.documentId}/web-reader?versionId=${saved.json().readerVersionId}`, headers: t.headers })).statusCode).toBe(200);
});
it('skips an imported block that cannot fit a Reader chunk while retaining other valid imported blocks and the source', async () => {
  const { withCandidates } = await import('../helpers/web-capture.js'); const { createHash } = await import('node:crypto'); const t = await setup();
  const value = await withCandidates(`<article><p>${'This is a readable English paragraph. '.repeat(2000)}</p><p>Another original paragraph carries a valid existing translated result.</p></article>`);
  const candidate = JSON.parse(value.translation.toString()); candidate.blocks[0].rawText = '译'.repeat(140000); value.translation = Buffer.from(JSON.stringify(candidate));
  const descriptor = value.manifest.files.find(f => f.id === 'translation')!; descriptor.bytes = value.translation.length; descriptor.sha256 = createHash('sha256').update(value.translation).digest('hex');
  const id = (await t.create(value)).json().id; await t.put(id, value.body);
  await t.app.inject({ method: 'PUT', url: `/api/v1/captures/${id}/files/translation`, headers: { ...t.headers, 'content-type': 'application/json' }, payload: value.translation });
  const saved = await t.commit(id); expect(saved.statusCode, saved.body).toBe(200); expect(saved.json().warnings.length).toBeGreaterThan(0);
  const reader = (await t.app.inject({ url: `/api/v1/documents/${saved.json().documentId}/web-reader`, headers: t.headers })).json(); expect(reader.translationStatus).toBe('partial'); expect(reader.index.generationKind).toBe('import');
});
it.each([false, true])('prunes multiple aggregate table-context imports while preserving unrelated proofs and exact source bytes (retained=%s)', async retained => {
  const { withCandidates } = await import('../helpers/web-capture.js'); const { createHash } = await import('node:crypto'); const t = await setup();
  const table = (label: string) => `<table><tr><th>${label} heading</th></tr><tr><td>${label} body paragraph is readable original English text.</td></tr></table>`;
  const html = `<article>${table('First')}${table('Second')}${table('Good')}<p>An unrelated paragraph has a valid existing translated result.</p></article>`;
  let original: { sourceVersionId: string; readerVersionId: string } | undefined;
  if (retained) { const value = capture(html); const id = (await t.create(value)).json().id; await t.put(id, value.body); original = (await t.commit(id)).json(); }
  const value = await withCandidates(html), payload = JSON.parse(value.translation.toString());
  payload.blocks[0].rawText = '译'.repeat(100000); payload.blocks[2].rawText = '文'.repeat(100000);
  value.translation = Buffer.from(JSON.stringify(payload)); const file = value.manifest.files.find(f => f.id === 'translation')!;
  file.bytes = value.translation.length; file.sha256 = createHash('sha256').update(value.translation).digest('hex');
  const id = (await t.create(value)).json().id; await t.put(id, value.body);
  await t.app.inject({ method: 'PUT', url: `/api/v1/captures/${id}/files/translation`, headers: { ...t.headers, 'content-type': 'application/json' }, payload: value.translation });
  const response = await t.commit(id); expect(response.statusCode, response.body).toBe(200); const saved = response.json();
  if (original) { expect(saved.sourceVersionId).toBe(original.sourceVersionId); expect(saved.readerVersionId).not.toBe(original.readerVersionId); }
  expect(saved.warnings.some((warning: string) => warning.includes('context'))).toBe(true);
  const reader = (await t.app.inject({ url: `/api/v1/documents/${saved.documentId}/web-reader?versionId=${saved.readerVersionId}`, headers: t.headers })).json();
  expect(reader.translationStatus).toBe('partial'); expect(reader.index.generationKind).toBe('import');
  expect(Object.keys(reader.index.blockLocations)).toHaveLength(7);
  const row = (await t.db.pool.query(`SELECT p.ir_sha256,a.object_key FROM web_translation_runs t JOIN web_parse_runs p ON (p.owner_id,p.document_id,p.source_version_id,p.id)=(t.owner_id,t.document_id,t.source_version_id,t.parse_id) JOIN assets a ON a.id=t.translation_asset_id WHERE t.document_id=$1 ORDER BY t.created_at DESC LIMIT 1`, [saved.documentId])).rows[0];
  const { createLocalObjectStore } = await import('../../src/storage/local-object-store.js'); const chunks: Buffer[] = [];
  for await (const bytes of createLocalObjectStore(t.config.dataDir).read(row.object_key)) chunks.push(Buffer.from(bytes));
  const artifact = JSON.parse(Buffer.concat(chunks).toString());
  expect(artifact.readerIrSha256).toBe(row.ir_sha256); expect(artifact.status).toBe('partial');
  expect(artifact.blocks.map((b: { nodeId: string }) => b.nodeId)).toEqual(payload.blocks.slice(4).map((b: { nodeId: string }) => b.nodeId));
  expect((await t.db.pool.query('SELECT id FROM source_versions')).rows).toHaveLength(1); expect(t.modelCalls()).toBe(0);
});
