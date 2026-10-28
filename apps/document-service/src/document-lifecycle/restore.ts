import { createHash } from 'node:crypto';
import type { Actor } from '../auth/guards.js';
import { assertActorCurrent } from '../auth/guards.js';
import type { Database } from '../db/database.js';
import type { ObjectStore } from '../storage/object-store.js';
import { ServiceError } from '../errors.js';
import { lockDocument } from './guards.js';
import { retainedAssetReferences } from './purge-plan.js';
import type { PoolClient } from 'pg';

async function assertRestorable(client: PoolClient, owner: string, id: string, epoch: number) {
  const row = (await client.query('SELECT lifecycle_epoch,deleted_at FROM documents WHERE owner_id=$1 AND id=$2', [owner,id])).rows[0];
  if (!row) throw new ServiceError(404, 'NOT_FOUND', 'Document not found');
  if (!row.deleted_at || Number(row.lifecycle_epoch) !== epoch) throw new ServiceError(409, 'DOCUMENT_EPOCH_CONFLICT', 'Document lifecycle changed');
  if ((await client.query("SELECT 1 FROM document_purges WHERE owner_id=$1 AND (document_id=$2 OR document_id IN (SELECT canonical_document_id FROM document_source_aliases WHERE owner_id=$1 AND document_id=$2 AND resolution='alias'))", [owner,id])).rowCount) throw new ServiceError(409, 'DOCUMENT_PURGING', 'Document cleanup has started');
  if ((await client.query("SELECT 1 FROM document_source_aliases a JOIN documents d ON(d.owner_id,d.id)=(a.owner_id,a.canonical_document_id) WHERE a.owner_id=$1 AND a.document_id=$2 AND a.resolution='alias' AND d.deleted_at IS NOT NULL",[owner,id])).rowCount) throw new ServiceError(409,'SOURCE_IDENTITY_CONFLICT','Restore the canonical document with its aliases');
}
export async function restoreDocument({ db, store }: { db: Database; store: ObjectStore }, actor: Actor, id: string, expectedEpoch: number) {
  const materials = await db.transaction(async client => {
    await assertActorCurrent(client, actor); await lockDocument(client, actor.userId, id);
    await assertRestorable(client, actor.userId, id, expectedEpoch);
    const references = retainedAssetReferences.flatMap(({ table,columns }) => columns.map(column =>
      `SELECT ${column} AS asset_id FROM ${table} WHERE owner_id=$1 AND document_id=$2`)).join(' UNION ALL ');
    return (await client.query<{ object_key: string; sha256: string; bytes: string }>(`SELECT object_key,sha256,bytes FROM assets
      WHERE owner_id=$1 AND document_id=$2 AND id IN (${references}) ORDER BY id`, [actor.userId,id])).rows;
  });
  // Deleted epochs cannot publish new assets. Immutable material stays unchanged until purge,
  // whose durable receipt makes the final CAS fail even before its first deletion batch.
  try {
    for (const material of materials) {
      let bytes = 0; const hash = createHash('sha256');
      for await (const chunk of store.read(material.object_key)) {
        bytes += chunk.byteLength;
        if (bytes > Number(material.bytes)) throw new Error('Material length mismatch');
        hash.update(chunk);
      }
      if (bytes !== Number(material.bytes) || hash.digest('hex') !== material.sha256) throw new Error('Material hash mismatch');
    }
  } catch { throw new ServiceError(409, 'RESTORE_MATERIAL_UNAVAILABLE', 'Retained material is missing or corrupt'); }
  return db.transaction(async client => {
    await assertActorCurrent(client, actor); await lockDocument(client, actor.userId, id);
    await assertRestorable(client, actor.userId, id, expectedEpoch);
    const members = (await client.query<{ id: string }>('SELECT id FROM documents WHERE owner_id=$1 AND source_trash_parent_id=$2 AND deleted_at IS NOT NULL ORDER BY id',[actor.userId,id])).rows;
    for (const member of members) {
      if ((await client.query("SELECT 1 FROM document_purges WHERE owner_id=$1 AND (document_id=$2 OR document_id IN (SELECT canonical_document_id FROM document_source_aliases WHERE owner_id=$1 AND document_id=$2 AND resolution='alias'))",[actor.userId,member.id])).rowCount) throw new ServiceError(409,'DOCUMENT_PURGING','Alias cleanup has started');
      await client.query('UPDATE documents SET deleted_at=NULL,purge_after=NULL,source_trash_parent_id=NULL,lifecycle_epoch=lifecycle_epoch+1 WHERE owner_id=$1 AND id=$2',[actor.userId,member.id]);
    }
    const row = (await client.query('UPDATE documents SET deleted_at=NULL,purge_after=NULL,lifecycle_epoch=lifecycle_epoch+1 WHERE owner_id=$1 AND id=$2 RETURNING lifecycle_epoch', [actor.userId,id])).rows[0];
    return { documentId: id, lifecycleEpoch: Number(row.lifecycle_epoch) };
  });
}
