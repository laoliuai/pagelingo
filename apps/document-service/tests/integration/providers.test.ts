import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultProviderProfile, providerProfileSchema } from '@pagelingo/document-contracts';
import type { ProviderKeyUpdate, ProviderProfileUpdate, ProviderSettings } from '@pagelingo/document-contracts';
import type { Actor } from '../../src/auth/guards.js';
import { createApp } from '../../src/app.js';
import { bootstrapAdmin } from '../../src/cli/bootstrap-admin.js';
import { createServiceTestApp } from '../helpers/app.js';
import { login } from '../helpers/session.js';
import { buildPdfFixture } from '../../../../tests/fixtures/pdf.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const password = 'correct password 123456';
const origin = 'http://127.0.0.1:5174';
const url = '/api/v1/settings/provider';
const apiKey = 'test-secret-provider-ONLY';
const settings: ProviderSettings = {
  baseUrl: 'https://provider.example/v1', model: 'model-one', temperature: 0.4,
  responseFormat: 'text', maxOutputTokens: 2048, maxTokensParameter: 'max_completion_tokens',
  thinkingMode: 'disabled', stream: true, maxInputTokens: 5000, contextWindowTokens: 16000,
};
function headers(session: { cookie: string; csrfToken: string }) {
  return { cookie: session.cookie, origin, 'x-csrf-token': session.csrfToken };
}
function input(expectedRevision = 0, key: ProviderKeyUpdate = { action: 'replace', value: apiKey }): ProviderProfileUpdate {
  return { expectedRevision, settings, key };
}
async function setup() {
  let outboundAttempts = 0;
  const test = await createServiceTestApp({ outboundFetch: async () => { outboundAttempts++; throw new Error('Unexpected provider call'); } });
  cleanup.push(test.close);
  await bootstrapAdmin(test.db, { username: 'admin', password });
  await test.db.pool.query(`INSERT INTO users (username, password_hash, role) SELECT name, password_hash, 'user'
    FROM users CROSS JOIN (VALUES ('alice'), ('bob')) AS fixture(name) WHERE username = 'admin'`);
  const admin = await login(test.app, 'admin', password);
  const alice = await login(test.app, 'alice', password);
  const bob = await login(test.app, 'bob', password);
  const get = (session = alice) => test.app.inject({ url, headers: headers(session) });
  const put = (payload: object = input(), session = alice) => test.app.inject({ method: 'PUT', url, headers: headers(session), payload });
  const actor = async (session = alice): Promise<Actor> => ({ userId: session.user.id, role: session.user.role, authVersion: 1,
    sessionHash: createHash('sha256').update(session.cookie.split('=')[1]!).digest('hex') });
  const row = async () => (await test.db.pool.query('SELECT * FROM provider_profiles WHERE owner_id = $1', [alice.user.id])).rows[0];
  return { ...test, admin, alice, bob, get, put, actor, row, outboundAttempts: () => outboundAttempts };
}

