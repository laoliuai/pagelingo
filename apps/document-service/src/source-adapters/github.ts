import { createHash, randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import type { WebCaptureManifest } from '@pagelingo/document-contracts';
import { z } from 'zod';
import { ServiceError } from '../errors.js';
import { isFakeIpRejection } from '../network/address-policy.js';
import { assertJobLeaseCurrent, releaseWebJobSlot, type JobLease } from '../web-jobs/repository.js';
import { finishWebJob } from '../web-jobs/lease.js';
import { receiveCaptureFile, stagingPath } from '../web-captures/staging.js';
import { validateCaptureInWorker, type PreparedCapture } from '../web-captures/worker-client.js';
import { assertSourcePublication, resolveSourceIdentity } from './identity.js';
import { acquireSourceMaterial, loadSourceAcquisition, type SourceAcquisition } from './repository.js';
import { readSourceBytes, captureGithubResources } from './capture-resources.js';
import { publishGithubReader, publishGithubRevision, type GithubMetadata, type GithubRevisionInput } from './github-publication.js';
import { createSourceTransport } from './network.js';
import type { SourceFetchDependencies, SourceReference } from './types.js';

const MiB = 1024 * 1024;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const segment = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/).refine(s => s !== '.' && s !== '..');
// Strip upstream additions; business DTOs contain only validated known values.
const repositorySchema = z.object({ id: z.union([z.number().int().positive().refine(Number.isSafeInteger), z.string().regex(/^[1-9]\d*$/)]), owner: z.object({ login: segment }), name: segment, description: z.string().max(2000).nullable(), html_url: z.string().max(8192), default_branch: z.string().min(1).max(1024), private: z.literal(false) });
const descriptorSchema = z.object({ type: z.literal('file'), path: z.string().min(1).max(4096).refine(path => !/[\x00-\x1f\x7f\\]/.test(path) && !path.split('/').some(p => !p || p === '.' || p === '..')), sha, size: z.number().int().nonnegative().max(MiB) });
function failure(code: string): never { throw new ServiceError(400, code, 'GitHub source unavailable'); }
function status(response: Response) {
  if (response.status === 429 || response.status === 403) failure('GITHUB_RATE_LIMITED');
  if (response.status === 404 || response.status === 401) failure('GITHUB_REPOSITORY_UNAVAILABLE');
  if (!response.ok) failure('GITHUB_UPSTREAM_UNAVAILABLE');
}
function repository(bytes: Uint8Array): GithubMetadata {
  const value = repositorySchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  const url = `https://github.com/${value.owner.login}/${value.name}`;
  if (value.html_url !== url) failure('GITHUB_INVALID_METADATA');
  return { id: String(value.id), owner: value.owner.login, name: value.name, description: value.description, url, defaultBranch: value.default_branch };
}
async function bounded(response: Response, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let bytes = 0;
  const reader = response.body?.getReader();
  try { if (reader) for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > maxBytes) failure('GITHUB_SOURCE_TOO_LARGE'); chunks.push(Buffer.from(chunk.value)); } }
  finally { await reader?.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

export async function runGithubFetchJob(lease: JobLease, deps: SourceFetchDependencies): Promise<void> {
  if (lease.kind !== 'fetch-link') throw new Error('GitHub fetch requires fetch-link lease');
  if (deps.sourceTransport && deps.config.mode !== 'test') throw new Error('Source transport injection requires test mode');
  if (deps.config.mode === 'test' && !deps.sourceTransport) throw new Error('Test source jobs require explicit source transport');
  const transport = deps.sourceTransport ?? createSourceTransport(); const { db, signal } = deps;
  const request = await db.transaction(async client => {
    await assertJobLeaseCurrent(client, lease);
    return (await client.query<{ reference: SourceReference; original_url: string }>('SELECT reference,original_url FROM source_requests WHERE owner_id=$1 AND document_id=$2 AND job_id=$3', [lease.ownerId, lease.documentId, lease.jobId])).rows[0];
  });
  if (!request || request.reference.provider !== 'github') throw new Error('GitHub request required');
  const reference = request.reference;
  let value: GithubRevisionInput | undefined; const warnings: string[] = [];
  async function check() { signal.throwIfAborted(); await db.transaction(c => assertSourcePublication(c, lease)); }
  async function material(role: string, url: string, accept: string, maxBytes: number, filename: string, mediaType: string): Promise<SourceAcquisition> {
    const previous = await loadSourceAcquisition(db, lease, role); if (previous) return previous;
    await check(); const response = await transport.readSmall(url, { accept, maxBytes, signal });
    if (!response.ok) { await response.body?.cancel(); status(response); }
    const bytes = await bounded(response, maxBytes);
    return acquireSourceMaterial(lease, deps, { role, url, maxBytes, filename, mediaType, body: (async function* () { yield bytes; })() });
  }
  async function revision() {
    return db.transaction(client => publishGithubRevision(client, lease, value!, null, { limits: deps.config.captureLimits }));
  }
  try {
    // Existing stable identity makes restart material reusable before any new network request.
    const identity = (await db.pool.query("SELECT provider_id FROM document_source_identities WHERE owner_id=$1 AND document_id=$2 AND provider='github'", [lease.ownerId, lease.documentId])).rows[0];
    let repo: GithubMetadata; let repoMaterial: SourceAcquisition | null = null;
    if (identity) { await resolveSourceIdentity(db, lease, { provider: 'github', id: identity.provider_id }); repoMaterial = await loadSourceAcquisition(db, lease, 'github-repository'); }
    if (repoMaterial) repo = repository(await readSourceBytes(deps, repoMaterial, MiB));
    else {
      const url = `https://api.github.com/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}`;
      signal.throwIfAborted(); const response = await transport.readSmall(url, { accept: 'application/vnd.github+json', maxBytes: MiB, signal }); status(response);
      const bytes = await bounded(response, MiB); repo = repository(bytes);
      const resolution = await resolveSourceIdentity(db, lease, { provider: 'github', id: repo.id });
      if (resolution.resolution !== 'self') { await finishWebJob(lease, db, 'failed', 'SOURCE_IDENTITY_CONFLICT'); return; }
      repoMaterial = await acquireSourceMaterial(lease, deps, { role: 'github-repository', url, maxBytes: MiB, filename: 'repository.json', mediaType: 'application/json', body: (async function* () { yield bytes; })() });
    }
    const capturedAt = await db.transaction(async client => {
      await assertSourcePublication(client, lease);
      return (await client.query('SELECT created_at FROM source_acquisitions WHERE owner_id=$1 AND document_id=$2 AND id=$3', [lease.ownerId, lease.documentId, repoMaterial!.id])).rows[0].created_at.toISOString() as string;
    });
    value = { repository: repo, originalUrl: request.original_url, commitSha: null, capturedAt };
    await revision();
    const base = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
    const resolved = await material('github-commit', `${base}/commits/${encodeURIComponent(reference.requestedRef ?? repo.defaultBranch)}`, 'application/vnd.github.sha', MiB, 'commit.txt', 'text/plain');
    const commitSha = sha.parse((await readSourceBytes(deps, resolved, MiB)).toString('utf8').trim());
    value.commitSha = commitSha; await revision();
    const readmeUrl = `${base}/readme?ref=${commitSha}`;
    let descriptor: SourceAcquisition;
    try { descriptor = await material('github-descriptor', readmeUrl, 'application/vnd.github+json', 2 * MiB, 'readme.json', 'application/json'); }
    catch (error) { if (error instanceof ServiceError && error.code === 'GITHUB_REPOSITORY_UNAVAILABLE') { warnings.push('GITHUB_README_NOT_FOUND'); await complete(); return; } throw error; }
    const info = descriptorSchema.parse(JSON.parse((await readSourceBytes(deps, descriptor, 2 * MiB)).toString('utf8')));
    const raw = await material('github-raw', readmeUrl, 'application/vnd.github.raw+json', MiB, 'README.raw', 'text/plain');
    const rawBytes = await readSourceBytes(deps, raw, MiB);
    if (rawBytes.length !== info.size || createHash('sha1').update(`blob ${rawBytes.length}\0`).update(rawBytes).digest('hex') !== info.sha) failure('GITHUB_BLOB_MISMATCH');
    value.readme = { path: info.path, blobSha: info.sha, raw }; await revision();
    const html = await material('github-html', readmeUrl, 'application/vnd.github.html+json', Math.min(8 * MiB, deps.config.captureLimits.maxHtmlBytes), 'README.html', 'text/html');
    value.readme.html = html;
    const htmlBytes = await readSourceBytes(deps, html, deps.config.captureLimits.maxHtmlBytes);
    const manifest: WebCaptureManifest = { schemaVersion: 'web-capture/1', captureId: randomUUID(), source: { url: request.original_url, canonicalUrl: repo.url, kind: 'article', method: 'public-fetch' }, metadata: { title: `${repo.owner}/${repo.name}`, author: null, publishedAt: null, capturedAt }, scope: { kind: 'article', rootNodeId: 'root', completeWithinScope: true, warnings: [] }, htmlFileId: 'html', files: [{ id: 'html', path: 'snapshot.html', role: 'html', mediaType: 'text/html', bytes: html.bytes, sha256: html.sha256 }], resources: [], stylesheetFileIds: [], snapshots: { previews: [], nodeLocations: {} }, existingTranslation: null };
    async function prepare(inputManifest: WebCaptureManifest, files: Array<{ id: string; bytes: Uint8Array }>, resourceBaseUrl?: string): Promise<PreparedCapture> {
      const staged: string[] = [];
      try {
        const paths = [];
        for (const file of files) { const key = randomUUID(); staged.push(key); await receiveCaptureFile(deps.config.dataDir, key, (async function* () { yield file.bytes; })(), inputManifest.files.find(f => f.id === file.id)!, signal); paths.push({ id: file.id, path: stagingPath(deps.config.dataDir, key) }); }
        await check(); return await validateCaptureInWorker({ manifest: inputManifest, files: paths, limits: deps.config.captureLimits, resourceBaseUrl }, signal);
      } finally { for (const key of staged) await unlink(stagingPath(deps.config.dataDir, key)).catch(() => {}); }
    }
    // Resource URLs are resolved against the fixed README path; document identity remains the saved repo URL.
    const readmePath = info.path.split('/').map(encodeURIComponent).join('/');
    let prepared = await prepare(manifest, [{ id: 'html', bytes: htmlBytes }], `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${commitSha}/${readmePath}`);
    await captureGithubResources(lease, deps, transport, prepared);
    // Preview files are generated again after actual image acquisition.
    prepared.manifest.files = prepared.manifest.files.filter(f => f.role !== 'preview'); prepared.manifest.snapshots = { previews: [], nodeLocations: {} };
    prepared = await prepare(prepared.manifest, prepared.files.filter(f => prepared.manifest.files.some(d => d.id === f.id)));
    if (!prepared.ir.blocks.length) { warnings.push('SOURCE_PREVIEW_UNAVAILABLE'); await revision(); await complete(); return; }
    const result = await publishGithubReader(lease, deps, prepared, { lease, repositoryId: repo.id, commitSha, path: info.path, descriptor, raw, html }, value);
    warnings.push(...prepared.warnings); if (prepared.manifest.resources.some(r => r.status === 'missing')) warnings.push('SOURCE_PARTIAL_RESOURCES');
    await complete(result.readerVersionId);
  } catch (error) {
    signal.throwIfAborted();
    const code = error instanceof ServiceError ? error.code : error instanceof z.ZodError ? 'GITHUB_INVALID_METADATA' : isFakeIpRejection(error) ? 'OUTBOUND_FAKE_IP' : 'GITHUB_SOURCE_UNAVAILABLE';
    await db.transaction(async client => {
      await assertJobLeaseCurrent(client, lease);
      // If identity exists, publication failure records still obey the provider retirement fence.
      if ((await client.query('SELECT 1 FROM document_source_identities WHERE owner_id=$1 AND document_id=$2', [lease.ownerId, lease.documentId])).rowCount) await assertSourcePublication(client, lease);
      await client.query("UPDATE web_jobs SET status='failed',error_code=$3,warnings=$4,lease_owner=NULL,lease_until=NULL,slot_id=NULL,slot_epoch=NULL,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2", [lease.ownerId, lease.jobId, code, JSON.stringify(warnings)]);
      await releaseWebJobSlot(client, lease);
    });
  }
  async function complete(readerVersionId?: string) {
    await db.transaction(async client => {
      await assertSourcePublication(client, lease); signal.throwIfAborted();
      await client.query("UPDATE web_jobs SET status='completed',reader_version_id=$3,error_code=NULL,warnings=$4,lease_owner=NULL,lease_until=NULL,slot_id=NULL,slot_epoch=NULL,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2", [lease.ownerId, lease.jobId, readerVersionId ?? null, JSON.stringify([...new Set(warnings)])]);
      await releaseWebJobSlot(client, lease);
    });
  }
}
