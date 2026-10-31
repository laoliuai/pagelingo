import { randomBytes, randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { bootstrapAdmin } from '../../src/cli/bootstrap-admin.js';
import { verifyRestore } from '../../src/cli/verify-restore.js';
import { sealApiKey } from '../../src/providers/secrets.js';
import { createLocalObjectStore } from '../../src/storage/local-object-store.js';
import { buildPdfFixture } from '../../../../tests/fixtures/pdf.js';
import { createServiceTestApp } from '../helpers/app.js';
import { login } from '../helpers/session.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const password = 'correct password 123456';

async function setup() {
  const t = await createServiceTestApp(); cleanup.push(t.close);
  await bootstrapAdmin(t.db, { username: 'admin', password });
  const session = await login(t.app, 'admin', password);
  const boundary = 'pgl-restore';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    Buffer.from(buildPdfFixture()), Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const saved = await t.app.inject({
    method: 'POST', url: '/api/v1/documents/pdf', payload,
    headers: { cookie: session.cookie, origin: t.config.publicOrigin, 'x-csrf-token': session.csrfToken, 'idempotency-key': randomUUID(), 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
  expect(saved.statusCode).toBe(201);
  const sealed = sealApiKey('fake-key', session.user.id, t.config.keyring);
  await t.db.pool.query(`INSERT INTO provider_profiles (owner_id,revision,base_url,model,key_id,key_nonce,key_ciphertext,key_tag)
    VALUES ($1,1,'https://api.example.com/v1','m',$2,$3,$4,$5)`, [session.user.id, sealed.keyId, sealed.nonce, sealed.ciphertext, sealed.tag]);
  const object = (await t.db.pool.query<{ object_key: string }>('SELECT object_key FROM assets LIMIT 1')).rows[0]!.object_key;
  return { t, path: join(t.config.dataDir, 'objects', object), store: createLocalObjectStore(t.config.dataDir) };
}

it('reads every registered object and API key', async () => {
  const { t, store } = await setup();
  const report = await verifyRestore(t.db, store, t.config.keyring);
  expect(report).toMatchObject({ assets: 1, missing: 0, mismatched: 0, secrets: 1, unreadableSecrets: 0 });
  expect(report.bytes).toBeGreaterThan(0);
});
it('reports a missing object', async () => {
  const { t, store, path } = await setup();
  await rm(path);
  expect(await verifyRestore(t.db, store, t.config.keyring)).toMatchObject({ assets: 1, missing: 1, mismatched: 0 });
});
it('reports changed object bytes even when the size still matches', async () => {
  const { t, store, path } = await setup();
  const { size } = await import('node:fs/promises').then(fs => fs.stat(path));
  await writeFile(path, randomBytes(size));
  expect(await verifyRestore(t.db, store, t.config.keyring)).toMatchObject({ assets: 1, missing: 0, mismatched: 1 });
});
it('reports API keys that the current keyring cannot open', async () => {
  const { t, store } = await setup();
  const otherKeyring = { activeKeyId: 'test', keys: { test: randomBytes(32) } };
  expect(await verifyRestore(t.db, store, otherKeyring)).toMatchObject({ secrets: 1, unreadableSecrets: 1 });
});
