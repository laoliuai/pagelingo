import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Database } from '../db/database.js';
import type { ObjectStore } from '../storage/object-store.js';
import type { JobLease } from '../web-jobs/repository.js';
import { lockObjectPublication } from '../documents/repository.js';
import { insertWebAsset } from '../web-readers/repository.js';
import { assertSourcePublication } from './identity.js';
import type { SourceAssetInfo } from './types.js';
export interface SourceAcquisition extends SourceAssetInfo { id: string; objectKey: string; role: string; url: string }
async function load(client: PoolClient, lease: JobLease, role: string): Promise<SourceAcquisition | null> {
  const row = (await client.query(`SELECT s.*,a.object_key FROM source_acquisitions s JOIN assets a ON(a.owner_id,a.document_id,a.id)=(s.owner_id,s.document_id,s.asset_id)
    WHERE s.owner_id=$1 AND s.job_id=$2 AND s.role=$3`, [lease.ownerId,lease.jobId,role])).rows[0];
  return row ? { id: row.id, assetId: row.asset_id, objectKey: row.object_key, role: row.role, url: row.url, sha256: row.sha256, bytes: Number(row.bytes), mediaType: row.media_type, filename: row.filename } : null;
}
export async function loadSourceAcquisition(db: Database, lease: JobLease, role: string): Promise<SourceAcquisition | null> {
  return db.transaction(async client => { await assertSourcePublication(client,lease); return load(client,lease,role); });
}
/** Stream/hash outside SQL; register actual bytes under the current lease and publication lock. */
export async function acquireSourceMaterial(lease: JobLease, deps: { db: Database; store: ObjectStore; signal: AbortSignal }, input: { role: string; filename: string; mediaType: string; url: string; maxBytes: number; body: AsyncIterable<Uint8Array> }): Promise<SourceAcquisition> {
  const { db,store,signal } = deps; signal.throwIfAborted();
  if (!/^[a-z][a-z0-9-]{0,99}$/.test(input.role) || !input.filename || input.filename.length>255 || /[\x00-\x1f\x7f/\\]/.test(input.filename)) throw new Error('Invalid source material descriptor');
  const previous = await loadSourceAcquisition(db,lease,input.role); if (previous) return previous;
  const objectKey = randomUUID(), assetId = randomUUID();
  const body = (async function* () { for await (const chunk of input.body) { signal.throwIfAborted(); yield chunk; } })();
  const stored = await store.putImmutable(objectKey,body,input.maxBytes);
  try {
    return await db.transaction(async client => {
      await assertSourcePublication(client,lease); signal.throwIfAborted();
      const existing = await load(client,lease,input.role); if (existing) return existing;
      const total = (await client.query('SELECT COALESCE(sum(bytes),0)::text AS bytes FROM source_acquisitions WHERE owner_id=$1 AND job_id=$2', [lease.ownerId,lease.jobId])).rows[0];
      const provider = (await client.query('SELECT provider FROM document_source_identities WHERE owner_id=$1 AND document_id=$2', [lease.ownerId,lease.documentId])).rows[0].provider;
      if (provider === 'github' && Number(total.bytes)+stored.bytes>64*1024*1024) throw new Error('Source acquisition budget exceeded');
      await lockObjectPublication(client); if ((await store.stat(objectKey)).bytes !== stored.bytes) throw new Error('Missing source material');
      await insertWebAsset(client,{ id: assetId,ownerId: lease.ownerId,documentId: lease.documentId,objectKey,...stored,mediaType: input.mediaType });
      await client.query('INSERT INTO source_acquisitions(owner_id,document_id,auth_version,job_id,role,asset_id,sha256,bytes,media_type,filename,url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [lease.ownerId,lease.documentId,lease.authVersion,lease.jobId,input.role,assetId,stored.sha256,stored.bytes,input.mediaType,input.filename,input.url]);
      return (await load(client,lease,input.role))!;
    });
  } finally {
    await db.transaction(async client => { await lockObjectPublication(client); if (!(await client.query('SELECT 1 FROM assets WHERE object_key=$1',[objectKey])).rowCount) await store.deleteUnreferenced(objectKey); });
  }
}

export async function sourceAsset(client: PoolClient, ownerId: string, documentId: string, assetId: string) {
  return (await client.query<{ id: string; object_key: string; sha256: string; bytes: string; media_type: string; filename: string }>(`SELECT a.*,s.filename FROM assets a
    JOIN source_acquisitions s ON(s.owner_id,s.document_id,s.asset_id)=(a.owner_id,a.document_id,a.id)
    WHERE a.owner_id=$1 AND a.document_id=$2 AND a.id=$3 ORDER BY s.created_at,s.id LIMIT 1`, [ownerId,documentId,assetId])).rows[0];
}
export async function sourceRevision(client: PoolClient, ownerId: string, documentId: string, provider: 'github' | 'arxiv', id: string): Promise<import('./types.js').GithubSourceRevision | import('./types.js').ArxivSourceRevision | null> {
  const table = provider === 'github' ? 'github_versions' : 'arxiv_versions';
  const row = (await client.query(`SELECT * FROM ${table} WHERE owner_id=$1 AND document_id=$2 AND id=$3`,[ownerId,documentId,id])).rows[0];
  if (!row) return null;
  async function asset(assetId: string | null): Promise<SourceAssetInfo | null> {
    if (!assetId) return null;
    const a=await sourceAsset(client,ownerId,documentId,assetId); if (!a) throw new Error('Unregistered source revision material');
    return { assetId:a.id,sha256:a.sha256,bytes:Number(a.bytes),mediaType:a.media_type,filename:a.filename };
  }
  if (provider==='github') return { kind:'github',id:row.id,sourceVersionId:row.source_version_id,
    repository:{id:row.repository_id,owner:row.repository_owner,name:row.repository_name,description:row.description,url:row.canonical_url},commitSha:row.commit_sha,
    readme:row.raw_asset_id ? {path:row.readme_path,blobSha:row.blob_sha,raw:(await asset(row.raw_asset_id))!,renderedHtml:await asset(row.html_asset_id)} : null,capturedAt:row.captured_at.toISOString() };
  return {kind:'arxiv',id:row.id,baseId:row.base_id,version:row.version,title:row.title,authors:row.authors,summary:row.summary,publishedAt:row.published_at.toISOString(),updatedAt:row.updated_at.toISOString(),capturedAt:row.captured_at.toISOString(),sourceVersionId:row.source_version_id,pdf:await asset(row.pdf_asset_id)};
}
