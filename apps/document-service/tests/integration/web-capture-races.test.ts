import { randomUUID } from 'node:crypto';
import { utimes, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { bootstrapAdmin } from '../../src/cli/bootstrap-admin.js';
import { tokenHash } from '../../src/auth/sessions.js';
import { createServiceTestApp } from '../helpers/app.js';
import { login } from '../helpers/session.js';
import { capture, withCandidates } from '../helpers/web-capture.js';
import { createWebCapturesService } from '../../src/web-captures/service.js';
import { createLocalObjectStore } from '../../src/storage/local-object-store.js';
import { cleanupStaging } from '../../src/cli/cleanup-staging.js';
import type { CapturePrincipal } from '../../src/devices/guards.js';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
async function setup() {
  const t = await createServiceTestApp(); closes.push(t.close);
  await bootstrapAdmin(t.db, { username: 'admin', password: 'correct password 123456' });
  const session = await login(t.app, 'admin', 'correct password 123456');
  const principal: CapturePrincipal = { kind: 'session', actor: { userId: session.user.id, role: 'admin', authVersion: 1, sessionHash: tokenHash(session.cookie.split('=')[1]!) } };
  const store = createLocalObjectStore(t.config.dataDir);
  const service = createWebCapturesService({ db: t.db, config: t.config, store });
  const value = capture(); const row = await service.create(principal, { manifest: value.manifest, translationIntent: 'none' }, value.manifest.captureId);
  await service.receiveFile(principal, row.id, 'html', (async function* () { yield value.body; })(), 'text/html');
  return { ...t, session, principal, store, service, row, value };
}
async function upload(t: Awaited<ReturnType<typeof setup>>, value: ReturnType<typeof capture> & { translation?: Buffer }, service = t.service) {
  const row = await service.create(t.principal, { manifest: value.manifest, translationIntent: 'none' }, value.manifest.captureId);
  for (const file of value.manifest.files) await service.receiveFile(t.principal, row.id, file.id, (async function* () { yield file.id === 'html' ? value.body : value.translation!; })(), file.mediaType);
  return row.id;
}
it.each(['reuse', 'extend'] as const)('checks only retained dependencies when histories and uploaded originals are missing (%s)', async mode => {
  const t = await setup(); const a = await t.service.commit(t.principal, t.row.id);
  const html = '<p>This independent source has a completed imported English paragraph and retained source files.</p>';
  const first = await t.service.commit(t.principal, await upload(t, capture(html)));
  const imported = await t.service.commit(t.principal, await upload(t, await withCandidates(html)));
  const ignored = new Set<string>((await t.db.pool.query(`SELECT a.object_key FROM assets a JOIN web_reader_versions r ON a.id=r.index_asset_id
    WHERE r.id=ANY($1::uuid[]) UNION SELECT a.object_key FROM assets a JOIN web_source_files f ON a.id=f.asset_id
    WHERE f.source_version_id=$2 AND f.id LIKE 'uploaded:%'`, [[a.readerVersionId, first.readerVersionId, ...(mode === 'extend' ? [imported.readerVersionId] : [])], imported.sourceVersionId])).rows.map(row => row.object_key));
  expect(ignored.size).toBeGreaterThan(3);
  for (const key of ignored) await t.store.deleteUnreferenced(key);
  const scanned: string[] = [];
  const store = { ...t.store, async stat(key: string) { scanned.push(key); return t.store.stat(key); } };
  const service = createWebCapturesService({ db: t.db, config: t.config, store });
  const id = await upload(t, mode === 'extend' ? await withCandidates(html) : capture(html), service);
  const result = await service.commit(t.principal, id);
  expect(result.sourceVersionId).toBe(imported.sourceVersionId);
  if (mode === 'reuse') expect(result.readerVersionId).toBe(imported.readerVersionId);
  else expect(result.readerVersionId).not.toBe(imported.readerVersionId);
  expect(scanned.filter(key => ignored.has(key))).toEqual([]);
  expect((await t.db.pool.query('SELECT id FROM source_versions')).rows).toHaveLength(2);
});
it.each(['reuse-chunk', 'extend-ir', 'extend-source-file'] as const)('rejects a required retained dependency lost after validation (%s)', async dependency => {
  const t = await setup(); const first = await t.service.commit(t.principal, t.row.id);
  const query = dependency === 'reuse-chunk'
    ? 'SELECT a.object_key FROM assets a JOIN web_reader_chunks c ON a.id=c.data_asset_id WHERE c.reader_version_id=$1 LIMIT 1'
    : dependency === 'extend-ir' ? 'SELECT a.object_key FROM assets a JOIN web_parse_runs p ON a.id=p.ir_asset_id WHERE p.source_version_id=$1'
      : "SELECT a.object_key FROM assets a JOIN web_source_files f ON a.id=f.asset_id WHERE f.source_version_id=$1 AND f.id='html'";
  const key = (await t.db.pool.query(query, [dependency === 'reuse-chunk' ? first.readerVersionId : first.sourceVersionId])).rows[0].object_key;
  let staged = false, removed = false;
  const store = { ...t.store,
    async putImmutable(...args: Parameters<typeof t.store.putImmutable>) { const result = await t.store.putImmutable(...args); staged = true; return result; },
    async stat(objectKey: string) { if (staged && objectKey === key) { removed = true; await t.store.deleteUnreferenced(key); } return t.store.stat(objectKey); },
  };
  const service = createWebCapturesService({ db: t.db, config: t.config, store });
  const value = dependency === 'reuse-chunk' ? capture(t.value.body.toString()) : await withCandidates(t.value.body.toString());
  const id = await upload(t, value, service);
  await expect(service.commit(t.principal, id)).rejects.toThrow(); expect(removed).toBe(true);
  expect((await t.service.status(t.principal, id)).status).toBe('failed');
  expect((await t.db.pool.query('SELECT id FROM web_reader_versions')).rows).toHaveLength(1);
  expect((await t.db.pool.query('SELECT id FROM web_translation_runs')).rows).toHaveLength(0);
  expect((await t.db.pool.query('SELECT current_source_version_id,current_web_reader_version_id FROM documents')).rows[0]).toEqual({ current_source_version_id: first.sourceVersionId, current_web_reader_version_id: first.readerVersionId });
});
it('rejects an object lost immediately before the publication dependency check', async () => {
  const t = await setup(); let removed = false;
  const store = { ...t.store, async stat(key: string) { if (!removed) { removed = true; await t.store.deleteUnreferenced(key); } return t.store.stat(key); } };
  const service = createWebCapturesService({ db: t.db, config: t.config, store });
  await expect(service.commit(t.principal, t.row.id)).rejects.toThrow();
  expect((await t.db.pool.query('SELECT id FROM source_versions')).rows).toHaveLength(0);
  expect((await t.service.status(t.principal, t.row.id)).status).toBe('failed');
});
it('fences revocation between finished validation and reference publication and later cleans only orphans', async () => {
  const t = await setup(); let reached!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { reached = resolve; }); const paused = new Promise<void>(resolve => { release = resolve; }); let first = true;
  const store = { ...t.store, async putImmutable(...args: Parameters<typeof t.store.putImmutable>) { const saved = await t.store.putImmutable(...args); if (first) { first = false; reached(); await paused; } return saved; } };
  const service = createWebCapturesService({ db: t.db, config: t.config, store });
  const pending = service.commit(t.principal, t.row.id).catch(error => error);
  await arrived;
  await t.db.pool.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [t.session.user.id]); release();
  expect(await pending).toMatchObject({ statusCode: 401 });
  expect((await t.db.pool.query('SELECT id FROM web_reader_versions')).rows).toHaveLength(0);
  const old = new Date(Date.now() - 25 * 3600_000);
  for (const key of await readdir(join(t.config.dataDir, 'objects'))) await utimes(join(t.config.dataDir, 'objects', key), old, old);
  expect((await cleanupStaging({ db: t.db, dataDir: t.config.dataDir })).objects).toBeGreaterThan(0);
});
it('retains all immutable Web history in orphan cleanup and resets aged unfinished upload completeness', async () => {
  const t = await setup(); const result = await t.service.commit(t.principal, t.row.id);
  const old = new Date(Date.now() - 25 * 3600_000);
  const orphan = randomUUID(); await t.store.putImmutable(orphan, (async function* () { yield Buffer.from('orphan'); })(), 10);
  for (const key of await readdir(join(t.config.dataDir, 'objects'))) await utimes(join(t.config.dataDir, 'objects', key), old, old);
  const value = capture('<p>A second unfinished original which should resume after stale staging cleanup.</p>');
  const pending = await t.service.create(t.principal, { manifest: value.manifest, translationIntent: 'none' }, value.manifest.captureId);
  await t.service.receiveFile(t.principal, pending.id, 'html', (async function* () { yield value.body; })(), 'text/html');
  const stage = (await t.db.pool.query('SELECT staging_key FROM web_capture_files WHERE capture_id=$1', [pending.id])).rows[0].staging_key;
  await utimes(join(t.config.dataDir, 'web-staging', stage), old, old);
  await t.db.pool.query("UPDATE web_captures SET updated_at=clock_timestamp()-interval '25 hours' WHERE id=$1", [pending.id]);
  expect((await cleanupStaging({ db: t.db, dataDir: t.config.dataDir })).objects).toBe(1);
  for (const asset of (await t.db.pool.query('SELECT object_key FROM assets')).rows) await expect(t.store.stat(asset.object_key)).resolves.toBeDefined();
  expect((await t.service.status(t.principal, pending.id)).missingFileIds).toEqual(['html']);
  expect((await t.service.status(t.principal, t.row.id)).readerVersionId).toBe(result.readerVersionId);
});
