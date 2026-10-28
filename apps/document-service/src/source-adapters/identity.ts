import type { PoolClient } from 'pg';
import type { Database } from '../db/database.js';
import { assertJobLeaseCurrent, type JobLease } from '../web-jobs/repository.js';
import { lockDocuments, assertDocumentActive } from '../document-lifecycle/guards.js';
import { ServiceError } from '../errors.js';
import { providerIdentityDigest } from './receipts.js';
import { classifySourceUrl } from './url.js';
export interface ProviderIdentity { provider: 'github' | 'arxiv'; id: string }
/** Compare original SQL admission precision, including previously unknown renamed/version URLs. */
export async function assertSourceIdentityNotRetired(client: PoolClient, lease: JobLease, identity: ProviderIdentity): Promise<void> {
  if ((await client.query(`SELECT 1 FROM retired_document_identities t JOIN source_requests r ON r.owner_id=t.owner_id
    WHERE r.owner_id=$1 AND r.job_id=$2 AND t.identity_kind='source-provider' AND t.identity_digest=$3 AND r.created_at<=t.retired_at`, [lease.ownerId,lease.jobId,providerIdentityDigest(identity.provider,identity.id)])).rowCount) throw new ServiceError(409,'DOCUMENT_RETIRED','Source request predates retirement');
}
/** True minimum aliases carry no user organization, relations, retained bytes or pending uploads. */
async function isMinimal(client: PoolClient, owner: string, document: string): Promise<boolean> {
  return (await client.query(`SELECT d.title_origin<>'user' AND o.revision=0 AND o.collection_id IS NULL AND o.note='' AND o.reading_status='unread'
    AND NOT EXISTS(SELECT 1 FROM document_tags WHERE owner_id=$1 AND document_id=$2)
    AND NOT EXISTS(SELECT 1 FROM document_relations WHERE owner_id=$1 AND (from_document_id=$2 OR to_document_id=$2))
    AND NOT EXISTS(SELECT 1 FROM assets WHERE owner_id=$1 AND document_id=$2)
    AND NOT EXISTS(SELECT 1 FROM web_captures WHERE owner_id=$1 AND (document_id=$2 OR target_document_id=$2))
    AND NOT EXISTS(SELECT 1 FROM bundle_imports WHERE owner_id=$1 AND (document_id=$2 OR target_document_id=$2)) AS minimal
    FROM documents d JOIN document_organization o ON(o.owner_id,o.document_id)=(d.owner_id,d.id) WHERE d.owner_id=$1 AND d.id=$2`, [owner,document])).rows[0]?.minimal === true;
}
export async function resolveSourceIdentity(db: Database, lease: JobLease, identity: ProviderIdentity): Promise<{ resolution: 'self' | 'alias' | 'conflict'; canonicalDocumentId: string }> {
  if (lease.kind !== 'fetch-link' || (identity.provider === 'github' ? !/^[1-9]\d*$/.test(identity.id) : classifySourceUrl(`https://arxiv.org/abs/${identity.id}`)?.provider !== 'arxiv' || /v\d+$/.test(identity.id))) throw new ServiceError(400,'INVALID_SOURCE_IDENTITY','Invalid source identity');
  return db.transaction(async client => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [lease.ownerId]);
    const canonical = (await client.query('SELECT document_id FROM document_source_identities WHERE owner_id=$1 AND provider=$2 AND provider_id=$3', [lease.ownerId,identity.provider,identity.id])).rows[0];
    await lockDocuments(client,lease.ownerId,[lease.documentId,...(canonical ? [canonical.document_id as string] : [])]);
    await assertJobLeaseCurrent(client,lease);
    const request = (await client.query('SELECT reference FROM source_requests WHERE owner_id=$1 AND job_id=$2', [lease.ownerId,lease.jobId])).rows[0];
    if (!request || request.reference.provider !== identity.provider || (identity.provider === 'arxiv' && request.reference.baseId !== identity.id)) throw new ServiceError(409,'SOURCE_IDENTITY_CONFLICT','Source request identity mismatch');
    await assertSourceIdentityNotRetired(client,lease,identity);
    const existing = (await client.query('SELECT provider,provider_id FROM document_source_identities WHERE owner_id=$1 AND document_id=$2', [lease.ownerId,lease.documentId])).rows[0];
    if (existing && (existing.provider !== identity.provider || existing.provider_id !== identity.id)) throw new ServiceError(409,'SOURCE_IDENTITY_CONFLICT','Document already has another stable identity');
    const priorAlias = (await client.query('SELECT resolution,canonical_document_id FROM document_source_aliases WHERE owner_id=$1 AND document_id=$2', [lease.ownerId,lease.documentId])).rows[0];
    if (priorAlias) {
      if (priorAlias.canonical_document_id !== canonical?.document_id) throw new ServiceError(409,'SOURCE_IDENTITY_CONFLICT','Alias identity differs');
      return { resolution: priorAlias.resolution, canonicalDocumentId: priorAlias.canonical_document_id };
    }
    if (!canonical) {
      await client.query('INSERT INTO document_source_identities(owner_id,document_id,provider,provider_id) VALUES($1,$2,$3,$4)', [lease.ownerId,lease.documentId,identity.provider,identity.id]);
      return { resolution: 'self', canonicalDocumentId: lease.documentId };
    }
    if (canonical.document_id === lease.documentId) return { resolution: 'self', canonicalDocumentId: lease.documentId };
    await assertDocumentActive(client,lease.ownerId,canonical.document_id);
    const resolution = await isMinimal(client,lease.ownerId,lease.documentId) ? 'alias' : 'conflict';
    await client.query('INSERT INTO document_source_aliases(owner_id,document_id,canonical_document_id,resolution) VALUES($1,$2,$3,$4)', [lease.ownerId,lease.documentId,canonical.document_id,resolution]);
    return { resolution, canonicalDocumentId: canonical.document_id };
  });
}
/** Every publication rechecks both its lease and stable identity cutoff. */
export async function assertSourcePublication(client: PoolClient, lease: JobLease): Promise<void> {
  await assertJobLeaseCurrent(client,lease);
  const identity = (await client.query('SELECT provider,provider_id AS id FROM document_source_identities WHERE owner_id=$1 AND document_id=$2', [lease.ownerId,lease.documentId])).rows[0];
  if (!identity || (await client.query('SELECT 1 FROM document_source_aliases WHERE owner_id=$1 AND document_id=$2', [lease.ownerId,lease.documentId])).rowCount) throw new ServiceError(409,'SOURCE_IDENTITY_CONFLICT','Resolve a canonical source before acquisition');
  await assertSourceIdentityNotRetired(client,lease,identity);
}
