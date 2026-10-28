import { retireProviderIdentity } from '../source-adapters/receipts.js';
import type { PoolClient } from 'pg';
import type { Actor } from '../auth/guards.js';
import { assertActorCurrent } from '../auth/guards.js';
import type { Database } from '../db/database.js';
import { ServiceError } from '../errors.js';
import { lockDocument } from './guards.js';
import { identityDigest } from './retired-identities.js';
export interface PurgeRow { id: string; owner_id: string; document_id: string; lifecycle_epoch: string; status: 'queued' | 'running' | 'completed'; cursor: string | null; attempts: number; lease_owner: string | null; }
export const purgeReceipt = (row: PurgeRow) => ({ id: row.id, documentId: row.document_id, status: row.status === 'completed' ? 'completed' : 'processing' });
/** Caller holds owner then document locks. Tombstone is the irreversible restoration fence. */
export async function schedulePurge(client: PoolClient, owner: string, id: string): Promise<PurgeRow> {
  const old = (await client.query<PurgeRow>('SELECT * FROM document_purges WHERE owner_id=$1 AND document_id=$2', [owner,id])).rows[0];
  if (old) return old;
  const document = (await client.query('SELECT lifecycle_epoch,deleted_at FROM documents WHERE owner_id=$1 AND id=$2', [owner,id])).rows[0];
  if (!document) throw new ServiceError(404, 'NOT_FOUND', 'Document not found');
  if (!document.deleted_at) throw new ServiceError(409, 'DOCUMENT_NOT_TRASHED', 'Document must be in trash');
  await client.query(`INSERT INTO document_tombstones(owner_id,document_id,lifecycle_epoch,purged_at) VALUES($1,$2,$3,clock_timestamp())`, [owner,id,document.lifecycle_epoch]);
  const identities = (await client.query<{ kind: string; identity: string }>(`SELECT 'url' AS kind,source_url AS identity FROM documents WHERE owner_id=$1 AND id=$2 AND source_url IS NOT NULL
    UNION SELECT 'source-sha256',sha256 FROM source_versions WHERE owner_id=$1 AND document_id=$2`, [owner,id])).rows;
  for (const identity of identities) await client.query(`INSERT INTO retired_document_identities(owner_id,document_id,identity_kind,identity_digest,retired_at)
    SELECT owner_id,document_id,$3,$4,purged_at FROM document_tombstones WHERE owner_id=$1 AND document_id=$2 ON CONFLICT DO NOTHING`, [owner,id,identity.kind,identityDigest(identity.identity)]);
  await retireProviderIdentity(client,owner,id,'purge');
  await client.query('INSERT INTO document_cache_cleanup_state(owner_id,legacy_cache_cutoff) VALUES($1,clock_timestamp()) ON CONFLICT DO NOTHING',[owner]);
  // Only mutable document pointers are cleared. Historical source/Reader rows are never updated.
  await client.query(`UPDATE documents SET current_source_version_id=NULL,current_reader_version_id=NULL,current_web_reader_version_id=NULL,latest_web_source_version_id=NULL,requested_web_job_id=NULL,current_github_revision_id=NULL,current_arxiv_revision_id=NULL WHERE owner_id=$1 AND id=$2`, [owner,id]);
  return (await client.query<PurgeRow>('INSERT INTO document_purges(owner_id,document_id,lifecycle_epoch) VALUES($1,$2,$3) RETURNING *', [owner,id,document.lifecycle_epoch])).rows[0]!;
}
export async function requestDocumentPurge(db: Database, actor: Actor, id: string) {
  return db.transaction(async client => {
    await assertActorCurrent(client,actor); await lockDocument(client,actor.userId,id);
    return purgeReceipt(await schedulePurge(client,actor.userId,id));
  });
}
export async function listTrash(db: Database, actor: Actor, { limit = 50, cursor }: { limit?: number; cursor?: string }) {
  return db.transaction(async client => {
    await assertActorCurrent(client,actor);
    const rows = (await client.query(`SELECT d.id AS "documentId",d.title,d.kind,d.deleted_at AS "deletedAt",d.purge_after AS "purgeAfter",d.lifecycle_epoch AS "lifecycleEpoch",
      CASE WHEN p.id IS NULL THEN 'retained' ELSE 'processing' END AS status
      FROM documents d LEFT JOIN document_purges p ON (p.owner_id,p.document_id)=(d.owner_id,d.id)
      WHERE d.owner_id=$1 AND d.deleted_at IS NOT NULL AND ($2::uuid IS NULL OR d.id>$2) ORDER BY d.id LIMIT $3`, [actor.userId,cursor ?? null,limit+1])).rows;
    return { items: rows.slice(0,limit).map(row=>({ ...row,lifecycleEpoch:Number(row.lifecycleEpoch) })), nextCursor: rows.length>limit ? rows[limit-1]!.documentId : null };
  });
}

/** Caller owns the root group lock; each scheduled child clears one mutable document row. */
export async function scheduleAliasPurges(client: PoolClient, owner: string, root: string, budget: number): Promise<number> {
  if (budget<=0) return 0;
  const aliases=(await client.query<{document_id:string}>(`SELECT a.document_id FROM document_source_aliases a
    WHERE a.owner_id=$1 AND a.canonical_document_id=$2 AND a.resolution='alias'
    AND NOT EXISTS(SELECT 1 FROM document_purges p WHERE p.owner_id=a.owner_id AND p.document_id=a.document_id)
    ORDER BY a.document_id LIMIT $3`,[owner,root,budget])).rows;
  for(const alias of aliases) {
    await schedulePurge(client,owner,alias.document_id);
    await client.query('UPDATE document_purges SET group_document_id=$3 WHERE owner_id=$1 AND document_id=$2',[owner,alias.document_id,root]);
  }
  return aliases.length;
}
