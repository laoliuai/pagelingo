import { readerSourceRevision } from './reader-revision.js';
import { sourceRevision } from './repository.js';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { DocumentLinkResult } from '@pagelingo/document-contracts';
import { canonicalManifestBytes } from '@pagelingo/web-capture';
import { assertActorCurrent, type Actor } from '../auth/guards.js';
import type { Database } from '../db/database.js';
import { assertDocumentActive, lockDocument } from '../document-lifecycle/guards.js';
import { ServiceError } from '../errors.js';
import { insertWebJob } from '../web-jobs/repository.js';
import { classifySourceUrl } from './url.js';
import { sourceRequestDigest } from './receipts.js';
import type { SourceDetails, SourceReference, SourceRefreshInput } from './types.js';
export const sourceRefreshSchema = z.strictObject({ ref: z.string().min(1).max(1024).optional(), translationIntent: z.enum(['auto','none']) });
function requestedReference(reference: SourceReference, ref?: string): SourceReference {
  if (ref === undefined) return reference;
  if (reference.provider === 'github') {
    if (/[\x00-\x20\x7f~^:?*\[\\]/.test(ref) || ref.includes('..') || ref.includes('@{') || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.') || ref.split('/').some(s => !s || s.startsWith('.') || s.endsWith('.lock'))) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid Git ref');
    return { ...reference, requestedRef: ref };
  }
  const parsed = classifySourceUrl(`https://arxiv.org/abs/${ref}`);
  if (!parsed || parsed.provider !== 'arxiv' || parsed.version === null || parsed.baseId !== reference.baseId) throw new ServiceError(400, 'INVALID_REQUEST', 'A version of this paper is required');
  return parsed;
}
/** Caller has authenticated the real session/device and locked its owner. No identity substitution. */
export async function admitSourceRequest(client: PoolClient, ownerId: string, authVersion: number, documentId: string, reference: SourceReference, input: SourceRefreshInput, key: string): Promise<DocumentLinkResult> {
  await lockDocument(client, ownerId, documentId);
  const active = await assertDocumentActive(client, ownerId, documentId);
  if (active.kind !== (reference.provider === 'github' ? 'repository' : 'paper')) throw new ServiceError(409, 'SOURCE_KIND_CONFLICT', 'Source document kind differs');
  if ((await client.query("SELECT 1 FROM retired_operations WHERE owner_id=$1 AND operation_kind='source-request' AND key_digest=$2", [ownerId, sourceRequestDigest(documentId, authVersion, key)])).rowCount) throw new ServiceError(410, 'DOCUMENT_PURGED', 'Source request was purged');
  const requested = requestedReference(reference, input.ref);
  const hash = createHash('sha256').update(canonicalManifestBytes({ reference: requested, translationIntent: input.translationIntent })).digest('hex');
  const previous = (await client.query('SELECT request_hash,job_id FROM source_requests WHERE owner_id=$1 AND document_id=$2 AND auth_version=$3 AND idempotency_key=$4', [ownerId,documentId,authVersion,key])).rows[0];
  if (previous) {
    if (previous.request_hash !== hash) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', 'Source request key was already used');
    return { documentId, jobId: previous.job_id };
  }
  if ((await client.query('SELECT 1 FROM document_source_aliases WHERE owner_id=$1 AND document_id=$2', [ownerId, documentId])).rowCount) throw new ServiceError(409, 'SOURCE_IDENTITY_CONFLICT', 'Refresh the canonical source explicitly');
  const job = await insertWebJob(client, { id: randomUUID(), ownerId, authVersion, documentId, kind: 'fetch-link', url: requested.url,
    inputSha256: createHash('sha256').update(canonicalManifestBytes({ sourceRequest: key.toLowerCase(), hash })).digest('hex') });
  await client.query('INSERT INTO source_requests(owner_id,document_id,auth_version,idempotency_key,job_id,request_hash,reference,translation_intent,original_url) SELECT $1,$2,$3,$4,$5,$6,$7,$8,source_url FROM documents WHERE owner_id=$1 AND id=$2', [ownerId,documentId,authVersion,key,job.id,hash,JSON.stringify(requested),input.translationIntent]);
  await client.query('UPDATE documents SET requested_web_job_id=$3 WHERE owner_id=$1 AND id=$2', [ownerId,documentId,job.id]);
  return { documentId, jobId: job.id };
}
export function createSourceAdaptersService({ db }: { db: Database }) {
  return {
    async refresh(actor: Actor, id: string, input: SourceRefreshInput, key: string): Promise<DocumentLinkResult> {
      const parsed = sourceRefreshSchema.safeParse(input);
      if (!parsed.success || !z.uuid().safeParse(key).success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid source refresh');
      return db.transaction(async client => {
        await assertActorCurrent(client, actor); await lockDocument(client, actor.userId, id); await assertDocumentActive(client, actor.userId, id);
        const row = (await client.query('SELECT id,source_url FROM documents WHERE owner_id=$1 AND id=$2', [actor.userId,id])).rows[0];
        const reference = classifySourceUrl(row.source_url);
        if (!reference) throw new ServiceError(400, 'UNSUPPORTED_SOURCE', 'Source is not supported');
        return admitSourceRequest(client, actor.userId, actor.authVersion, row.id, reference, parsed.data, key);
      });
    },
    async versions(actor: Actor,id: string,query: { limit?: number; cursor?: string }) {
      return db.transaction(async client => {
        await assertActorCurrent(client,actor); const active=await assertDocumentActive(client,actor.userId,id);
        const provider=active.kind==='repository' ? 'github' : active.kind==='paper' ? 'arxiv' : null;
        if (!provider) return {items:[],nextCursor:null};
        const table=provider==='github' ? 'github_versions' : 'arxiv_versions', limit=query.limit ?? 20;
        if (query.cursor && !(await client.query(`SELECT 1 FROM ${table} WHERE owner_id=$1 AND document_id=$2 AND id=$3`,[actor.userId,id,query.cursor])).rowCount) throw new ServiceError(404,'NOT_FOUND','Source cursor not found');
        const rows=(await client.query<{id:string}>(`SELECT id FROM ${table} WHERE owner_id=$1 AND document_id=$2 AND ($3::uuid IS NULL OR (captured_at,id)<(SELECT captured_at,id FROM ${table} WHERE owner_id=$1 AND document_id=$2 AND id=$3)) ORDER BY captured_at DESC,id DESC LIMIT $4`,[actor.userId,id,query.cursor ?? null,limit+1])).rows;
        const items=[]; for(const row of rows.slice(0,limit)) items.push((await sourceRevision(client,actor.userId,id,provider,row.id))!);
        return {items,nextCursor:rows.length>limit ? rows[limit-1]!.id : null};
      });
    },
    async details(actor: Actor, id: string, revisionId?: string, readerVersionId?: string): Promise<SourceDetails> {
      return db.transaction(async client => {
        await assertActorCurrent(client, actor); await assertDocumentActive(client, actor.userId, id);
        const d = (await client.query('SELECT * FROM documents WHERE owner_id=$1 AND id=$2', [actor.userId,id])).rows[0];
        const alias = (await client.query('SELECT resolution,canonical_document_id FROM document_source_aliases WHERE owner_id=$1 AND document_id=$2', [actor.userId,d.id])).rows[0];
        const job = (await client.query(`SELECT j.id,j.status,j.error_code,j.warnings,j.source_github_revision_id,j.source_arxiv_revision_id,r.reference FROM web_jobs j LEFT JOIN source_requests r ON(r.owner_id,r.job_id)=(j.owner_id,j.id)
          WHERE j.owner_id=$1 AND j.document_id=$2 AND j.kind='fetch-link' ORDER BY COALESCE(r.created_at,j.created_at) DESC,j.id DESC LIMIT 1`, [actor.userId,d.id])).rows[0];
        const ref = classifySourceUrl(d.source_url ?? '');
        const base: Omit<SourceDetails, 'kind' | 'current'> = { documentId: d.id, url: d.source_url ?? '', resolution: alias?.resolution ?? 'self', canonicalDocumentId: alias?.canonical_document_id ?? null, fetchJobId: job?.id ?? null,
          status: (job?.status === 'failed' ? 'fetch-failed' : 'link-only') as SourceDetails['status'], errorCode: job?.error_code ?? null, warnings: job?.warnings ?? [],
          latestAttempt: job ? { jobId: job.id, status: job.status, requestedRef: job.reference?.requestedRef ?? (job.reference?.version ? `${job.reference.baseId}v${job.reference.version}` : null), resolvedRevision: null, errorCode: job.error_code } : null };
        if (ref && d.kind === (ref.provider === 'github' ? 'repository' : 'paper')) {
          const binding = readerVersionId ? await readerSourceRevision(client, actor.userId, d.id, ref.provider, readerVersionId, revisionId) : null;
          const selected = binding ? binding.revisionId : revisionId ?? (ref.provider==='github' ? d.current_github_revision_id : d.current_arxiv_revision_id);
          if (binding?.warning) {
            base.warnings = [...base.warnings, binding.warning];
            base.status = 'source-saved'; // An owned Reader was verified even when its revision is unresolved.
          }
          const current = selected ? await sourceRevision(client,actor.userId,d.id,ref.provider,selected) : null;
          if (revisionId && !current) throw new ServiceError(404,'NOT_FOUND','Source revision not found');
          if (current) {
            const source = current.sourceVersionId && ref.provider === 'github' ? (await client.query('SELECT metadata FROM web_sources WHERE owner_id=$1 AND document_id=$2 AND source_version_id=$3', [actor.userId, d.id, current.sourceVersionId])).rows[0] : null;
            base.status = current.sourceVersionId ? source?.metadata.saveStatus === 'partial-resources' ? 'partial-resources' : 'source-saved' : 'metadata-saved'; base.errorCode=null;
          }
          if (current?.kind==='github' && current.readme && !current.sourceVersionId) base.warnings=[...base.warnings,'SOURCE_PREVIEW_UNAVAILABLE'];
          if (base.latestAttempt) base.latestAttempt.resolvedRevision=ref.provider==='github' ? job.source_github_revision_id : job.source_arxiv_revision_id;
          return { ...base, kind: ref.provider, current } as SourceDetails;
        }
        if (revisionId || readerVersionId) throw new ServiceError(404,'NOT_FOUND','Source revision not found');
        if (d.current_source_version_id) { base.status='source-saved'; base.errorCode=null; }
        return { ...base, kind: 'link' };
      });
    },
  };
}
export { runSourceFetchJob } from './dispatch.js';
