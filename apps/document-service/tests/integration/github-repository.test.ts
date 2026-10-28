import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { bootstrapAdmin } from '../../src/cli/bootstrap-admin.js';
import { createServiceTestApp } from '../helpers/app.js';
import { login } from '../helpers/session.js';
import { startWebJobLease } from '../../src/web-jobs/repository.js';
import { runWebJob } from '../../src/web-jobs/translation-runner.js';
import { createLocalObjectStore } from '../../src/storage/local-object-store.js';
import { githubFixture, fixtureTransport, commit, raw, blob, type Fixture } from '../helpers/github-fixture.js';
import { startWorker } from '../helpers/worker-process.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
it('acquires repository material through an independent shared worker and real owned API database', async () => {
  const t = await setup(); const saved = await t.save();
  const worker = await startWorker(t, { github: true });
  try {
    await expect.poll(async () => (await t.db.pool.query('SELECT status FROM web_jobs WHERE id=$1', [saved.jobId])).rows[0].status, { timeout: 7000 }).toBe('completed');
    expect(await t.details(saved.documentId)).toMatchObject({ current: { sourceVersionId: expect.any(String) }, latestAttempt: { status: 'completed' } });
    expect(worker.messages.filter(m => m.type === 'request')).toEqual([]);
  } finally {
    await worker.stop();
    const directory = process.env.PAGELINGO_TEST_GITHUB_EVIDENCE_DIR ?? join(t.config.dataDir, 'github-evidence');
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, `independent-worker-${randomUUID()}.json`), JSON.stringify({ pid: worker.child.pid, parentPid: process.pid, messages: worker.messages, output: worker.output() }));
  }
});
async function setup() {
  const t = await createServiceTestApp(); closes.push(t.close);
  await bootstrapAdmin(t.db, { username: 'admin', password: 'correct password 123456' });
  const session = await login(t.app, 'admin', 'correct password 123456');
  const headers = { cookie: session.cookie, origin: t.config.publicOrigin, 'x-csrf-token': session.csrfToken };
  const store = createLocalObjectStore(t.config.dataDir);
  const save = async (url = 'https://github.com/Org/Repo', extra = {}) => { const r = await t.app.inject({ method: 'POST', url: '/api/v1/documents/links', headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { url, translationIntent: 'none', ...extra } }); expect(r.statusCode, r.body).toBe(201); return r.json() as { documentId: string; jobId: string }; };
  const run = async (jobId: string, fixtures: Fixture = githubFixture()) => { const lease = (await t.db.transaction(c => startWebJobLease(c, { ownerId: session.user.id, jobId, slotId: 1, leaseOwner: randomUUID() })))!; expect(lease).not.toBeNull(); const seen: string[] = []; await runWebJob(lease, { db: t.db, store, config: t.config, signal: new AbortController().signal, sourceTransport: fixtureTransport(fixtures, seen) }); return seen; };
  const details = async (id: string) => (await t.app.inject({ url: `/api/v1/documents/${id}/source-details`, headers })).json();
  const refresh = async (id: string) => { const r = await t.app.inject({ method: 'POST', url: `/api/v1/documents/${id}/source-refresh`, headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { translationIntent: 'none' } }); expect(r.statusCode, r.body).toBe(202); return r.json().jobId as string; };
  return { ...t, headers, store, save, run, details, refresh, ownerId: session.user.id };
}
it('pins metadata raw README and rendered HTML to one commit and publishes a real Reader with actual images', async () => {
  const t = await setup(); const saved = await t.save(); const seen = await t.run(saved.jobId);
  const value = await t.details(saved.documentId);
  expect(value).toMatchObject({ kind: 'github', status: 'partial-resources', current: { repository: { id: '12345', owner: 'Org', name: 'Repo' }, commitSha: commit, readme: { path: 'docs/README.md', blobSha: blob, raw: { sha256: createHash('sha256').update(raw).digest('hex'), bytes: raw.length } } }, latestAttempt: { status: 'completed', resolvedRevision: expect.any(String) } });
  expect(value.current.sourceVersionId).toEqual(expect.any(String)); expect(value.latestAttempt.resolvedRevision).toBe(value.current.id);
  const acquired = (await t.db.pool.query("SELECT created_at FROM source_acquisitions WHERE job_id=$1 AND role='github-repository'", [saved.jobId])).rows[0];
  expect(value.current.capturedAt).toBe(acquired.created_at.toISOString());
  expect(seen.filter(url => url.includes('/readme?'))).toHaveLength(3); expect(seen.filter(url => url.includes('/readme?')).every(url => url.includes(`ref=${commit}`))).toBe(true);
  const readerResponse = await t.app.inject({ url: `/api/v1/documents/${saved.documentId}/web-reader`, headers: t.headers }); expect(readerResponse.statusCode, readerResponse.body).toBe(200);
  const reader = readerResponse.json(); const diagnostic = await t.app.inject({url: `/api/v1/documents/${saved.documentId}/web-snapshots/${value.current.sourceVersionId}/manifest`,headers:t.headers}); expect(reader.index.assetIds, diagnostic.body).toHaveLength(1);
  const clean = await t.app.inject({ url: `/api/v1/documents/${saved.documentId}/web-snapshots/${value.current.sourceVersionId}/files/html`, headers: t.headers }); expect(clean.body).toContain('Fixed source'); expect(clean.body).not.toContain('UNSAFE_SCRIPT'); expect(clean.body).not.toContain('<form');
  expect((await t.app.inject({ url: `/api/v1/documents/${saved.documentId}`, headers: t.headers })).json()).toMatchObject({ kind: 'repository', title: 'Org/Repo', reader: { versionId: reader.versionId } });
  await expect(t.db.pool.query('UPDATE github_versions SET description=$1', ['changed'])).rejects.toThrow(/immutable/i);
});
it('keeps metadata when README is absent and preserves explicit titles when fetch completes late', async () => {
  const t = await setup(); const saved = await t.save(undefined, { title: 'My title' });
  await t.run(saved.jobId, githubFixture({ [`https://api.github.com/repos/Org/Repo/readme?ref=${commit}|application/vnd.github+json`]: { status: 404, body: '{}' } }));
  expect(await t.details(saved.documentId)).toMatchObject({ status: 'metadata-saved', current: { readme: null, sourceVersionId: null }, warnings: expect.arrayContaining(['GITHUB_README_NOT_FOUND']) });
  expect((await t.app.inject({ url: `/api/v1/documents/${saved.documentId}`, headers: t.headers })).json()).toMatchObject({ kind: 'repository', title: 'My title', reader: null });
  expect((await t.db.pool.query('SELECT id FROM web_parse_runs')).rows).toHaveLength(0);
});
it('preserves the selected revision and opened Reader when a newer attempt fails blob verification', async () => {
  const t = await setup(); const saved = await t.save(); await t.run(saved.jobId); const before = await t.details(saved.documentId);
  const reader = (await t.app.inject({ url: `/api/v1/documents/${saved.documentId}/web-reader`, headers: t.headers })).json();
  const jobId = await t.refresh(saved.documentId); await t.run(jobId, githubFixture({ [`https://api.github.com/repos/Org/Repo/readme?ref=${commit}|application/vnd.github.raw+json`]: { body: '# Different raw bytes', type: 'text/plain' } }));
  expect(await t.details(saved.documentId)).toMatchObject({ current: { id: before.current.id }, latestAttempt: { jobId, status: 'failed', errorCode: 'GITHUB_BLOB_MISMATCH', resolvedRevision: expect.any(String) } });
  expect((await t.app.inject({ url: `/api/v1/documents/${saved.documentId}/web-reader?versionId=${reader.versionId}`, headers: t.headers })).json().versionId).toBe(reader.versionId);
});
it('reuses a known repo across rename without merging edited records or acquiring their material', async () => {
  const t = await setup(); const canonical = await t.save(); await t.run(canonical.jobId);
  for (const [url, extra, resolution] of [['https://github.com/Old/Repo', {}, 'alias'], ['https://github.com/Edited/Repo', { title: 'Keep me' }, 'conflict']] as const) {
    const saved = await t.save(url, extra); await t.run(saved.jobId, { [url.replace('https://github.com/', 'https://api.github.com/repos/')]: githubFixture()['https://api.github.com/repos/Org/Repo']! });
    expect(await t.details(saved.documentId)).toMatchObject({ resolution, canonicalDocumentId: canonical.documentId, current: null });
    expect((await t.db.pool.query('SELECT id FROM source_acquisitions WHERE document_id=$1', [saved.documentId])).rowCount).toBe(0);
    expect((await t.db.pool.query('SELECT document_id FROM web_jobs WHERE id=$1', [saved.jobId])).rows[0].document_id).toBe(saved.documentId);
  }
});
it('reuses immutable source revisions for repeated bytes and records each requesting job', async () => {
  const t = await setup(); const saved = await t.save(); await t.run(saved.jobId); const before = await t.details(saved.documentId);
  const jobId = await t.refresh(saved.documentId); await t.run(jobId);
  expect(await t.details(saved.documentId)).toMatchObject({ current: { id: before.current.id, sourceVersionId: before.current.sourceVersionId }, latestAttempt: { jobId, status: 'completed', resolvedRevision: before.current.id } });
  expect((await t.db.pool.query('SELECT id FROM web_reader_versions WHERE document_id=$1', [saved.documentId])).rowCount).toBe(1);
});
it('recovers a published Reader after process loss without fetching or republishing its captured material', async () => {
  const t = await setup(); const saved = await t.save(); await t.run(saved.jobId); const before = await t.details(saved.documentId);
  // A crash after the publication transaction but before final job completion.
  await t.db.pool.query("UPDATE web_jobs SET status='queued',epoch=epoch+1 WHERE id=$1", [saved.jobId]);
  await t.run(saved.jobId, {});
  expect(await t.details(saved.documentId)).toMatchObject({ current: { id: before.current.id }, latestAttempt: { status: 'completed', resolvedRevision: before.current.id } });
  expect((await t.db.pool.query('SELECT id FROM web_reader_versions WHERE document_id=$1', [saved.documentId])).rowCount).toBe(1);
});
it.each([
  ['private', { status: 404, body: '{}' }, 'GITHUB_REPOSITORY_UNAVAILABLE'],
  ['rate-limited', { status: 429, body: '{}' }, 'GITHUB_RATE_LIMITED'],
  ['unsafe numeric identity', { body: JSON.stringify({ id: 9007199254740992, owner: { login: 'Org' }, name: 'Repo', html_url: 'https://github.com/Org/Repo', description: null, private: false, default_branch: 'Main' }) }, 'GITHUB_INVALID_METADATA'],
] as const)('does not fabricate source for a %s repository', async (_name, response, errorCode) => {
  const t = await setup(); const saved = await t.save(); await t.run(saved.jobId, { 'https://api.github.com/repos/Org/Repo': response });
  expect(await t.details(saved.documentId)).toMatchObject({ current: null, latestAttempt: { status: 'failed', errorCode } });
  expect((await t.db.pool.query('SELECT id FROM source_acquisitions')).rowCount).toBe(0);
  expect((await t.db.pool.query('SELECT id FROM source_versions')).rowCount).toBe(0);
});
it('rejects oversized actual raw bytes without trusting the descriptor size and keeps metadata', async () => {
  const t = await setup(); const saved = await t.save();
  await t.run(saved.jobId, githubFixture({ [`https://api.github.com/repos/Org/Repo/readme?ref=${commit}|application/vnd.github.raw+json`]: { body: 'x'.repeat(1024 * 1024 + 1), type: 'text/plain' } }));
  expect(await t.details(saved.documentId)).toMatchObject({ status: 'metadata-saved', current: { readme: null }, latestAttempt: { status: 'failed', errorCode: 'GITHUB_SOURCE_TOO_LARGE' } });
  expect((await t.db.pool.query("SELECT id FROM source_acquisitions WHERE role='github-raw'")).rowCount).toBe(0);
});
it('keeps a raw-only revision when rendered HTML cannot be acquired', async () => {
  const t = await setup(); const saved = await t.save();
  await t.run(saved.jobId, githubFixture({ [`https://api.github.com/repos/Org/Repo/readme?ref=${commit}|application/vnd.github.html+json`]: { status: 500, body: '{}' } }));
  expect(await t.details(saved.documentId)).toMatchObject({ status: 'metadata-saved', current: { sourceVersionId: null, readme: { raw: { bytes: raw.length }, renderedHtml: null } }, warnings: expect.arrayContaining(['SOURCE_PREVIEW_UNAVAILABLE']) });
  expect((await t.app.inject({ url: `/api/v1/documents/${saved.documentId}/web-reader`, headers: t.headers })).statusCode).toBe(404);
});
it('keeps public capture target and DTO checks strict for repositories', async () => {
  const t = await setup(); const saved = await t.save();
  const { capture } = await import('../helpers/web-capture.js'); const fixture = capture('<article><p>Public capture is not provider proof.</p></article>'); fixture.manifest.source.url = 'https://github.com/Org/Repo';
  const create = (extra: object) => t.app.inject({ method: 'POST', url: '/api/v1/captures', headers: { ...t.headers, 'idempotency-key': fixture.manifest.captureId }, payload: { manifest: fixture.manifest, targetDocumentId: saved.documentId, translationIntent: 'none', ...extra } });
  expect((await create({})).statusCode).toBe(404); expect((await create({ githubProof: { trusted: true } })).statusCode).toBe(400);
  expect((await t.db.pool.query('SELECT id FROM web_captures')).rowCount).toBe(0);
});
it('resolves relative images against the case-exact escaped fixed README path', async () => {
  const t = await setup(); const saved = await t.save(); const fixtures = githubFixture();
  fixtures[`https://api.github.com/repos/Org/Repo/readme?ref=${commit}|application/vnd.github+json`]!.body = JSON.stringify({ type: 'file', path: 'Docs#Case/README.md', sha: blob, size: raw.length });
  fixtures[`https://api.github.com/repos/Org/Repo/readme?ref=${commit}|application/vnd.github.html+json`]!.body = '<article><h1>Fixed source</h1><p>Repository documentation.</p><img src="./Figure.png"></article>';
  fixtures[`https://raw.githubusercontent.com/Org/Repo/${commit}/Docs%23Case/Figure.png`] = fixtures['https://images.example/figure.png']!;
  await t.run(saved.jobId, fixtures); const value = await t.details(saved.documentId);
  expect(value.current.readme.path).toBe('Docs#Case/README.md');
  const manifest = (await t.app.inject({ url: `/api/v1/documents/${saved.documentId}/web-snapshots/${value.current.sourceVersionId}/manifest`, headers: t.headers })).json();
  expect(manifest.resources).toEqual([expect.objectContaining({ url: `https://raw.githubusercontent.com/Org/Repo/${commit}/Docs%23Case/Figure.png`, status: 'available' })]);
});
it('retains opened Reader bytes while selecting a newer valid repository revision', async () => {
  const t = await setup(); const saved = await t.save(); await t.run(saved.jobId); const before = await t.details(saved.documentId);
  const oldReader = (await t.app.inject({ url: `/api/v1/documents/${saved.documentId}/web-reader`, headers: t.headers })).json();
  const nextCommit = 'b'.repeat(40); const fixtures = githubFixture();
  fixtures['https://api.github.com/repos/Org/Repo/commits/Main']!.body = nextCommit;
  for (const key of Object.keys(fixtures)) if (key.includes(`ref=${commit}`)) { fixtures[key.replace(commit, nextCommit)] = fixtures[key]!; delete fixtures[key]; }
  fixtures[`https://api.github.com/repos/Org/Repo/readme?ref=${nextCommit}|application/vnd.github.html+json`]!.body = '<article><h1>New fixed source</h1><p>The revised repository documentation adds new evidence about this software system.</p></article>';
  const jobId = await t.refresh(saved.documentId); await t.run(jobId, fixtures);
  const after = await t.details(saved.documentId); expect(after.current.id).not.toBe(before.current.id); expect(after.current.commitSha).toBe(nextCommit);
  const current = (await t.app.inject({ url: `/api/v1/documents/${saved.documentId}/web-reader`, headers: t.headers })).json(); expect(current.source.sourceVersionId).toBe(after.current.sourceVersionId);
  expect((await t.app.inject({ url: `/api/v1/documents/${saved.documentId}/web-reader?versionId=${oldReader.versionId}`, headers: t.headers })).json()).toMatchObject({ versionId: oldReader.versionId, source: { sourceVersionId: before.current.sourceVersionId } });
});
it('keeps the selected revision matched when lawful automatic SDK translation promotes a newer source', async () => {
  const t = await setup(); const { defaultProviderProfile } = await import('@pagelingo/document-contracts');
  const { revision: _revision, hasApiKey: _hasApiKey, ...defaults } = defaultProviderProfile;
  expect((await t.app.inject({ method: 'PUT', url: '/api/v1/settings/provider', headers: t.headers, payload: { expectedRevision: 0, settings: { ...defaults, baseUrl: 'https://mock.example/v1', model: 'test' }, key: { action: 'replace', value: 'owned-test-key' } } })).statusCode).toBe(200);
  expect((await t.app.inject({ method: 'PUT', url: '/api/v1/settings/save-preferences', headers: t.headers, payload: { expectedRevision: 0, autoTranslate: true } })).statusCode).toBe(200);
  function fixturesFor(commitSha: string, heading: string) {
    const fixtures = githubFixture(); fixtures['https://api.github.com/repos/Org/Repo/commits/Main']!.body = commitSha;
    for (const key of Object.keys(fixtures)) if (key.includes(`ref=${commit}`)) { const item = fixtures[key]!; delete fixtures[key]; fixtures[key.replace(commit, commitSha)] = item; }
    fixtures[`https://api.github.com/repos/Org/Repo/readme?ref=${commitSha}|application/vnd.github.html+json`]!.body = `<article><h1>${heading}</h1>${'<p>The reader can save the original article and read the source without any translation. This paragraph explains how the software and the system work with useful evidence.</p>'.repeat(5)}</article>`;
    return fixtures;
  }
  async function translate(sourceId: string) {
    const job = (await t.db.pool.query("SELECT id FROM web_jobs WHERE document_id=$1 AND source_version_id=$2 AND kind='translate'", [saved.documentId, sourceId])).rows[0]; expect(job).toBeDefined();
    const lease = (await t.db.transaction(c => startWebJobLease(c, { ownerId: t.ownerId, jobId: job.id, slotId: 1, leaseOwner: randomUUID() })))!; expect(lease).not.toBeNull();
    await runWebJob(lease, { db: t.db, store: t.store, config: t.config, signal: new AbortController().signal, provider: { async generate(request) { return { translations: request.data.blocks.map(b => ({ id: b.id, text: b.protectedText })) }; } } });
    expect((await t.db.pool.query('SELECT status FROM web_jobs WHERE id=$1', [job.id])).rows[0].status).toBe('completed');
  }
  const saved = await t.save(undefined, { translationIntent: 'auto' }); await t.run(saved.jobId, fixturesFor(commit, 'First revision'));
  const first = await t.details(saved.documentId); await translate(first.current.sourceVersionId);
  const response = await t.app.inject({ method: 'POST', url: `/api/v1/documents/${saved.documentId}/source-refresh`, headers: { ...t.headers, 'idempotency-key': randomUUID() }, payload: { translationIntent: 'auto' } });
  expect(response.statusCode, response.body).toBe(202); await t.run(response.json().jobId, fixturesFor('b'.repeat(40), 'Second revision'));
  const pending = await t.details(saved.documentId); expect(pending.current.id).toBe(first.current.id); expect(pending.latestAttempt.resolvedRevision).not.toBe(first.current.id);
  const source = (await t.db.pool.query('SELECT source_version_id FROM github_versions WHERE id=$1', [pending.latestAttempt.resolvedRevision])).rows[0].source_version_id;
  await translate(source);
  const selected = await t.details(saved.documentId); const reader = (await t.app.inject({ url: `/api/v1/documents/${saved.documentId}/web-reader`, headers: t.headers })).json();
  expect(selected.current.id).toBe(pending.latestAttempt.resolvedRevision); expect(selected.current.sourceVersionId).toBe(reader.source.sourceVersionId); expect(reader.translationStatus).toBe('completed');
}, 20000);
it('preserves user and legacy titles while projecting bounded metadata from one article extraction', async () => {
  const t = await setup();
  const { runFetchJob } = await import('../../src/web-captures/fetch-runner.js');
  for (const origin of ['url', 'user', 'legacy']) {
    const saved = await t.save(`https://blog.example/${origin}`, origin === 'user' ? { title: 'User title' } : {});
    if (origin === 'legacy') await t.db.pool.query("UPDATE documents SET title='Legacy title',title_origin='legacy' WHERE id=$1", [saved.documentId]);
    let fetches = 0;
    const lease = (await t.db.transaction(c => startWebJobLease(c, { ownerId: t.ownerId, jobId: saved.jobId, slotId: 1, leaseOwner: randomUUID() })))!;
    await runFetchJob(lease, { db: t.db, store: t.store, config: t.config, signal: new AbortController().signal, captureFetch: async () => { fetches++; return new Response(`<html><head><title>Source article title</title><meta name="author" content="Ada Reader"><meta property="article:published_time" content="2026-10-01T00:00:00Z"></head><body><article><h1>Source article title</h1>${'<p>The original article explains the software and the system with enough detailed evidence to read offline without translation.</p>'.repeat(6)}</article></body></html>`, { headers: { 'content-type': 'text/html' } }); } });
    expect(fetches).toBe(1); expect((await t.db.pool.query('SELECT status,error_code FROM web_jobs WHERE id=$1',[saved.jobId])).rows[0]).toEqual({status:'completed',error_code:null});
    expect((await t.db.pool.query('SELECT title FROM documents WHERE id=$1', [saved.documentId])).rows[0].title).toBe(origin === 'url' ? 'Source article title' : origin === 'user' ? 'User title' : 'Legacy title');
    expect((await t.db.pool.query('SELECT metadata FROM web_sources WHERE document_id=$1', [saved.documentId])).rows[0].metadata).toMatchObject({ title: 'Source article title', author: 'Ada Reader', publishedAt: '2026-10-01T00:00:00.000Z' });
    expect((await t.db.pool.query('SELECT authors FROM document_search_metadata WHERE document_id=$1', [saved.documentId])).rows[0].authors).toBe('Ada Reader');
  }
});
