import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createBundleImportsService } from '../../src/bundle-imports/service.js';
import { createDocumentsService } from '../../src/documents/service.js';
import { createLocalObjectStore } from '../../src/storage/local-object-store.js';
import { bootstrapAdmin } from '../../src/cli/bootstrap-admin.js';
import { createServiceTestApp } from '../helpers/app.js';
import { login } from '../helpers/session.js';
import { bundleFixture, body } from '../helpers/bundles.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup() {
  const test = await createServiceTestApp(); cleanup.push(test.close);
  await bootstrapAdmin(test.db, { username: 'admin', password: 'correct password 123456' });
  await test.db.pool.query(`INSERT INTO users (username,password_hash,role) SELECT 'alice',password_hash,'user' FROM users WHERE username='admin'`);
  async function actorFor(name: string) {
    const session = await login(test.app, name, 'correct password 123456');
    return { userId: session.user.id, role: session.user.role, authVersion: 1,
      sessionHash: (await test.db.pool.query('SELECT token_hash FROM sessions WHERE user_id=$1', [session.user.id])).rows[0].token_hash as string };
  }
  const actor = await actorFor('alice'); const admin = await actorFor('admin');
  const store = createLocalObjectStore(test.config.dataDir);
  const service = createBundleImportsService({ db: test.db, store, config: test.config });
  const documents = createDocumentsService({ db: test.db, store });
  const ingest = async (bytes: Uint8Array, targetDocumentId?: string) => {
    const created = await service.create(actor, targetDocumentId ? { targetDocumentId } : {}, randomUUID());
    return service.receive(actor, created.id, body(bytes));
  };
  return { ...test, actor, admin, store, service, documents, ingest };
}

