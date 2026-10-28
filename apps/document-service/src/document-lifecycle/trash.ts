import { retireProviderIdentity } from '../source-adapters/receipts.js';
import type { ObjectStore } from '../storage/object-store.js';
import { restoreDocument } from './restore.js';
import { requestDocumentPurge, listTrash } from './repository.js';
import type { Actor } from '../auth/guards.js';
import { assertActorCurrent } from '../auth/guards.js';
import type { Database } from '../db/database.js';
import { assertDocumentActive, lockDocument } from './guards.js';
import { identityDigest } from './retired-identities.js';
export function createDocumentLifecycleService({ db, store }: { db: Database; store: ObjectStore }) {
  return {
    restoreDocument: (actor: Actor, id: string, expectedEpoch: number) => restoreDocument({ db,store },actor,id,expectedEpoch),
    requestDocumentPurge: (actor: Actor, id: string) => requestDocumentPurge(db,actor,id),
    listTrash: (actor: Actor, query: { limit?: number; cursor?: string }) => listTrash(db,actor,query),
    async trashDocument(actor: Actor, id: string, expectedEpoch: number) {
      return db.transaction(async client => {
        await assertActorCurrent(client, actor); await lockDocument(client, actor.userId, id);
        await assertDocumentActive(client, actor.userId, id, expectedEpoch);
        const rootId = (await client.query<{ id: string }>('SELECT id FROM documents WHERE owner_id=$1 AND id=$2', [actor.userId,id])).rows[0]!.id;
        const group = (await client.query<{ id: string }>(`SELECT id FROM documents WHERE owner_id=$1 AND deleted_at IS NULL AND (id=$2 OR id IN
          (SELECT document_id FROM document_source_aliases WHERE owner_id=$1 AND canonical_document_id=$2 AND resolution='alias')) ORDER BY id`,[actor.userId,rootId])).rows;
        let root: { documentId: string; lifecycleEpoch: number; deletedAt: string; purgeAfter: string } | undefined;
        for (const member of group) {
          const memberId = member.id;
          const identities = (await client.query<{ kind: 'url' | 'source-sha256'; identity: string }>(`SELECT 'url' AS kind,source_url AS identity FROM documents WHERE owner_id=$1 AND id=$2 AND source_url IS NOT NULL
            UNION SELECT 'source-sha256',sha256 FROM source_versions WHERE owner_id=$1 AND document_id=$2`, [actor.userId, memberId])).rows;
          const deleted = (await client.query(`WITH retirement AS MATERIALIZED (SELECT clock_timestamp() AS at)
            UPDATE documents SET deleted_at=retirement.at,purge_after=retirement.at+interval '30 days',lifecycle_epoch=lifecycle_epoch+1,requested_web_job_id=NULL
            FROM retirement WHERE owner_id=$1 AND id=$2 RETURNING id,lifecycle_epoch,deleted_at,purge_after`, [actor.userId, memberId])).rows[0];
          for (const identity of identities) await client.query(`INSERT INTO retired_document_identities(owner_id,document_id,identity_kind,identity_digest,retired_at)
            SELECT owner_id,id,$3,$4,deleted_at FROM documents WHERE owner_id=$1 AND id=$2`, [actor.userId,memberId,identity.kind,identityDigest(identity.identity)]);
          await client.query('SELECT id FROM web_worker_slots WHERE owner_id=$1 AND job_id IN (SELECT id FROM web_jobs WHERE owner_id=$1 AND document_id=$2) ORDER BY id FOR UPDATE', [actor.userId,memberId]);
          await client.query(`UPDATE web_worker_slots SET epoch=epoch+1,owner_id=NULL,job_id=NULL,lease_owner=NULL,lease_until=NULL
            WHERE owner_id=$1 AND job_id IN (SELECT id FROM web_jobs WHERE owner_id=$1 AND document_id=$2)`, [actor.userId,memberId]);
          await client.query(`UPDATE web_jobs SET status=CASE WHEN status IN ('queued','running') THEN 'cancelled' ELSE status END,epoch=epoch+1,finalized_epoch=epoch+1,
            lease_owner=NULL,lease_until=NULL,slot_id=NULL,slot_epoch=NULL,error_code='DOCUMENT_RETIRED',updated_at=clock_timestamp() WHERE owner_id=$1 AND document_id=$2`, [actor.userId,memberId]);
          for (const table of ['bundle_imports','web_captures']) await client.query(`UPDATE ${table} SET status='cancelled',epoch=epoch+1,error_code='DOCUMENT_RETIRED',updated_at=clock_timestamp()
            WHERE owner_id=$1 AND target_document_id=$2 AND status IN ('created','receiving','validating','failed')`, [actor.userId,memberId]);
          await retireProviderIdentity(client,actor.userId,memberId,'trash');
          if (memberId!==rootId) await client.query('UPDATE documents SET source_trash_parent_id=$3 WHERE owner_id=$1 AND id=$2',[actor.userId,memberId,rootId]);
          if (memberId===rootId) root = { documentId: deleted.id, lifecycleEpoch: Number(deleted.lifecycle_epoch), deletedAt: deleted.deleted_at.toISOString(), purgeAfter: deleted.purge_after.toISOString() };
        }
        return root!;
      });
    },
  };
}
