import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { canonicalManifestBytes } from '@pagelingo/web-capture';
import type { JobLease } from '../web-jobs/repository.js';
import { createCaptureJobScheduler } from '../web-jobs/service.js';
import { publishCapture, type CaptureAsset } from '../web-captures/publication.js';
import { findWebCapture, insertWebCapture } from '../web-captures/repository.js';
import type { PreparedCapture } from '../web-captures/worker-client.js';
import { projectSelectedMetadata } from '../document-management/metadata-projection.js';
import { assertSourcePublication } from './identity.js';
import type { SourceAcquisition } from './repository.js';
import type { SourceFetchDependencies } from './types.js';
import { readSourceBytes } from './capture-resources.js';

export interface GithubMetadata { id: string; owner: string; name: string; description: string | null; url: string; defaultBranch: string }
export interface GithubRevisionInput {
  repository: GithubMetadata; originalUrl: string; commitSha: string | null;
  readme?: { path: string; blobSha: string; raw: SourceAcquisition; html?: SourceAcquisition };
  capturedAt: string;
}
/** Internal evidence only; callers cannot submit this through the public capture DTO. */
export interface GithubCaptureProof {
  lease: JobLease; repositoryId: string; commitSha: string; path: string;
  descriptor: SourceAcquisition; raw: SourceAcquisition; html: SourceAcquisition;
}
export async function assertGithubCapture(client: PoolClient, proof: GithubCaptureProof, captureJobId: string | null, targetId: string | null, sourceUrl: string): Promise<void> {
  const { lease } = proof; await assertSourcePublication(client, lease);
  const row = (await client.query(`SELECT i.provider_id,r.original_url FROM document_source_identities i JOIN source_requests r ON(r.owner_id,r.document_id)=(i.owner_id,i.document_id)
    WHERE i.owner_id=$1 AND i.document_id=$2 AND i.provider='github' AND r.job_id=$3`, [lease.ownerId, lease.documentId, lease.jobId])).rows[0];
  if (!row || row.provider_id !== proof.repositoryId || captureJobId !== lease.jobId || targetId !== lease.documentId || row.original_url !== sourceUrl || !/^[a-f0-9]{40}$/.test(proof.commitSha) || !proof.path || proof.path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Repository publication proof mismatch');
  for (const [material, role] of [[proof.descriptor, 'github-descriptor'], [proof.raw, 'github-raw'], [proof.html, 'github-html']] as const) {
    if (!(await client.query(`SELECT 1 FROM source_acquisitions WHERE owner_id=$1 AND document_id=$2 AND job_id=$3 AND id=$4 AND role=$5 AND asset_id=$6 AND sha256=$7 AND bytes=$8 AND url=$9`, [lease.ownerId, lease.documentId, lease.jobId, material.id, role, material.assetId, material.sha256, material.bytes, material.url])).rowCount || new URL(material.url).searchParams.get('ref') !== proof.commitSha) throw new Error('Unregistered repository material');
  }
}

/** Insert an immutable snapshot, then separately select only the revision matching the current Reader. */
export async function publishGithubRevision(client: PoolClient, lease: JobLease, value: GithubRevisionInput, sourceVersionId: string | null, configDigest: unknown): Promise<string> {
  await assertSourcePublication(client, lease);
  const r = value.repository, readme = value.readme;
  const digest = createHash('sha256').update(canonicalManifestBytes({ repository: r, originalUrl: value.originalUrl, commitSha: value.commitSha, readme: readme ? { path: readme.path, blobSha: readme.blobSha, raw: readme.raw.sha256, html: readme.html?.sha256 ?? null } : null, config: configDigest })).digest('hex');
  let revision = (await client.query('SELECT id,source_version_id FROM github_versions WHERE owner_id=$1 AND document_id=$2 AND content_digest=$3', [lease.ownerId, lease.documentId, digest])).rows[0];
  if (!revision) revision = (await client.query(`INSERT INTO github_versions(id,owner_id,document_id,job_id,repository_id,repository_owner,repository_name,description,original_url,canonical_url,commit_sha,readme_path,blob_sha,raw_asset_id,html_asset_id,source_version_id,content_digest,captured_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id,source_version_id`, [randomUUID(), lease.ownerId, lease.documentId, lease.jobId, r.id, r.owner, r.name, r.description, value.originalUrl, r.url, value.commitSha, readme?.path ?? null, readme?.blobSha ?? null, readme?.raw.assetId ?? null, readme?.html?.assetId ?? null, sourceVersionId, digest, value.capturedAt])).rows[0];
  await client.query('UPDATE web_jobs SET source_github_revision_id=$3 WHERE owner_id=$1 AND id=$2', [lease.ownerId, lease.jobId, revision.id]);
  // Failed newer attempts retain their own result pointer without displacing old readable material.
  await client.query(`UPDATE documents SET current_github_revision_id=$3 WHERE owner_id=$1 AND id=$2
    AND (current_web_reader_version_id IS NULL OR current_source_version_id=$4)`, [lease.ownerId, lease.documentId, revision.id, revision.source_version_id]);
  if (!sourceVersionId && !(await client.query('SELECT current_web_reader_version_id FROM documents WHERE owner_id=$1 AND id=$2', [lease.ownerId, lease.documentId])).rows[0].current_web_reader_version_id) await projectSelectedMetadata(client, lease.ownerId, lease.documentId, { title: `${r.owner}/${r.name}`, url: value.originalUrl });
  return revision.id;
}

export async function publishGithubReader(lease: JobLease, deps: SourceFetchDependencies, prepared: PreparedCapture, proof: GithubCaptureProof, value: GithubRevisionInput): Promise<{ sourceVersionId: string; readerVersionId: string; revisionId: string }> {
  const descriptor = JSON.parse((await readSourceBytes(deps, proof.descriptor, 2 * 1024 * 1024)).toString('utf8'));
  if (!value.readme || descriptor.path !== proof.path || descriptor.sha !== value.readme.blobSha || proof.path !== value.readme.path || proof.commitSha !== value.commitSha || proof.repositoryId !== value.repository.id) throw new Error('Repository descriptor proof mismatch');
  const assets: CaptureAsset[] = [];
  async function stage(kind: CaptureAsset['kind'], mediaType: string, bytes: Uint8Array, localId?: string) {
    deps.signal.throwIfAborted(); const key = randomUUID();
    const stored = await deps.store.putImmutable(key, (async function* () { yield bytes; })(), Math.max(deps.config.captureLimits.maxTotalBytes, deps.config.captureLimits.maxIrBytes));
    assets.push({ ...stored, id: randomUUID(), key, kind, mediaType, localId });
  }
  for (const file of prepared.files) await stage('file', prepared.manifest.files.find(f => f.id === file.id)!.mediaType, file.bytes, file.id);
  await stage('manifest', 'application/json', prepared.manifestBytes); await stage('ir', 'application/json', Buffer.from(JSON.stringify(prepared.ir)));
  await stage('index', 'application/json', Buffer.from(JSON.stringify(prepared.build.index)));
  for (const chunk of prepared.build.chunks) await stage('chunk', 'application/json', Buffer.from(JSON.stringify(chunk)), chunk.id);
  return deps.db.transaction(async client => {
    await assertSourcePublication(client, lease); deps.signal.throwIfAborted();
    const request = (await client.query('SELECT translation_intent FROM source_requests WHERE owner_id=$1 AND job_id=$2', [lease.ownerId, lease.jobId])).rows[0];
    let row = (await client.query('SELECT id FROM web_captures WHERE owner_id=$1 AND fetch_job_id=$2', [lease.ownerId, lease.jobId])).rows[0];
    if (!row) {
      row = { id: randomUUID() };
      await insertWebCapture(client, { id: row.id, ownerId: lease.ownerId, authVersion: lease.authVersion, deviceId: null, sessionId: null, fetchJobId: lease.jobId, manifest: prepared.manifest, requestHash: createHash('sha256').update(prepared.manifestBytes).digest('hex'), targetDocumentId: lease.documentId, translationIntent: request.translation_intent, stagingKey: randomUUID() });
      await client.query(`UPDATE web_capture_files SET received_at=clock_timestamp(),received_sha256=descriptor->>'sha256',received_bytes=(descriptor->>'bytes')::bigint WHERE owner_id=$1 AND capture_id=$2`, [lease.ownerId, row.id]);
      await client.query("UPDATE web_captures SET status='validating' WHERE owner_id=$1 AND id=$2", [lease.ownerId, row.id]);
    }
    const capture = (await findWebCapture(client, lease.ownerId, row.id))!;
    if (capture.status !== 'completed') await publishCapture(client, deps.store, capture, prepared, assets, proof);
    else await assertGithubCapture(client, proof, capture.fetch_job_id, capture.target_document_id, capture.manifest.source.url);
    const completed = (await findWebCapture(client, lease.ownerId, row.id))!;
    const revisionId = await publishGithubRevision(client, lease, value, completed.source_version_id, { limits: deps.config.captureLimits, fingerprint: prepared.fingerprint });
    if (capture.status !== 'completed') {
      const jobId = await createCaptureJobScheduler()(client, { ownerId: lease.ownerId, authVersion: lease.authVersion, ingestionId: row.id, captureId: capture.capture_id, documentId: lease.documentId, sourceVersionId: completed.source_version_id!, readerVersionId: completed.reader_version_id!, translationIntent: request.translation_intent });
      if (jobId) await client.query('UPDATE web_captures SET job_id=$3 WHERE owner_id=$1 AND id=$2', [lease.ownerId, row.id, jobId]);
    }
    return { sourceVersionId: completed.source_version_id!, readerVersionId: completed.reader_version_id!, revisionId };
  });
}
