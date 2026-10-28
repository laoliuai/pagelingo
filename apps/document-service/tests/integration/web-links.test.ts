import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { bootstrapAdmin } from '../../src/cli/bootstrap-admin.js';
import { createServiceTestApp } from '../helpers/app.js';
import { login } from '../helpers/session.js';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
async function setup() {
  let modelCalls = 0;
  const t = await createServiceTestApp({ outboundFetch: async () => { modelCalls++; throw new Error('No provider'); } }); closes.push(t.close);
  await bootstrapAdmin(t.db, { username: 'admin', password: 'correct password 123456' });
  const session = await login(t.app, 'admin', 'correct password 123456');
  const headers = { cookie: session.cookie, origin: t.config.publicOrigin, 'x-csrf-token': session.csrfToken };
  const save = (url = 'https://public.example/article?id=2&utm_source=test', key = randomUUID(), extra = {}) => t.app.inject({ method: 'POST', url: '/api/v1/documents/links', headers: { ...headers, 'idempotency-key': key }, payload: { url, translationIntent: 'none', ...extra } });
  return { ...t, session, headers, save, modelCalls: () => modelCalls };
}
it('saves a durable real link and queues one job across concurrent lost-ACK retries', async () => {
  const t = await setup(); const key = randomUUID();
  const first = await t.save(undefined, key); expect(first.statusCode, first.body).toBe(201);
  const retries = await Promise.all(Array.from({ length: 3 }, () => t.save(undefined, key)));
  for (const response of retries) expect(response.json()).toEqual(first.json());
  const normalized = await t.save('https://public.example/article?id=2&utm_medium=new'); expect(normalized.json()).toEqual(first.json());
  expect((await t.save('https://public.example/different', key)).statusCode).toBe(409);
  expect((await t.db.pool.query('SELECT id,source_url FROM documents')).rows).toEqual([{ id: first.json().documentId, source_url: 'https://public.example/article?id=2' }]);
  expect((await t.db.pool.query('SELECT id,kind,status FROM web_jobs')).rows).toEqual([{ id: first.json().jobId, kind: 'fetch-link', status: 'queued' }]);
  expect((await t.app.inject({ url: `/api/v1/documents/${first.json().documentId}`, headers: t.headers })).json()).toMatchObject({ source: null, saveStatus: 'link-only' });
  expect(t.modelCalls()).toBe(0);
});
it.each(['https://x.com/u/status/123', 'https://www.zhihu.com/question/123/answer/456', 'https://mp.weixin.qq.com/s/article', 'https://github.com/a/b/issues', 'https://arxiv.org/search', 'https://example.com/account/login'])('keeps unsupported/browser-only source %s as an honest link', async url => {
  const t = await setup(); const response = await t.save(url); expect(response.statusCode, response.body).toBe(201); expect(response.json().jobId).toBeNull();
  expect((await t.db.pool.query('SELECT id FROM web_jobs')).rows).toHaveLength(0);
  expect((await t.app.inject({ url: `/api/v1/documents/${response.json().documentId}`, headers: t.headers })).json()).toMatchObject({ source: null, reader: null, saveStatus: 'link-only' });
  expect(t.modelCalls()).toBe(0);
});
it('requires stable transport identity and session CSRF; invalid device never falls back to cookies', async () => {
  const t = await setup();
  const payload = { url: 'https://example.com/', translationIntent: 'none' };
  expect((await t.app.inject({ method: 'POST', url: '/api/v1/documents/links', headers: t.headers, payload })).statusCode).toBe(400);
  expect((await t.app.inject({ method: 'POST', url: '/api/v1/documents/links', headers: { cookie: t.session.cookie, 'idempotency-key': randomUUID() }, payload })).statusCode).toBe(403);
  expect((await t.app.inject({ method: 'POST', url: '/api/v1/documents/links', headers: { ...t.headers, authorization: 'Bearer invalid', 'idempotency-key': randomUUID() }, payload })).statusCode).toBe(401);
  expect((await t.save(undefined, randomUUID(), { ownerId: randomUUID() })).statusCode).toBe(400);
  expect((await t.db.pool.query('SELECT id FROM documents')).rows).toHaveLength(0);
});
it('runs real worker extraction under a lease and retains raw bytes independently of the cleaned source', async () => {
  const { runFetchJob } = await import('../../src/web-captures/fetch-runner.js');
  const { startWebJobLease } = await import('../../src/web-jobs/repository.js');
  const { createLocalObjectStore } = await import('../../src/storage/local-object-store.js');
  const { createCaptureFetch } = await import('../../src/network/capture-fetch.js');
  const { wire, lookup } = await import('../helpers/pinned-wire.js');
  const { createHash } = await import('node:crypto');
  const t = await setup(); const saved = (await t.save()).json();
  const raw = Buffer.from('<html><head><title>Article</title></head><body><article><h1>Public article</h1>' + '<p>This original public article explains a useful subject in several detailed sentences. The meaningful evidence remains available for ordinary reading without any translation request.</p>'.repeat(5) + '<img src="blob:https://public.example/123e4567-e89b-42d3-a456-426614174000"><pre><code>&lt;input type="password"&gt;</code></pre><script>SECRET_SCRIPT(); const code = \'<input type="password">\';</script></article></body></html>');
  const socket = wire(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${raw.length}\r\n\r\n${raw}`);
  const lease = await t.db.transaction(c => startWebJobLease(c, { ownerId: t.session.user.id, jobId: saved.jobId, slotId: 1, leaseOwner: 'test-worker' })); expect(lease).not.toBeNull();
  await runFetchJob(lease!, { db: t.db, config: t.config, store: createLocalObjectStore(t.config.dataDir), signal: new AbortController().signal,
    captureFetch: createCaptureFetch({ lookup, connector: async () => socket.stream, timeoutMs: 1000, maxResponseBytes: t.config.captureLimits.maxHtmlBytes }) });
  const job = (await t.db.pool.query('SELECT status,reader_version_id FROM web_jobs WHERE id=$1', [saved.jobId])).rows[0]; expect(job.status).toBe('completed');
  const acquisition = (await t.db.pool.query('SELECT a.*,c.capture_id,c.manifest,c.session_id,c.device_id FROM web_fetch_acquisitions a JOIN web_captures c ON c.id=a.ingestion_id')).rows[0];
  expect(new Set([saved.jobId, acquisition.ingestion_id, acquisition.capture_id]).size).toBe(3);
  expect(acquisition).toMatchObject({ raw_sha256: createHash('sha256').update(raw).digest('hex'), session_id: null, device_id: null });
  const result = (await t.app.inject({ url: `/api/v1/documents/${saved.documentId}/web-reader`, headers: t.headers })).json();
  expect(result.versionId).toBe(job.reader_version_id); expect(result.translationStatus).toBe('pending');
  const manifest = (await t.app.inject({ url: `/api/v1/documents/${saved.documentId}/web-snapshots/${result.source.sourceVersionId}/manifest`, headers: t.headers })).json();
  expect(manifest.resources).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'image', status: 'missing', reason: 'unavailable' })]));
  const cleaned = await t.app.inject({ url: `/api/v1/documents/${saved.documentId}/web-snapshots/${result.source.sourceVersionId}/files/html`, headers: t.headers });
  expect(cleaned.body).toContain('original public article'); expect(cleaned.body).not.toContain('SECRET_SCRIPT');
  const original = await t.app.inject({ url: `/api/v1/documents/${saved.documentId}/web-snapshots/${result.source.sourceVersionId}/files/uploaded:${acquisition.raw_asset_id}`, headers: t.headers });
  expect(original.rawPayload).toEqual(raw); expect(t.modelCalls()).toBe(0);
  await expect(t.db.pool.query('UPDATE web_fetch_acquisitions SET raw_sha256=$1', ['a'.repeat(64)])).rejects.toThrow(/immutable/i);
  await expect(t.db.pool.query('UPDATE web_captures SET fetch_job_id=NULL WHERE id=$1', [acquisition.ingestion_id])).rejects.toThrow('Immutable capture input');
  await expect(t.db.pool.query('UPDATE web_link_requests SET request_hash=$1', ['a'.repeat(64)])).rejects.toThrow(/immutable/i);
  await expect(t.db.transaction(async c => {
    const current = (await c.query('DELETE FROM web_fetch_acquisitions WHERE owner_id=$1 RETURNING *', [t.session.user.id])).rows[0];
    await c.query('INSERT INTO web_fetch_acquisitions (owner_id,document_id,auth_version,job_id,ingestion_id,raw_asset_id,raw_sha256,raw_bytes,final_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [current.owner_id,current.document_id,current.auth_version+1,current.job_id,current.ingestion_id,current.raw_asset_id,current.raw_sha256,current.raw_bytes,current.final_url]);
  })).rejects.toMatchObject({ code: '23503' });
});
it.each(['<html><body><form><input type="password"></form></body></html>', '<html><body><h1>Account access</h1><form><input TYPE="password"></form><p>Sign in to your account to read the article. Manage your account settings and subscription here. This page explains account access, password recovery and the services available after authentication.</p></body></html>'])('keeps unavailable/login content as a link and never fabricates a Reader: %s', async html => {
  const { runFetchJob } = await import('../../src/web-captures/fetch-runner.js');
  const { startWebJobLease } = await import('../../src/web-jobs/repository.js');
  const { createLocalObjectStore } = await import('../../src/storage/local-object-store.js');
  const t = await setup(); const saved = (await t.save()).json();
  const lease = await t.db.transaction(c => startWebJobLease(c, { ownerId: t.session.user.id, jobId: saved.jobId, slotId: 1, leaseOwner: 'test-worker' }));
  await runFetchJob(lease!, { db: t.db, config: t.config, store: createLocalObjectStore(t.config.dataDir), signal: new AbortController().signal,
    captureFetch: async () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
  expect((await t.db.pool.query('SELECT status,error_code FROM web_jobs')).rows[0]).toMatchObject({ status: 'failed', error_code: 'FETCH_BROWSER_REQUIRED' });
  expect((await t.db.pool.query('SELECT id FROM source_versions')).rows).toHaveLength(0);
  expect((await t.app.inject({ url: `/api/v1/documents/${saved.documentId}`, headers: t.headers })).json()).toMatchObject({ source: null, reader: null, saveStatus: 'link-only' });
});
it('restarts from immutable acquired bytes after failed publication and GC without another fetch', async () => {
  const { runFetchJob } = await import('../../src/web-captures/fetch-runner.js');
  const { startWebJobLease } = await import('../../src/web-jobs/repository.js');
  const { createLocalObjectStore } = await import('../../src/storage/local-object-store.js');
  const { cleanupStaging } = await import('../../src/cli/cleanup-staging.js');
  const { utimes } = await import('node:fs/promises'); const { join } = await import('node:path');
  const t = await setup(); const saved = (await t.save(undefined, randomUUID(), { translationIntent: 'auto', title: 'Saved public title' })).json();
  const store = createLocalObjectStore(t.config.dataDir); let fetches = 0;
  const captureFetch: typeof fetch = async () => { fetches++; return new Response('<article><h1>Durable source</h1>' + '<p>The retained source provides a detailed explanation with useful original evidence. Restarting must not change any source bytes or its capture time and identity.</p>'.repeat(5) + '</article>', { headers: { 'content-type': 'text/html' } }); };
  const claim = () => t.db.transaction(c => startWebJobLease(c, { ownerId: t.session.user.id, jobId: saved.jobId, slotId: 1, leaseOwner: 'restart-worker' }));
  await runFetchJob((await claim())!, { db: t.db, config: t.config, store, signal: new AbortController().signal, captureFetch, onPublication: async () => { throw new Error('Simulated transaction failure'); } });
  const before = (await t.db.pool.query('SELECT a.*,c.manifest,c.capture_id FROM web_fetch_acquisitions a JOIN web_captures c ON c.id=a.ingestion_id')).rows[0]; expect(before).toBeDefined();
  expect((await t.db.pool.query('SELECT id FROM source_versions')).rows).toHaveLength(0);
  const key = (await t.db.pool.query('SELECT object_key FROM assets WHERE id=$1', [before.raw_asset_id])).rows[0].object_key;
  const old = new Date(Date.now() - 26 * 3600_000); await utimes(join(t.config.dataDir, 'objects', key), old, old);
  await t.db.pool.query('UPDATE web_captures SET updated_at=$2 WHERE id=$1', [before.ingestion_id, old]);
  await cleanupStaging({ db: t.db, dataDir: t.config.dataDir });
  expect((await store.stat(key)).bytes).toBe(Number(before.raw_bytes));
  await t.db.pool.query("UPDATE web_jobs SET status='queued',epoch=epoch+1 WHERE id=$1", [saved.jobId]);
  let event: unknown;
  await runFetchJob((await claim())!, { db: t.db, config: t.config, store, signal: new AbortController().signal, captureFetch, onPublication: async (_c, value) => { event = value; return null; } });
  expect((await t.db.pool.query('SELECT status FROM web_jobs')).rows[0].status).toBe('completed');
  expect(fetches).toBe(1); expect(event).toMatchObject({ captureId: before.capture_id, ingestionId: before.ingestion_id, translationIntent: 'auto' });
  const after = (await t.db.pool.query('SELECT a.*,c.manifest,c.capture_id FROM web_fetch_acquisitions a JOIN web_captures c ON c.id=a.ingestion_id')).rows[0]; expect(after).toEqual(before);
  expect((await t.db.pool.query('SELECT id FROM source_versions')).rows).toHaveLength(1);
  expect((await t.app.inject({ url: `/api/v1/captures/${before.ingestion_id}`, headers: t.headers })).statusCode).toBe(404);
});
it.each(['job', 'slot', 'auth'] as const)('fences a superseded %s during fetch without publication or erasing the new owner', async boundary => {
  const { runFetchJob } = await import('../../src/web-captures/fetch-runner.js');
  const { startWebJobLease } = await import('../../src/web-jobs/repository.js');
  const { createLocalObjectStore } = await import('../../src/storage/local-object-store.js');
  const t = await setup(); const saved = (await t.save()).json();
  const lease = (await t.db.transaction(c => startWebJobLease(c, { ownerId: t.session.user.id, jobId: saved.jobId, slotId: 1, leaseOwner: 'old-worker' })))!;
  await expect(runFetchJob(lease, { db: t.db, config: t.config, store: createLocalObjectStore(t.config.dataDir), signal: new AbortController().signal, captureFetch: async () => {
    // The network callback can take the user lock: no transaction spans network/worker work.
    await t.db.transaction(async c => { await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT', [lease.ownerId]);
      if (boundary === 'job') await c.query('UPDATE web_jobs SET epoch=epoch+1 WHERE id=$1', [lease.jobId]);
      if (boundary === 'slot') await c.query("UPDATE web_worker_slots SET epoch=epoch+1,lease_owner='new-worker' WHERE id=$1", [lease.slotId]);
      if (boundary === 'auth') await c.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [lease.ownerId]);
    });
    return new Response('<article><p>Stale fetched article.</p></article>', { headers: { 'content-type': 'text/html' } });
  } })).rejects.toThrow('lease is no longer current');
  expect((await t.db.pool.query('SELECT id FROM source_versions')).rows).toHaveLength(0);
  expect((await t.db.pool.query('SELECT id FROM web_captures')).rows).toHaveLength(0);
  expect((await t.db.pool.query('SELECT status FROM web_jobs')).rows[0].status).toBe('running');
  if (boundary === 'slot') expect((await t.db.pool.query('SELECT lease_owner FROM web_worker_slots WHERE id=1')).rows[0].lease_owner).toBe('new-worker');
});
it('isolates device link ownership from admin cookies and revalidates links scope/revocation', async () => {
  const t = await setup();
  await t.db.pool.query("INSERT INTO users (username,password_hash,role) SELECT 'alice',password_hash,'user' FROM users WHERE username='admin'");
  const alice = await login(t.app, 'alice', 'correct password 123456');
  const aliceHeaders = { cookie: alice.cookie, origin: t.config.publicOrigin, 'x-csrf-token': alice.csrfToken };
  const pairing = await t.app.inject({ method: 'POST', url: '/api/v1/devices/pairing-codes', headers: aliceHeaders, payload: {} });
  const exchange = await t.app.inject({ method: 'POST', url: '/api/v1/devices/exchange', payload: { code: pairing.json().code, deviceName: 'Browser', extensionId: 'test-extension', extensionVersion: '1.0' } });
  const device = exchange.json(); const key = randomUUID();
  const create = () => t.app.inject({ method: 'POST', url: '/api/v1/documents/links', headers: { ...t.headers, authorization: `Bearer ${device.token}`, 'idempotency-key': key }, payload: { url: 'https://x.com/a/status/123', translationIntent: 'none' } });
  const saved = await create(); expect(saved.statusCode, saved.body).toBe(201);
  expect((await t.db.pool.query('SELECT owner_id FROM documents WHERE id=$1', [saved.json().documentId])).rows[0].owner_id).toBe(alice.user.id);
  expect((await t.app.inject({ url: `/api/v1/documents/${saved.json().documentId}`, headers: t.headers })).statusCode).toBe(404);
  const admin = await t.save('https://x.com/a/status/123', key); expect(admin.json().documentId).not.toBe(saved.json().documentId);
  await t.db.pool.query("UPDATE devices SET scopes=ARRAY['captures:write'] WHERE id=$1", [device.device.id]); expect((await create()).statusCode).toBe(403);
  await t.db.pool.query("UPDATE devices SET scopes=ARRAY['links:write'],revoked_at=clock_timestamp() WHERE id=$1", [device.device.id]); expect((await create()).statusCode).toBe(401);
  expect((await t.db.pool.query('SELECT id FROM documents')).rows).toHaveLength(2);
});
it('preserves an old lost-ACK result but never revives its job after authVersion changes', async () => {
  const t = await setup(); const key = randomUUID(); const first = (await t.save(undefined, key)).json();
  await t.db.pool.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [t.session.user.id]);
  const current = await login(t.app, 'admin', 'correct password 123456');
  const save = (idempotencyKey: string) => t.app.inject({ method: 'POST', url: '/api/v1/documents/links', headers: { cookie: current.cookie, origin: t.config.publicOrigin, 'x-csrf-token': current.csrfToken, 'idempotency-key': idempotencyKey }, payload: { url: 'https://public.example/article?id=2', translationIntent: 'none' } });
  expect((await save(key)).json()).toEqual(first);
  const next = (await save(randomUUID())).json(); expect(next.documentId).toBe(first.documentId); expect(next.jobId).not.toBe(first.jobId);
  const { startWebJobLease } = await import('../../src/web-jobs/repository.js');
  expect(await t.db.transaction(c => startWebJobLease(c, { ownerId: t.session.user.id, jobId: first.jobId, slotId: 1, leaseOwner: 'worker' }))).toBeNull();
});
it('checks the lease again after real worker/render staging before publishing', async () => {
  const { runFetchJob } = await import('../../src/web-captures/fetch-runner.js');
  const { startWebJobLease } = await import('../../src/web-jobs/repository.js');
  const { createLocalObjectStore } = await import('../../src/storage/local-object-store.js');
  const t = await setup(); const saved = (await t.save()).json();
  const lease = (await t.db.transaction(c => startWebJobLease(c, { ownerId: t.session.user.id, jobId: saved.jobId, slotId: 1, leaseOwner: 'late-worker' })))!;
  const local = createLocalObjectStore(t.config.dataDir); let puts = 0;
  const store: typeof local = { ...local, async putImmutable(...args) {
    const stored = await local.putImmutable(...args);
    if (++puts === 2) await t.db.transaction(async c => {
      await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT', [lease.ownerId]);
      await c.query('UPDATE web_jobs SET epoch=epoch+1 WHERE id=$1', [lease.jobId]);
    });
    return stored;
  } };
  await expect(runFetchJob(lease, { db: t.db, store, config: t.config, signal: new AbortController().signal, captureFetch: async () => new Response('<article><h1>Original article</h1>' + '<p>This public article gives a detailed explanation with many useful sentences. The content is available, but the worker loses its lease before publication is allowed.</p>'.repeat(5) + '</article>', { headers: { 'content-type': 'text/html' } }) })).rejects.toThrow('lease is no longer current');
  expect(puts).toBeGreaterThan(2); expect((await t.db.pool.query('SELECT id FROM source_versions')).rows).toHaveLength(0);
  expect((await t.db.pool.query('SELECT raw_asset_id FROM web_fetch_acquisitions')).rows).toHaveLength(1);
});
