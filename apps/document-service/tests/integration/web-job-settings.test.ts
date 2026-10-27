import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { defaultProviderProfile } from '@pagelingo/document-contracts';
import { bootstrapAdmin } from '../../src/cli/bootstrap-admin.js';
import { createServiceTestApp } from '../helpers/app.js';
import { login } from '../helpers/session.js';
import { capture } from '../helpers/web-capture.js';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});
const english =
  '<article><p>The reader can save the original article and read the source without any translation. This is a useful document about the software and the system.</p><p>The second paragraph has more information for the reader about how this system works and why it is useful.</p></article>';
async function setup() {
  let calls = 0;
  const t = await createServiceTestApp({
    outboundFetch: async () => {
      calls++;
      throw Error('Unexpected model call');
    },
  });
  closes.push(t.close);
  await bootstrapAdmin(t.db, { username: 'admin', password: 'correct password 123456' });
  const session = await login(t.app, 'admin', 'correct password 123456');
  const headers = { cookie: session.cookie, origin: t.config.publicOrigin, 'x-csrf-token': session.csrfToken };
  const request = (url: string, method: 'GET' | 'PUT' | 'POST' = 'GET', payload?: object) =>
    t.app.inject({ url, method, headers, ...(payload ? { payload } : {}) });
  async function save(html = english, translationIntent = 'none') {
    const c = capture(html);
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/v1/captures',
      headers: { ...headers, 'idempotency-key': c.manifest.captureId },
      payload: { manifest: c.manifest, translationIntent },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    expect(
      (
        await t.app.inject({
          method: 'PUT',
          url: `/api/v1/captures/${id}/files/html`,
          headers: { ...headers, 'content-type': 'text/html' },
          payload: c.body,
        })
      ).statusCode,
    ).toBe(200);
    const saved = await request(`/api/v1/captures/${id}/commit`, 'POST', {});
    expect(saved.statusCode, saved.body).toBe(200);
    const result = saved.json();
    const reader = (
      await request(`/api/v1/documents/${result.documentId}/web-reader?versionId=${result.readerVersionId}`)
    ).json();
    return { ...result, parseId: reader.parseId, blocks: Object.keys(reader.index.blockLocations) };
  }
  const profile = async (expectedRevision = 0, action: 'replace' | 'keep' | 'delete' = 'replace') => {
    const { revision: _r, hasApiKey: _k, ...defaults } = defaultProviderProfile;
    return request('/api/v1/settings/provider', 'PUT', {
      expectedRevision,
      settings: { ...defaults, baseUrl: 'https://provider.example/v1', model: 'test-model' },
      key: action === 'replace' ? { action, value: 'private-test-key' } : { action },
    });
  };
  const actor = {
    userId: session.user.id,
    role: session.user.role,
    authVersion: 1,
    sessionHash: createHash('sha256').update(session.cookie.split('=')[1]!).digest('hex'),
  };
  return {
    ...t,
    session,
    headers,
    actor,
    request,
    save,
    profile,
    calls: () => calls,
    input: (s: { sourceVersionId: string; parseId: string }, extra = {}) => ({
      sourceVersionId: s.sourceVersionId,
      parseId: s.parseId,
      profileRevision: 1,
      glossaryRevision: 0,
      ...extra,
    }),
  };
}
it('defaults auto off and CAS saves never create a historical job or call a model', async () => {
  const t = await setup();
  const saved = await t.save();
  expect((await t.request('/api/v1/settings/save-preferences')).json()).toEqual({ revision: 0, autoTranslate: false });
  expect((await t.profile()).statusCode).toBe(200);
  const results = await Promise.all(
    [true, false].map((autoTranslate) =>
      t.request('/api/v1/settings/save-preferences', 'PUT', { expectedRevision: 0, autoTranslate }),
    ),
  );
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect((await t.db.pool.query('SELECT id FROM web_jobs')).rows).toEqual([]);
  expect(t.calls()).toBe(0);
  expect((await t.request(`/api/v1/documents/${saved.documentId}/web-reader`)).statusCode).toBe(200);
});
it('creates canonical immutable inputs, dedupes reordering and isolates reads', async () => {
  const t = await setup();
  const s = await t.save();
  await t.profile();
  const url = `/api/v1/documents/${s.documentId}/web-jobs`;
  const [a, b] = await Promise.all([
    t.request(url, 'POST', t.input(s, { selectionBlockIds: [...s.blocks].reverse() })),
    t.request(url, 'POST', t.input(s, { selectionBlockIds: s.blocks })),
  ]);
  expect(a.statusCode, a.body).toBe(201);
  expect(a.json().selectionBlockIds).toBeNull();
  expect(b.json().id).toBe(a.json().id);
  expect((await t.request(url, 'POST', t.input(s))).json().id).toBe(a.json().id);
  expect((await t.request(`/api/v1/web-jobs/${a.json().id}`)).json().status).toBe('queued');
  expect(a.body).not.toContain('private-test-key');
  expect((await t.request(url, 'POST', t.input(s, { selectionBlockIds: ['b_' + 'f'.repeat(32)] }))).statusCode).toBe(
    400,
  );
  expect((await t.request(url, 'POST', { ...t.input(s), ownerId: t.session.user.id })).statusCode).toBe(400);
  expect(t.calls()).toBe(0);
});
it('does not create executable jobs for no key, Chinese, no-language or implicit short text', async () => {
  const t = await setup();
  const en = await t.save();
  const create = (s: Awaited<ReturnType<typeof t.save>>, extra = {}) =>
    t.request(`/api/v1/documents/${s.documentId}/web-jobs`, 'POST', t.input(s, extra));
  expect((await create(en, { profileRevision: 0 })).json().error.code).toBe('PROVIDER_NOT_CONFIGURED');
  await t.profile();
  for (const html of ['<p>这是中文内容，不需要自动翻译。</p>', '<p>123456</p>', '<p>Hello</p>']) {
    const s = await t.save(html);
    expect((await create(s)).statusCode).toBe(409);
  }
  expect((await t.db.pool.query('SELECT id FROM web_jobs')).rows).toEqual([]);
  const short = await t.save('<p>Bonjour</p>');
  expect((await create(short, { sourceLanguage: 'fr' })).statusCode).toBe(201);
  expect(t.calls()).toBe(0);
});
it('inherits auto only for eligible future saves and reuses actual retained source identity', async () => {
  const t = await setup();
  await t.profile();
  expect((await t.save(english, 'auto')).jobId).toBeNull();
  expect(
    (await t.request('/api/v1/settings/save-preferences', 'PUT', { expectedRevision: 0, autoTranslate: true }))
      .statusCode,
  ).toBe(200);
  expect((await t.db.pool.query('SELECT id FROM web_jobs')).rows).toEqual([]);
  const s = await t.save(english, 'auto');
  expect(s.jobId).toEqual(expect.any(String));
  const again = await t.save(english, 'auto');
  expect(again.sourceVersionId).toBe(s.sourceVersionId);
  expect(again.jobId).toBe(s.jobId);
  expect((await t.save(english + '<p>An explicit opt out remains original only.</p>', 'none')).jobId).toBeNull();
  expect((await t.save('<p>这是中文，不需要翻译。</p>', 'auto')).jobId).toBeNull();
  await t.profile(1, 'delete');
  expect((await t.save(english + '<p>A new source has no key.</p>', 'auto')).jobId).toBeNull();
  expect(t.calls()).toBe(0);
});
it('fences cancellation durably and requires explicit new run after provider changes', async () => {
  const t = await setup();
  const s = await t.save();
  await t.profile();
  const job = (await t.request(`/api/v1/documents/${s.documentId}/web-jobs`, 'POST', t.input(s))).json();
  const { startWebJobLease, assertJobLeaseCurrent } = await import('../../src/web-jobs/repository.js');
  const lease = await t.db.transaction((c) =>
    startWebJobLease(c, { ownerId: t.session.user.id, jobId: job.id, slotId: 1, leaseOwner: 'worker' }),
  );
  expect(lease).not.toBeNull();
  const { createJobProfileResolver } = await import('../../src/web-jobs/profile.js');
  const resolveJobProfile = createJobProfileResolver({ db: t.db, keyring: t.config.keyring });
  expect(await resolveJobProfile(lease!)).toMatchObject({
    apiKey: 'private-test-key',
    profileRevision: 1,
    glossaryRevision: 0,
    glossary: [],
  });
  const cancelled = await t.request(`/api/v1/web-jobs/${job.id}/cancel`, 'POST', {});
  expect(cancelled.json().status).toBe('cancelled');
  await expect(t.db.transaction((c) => assertJobLeaseCurrent(c, lease!))).rejects.toThrow();
  expect((await t.db.pool.query('SELECT job_id FROM web_worker_slots WHERE id=1')).rows[0].job_id).toBeNull();
  expect(
    (await t.request(`/api/v1/web-jobs/${job.id}/retry`, 'POST', { profileRevision: 1, glossaryRevision: 0 })).json()
      .status,
  ).toBe('queued');
  await t.profile(1, 'keep');
  const retry = await t.request(`/api/v1/web-jobs/${job.id}/retry`, 'POST', {
    profileRevision: 2,
    glossaryRevision: 0,
  });
  expect(retry.statusCode).toBe(409);
  expect(retry.json().error.code).toBe('PROFILE_CHANGED');
  expect((await t.request(`/api/v1/web-jobs/${job.id}`)).json().status).toBe('paused-config');
  expect(
    (await t.request(`/api/v1/documents/${s.documentId}/web-jobs`, 'POST', t.input(s, { profileRevision: 2 }))).json()
      .id,
  ).not.toBe(job.id);
  expect((await t.db.pool.query('SELECT settings FROM web_provider_revisions')).rows).toHaveLength(2);
  expect(JSON.stringify((await t.db.pool.query('SELECT * FROM web_provider_revisions')).rows)).not.toContain(
    'private-test-key',
  );
});
it('allows only device preference reads and rejects owner hints, missing CSRF and revoked identities', async () => {
  const t = await setup();
  const code = (await t.request('/api/v1/devices/pairing-codes', 'POST', {})).json().code;
  const paired = await t.app.inject({
    method: 'POST',
    url: '/api/v1/devices/exchange',
    payload: { code, deviceName: 'browser', extensionId: 'extension', extensionVersion: '1.0' },
  });
  expect(paired.statusCode).toBe(201);
  const device = paired.json();
  const headers = { ...t.headers, authorization: `Bearer ${device.token}` };
  expect((await t.app.inject({ url: '/api/v1/settings/save-preferences', headers })).json()).toEqual({
    revision: 0,
    autoTranslate: false,
  });
  for (const url of ['/api/v1/settings/provider', '/api/v1/settings/glossary', '/api/v1/admin/users'])
    expect((await t.app.inject({ url, headers })).statusCode).toBe(401);
  expect(
    (
      await t.app.inject({
        url: '/api/v1/settings/save-preferences',
        method: 'PUT',
        headers,
        payload: { expectedRevision: 0, autoTranslate: true },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await t.app.inject({
        url: '/api/v1/settings/save-preferences',
        method: 'PUT',
        headers: { cookie: t.session.cookie, origin: t.config.publicOrigin },
        payload: { expectedRevision: 0, autoTranslate: true },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await t.request('/api/v1/settings/save-preferences', 'PUT', {
        expectedRevision: 0,
        autoTranslate: true,
        ownerId: t.session.user.id,
      })
    ).statusCode,
  ).toBe(400);
  await t.request(`/api/v1/devices/${device.device.id}/revoke`, 'POST', {});
  expect((await t.app.inject({ url: '/api/v1/settings/save-preferences', headers })).statusCode).toBe(401);
});
it('keeps glossary snapshots for retries, rejects cross-owner sources/jobs, and does not revive disabled owners', async () => {
  const t = await setup();
  const s = await t.save();
  await t.profile();
  const job = (await t.request(`/api/v1/documents/${s.documentId}/web-jobs`, 'POST', t.input(s))).json();
  await t.request('/api/v1/settings/glossary', 'PUT', {
    expectedRevision: 0,
    entries: [{ source: 'reader', target: '读者', policy: 'translate', domain: 'all' }],
  });
  await t.request(`/api/v1/web-jobs/${job.id}/cancel`, 'POST', {});
  expect(
    (await t.request(`/api/v1/web-jobs/${job.id}/retry`, 'POST', { profileRevision: 1, glossaryRevision: 0 }))
      .statusCode,
  ).toBe(200);
  await t.db.pool.query(
    "INSERT INTO users(username,password_hash,role) SELECT 'other',password_hash,'user' FROM users WHERE id=$1",
    [t.session.user.id],
  );
  const other = await login(t.app, 'other', 'correct password 123456');
  const headers = { cookie: other.cookie, origin: t.config.publicOrigin, 'x-csrf-token': other.csrfToken };
  expect((await t.app.inject({ url: `/api/v1/web-jobs/${job.id}`, headers })).statusCode).toBe(404);
  expect(
    (
      await t.app.inject({
        url: `/api/v1/documents/${s.documentId}/web-jobs`,
        method: 'POST',
        headers,
        payload: t.input(s),
      })
    ).statusCode,
  ).toBe(404);
  expect((await t.app.inject({ url: '/api/v1/settings/glossary', headers })).json()).toEqual({
    revision: 0,
    entries: [],
  });
  const { createWebJobsService } = await import('../../src/web-jobs/service.js');
  const { createLocalObjectStore } = await import('../../src/storage/local-object-store.js');
  await t.db.pool.query('UPDATE users SET active=false,auth_version=auth_version+1 WHERE id=$1', [t.session.user.id]);
  await expect(
    createWebJobsService({ db: t.db, store: createLocalObjectStore(t.config.dataDir) }).create(
      t.actor,
      s.documentId,
      t.input(s, { glossaryRevision: 1 }),
    ),
  ).rejects.toMatchObject({ statusCode: 401 });
  expect(t.calls()).toBe(0);
});
it('binds the actual retained source parse and SHA despite a new capture timestamp and never auto-runs complete imports', async () => {
  const t = await setup();
  const original = await t.save();
  await t.profile();
  await t.request('/api/v1/settings/save-preferences', 'PUT', { expectedRevision: 0, autoTranslate: true });
  const again = await t.save(english, 'auto');
  expect(again.sourceVersionId).toBe(original.sourceVersionId);
  const row = (
    await t.db.pool.query(
      `SELECT j.input_sha256,p.ir_sha256,s.sha256,w.metadata FROM web_jobs j JOIN web_parse_runs p ON (p.owner_id,p.id)=(j.owner_id,j.parse_id) JOIN source_versions s ON s.id=j.source_version_id JOIN web_sources w ON w.source_version_id=s.id WHERE j.id=$1`,
      [again.jobId],
    )
  ).rows[0];
  expect(row.metadata.language).toMatchObject({ language: 'en', sourceLanguage: 'en' });
  const { canonicalManifestBytes } = await import('@pagelingo/web-capture');
  expect(row.input_sha256).toBe(
    createHash('sha256')
      .update(
        canonicalManifestBytes({
          kind: 'translate',
          sourceVersionId: original.sourceVersionId,
          parseId: original.parseId,
          readerIrSha256: row.ir_sha256,
          profileRevision: 1,
          glossaryRevision: 0,
          sourceLanguage: null,
          selectionBlockIds: null,
        }),
      )
      .digest('hex'),
  );
  const { withCandidates } = await import('../helpers/web-capture.js');
  const c = await withCandidates(english + '<p>The imported source is already translated for the reader.</p>');
  const created = await t.app.inject({
    url: '/api/v1/captures',
    method: 'POST',
    headers: { ...t.headers, 'idempotency-key': c.manifest.captureId },
    payload: { manifest: c.manifest, translationIntent: 'auto' },
  });
  const id = created.json().id;
  for (const [fileId, body, type] of [
    ['html', c.body, 'text/html'],
    ['translation', c.translation, 'application/json'],
  ] as const)
    expect(
      (
        await t.app.inject({
          url: `/api/v1/captures/${id}/files/${fileId}`,
          method: 'PUT',
          headers: { ...t.headers, 'content-type': type },
          payload: body,
        })
      ).statusCode,
    ).toBe(200);
  const result = await t.request(`/api/v1/captures/${id}/commit`, 'POST', {});
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().jobId).toBeNull();
});
it('skips missing or malformed legacy language metadata automatically but manual creation reads verified IR', async () => {
  const t = await setup();
  const s = await t.save();
  await t.profile();
  await t.request('/api/v1/settings/save-preferences', 'PUT', { expectedRevision: 0, autoTranslate: true });
  // Disposable DB legacy fixture: old sources predate the added server metadata field.
  await t.db.pool.query('ALTER TABLE web_sources DISABLE TRIGGER immutable_web_sources');
  await t.db.pool.query("UPDATE web_sources SET metadata=metadata-'language' WHERE source_version_id=$1", [
    s.sourceVersionId,
  ]);
  await t.db.pool.query('ALTER TABLE web_sources ENABLE TRIGGER immutable_web_sources');
  expect((await t.save(english, 'auto')).jobId).toBeNull();
  await t.db.pool.query('ALTER TABLE web_sources DISABLE TRIGGER immutable_web_sources');
  await t.db.pool.query(
    'UPDATE web_sources SET metadata=metadata || \'{"language":{"language":"en","sourceLanguage":"und-US"}}\'::jsonb WHERE source_version_id=$1',
    [s.sourceVersionId],
  );
  await t.db.pool.query('ALTER TABLE web_sources ENABLE TRIGGER immutable_web_sources');
  expect((await t.save(english, 'auto')).jobId).toBeNull();
  const manual = await t.request(`/api/v1/documents/${s.documentId}/web-jobs`, 'POST', t.input(s));
  expect(manual.statusCode, manual.body).toBe(201);
  expect(t.calls()).toBe(0);
});
it('revalidates the actor after loading IR and serializes profile changes against final job writes', async () => {
  const t = await setup();
  const s = await t.save();
  await t.profile();
  const { createWebJobsService } = await import('../../src/web-jobs/service.js');
  const { createLocalObjectStore } = await import('../../src/storage/local-object-store.js');
  const store = createLocalObjectStore(t.config.dataDir);
  let loads = 0;
  const changeDuringRead = {
    ...store,
    read(key: string) {
      const stream = store.read(key);
      return (async function* () {
        for await (const chunk of stream) yield chunk;
        if (loads++ === 0) await t.profile(1, 'replace');
      })();
    },
  };
  const service = createWebJobsService({ db: t.db, store: changeDuringRead });
  await expect(service.create(t.actor, s.documentId, t.input(s))).rejects.toMatchObject({ code: 'PROFILE_CHANGED' });
  expect((await t.db.pool.query('SELECT id FROM web_jobs')).rows).toEqual([]);
  const revokeDuringRead = {
    ...store,
    read(key: string) {
      const stream = store.read(key);
      return (async function* () {
        for await (const chunk of stream) yield chunk;
        await t.db.pool.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [t.session.user.id]);
      })();
    },
  };
  await expect(
    createWebJobsService({ db: t.db, store: revokeDuringRead }).create(
      t.actor,
      s.documentId,
      t.input(s, { profileRevision: 2 }),
    ),
  ).rejects.toMatchObject({ statusCode: 401 });
  expect((await t.db.pool.query('SELECT id FROM web_jobs')).rows).toEqual([]);
});
it('requires the preferences scope at the internal service boundary', async () => {
  const t = await setup();
  const code = (await t.request('/api/v1/devices/pairing-codes', 'POST', {})).json().code;
  const exchange = await t.app.inject({
    method: 'POST',
    url: '/api/v1/devices/exchange',
    payload: { code, deviceName: 'browser', extensionId: 'extension', extensionVersion: '1.0' },
  });
  const device = exchange.json();
  const { createSavePreferencesService } = await import('../../src/web-jobs/preferences.js');
  await expect(
    createSavePreferencesService({ db: t.db }).get({
      kind: 'device',
      userId: t.session.user.id,
      authVersion: 1,
      deviceId: device.device.id,
      tokenHash: createHash('sha256').update(device.token).digest('hex'),
      scopes: ['captures:read'],
      scope: 'captures:read',
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
});
it('canonicalizes a proper subset and manual language while retaining immutable job inputs', async () => {
  const t = await setup();
  const s = await t.save(
    english + '<p>The third paragraph contains more useful information about this article and how it works.</p>',
  );
  await t.profile();
  expect(s.blocks).toHaveLength(3);
  const url = `/api/v1/documents/${s.documentId}/web-jobs`;
  const first = await t.request(
    url,
    'POST',
    t.input(s, { sourceLanguage: 'FR', selectionBlockIds: [s.blocks[2], s.blocks[0]] }),
  );
  expect(first.statusCode, first.body).toBe(201);
  expect(first.json()).toMatchObject({ sourceLanguage: 'fr', selectionBlockIds: [s.blocks[0], s.blocks[2]] });
  const same = await t.request(
    url,
    'POST',
    t.input(s, { sourceLanguage: 'fr', selectionBlockIds: [s.blocks[0], s.blocks[2]] }),
  );
  expect(same.json().id).toBe(first.json().id);
  const different = await t.request(
    url,
    'POST',
    t.input(s, { sourceLanguage: 'fr', selectionBlockIds: [s.blocks[0]] }),
  );
  expect(different.json().id).not.toBe(first.json().id);
  await expect(
    t.db.pool.query("UPDATE web_jobs SET source_language='de' WHERE id=$1", [first.json().id]),
  ).rejects.toThrow();
  for (const sourceLanguage of ['und-US', 'mul-Latn', 'zxx-US'])
    expect((await t.request(url, 'POST', t.input(s, { sourceLanguage }))).statusCode).toBe(400);
});
it('discovers owned jobs with bounded stable cursor pages and no job mutations or model calls', async () => {
  const t = await setup(); const saved = await t.save(); await t.profile();
  const ids: string[] = [];
  for (const sourceLanguage of ['en', 'fr', 'de']) {
    const response = await t.request(`/api/v1/documents/${saved.documentId}/web-jobs`, 'POST', t.input(saved, { sourceLanguage }));
    expect(response.statusCode).toBe(201); ids.push(response.json().id);
  }
  // Add tied immutable rows in the disposable fixture; no UPDATE bypass of input guards.
  const tied = await t.db.pool.query(`INSERT INTO web_jobs (id,owner_id,document_id,auth_version,kind,input_sha256,source_version_id,parse_id,profile_revision,glossary_revision,source_language,created_at) SELECT gen_random_uuid(),owner_id,document_id,auth_version,kind,repeat(n::text,64),source_version_id,parse_id,profile_revision,glossary_revision,source_language,'2027-01-01 00:00:00.123456+00' FROM web_jobs CROSS JOIN generate_series(1,3) n WHERE id=$1 RETURNING id`, [ids[0]]);
  const expected = [...tied.rows.map(row => row.id).sort().reverse(), ...ids.reverse()];
  const before = (await t.db.pool.query('SELECT * FROM web_jobs ORDER BY id')).rows;
  const path = `/api/v1/documents/${saved.documentId}/web-jobs?limit=1&sourceVersionId=${saved.sourceVersionId}&parseId=${saved.parseId}`;
  const seen: string[] = []; let cursor = '';
  do {
    const response = await t.request(path + (cursor ? `&cursor=${cursor}` : ''));
    expect(response.statusCode, response.body).toBe(200);
    const page = response.json(); expect(page.items).toHaveLength(1);
    expect(Object.keys(page.items[0])).not.toContain('owner_id'); seen.push(page.items[0].id); cursor = page.nextCursor;
  } while (cursor);
  expect(seen).toEqual(expected);
  expect((await t.request(path + '&cursor=00000000-0000-4000-8000-000000000000')).statusCode).toBe(400);
  expect((await t.request(`/api/v1/documents/${saved.documentId}/web-jobs?limit=51`)).statusCode).toBe(400);
  expect((await t.request(`/api/v1/documents/${saved.documentId}/web-jobs?parseId=${saved.parseId}`)).statusCode).toBe(400);
  expect((await t.request(`/api/v1/documents/${saved.documentId}/web-jobs?sourceVersionId=00000000-0000-4000-8000-000000000000`)).statusCode).toBe(404);
  expect((await t.app.inject({ url: path, headers: { authorization: 'Bearer invalid-device', cookie: t.session.cookie } })).statusCode).toBe(401);
  expect((await t.db.pool.query('SELECT * FROM web_jobs ORDER BY id')).rows).toEqual(before);
  expect(t.calls()).toBe(0);
});
it('job discovery distinguishes an empty owned Web document from another owner or non-Web document', async () => {
  const t = await setup(); const saved = await t.save();
  const path = `/api/v1/documents/${saved.documentId}/web-jobs`;
  const empty = await t.request(path); expect(empty.statusCode).toBe(200); expect(empty.json()).toEqual({ items: [], nextCursor: null });
  expect((await t.request('/api/v1/admin/users', 'POST', { username: 'list-other', password: 'another password 123456' })).statusCode).toBe(201);
  const other = await login(t.app, 'list-other', 'another password 123456');
  expect((await t.app.inject({ url: path, headers: { cookie: other.cookie } })).statusCode).toBe(404);
  expect((await t.request('/api/v1/documents/00000000-0000-4000-8000-000000000000/web-jobs')).statusCode).toBe(404);
  expect((await t.db.pool.query('SELECT id FROM web_jobs')).rowCount).toBe(0); expect(t.calls()).toBe(0);
});
