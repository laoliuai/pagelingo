import { randomUUID } from 'node:crypto';
import { bootstrapAdmin } from '../../src/cli/bootstrap-admin.js';
import { createServiceTestApp } from './app.js';
import { login } from './session.js';
import { bundleFixture } from './bundles.js';

export const origin = 'http://127.0.0.1:5174';
export const headers = (session: { cookie: string; csrfToken: string }) => ({ cookie: session.cookie, origin, 'x-csrf-token': session.csrfToken });
export async function readerTestApp(cleanup: Array<() => Promise<void>>) {
  const t = await createServiceTestApp(); cleanup.push(t.close);
  const password = 'correct password 123456';
  await bootstrapAdmin(t.db, { username: 'admin', password });
  await t.db.pool.query(`INSERT INTO users (username,password_hash,role) SELECT name,password_hash,'user'
    FROM users CROSS JOIN (VALUES ('alice'),('bob')) AS fixture(name) WHERE username='admin'`);
  const admin = await login(t.app, 'admin', password), alice = await login(t.app, 'alice', password), bob = await login(t.app, 'bob', password);
  async function ingest(options: Parameters<typeof bundleFixture>[1] = {}, session = alice) {
    const fixture = await bundleFixture(t.config.dataDir, options);
    const created = await t.app.inject({ method: 'POST', url: '/api/v1/bundle-imports', headers: { ...headers(session), 'idempotency-key': randomUUID() }, payload: {} });
    if (created.statusCode !== 201) throw new Error(`Create import: ${created.statusCode} ${created.body}`);
    const received = await t.app.inject({ method: 'PUT', url: `/api/v1/bundle-imports/${created.json().id}/content`, headers: { ...headers(session), 'content-type': 'application/zip' }, payload: fixture.bytes });
    if (received.statusCode !== 200) throw new Error(`Receive import: ${received.statusCode} ${received.body}`);
    return { ...fixture, imported: received.json(), base: `/api/v1/documents/${received.json().documentId}`, version: received.json().readerVersionId as string };
  }
  return { ...t, admin, alice, bob, ingest };
}