describe('private provider settings', () => {
  it('returns a complete revision-zero profile without creating rows and requires authentication', async () => {
    const { app, get, db } = await setup();
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url, headers: { origin }, payload: input() })).statusCode).toBe(401);
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revision: 0, baseUrl: '', model: '', temperature: 0.1, responseFormat: 'json-object',
      maxOutputTokens: 4096, maxTokensParameter: 'max_tokens', thinkingMode: 'auto', stream: false,
      maxInputTokens: 6000, contextWindowTokens: 32768, hasApiKey: false });
    expect(response.headers['cache-control']).toBe('no-store');
    expect((await db.pool.query('SELECT * FROM provider_profiles')).rows).toEqual([]);
  });

  it('persists only ciphertext and exposes only the public schema to the owner, other users and admins', async () => {
    const { put, get, bob, admin, row, app, alice } = await setup();
    const saved = await put();
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ ...settings, revision: 1, hasApiKey: true });
    expect(providerProfileSchema.parse(saved.json())).toEqual(saved.json());
    const stored = await row();
    expect(stored.key_id).toBe('test');
    expect(stored.key_nonce).toHaveLength(12);
    expect(stored.key_tag).toHaveLength(16);
    expect(JSON.stringify(stored)).not.toContain(apiKey);
    expect(stored.key_ciphertext.toString()).not.toContain(apiKey);
    const read = await get();
    expect(read.json()).toEqual(saved.json());
    expect(read.body).not.toContain(apiKey);
    for (const field of ['key_id', 'key_nonce', 'key_ciphertext', 'key_tag', 'apiKey', 'owner_id']) expect(read.json()).not.toHaveProperty(field);
    for (const session of [bob, admin]) {
      expect((await get(session)).json()).toEqual(defaultProviderProfile);
      const own = await put(input(0, { action: 'keep' }), session);
      expect(own.json()).toMatchObject({ revision: 1, hasApiKey: false });
      expect((await get()).json()).toEqual(saved.json());
      expect((await app.inject({ url: `${url}?ownerId=${alice.user.id}`, headers: headers(session) })).statusCode).toBe(400);
    }
  });

  it('keeps exact ciphertext, replaces a key, and deletes all secret columns while incrementing revisions', async () => {
    const { put, row, get, outboundAttempts } = await setup();
    expect((await put()).statusCode).toBe(200);
    const initial = await row();
    expect((await put(input(1, { action: 'keep' }))).json()).toMatchObject({ revision: 2, hasApiKey: true });
    const kept = await row();
    for (const field of ['key_id', 'key_nonce', 'key_ciphertext', 'key_tag']) expect(kept[field]).toEqual(initial[field]);
    expect((await put(input(2, { action: 'replace', value: 'replacement-secret' }))).json()).toMatchObject({ revision: 3, hasApiKey: true });
    expect((await row()).key_ciphertext).not.toEqual(initial.key_ciphertext);
    expect((await put(input(3, { action: 'delete' }))).json()).toMatchObject({ revision: 4, hasApiKey: false });
    expect(await row()).toMatchObject({ key_id: null, key_nonce: null, key_ciphertext: null, key_tag: null });
    expect((await get()).json()).toEqual({ ...settings, revision: 4, hasApiKey: false });
    expect(outboundAttempts()).toBe(0);
  });

  it('allows only one concurrent revision-zero create and one concurrent later update', async () => {
    const { put, row } = await setup();
    for (const revision of [0, 1]) {
      const responses = await Promise.all([put(input(revision)), put(input(revision))]);
      expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
      expect(responses.find(response => response.statusCode === 409)!.json().error.code).toBe('REVISION_CONFLICT');
      expect((await row()).revision).toBe(revision + 1);
    }
  });

  it('rejects empty replacements, unknown fields, owner hints and unsafe settings without saving', async () => {
    const { put, get, db, app, alice } = await setup();
    for (const payload of [
      input(0, { action: 'replace', value: '' }),
      { ...input(), ownerId: randomUUID() },
      { ...input(), expectedRevision: -1 },
      { ...input(), settings: { ...settings, secret: apiKey } },
      { ...input(), key: { action: 'keep', value: apiKey } },
      { ...input(), settings: { ...settings, baseUrl: 'https://name:secret@provider.example/v1' } },
    ]) {
      const response = await put(payload);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_REQUEST');
      expect(response.body).not.toContain(apiKey);
    }
    expect((await app.inject({ method: 'PUT', url: `${url}?ownerId=evil`, headers: headers(alice), payload: input() })).statusCode).toBe(400);
    expect((await get()).json()).toEqual(defaultProviderProfile);
    expect((await db.pool.query('SELECT * FROM provider_profiles')).rows).toEqual([]);
  });

  it('guards saves with Origin, CSRF and JSON validation', async () => {
    const { app, alice, row } = await setup();
    for (const requestHeaders of [{ cookie: alice.cookie, origin }, { ...headers(alice), origin: 'https://evil.example' }, { ...headers(alice), 'x-csrf-token': 'wrong' }]) {
      expect((await app.inject({ method: 'PUT', url, headers: requestHeaders, payload: input() })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'PUT', url, headers: { ...headers(alice), 'content-type': 'text/plain' }, payload: '{}' })).statusCode).toBe(415);
    expect(await row()).toBeUndefined();
  });

  it('rolls back both first insert and later replacement on commit failure with a controlled error', async () => {
    const { db, put, row } = await setup();
    await db.pool.query(`CREATE FUNCTION fail_provider_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test-secret-provider-ONLY'; END; $$`);
    const trigger = () => db.pool.query(`CREATE CONSTRAINT TRIGGER fail_provider_commit AFTER INSERT OR UPDATE ON provider_profiles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_provider_commit()`);
    await trigger();
    const failed = await put();
    expect(failed.statusCode).toBe(500);
    expect(failed.json().error.code).toBe('INTERNAL_ERROR');
    expect(failed.body).not.toContain(apiKey);
    expect(await row()).toBeUndefined();
    await db.pool.query('DROP TRIGGER fail_provider_commit ON provider_profiles');
    await put(); const before = await row(); await trigger();
    expect((await put(input(1, { action: 'replace', value: 'other-secret' }))).statusCode).toBe(500);
    expect(await row()).toEqual(before);
  });

  it('reads retained old key IDs internally, keeps historical ciphertext, and fails closed for damaged secrets', async () => {
    const test = await setup(); const { createProvidersService } = await import('../../src/providers/service.js');
    const actor = await test.actor();
    const service = createProvidersService({ db: test.db, keyring: test.config.keyring });
    expect(await service.getForCall(actor)).toEqual({ profile: defaultProviderProfile, apiKey: undefined });
    await test.put(); const before = await test.row();
    const rotated = createProvidersService({ db: test.db, keyring: { activeKeyId: 'new', keys: { ...test.config.keyring.keys, new: Buffer.alloc(32, 3) } } });
    expect(await rotated.getForCall(actor)).toEqual({ profile: { ...settings, revision: 1, hasApiKey: true }, apiKey });
    await rotated.update(actor, input(1, { action: 'keep' }));
    expect((await test.row()).key_id).toBe('test');
    expect((await test.row()).key_ciphertext).toEqual(before.key_ciphertext);
    const removed = createProvidersService({ db: test.db, keyring: { activeKeyId: 'new', keys: { new: Buffer.alloc(32, 3) } } });
    await expect(removed.getForCall(actor)).rejects.toMatchObject({ statusCode: 500, code: 'PROVIDER_SECRET_UNAVAILABLE' });
    // Public GET and keep do not decrypt or migrate existing ciphertext.
    expect(await removed.get(actor)).toMatchObject({ revision: 2, hasApiKey: true });
    await test.db.pool.query('UPDATE provider_profiles SET key_tag = $1 WHERE owner_id = $2', [Buffer.alloc(16), actor.userId]);
    await expect(rotated.getForCall(actor)).rejects.toMatchObject({ statusCode: 500, code: 'PROVIDER_SECRET_UNAVAILABLE' });
    await rotated.update(actor, input(2, { action: 'delete' }));
    expect(await rotated.getForCall(actor)).toEqual({ profile: { ...settings, revision: 3, hasApiKey: false }, apiKey: undefined });
  });

  it('rechecks revoked actors for reads, saves and internal calls and validates direct service input', async () => {
    const test = await setup(); const { createProvidersService } = await import('../../src/providers/service.js');
    const service = createProvidersService({ db: test.db, keyring: test.config.keyring }); const actor = await test.actor();
    await expect(service.update(actor, { ...input(), ownerId: test.bob.user.id } as ProviderProfileUpdate)).rejects.toMatchObject({ statusCode: 400 });
    await test.db.pool.query('UPDATE users SET auth_version = auth_version + 1 WHERE id = $1', [actor.userId]);
    await expect(service.get(actor)).rejects.toMatchObject({ statusCode: 401 });
    await expect(service.update(actor, input())).rejects.toMatchObject({ statusCode: 401 });
    await expect(service.getForCall(actor)).rejects.toMatchObject({ statusCode: 401 });
    expect(await test.row()).toBeUndefined();
  });

  it('rechecks revocation between HTTP authorization and transaction entry', async () => {
    const test = await setup();
    let reached!: () => void; const started = new Promise<void>(resolve => { reached = resolve; });
    let release!: () => void; const resume = new Promise<void>(resolve => { release = resolve; });
    const paused = await createApp({ config: test.config, db: { ...test.db, async transaction(fn) { reached(); await resume; return test.db.transaction(fn); } } });
    cleanup.push(() => paused.close()); await paused.ready();
    const pending = paused.inject({ method: 'PUT', url, headers: headers(test.alice), payload: input() }).then(result => result);
    try {
      await started;
      expect((await test.app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${test.alice.user.id}`, headers: headers(test.admin), payload: { active: false } })).statusCode).toBe(200);
    } finally { release(); }
    expect((await pending).statusCode).toBe(401);
    expect(await test.row()).toBeUndefined();
  });

  it('does not change saved document rows or original PDF bytes on key replacement or deletion', async () => {
    const test = await setup(); const { createDocumentsService } = await import('../../src/documents/service.js');
    const { createLocalObjectStore } = await import('../../src/storage/local-object-store.js');
    const pdf = Buffer.from(buildPdfFixture());
    const documents = createDocumentsService({ db: test.db, store: createLocalObjectStore(test.config.dataDir) });
    const document = await documents.savePdf(await test.actor(), { idempotencyKey: randomUUID(), originalFilename: 'source.pdf', body: (async function* () { yield pdf; })() });
    const before = (await test.db.pool.query('SELECT * FROM documents')).rows;
    expect((await test.put()).statusCode).toBe(200);
    expect((await test.put(input(1, { action: 'replace', value: 'replacement-secret' }))).statusCode).toBe(200);
    expect((await test.put(input(2, { action: 'delete' }))).statusCode).toBe(200);
    expect((await test.db.pool.query('SELECT * FROM documents')).rows).toEqual(before);
    const source = await test.app.inject({ url: `/api/v1/documents/${document.id}/source`, headers: headers(test.alice) });
    expect(source.statusCode).toBe(200); expect(source.rawPayload).toEqual(pdf);
    expect(test.outboundAttempts()).toBe(0);
  });
});
