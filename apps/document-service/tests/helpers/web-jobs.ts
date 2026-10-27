import { createHash } from 'node:crypto';
import { defaultProviderProfile } from '@pagelingo/document-contracts';
import { expect } from 'vitest';
import { bootstrapAdmin } from '../../src/cli/bootstrap-admin.js';
import { createLocalObjectStore } from '../../src/storage/local-object-store.js';
import { createServiceTestApp } from './app.js';
import { login } from './session.js';
import { capture } from './web-capture.js';
export async function jobFixture(shared?: Awaited<ReturnType<typeof createServiceTestApp>>, username = 'admin') {
  const t = shared ?? await createServiceTestApp();
  if (!shared) await bootstrapAdmin(t.db, { username: 'admin', password: 'correct password 123456' });
  const session = await login(t.app, username, 'correct password 123456');
  const headers = { cookie: session.cookie, origin: t.config.publicOrigin, 'x-csrf-token': session.csrfToken };
  const request = (url: string, method: 'GET' | 'PUT' | 'POST' = 'GET', payload?: object) => t.app.inject({ url, method, headers, ...(payload ? { payload } : {}) });
  const { revision: _r, hasApiKey: _k, ...defaults } = defaultProviderProfile;
  async function profile(expectedRevision = 0) {
    const result = await request('/api/v1/settings/provider', 'PUT', { expectedRevision, settings: { ...defaults, baseUrl: 'https://provider.example/v1', model: 'test-model' }, key: { action: 'replace', value: 'private-test-key' } });
    expect(result.statusCode, result.body).toBe(200);
  }
  await profile();
  async function save(count = 12, suffix = '') {
    const c = capture(`<article>${Array.from({ length: count }, (_, i) => `<p>The reader can save the original article and read the source without any translation. This paragraph number ${i} explains how the software and the system work. ${suffix}</p>`).join('')}</article>`);
    const created = await t.app.inject({ method: 'POST', url: '/api/v1/captures', headers: { ...headers, 'idempotency-key': c.manifest.captureId }, payload: { manifest: c.manifest, translationIntent: 'translate' } });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    await t.app.inject({ method: 'PUT', url: `/api/v1/captures/${id}/files/html`, headers: { ...headers, 'content-type': 'text/html' }, payload: c.body });
    const result = await request(`/api/v1/captures/${id}/commit`, 'POST', {});
    expect(result.statusCode, result.body).toBe(200);
    return result.json() as { jobId: string; documentId: string; sourceVersionId: string; readerVersionId: string };
  }
  const actor = { userId: session.user.id, role: session.user.role, authVersion: 1, sessionHash: createHash('sha256').update(session.cookie.split('=')[1]!).digest('hex') };
  return { ...t, actor, headers, request, save, profile, store: createLocalObjectStore(t.config.dataDir) };
}
export async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 15000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}