describe('atomic private bundle publication', () => {
  it('attaches to the uploaded original, stores all bundle files and generated chunks, and directly creates a document', async () => {
    const t = await setup(); const fixture = await bundleFixture(t.config.dataDir);
    const original = await t.documents.savePdf(t.actor, { idempotencyKey: randomUUID(), originalFilename: 'book.pdf', body: body(fixture.files.get('source.pdf')!) });
    const imported = await t.ingest(fixture.bytes, original.id);
    expect(imported).toMatchObject({ status: 'completed', documentId: original.id, epoch: 1 });
    expect((await t.documents.get(t.actor, original.id)).reader?.versionId).toBe(imported.readerVersionId);
    expect((await t.db.pool.query('SELECT path FROM bundle_files')).rows).toHaveLength(fixture.files.size);
    expect((await t.db.pool.query('SELECT id FROM reader_chunks')).rows.length).toBeGreaterThan(0);
    const created = await t.service.create(t.admin, {}, randomUUID());
    const other = await t.service.receive(t.admin, created.id, body(fixture.bytes));
    expect(other.documentId).not.toBe(original.id);
    const assets = (await t.db.pool.query('SELECT owner_id, object_key FROM assets')).rows;
    expect(new Set(assets.map(asset => asset.object_key)).size).toBe(assets.length);
    await expect(t.service.get(t.admin, imported.id)).rejects.toMatchObject({ statusCode: 404 });
  });
  it('is idempotent by request and package and never moves current back to an older package', async () => {
    const t = await setup(); const old = await bundleFixture(t.config.dataDir);
    const key = randomUUID(); const created = await t.service.create(t.actor, {}, key);
    expect(await t.service.create(t.actor, {}, key)).toEqual(created);
    const first = await t.service.receive(t.actor, created.id, body(old.bytes));
    const next = await t.ingest((await bundleFixture(t.config.dataDir, { status: 'completed' })).bytes);
    expect(next.documentId).toBe(first.documentId);
    const duplicate = await t.ingest(old.bytes);
    expect(duplicate.readerVersionId).toBe(first.readerVersionId);
    expect((await t.documents.get(t.actor, first.documentId!)).reader?.versionId).toBe(next.readerVersionId);
    await expect(t.service.cancel(t.actor, duplicate.id)).rejects.toMatchObject({ statusCode: 409 });
    const conflict = await bundleFixture(t.config.dataDir, { packageId: old.manifest.packageId });
    await expect(t.ingest(conflict.bytes)).rejects.toMatchObject({ code: 'BUNDLE_IDENTITY_CONFLICT' });
  });
  it('preserves successful current after partial and failed retranslations but exposes the first partial version', async () => {
    const t = await setup(); const first = await t.ingest((await bundleFixture(t.config.dataDir, { status: 'partial' })).bytes);
    expect((await t.documents.get(t.actor, first.documentId!)).reader?.versionId).toBe(first.readerVersionId);
    const success = await t.ingest((await bundleFixture(t.config.dataDir, { status: 'completed' })).bytes);
    for (const status of ['partial', 'failed'] as const) {
      const next = await t.ingest((await bundleFixture(t.config.dataDir, { status })).bytes);
      expect(next.status).toBe('completed');
      expect((await t.documents.get(t.actor, first.documentId!)).reader?.versionId).toBe(success.readerVersionId);
    }
  });
  it('rejects foreign targets and mismatched original identity without altering the original', async () => {
    const t = await setup(); const original = await t.documents.savePdf(t.actor, { idempotencyKey: randomUUID(), originalFilename: 'other.pdf', body: body(Buffer.from('%PDF-1.7\ndifferent')) });
    await expect(t.service.create(t.admin, { targetDocumentId: original.id }, randomUUID())).rejects.toMatchObject({ statusCode: 404 });
    await expect(t.ingest((await bundleFixture(t.config.dataDir)).bytes, original.id)).rejects.toMatchObject({ code: 'BUNDLE_SOURCE_CONFLICT' });
    expect((await t.documents.get(t.actor, original.id)).reader).toBeNull();
    expect((await t.db.pool.query('SELECT id FROM reader_versions')).rows).toEqual([]);
  });
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
it('cancels a disconnected producer immediately and permits a new ingestion without publishing partial state', async () => {
  const t = await setup(); const reached = deferred(); const release = deferred();
  const created = await t.service.create(t.actor, {}, randomUUID());
  const receiving = t.service.receive(t.actor, created.id, (async function* () { yield Buffer.from('PK'); reached.resolve(); await release.promise; })());
  const rejected = expect(receiving).rejects.toMatchObject({ code: 'BUNDLE_ABORTED' });
  await reached.promise;
  try {
    expect((await t.service.get(t.actor, created.id)).status).toBe('receiving');
    expect((await t.service.cancel(t.actor, created.id)).status).toBe('cancelled');
    await rejected;
    expect((await t.db.pool.query('SELECT id FROM reader_versions')).rows).toEqual([]);
    expect((await t.service.create(t.actor, {}, randomUUID())).status).toBe('created');
  } finally { release.resolve(); }
});
it('records interrupted uploads, fences stale epochs and recovers status and ingestion after restart', async () => {
  const t = await setup(); const fixture = await bundleFixture(t.config.dataDir);
  const created = await t.service.create(t.actor, {}, randomUUID());
  await expect(t.service.receive(t.actor, created.id, (async function* () { yield Buffer.from('PK'); throw new Error('socket lost'); })())).rejects.toMatchObject({ code: 'BUNDLE_IMPORT_FAILED' });
  expect((await t.service.get(t.actor, created.id)).status).toBe('failed');
  const restarted = createBundleImportsService({ db: t.db, store: t.store, config: t.config });
  expect((await restarted.receive(t.actor, created.id, body(fixture.bytes))).epoch).toBe(2);
  const next = await t.service.create(t.actor, {}, randomUUID());
  await t.db.pool.query("UPDATE bundle_imports SET status='validating',epoch=4,heartbeat_at=now()-interval '16 minutes' WHERE id=$1", [next.id]);
  expect(await restarted.get(t.actor, next.id)).toMatchObject({ status: 'failed', errorCode: 'BUNDLE_LEASE_EXPIRED' });
  expect((await restarted.receive(t.actor, next.id, body(fixture.bytes))).epoch).toBe(5);
});
it.each(['disable', 'reset'])('rechecks the account after long upload before publishing: %s', async action => {
  const t = await setup(); const fixture = await bundleFixture(t.config.dataDir); const reached = deferred(); const release = deferred();
  const created = await t.service.create(t.actor, {}, randomUUID());
  const receiving = t.service.receive(t.actor, created.id, (async function* () { yield fixture.bytes; reached.resolve(); await release.promise; })());
  const rejected = expect(receiving).rejects.toMatchObject({ statusCode: 401 });
  await reached.promise;
  await t.db.pool.query(action === 'disable' ? 'UPDATE users SET active=false WHERE id=$1' : 'UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [t.actor.userId]);
  release.resolve(); await rejected;
  expect((await t.db.pool.query('SELECT id FROM documents')).rows).toEqual([]);
});
it('rolls back references after object writes and preserves the original on deferred commit failure', async () => {
  const t = await setup(); const fixture = await bundleFixture(t.config.dataDir);
  const original = await t.documents.savePdf(t.actor, { idempotencyKey: randomUUID(), originalFilename: 'source.pdf', body: body(fixture.files.get('source.pdf')!) });
  await t.db.pool.query(`CREATE FUNCTION fail_bundle_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled'; END; $$`);
  await t.db.pool.query('CREATE CONSTRAINT TRIGGER fail_bundle_commit AFTER INSERT ON reader_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_bundle_commit()');
  await expect(t.ingest(fixture.bytes)).rejects.toMatchObject({ code: 'BUNDLE_IMPORT_FAILED' });
  expect((await t.documents.get(t.actor, original.id)).reader).toBeNull();
  expect((await t.db.pool.query('SELECT id FROM assets')).rows).toHaveLength(1);
  expect((await t.db.pool.query('SELECT id FROM reader_versions')).rows).toHaveLength(0);
  await t.db.pool.query('DROP TRIGGER fail_bundle_commit ON reader_versions');
  expect((await t.ingest(fixture.bytes)).documentId).toBe(original.id);
});
it('checks every object at the publication boundary and publishes nothing if the last object disappears', async () => {
  const t = await setup(); const fixture = await bundleFixture(t.config.dataDir); let last = '';
  const failing = createBundleImportsService({ db: t.db, config: t.config, store: { ...t.store,
    async putImmutable(key, bytes, max) { last = key; return t.store.putImmutable(key, bytes, max); },
    async stat(key) { if (key === last) await t.store.deleteUnreferenced(key); return t.store.stat(key); },
  } });
  const created = await failing.create(t.actor, {}, randomUUID());
  await expect(failing.receive(t.actor, created.id, body(fixture.bytes))).rejects.toMatchObject({ code: 'BUNDLE_IMPORT_FAILED' });
  expect((await t.db.pool.query('SELECT id FROM documents')).rows).toHaveLength(0);
  expect((await t.db.pool.query('SELECT id FROM assets')).rows).toHaveLength(0);
});
it('serializes first source reuse against a simultaneous original upload and rejects overlapping bundle processing', async () => {
  const t = await setup(); const fixture = await bundleFixture(t.config.dataDir); const reached = deferred(); const release = deferred();
  const created = await t.service.create(t.actor, {}, randomUUID());
  const receiving = t.service.receive(t.actor, created.id, (async function* () { yield fixture.bytes; reached.resolve(); await release.promise; })());
  await reached.promise;
  const other = await t.service.create(t.admin, {}, randomUUID());
  await expect(t.service.receive(t.admin, other.id, body(fixture.bytes))).rejects.toMatchObject({ code: 'BUNDLE_IMPORT_BUSY' });
  await expect(t.service.create(t.actor, {}, randomUUID())).rejects.toMatchObject({ code: 'BUNDLE_IMPORT_BUSY' });
  const saved = t.documents.savePdf(t.actor, { idempotencyKey: randomUUID(), originalFilename: 'source.pdf', body: body(fixture.files.get('source.pdf')!) });
  release.resolve(); const [imported, original] = await Promise.all([receiving, saved]);
  expect(imported.documentId).toBe(original.id); expect((await t.db.pool.query('SELECT id FROM documents')).rows).toHaveLength(1);
});
it('cleans orphan inputs and objects while retaining every published bundle asset and active input', async () => {
  const t = await setup(); const fixture = await bundleFixture(t.config.dataDir); await t.ingest(fixture.bytes);
  const { readdir, utimes, writeFile } = await import('node:fs/promises'); const { join } = await import('node:path');
  const { cleanupStaging } = await import('../../src/cli/cleanup-staging.js');
  const old = new Date(Date.now() - 25 * 3600_000);
  for (const key of await readdir(join(t.config.dataDir, 'objects'))) await utimes(join(t.config.dataDir, 'objects', key), old, old);
  const active = await t.service.create(t.actor, {}, randomUUID()); const activeKey = randomUUID(); const staleKey = randomUUID();
  await t.db.pool.query('UPDATE bundle_imports SET staging_key=$2 WHERE id=$1', [active.id, activeKey]);
  for (const key of [activeKey, staleKey]) { const path = join(t.config.dataDir, 'bundle-staging', key); await writeFile(path, 'input'); await utimes(path, old, old); }
  await cleanupStaging({ db: t.db, dataDir: t.config.dataDir });
  expect(await readdir(join(t.config.dataDir, 'bundle-staging'))).toEqual([activeKey]);
  for (const asset of (await t.db.pool.query('SELECT object_key,bytes FROM assets')).rows) expect((await t.store.stat(asset.object_key)).bytes).toBe(Number(asset.bytes));
});
it('protects completed translation on partial parses and does not degrade existing partial translation to blank results', async () => {
  const t = await setup();
  const completePartial = await t.ingest((await bundleFixture(t.config.dataDir, { status: 'completed', partialParse: true })).bytes);
  await t.ingest((await bundleFixture(t.config.dataDir)).bytes);
  expect((await t.documents.get(t.actor, completePartial.documentId!)).reader?.versionId).toBe(completePartial.readerVersionId);
  const full = await t.ingest((await bundleFixture(t.config.dataDir, { status: 'completed' })).bytes);
  await t.ingest((await bundleFixture(t.config.dataDir, { status: 'completed', partialParse: true })).bytes);
  expect((await t.documents.get(t.actor, full.documentId!)).reader?.versionId).toBe(full.readerVersionId);
  // Independent owner: first partial translation has useful blocks that pending/failed must preserve.
  const partial = await bundleFixture(t.config.dataDir, { status: 'partial' });
  const created = await t.service.create(t.admin, {}, randomUUID());
  const original = await t.service.receive(t.admin, created.id, body(partial.bytes));
  for (const status of ['pending', 'failed'] as const) {
    const created = await t.service.create(t.admin, {}, randomUUID());
    await t.service.receive(t.admin, created.id, body((await bundleFixture(t.config.dataDir, { status })).bytes));
    expect((await t.documents.get(t.admin, original.documentId!)).reader?.versionId).toBe(original.readerVersionId);
  }
}, 30_000);
it('rejects logical parse or translation identity reused with different immutable bytes', async () => {
  const t = await setup(); const first = await bundleFixture(t.config.dataDir); await t.ingest(first.bytes);
  const changedTranslation = await bundleFixture(t.config.dataDir, { translationId: first.manifest.translation.id, status: 'completed' });
  await expect(t.ingest(changedTranslation.bytes)).rejects.toMatchObject({ code: 'BUNDLE_IDENTITY_CONFLICT' });
  const changedParse = await bundleFixture(t.config.dataDir, { edit(files) {
    const ir = JSON.parse(files.get('source-ir.json')!.toString()); ir.warnings.push('new-warning'); files.set('source-ir.json', Buffer.from(JSON.stringify(ir)));
  } });
  await expect(t.ingest(changedParse.bytes)).rejects.toMatchObject({ code: 'BUNDLE_IDENTITY_CONFLICT' });
  expect((await t.db.pool.query('SELECT id FROM reader_versions')).rows).toHaveLength(1);
});
it('fences a receiver whose epoch changes while its stream is paused', async () => {
  const t = await setup(); const fixture = await bundleFixture(t.config.dataDir); const reached = deferred(); const release = deferred();
  const created = await t.service.create(t.actor, {}, randomUUID());
  const pending = t.service.receive(t.actor, created.id, (async function* () { yield fixture.bytes; reached.resolve(); await release.promise; })());
  const rejected = expect(pending).rejects.toMatchObject({ code: 'BUNDLE_IMPORT_SUPERSEDED' });
  await reached.promise; await t.db.pool.query("UPDATE bundle_imports SET epoch=epoch+1,status='failed',error_code='BUNDLE_LEASE_EXPIRED' WHERE id=$1", [created.id]);
  release.resolve(); await rejected;
  expect((await t.service.get(t.actor, created.id)).epoch).toBe(2);
  expect((await t.db.pool.query('SELECT id FROM reader_versions')).rows).toHaveLength(0);
});
it('enforces compound source and owner references and rejects mutation of immutable versions', async () => {
  const t = await setup(); const fixture = await bundleFixture(t.config.dataDir); const imported = await t.ingest(fixture.bytes);
  const row = (await t.db.pool.query('SELECT * FROM reader_versions WHERE id=$1', [imported.readerVersionId])).rows[0];
  await expect(t.db.pool.query("UPDATE reader_versions SET manifest_sha256=repeat('0',64) WHERE id=$1", [row.id])).rejects.toThrow('Immutable reader data');
  await expect(t.db.pool.query('INSERT INTO reader_chunks (owner_id,document_id,reader_version_id,id,data_asset_id) VALUES ($1,$2,$3,\'c_999999\',$4)', [t.admin.userId, row.document_id, row.id, row.index_asset_id])).rejects.toMatchObject({ code: '23503' });
  const source = (await t.db.pool.query('SELECT * FROM source_versions WHERE id=$1', [row.source_version_id])).rows[0];
  const differentSource = randomUUID();
  await t.db.pool.query('INSERT INTO source_versions (id,owner_id,document_id,asset_id,sha256,bytes) VALUES ($1,$2,$3,$4,$5,$6)', [differentSource, t.actor.userId, row.document_id, source.asset_id, source.sha256, source.bytes]);
  await expect(t.db.pool.query('UPDATE documents SET current_source_version_id=$1 WHERE id=$2', [differentSource, row.document_id])).rejects.toMatchObject({ code: '23503' });
});
it('holds the cleanup publication lock through final stat and commit', async () => {
  const t = await setup(); const fixture = await bundleFixture(t.config.dataDir); const reached = deferred(); const release = deferred(); let first = true;
  const { readdir, utimes } = await import('node:fs/promises'); const { join } = await import('node:path');
  const { cleanupStaging } = await import('../../src/cli/cleanup-staging.js');
  const service = createBundleImportsService({ db: t.db, config: t.config, store: { ...t.store, async stat(key) {
    if (first) { first = false; const old = new Date(Date.now() - 25 * 3600_000); for (const file of await readdir(join(t.config.dataDir, 'objects'))) await utimes(join(t.config.dataDir, 'objects', file), old, old); reached.resolve(); await release.promise; }
    return t.store.stat(key);
  } } });
  const created = await service.create(t.actor, {}, randomUUID()); const pending = service.receive(t.actor, created.id, body(fixture.bytes));
  await reached.promise;
  let finished = false; const cleanupTask = cleanupStaging({ db: t.db, dataDir: t.config.dataDir }).then(value => { finished = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 50)); expect(finished).toBe(false);
  release.resolve(); const result = await pending; await cleanupTask;
  expect((await t.documents.get(t.actor, result.documentId!)).reader?.versionId).toBe(result.readerVersionId);
  for (const asset of (await t.db.pool.query('SELECT object_key,bytes FROM assets')).rows) expect((await t.store.stat(asset.object_key)).bytes).toBe(Number(asset.bytes));
});
it('stats the reused logical parse asset as well as newly staged files before publication', async () => {
  const t = await setup(); const first = await t.ingest((await bundleFixture(t.config.dataDir)).bytes);
  const parseAsset = (await t.db.pool.query(`SELECT a.object_key FROM reader_versions r JOIN parse_runs p ON (p.owner_id,p.id)=(r.owner_id,r.parse_id)
    JOIN assets a ON (a.owner_id,a.document_id,a.id)=(p.owner_id,p.document_id,p.ir_asset_id) WHERE r.id=$1`, [first.readerVersionId])).rows[0];
  await t.store.deleteUnreferenced(parseAsset.object_key); // Controlled external disappearance; normal GC never removes it.
  await expect(t.ingest((await bundleFixture(t.config.dataDir, { status: 'completed' })).bytes)).rejects.toMatchObject({ code: 'BUNDLE_IMPORT_FAILED' });
  expect((await t.db.pool.query('SELECT id FROM reader_versions')).rows).toHaveLength(1);
});
it('keeps parent-owned database heartbeats alive while a validation worker is synchronously busy', async () => {
  const t = await setup(); const created = await t.service.create(t.actor, {}, randomUUID());
  await t.db.pool.query("UPDATE bundle_imports SET status='validating',epoch=1,heartbeat_at=now()-interval '14 minutes' WHERE id=$1", [created.id]);
  const { maintainLease } = await import('../../src/bundle-imports/lease.js');
  const { validateInWorker } = await import('../../src/bundle-imports/worker-client.js');
  const { join } = await import('node:path'); const controller = new AbortController();
  const stop = maintainLease(t.db, t.actor, created.id, '1', controller);
  try {
    const busy = validateInWorker(join(t.config.dataDir, 'worker-ready'), t.config.bundleLimits, controller.signal,
      { entry: new URL('../fixtures/busy-bundle-worker.mjs', import.meta.url), deadlineMs: 16_000 });
    await expect(busy).rejects.toMatchObject({ code: 'BUNDLE_VALIDATION_TIMEOUT' });
    const row = (await t.db.pool.query("SELECT heartbeat_at > now()-interval '3 seconds' AS fresh FROM bundle_imports WHERE id=$1", [created.id])).rows[0];
    expect(row.fresh).toBe(true);
  } finally { controller.abort(); await stop(); }
}, 25_000);
it('enforces configured archive limits and validates malformed input without replacing a readable version', async () => {
  const t = await setup(); const first = await t.ingest((await bundleFixture(t.config.dataDir)).bytes);
  const small = createBundleImportsService({ db: t.db, store: t.store, config: { ...t.config, bundleLimits: { ...t.config.bundleLimits, maxArchiveBytes: 4 } } });
  const created = await small.create(t.actor, {}, randomUUID());
  await expect(small.receive(t.actor, created.id, body(Buffer.from('12345')))).rejects.toMatchObject({ code: 'BUNDLE_TOO_LARGE' });
  expect(await small.get(t.actor, created.id)).toMatchObject({ status: 'failed', errorCode: 'BUNDLE_TOO_LARGE' });
  await expect(t.ingest(Buffer.from('invalid zip'))).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
  expect((await t.documents.get(t.actor, first.documentId!)).reader?.versionId).toBe(first.readerVersionId);
});
it('stores exact original archive bytes and schema-valid generated JSON chunks', async () => {
  const t = await setup(); const fixture = await bundleFixture(t.config.dataDir); const imported = await t.ingest(fixture.bytes);
  const { readerChunkSchema, readerIndexSchema } = await import('@pagelingo/document-contracts');
  async function bytes(key: string) { const parts: Buffer[] = []; for await (const chunk of t.store.read(key)) parts.push(Buffer.from(chunk)); return Buffer.concat(parts); }
  const metadata = (await t.db.pool.query(`SELECT a.object_key AS archive,i.object_key AS index FROM reader_versions r
    JOIN assets a ON (a.owner_id,a.document_id,a.id)=(r.owner_id,r.document_id,r.archive_asset_id)
    JOIN assets i ON (i.owner_id,i.document_id,i.id)=(r.owner_id,r.document_id,r.index_asset_id) WHERE r.id=$1`, [imported.readerVersionId])).rows[0];
  expect(await bytes(metadata.archive)).toEqual(fixture.bytes);
  const index = readerIndexSchema.parse(JSON.parse((await bytes(metadata.index)).toString()));
  expect(index.parseId).toBe(fixture.manifest.parse.id);
  const chunks = (await t.db.pool.query(`SELECT c.id,a.object_key FROM reader_chunks c JOIN assets a
    ON (a.owner_id,a.document_id,a.id)=(c.owner_id,c.document_id,c.data_asset_id) WHERE c.reader_version_id=$1 ORDER BY c.id`, [imported.readerVersionId])).rows;
  expect(chunks.map(chunk => chunk.id)).toEqual(index.chunks.map(chunk => chunk.id));
  for (const chunk of chunks) expect(readerChunkSchema.parse(JSON.parse((await bytes(chunk.object_key)).toString())).parseId).toBe(fixture.manifest.parse.id);
});
it('recovers durable status and retries ingestion after the actual receiver process dies', async () => {
  const t = await setup(); const fixture = await bundleFixture(t.config.dataDir);
  const { fork } = await import('node:child_process'); const { once } = await import('node:events');
  const child = fork(new URL('../fixtures/bundle-restart-process.mjs', import.meta.url), [], {
    execArgv: ['--import', 'tsx'], env: { LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = once(child, 'exit');
  try {
    const message = once(child, 'message');
    const schema = (await t.db.pool.query('SELECT current_schema() AS name')).rows[0].name;
    child.send({ databaseUrl: process.env.PAGELINGO_TEST_DATABASE_URL, schema, dataDir: t.config.dataDir, actor: t.actor });
    const [received] = await message; const id = (received as { id: string }).id; expect(id).toBeTypeOf('string');
    child.kill('SIGKILL'); await exited;
    const restarted = createBundleImportsService({ db: t.db, store: t.store, config: t.config });
    expect((await restarted.get(t.actor, id)).status).toBe('receiving');
    await t.db.pool.query("UPDATE bundle_imports SET heartbeat_at=now()-interval '16 minutes' WHERE id=$1", [id]);
    expect(await restarted.get(t.actor, id)).toMatchObject({ status: 'failed', errorCode: 'BUNDLE_LEASE_EXPIRED' });
    expect(await restarted.receive(t.actor, id, body(fixture.bytes))).toMatchObject({ status: 'completed', epoch: 2 });
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; }
});
it('returns restore conflicts for fresh targeted and untargeted imports while replaying accepted receipts', async () => {
  const t = await setup(), fixture = await bundleFixture(t.config.dataDir);
  const key = randomUUID(), admitted = await t.service.create(t.actor, {}, key);
  const first = await t.service.receive(t.actor, admitted.id, body(fixture.bytes));
  const { createDocumentLifecycleService } = await import('../../src/document-lifecycle/trash.js');
  await createDocumentLifecycleService(t).trashDocument(t.actor, first.documentId!, 1);
  expect(await t.service.create(t.actor, {}, key)).toEqual(first);
  await expect(t.service.create(t.actor, { targetDocumentId: first.documentId! }, randomUUID())).rejects.toMatchObject({ statusCode: 409, code: 'DOCUMENT_IN_TRASH' });
  await expect(t.ingest(fixture.bytes)).rejects.toMatchObject({ statusCode: 409, code: 'DOCUMENT_IN_TRASH' });
});
