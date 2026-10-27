import { afterEach, expect, it } from 'vitest';
import { bootstrapAdmin } from '../../src/cli/bootstrap-admin.js';
import { createServiceTestApp } from '../helpers/app.js';
import { login } from '../helpers/session.js';
import { capture } from '../helpers/web-capture.js';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
it('serves private source Readers, bounded snapshots and CAS progress without exposing Web through PDF routes', async () => {
  let modelCalls = 0;
  const t = await createServiceTestApp({ outboundFetch: async () => { modelCalls++; throw Error('network'); } }); closes.push(t.close);
  await bootstrapAdmin(t.db, { username: 'admin', password: 'correct password 123456' });
  await t.db.pool.query("INSERT INTO users (username,password_hash,role) SELECT 'alice',password_hash,'user' FROM users WHERE username='admin'");
  const admin = await login(t.app, 'admin', 'correct password 123456'); const alice = await login(t.app, 'alice', 'correct password 123456');
  const headers = { cookie: alice.cookie, origin: t.config.publicOrigin, 'x-csrf-token': alice.csrfToken };
  const value = capture();
  const created = await t.app.inject({ method: 'POST', url: '/api/v1/captures', headers: { ...headers, 'idempotency-key': value.manifest.captureId }, payload: { manifest: value.manifest, translationIntent: 'auto' } });
  expect(created.statusCode).toBe(201);
  const id = created.json().id;
  await t.app.inject({ method: 'PUT', url: `/api/v1/captures/${id}/files/html`, headers: { ...headers, 'content-type': 'text/html' }, payload: value.body });
  const result = await t.app.inject({ method: 'POST', url: `/api/v1/captures/${id}/commit`, headers, payload: {} }); expect(result.statusCode).toBe(200);
  const saved = result.json(), base = `/api/v1/documents/${saved.documentId}`;
  const response = await t.app.inject({ url: `${base}/web-reader`, headers }); expect(response.statusCode).toBe(200);
  const descriptor = response.json(); expect(descriptor.translationStatus).toBe('not-required'); expect(descriptor.index.generationKind).toBe('none');
  const chunkUrl = `${base}/web-reader/versions/${saved.readerVersionId}/chunks/${descriptor.index.chunks[0].id}`;
  const urls = [`${base}/web-reader`, `${base}/web-reader/versions`, chunkUrl, `${base}/web-snapshots/${saved.sourceVersionId}/manifest`, `${base}/web-snapshots/${saved.sourceVersionId}/files/html`, `${base}/web-progress`];
  for (const url of urls) {
    const authorized = await t.app.inject({ url, headers }); expect(authorized.statusCode, url).toBe(200); expect(authorized.headers['cache-control']).toBe('no-store');
    expect((await t.app.inject({ url, headers: { cookie: admin.cookie } })).statusCode).toBe(404);
    expect((await t.app.inject({ url, headers: { ...headers, authorization: 'Bearer invalid' } })).statusCode).toBe(401);
  }
  const html = await t.app.inject({ url: urls[4], headers }); expect(html.headers['content-type']).toContain('application/octet-stream'); expect(html.headers['content-disposition']).toContain('attachment'); expect(html.headers['x-content-type-options']).toBe('nosniff');
  expect((await t.app.inject({ url: `${base}/source`, headers })).statusCode).toBe(404);
  expect((await t.app.inject({ url: `${base}/reader`, headers })).statusCode).toBe(404);
  const list = await t.app.inject({ url: '/api/v1/documents?pageSize=1', headers }); expect(list.json().items[0]).toMatchObject({ id: saved.documentId, kind: 'article', saveStatus: 'original-saved' }); expect(list.json().total).toBe(1);
  expect((await t.app.inject({ url: base, headers })).json().source.sourceVersionId).toBe(saved.sourceVersionId);
  const pdf = await t.app.inject({ method: 'POST', url: '/api/v1/documents/pdf', headers: { ...headers, 'idempotency-key': 'mixed-library-pdf', 'content-type': 'multipart/form-data; boundary=mixed' },
    payload: Buffer.from('--mixed\r\nContent-Disposition: form-data; name="file"; filename="mixed.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7\n%%EOF\r\n--mixed--\r\n') });
  expect(pdf.statusCode, pdf.body).toBe(201);
  const pages = await Promise.all([1, 2].map(page => t.app.inject({ url: `/api/v1/documents?pageSize=1&page=${page}`, headers })));
  expect(pages.map(page => page.json().total)).toEqual([2, 2]);
  expect(new Set(pages.flatMap(page => page.json().items.map((item: { kind: string }) => item.kind)))).toEqual(new Set(['pdf', 'article']));
  const range = await t.app.inject({ url: `/api/v1/documents/${pdf.json().id}/source`, headers: { ...headers, range: 'bytes=0-4' } });
  expect(range.statusCode).toBe(206); expect(range.body).toBe('%PDF-');
  const position = { readerVersionId: saved.readerVersionId, sourceVersionId: saved.sourceVersionId, parseId: descriptor.parseId, blockId: descriptor.index.chunks[0].blockIds[0], blockOffset: 0.4, view: 'content', contentMode: 'source' };
  const put = (expectedRevision: number, p = position) => t.app.inject({ method: 'PUT', url: `${base}/web-progress`, headers, payload: { expectedRevision, position: p } });
  expect((await put(0)).json()).toMatchObject({ revision: 1, position }); expect((await put(0)).statusCode).toBe(409);
  expect((await put(1, { ...position, blockId: `b_${'f'.repeat(32)}` })).statusCode).toBe(400);
  expect((await t.app.inject({ url: `${base}/web-reader`, headers })).json().progress.position).toEqual(position);
  expect(modelCalls).toBe(0); expect((await t.db.pool.query('SELECT id FROM web_jobs')).rows).toHaveLength(0);
});
it('exposes only registered image closure, archives CSS as an attachment, and keeps device access capture-only', async () => {
  const { createHash } = await import('node:crypto');
  const t = await createServiceTestApp(); closes.push(t.close);
  await bootstrapAdmin(t.db, { username: 'admin', password: 'correct password 123456' });
  const session = await login(t.app, 'admin', 'correct password 123456');
  const headers = { cookie: session.cookie, origin: t.config.publicOrigin, 'x-csrf-token': session.csrfToken };
  const pairedCode = await t.app.inject({ method: 'POST', url: '/api/v1/devices/pairing-codes', headers, payload: {} });
  const paired = await t.app.inject({ method: 'POST', url: '/api/v1/devices/exchange', payload: { code: pairedCode.json().code, deviceName: 'Capture', extensionId: 'test', extensionVersion: '1' } });
  const authorization = `Bearer ${paired.json().token}`;
  const value = capture('<article><p>The original source includes a local archived image.</p><img data-pl-resource="r_1" alt="illustration"></article>');
  const image = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'); const css = Buffer.from('body { background: url(https://evil.example); }');
  for (const [id, bytes, role, mediaType] of [['__proto__', image, 'image', 'image/gif'], ['css', css, 'css', 'text/css']] as const) value.manifest.files.push({ id, path: `${id}.data`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), role, mediaType });
  value.manifest.resources.push({ id: 'r_1', url: 'https://example.com/image.gif', role: 'image', status: 'available', fileId: '__proto__' }); value.manifest.stylesheetFileIds.push('css');
  const created = await t.app.inject({ method: 'POST', url: '/api/v1/captures', headers: { authorization, 'idempotency-key': value.manifest.captureId }, payload: { manifest: value.manifest, translationIntent: 'none' } }); expect(created.statusCode).toBe(201);
  const id = created.json().id;
  for (const [fileId, payload, media] of [['html', value.body, 'text/html'], ['__proto__', image, 'image/gif'], ['css', css, 'text/css']] as const) {
    const response = await t.app.inject({ method: 'PUT', url: `/api/v1/captures/${id}/files/${fileId}`, headers: { authorization, 'content-type': media }, payload }); expect(response.statusCode, response.body).toBe(200);
  }
  const response = await t.app.inject({ method: 'POST', url: `/api/v1/captures/${id}/commit`, headers: { authorization }, payload: {} }); expect(response.statusCode, response.body).toBe(200);
  const saved = response.json(), base = `/api/v1/documents/${saved.documentId}`;
  const descriptor = (await t.app.inject({ url: `${base}/web-reader`, headers })).json(); expect(Object.hasOwn(descriptor.assetMap, '__proto__')).toBe(true);
  const assetUrl = `${base}/web-reader/versions/${saved.readerVersionId}/assets/${descriptor.assetMap['__proto__']}`;
  const delivered = await t.app.inject({ url: assetUrl, headers }); expect(delivered.statusCode).toBe(200); expect(delivered.rawPayload).toEqual(image);
  expect((await t.app.inject({ url: `${base}/web-reader/versions/${saved.readerVersionId}/assets/${saved.sourceVersionId}`, headers })).statusCode).toBe(404);
  const stylesheet = await t.app.inject({ url: `${base}/web-snapshots/${saved.sourceVersionId}/files/css`, headers }); expect(stylesheet.headers['content-type']).toContain('application/octet-stream'); expect(stylesheet.headers['content-disposition']).toContain('attachment');
  for (const url of [assetUrl, `${base}/web-reader`, `${base}/web-snapshots/${saved.sourceVersionId}/manifest`, '/api/v1/documents']) expect((await t.app.inject({ url, headers: { ...headers, authorization } })).statusCode).toBe(401);
});
