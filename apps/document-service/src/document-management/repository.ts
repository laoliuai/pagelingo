import type { PoolClient } from 'pg';
import { documentOrganizationSchema, type DocumentKind, type SaveOrganization, type DocumentOrganization } from '@pagelingo/document-contracts';
import { ServiceError } from '../errors.js';
import { addRelation } from './relations.js';

export const notFound = () => new ServiceError(404, 'NOT_FOUND', 'Document or taxonomy item not found');
/** Owner lock is taken by the caller before this helper; read callers need no row lock. */
export async function assertDocumentActive(client: PoolClient, ownerId: string, documentId: string, expectedEpoch?: number): Promise<{epoch:number;kind:DocumentKind}> {
  const row = (await client.query<{lifecycle_epoch:string;kind:DocumentKind}>('SELECT lifecycle_epoch,kind FROM documents WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL', [ownerId,documentId])).rows[0];
  if (!row) {
    if ((await client.query('SELECT 1 FROM document_tombstones WHERE owner_id=$1 AND document_id=$2', [ownerId,documentId])).rowCount) throw new ServiceError(410, 'DOCUMENT_PURGED', 'Document was purged');
    throw notFound();
  }
  if (expectedEpoch !== undefined && Number(row.lifecycle_epoch) !== expectedEpoch) throw new ServiceError(409, 'DOCUMENT_EPOCH_CONFLICT', 'Document lifecycle changed');
  return { epoch: Number(row.lifecycle_epoch), kind: row.kind };
}
export async function assertTaxonomyOwned(client: PoolClient, ownerId: string, type: 'collections'|'tags', ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = (await client.query<{ id: string }>(`SELECT id FROM ${type} WHERE owner_id=$1 AND id=ANY($2::uuid[])`, [ownerId,ids])).rows;
  if (rows.length !== new Set(ids.map(id => id.toLowerCase())).size) throw notFound();
  const identities = new Map(rows.map(row => [row.id.toLowerCase(),row.id]));
  return ids.map(id => identities.get(id.toLowerCase())!);
}
export interface OrganizationHints { organization?: SaveOrganization; discoveredFromDocumentId?: string }
export async function assertSaveHintsOwned(client: PoolClient, ownerId: string, hints: OrganizationHints): Promise<OrganizationHints> {
  const result: OrganizationHints = {};
  if (hints.organization) {
    const collectionId = hints.organization.collectionId
      ? (await assertTaxonomyOwned(client, ownerId, 'collections', [hints.organization.collectionId]))[0]! : null;
    const tagIds = await assertTaxonomyOwned(client, ownerId, 'tags', hints.organization.tagIds);
    result.organization = { collectionId,tagIds };
  }
  if (hints.discoveredFromDocumentId) {
    await assertDocumentActive(client, ownerId, hints.discoveredFromDocumentId);
    result.discoveredFromDocumentId = (await client.query<{ id: string }>('SELECT id FROM documents WHERE owner_id=$1 AND id=$2', [ownerId,hints.discoveredFromDocumentId])).rows[0]!.id;
  }
  return result;
}
/** Accepted replay uses only the recorded, previously authorized identities, even after unlinking. */
export function replaySaveHints(input: OrganizationHints, recorded: OrganizationHints): OrganizationHints {
  const identity = (supplied: string, accepted?: string) => accepted && supplied.toLowerCase() === accepted.toLowerCase() ? accepted : supplied;
  return {
    ...(input.organization ? { organization: {
      collectionId: input.organization.collectionId === null ? null : identity(input.organization.collectionId,recorded.organization?.collectionId ?? undefined),
      tagIds: input.organization.tagIds.map((id,index) => identity(id,recorded.organization?.tagIds[index])),
    } } : {}),
    ...(input.discoveredFromDocumentId ? { discoveredFromDocumentId: identity(input.discoveredFromDocumentId,recorded.discoveredFromDocumentId) } : {}),
  };
}
/** Call only for a newly inserted document, in the same transaction. Never overwrites a save. */
export async function insertInitialOrganization(client: PoolClient, ownerId: string, documentId: string, hints: OrganizationHints = {}): Promise<void> {
  await assertSaveHintsOwned(client, ownerId, hints);
  const inserted = await client.query('INSERT INTO document_organization(owner_id,document_id,collection_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING document_id', [ownerId,documentId,hints.organization?.collectionId ?? null]);
  if (!inserted.rowCount) return;
  await replaceTags(client, ownerId, documentId, hints.organization?.tagIds ?? []);
  if (hints.discoveredFromDocumentId) await addRelation(client, ownerId, { fromDocumentId: documentId, toDocumentId: hints.discoveredFromDocumentId, kind: 'discovered-from' });
}
export async function replaceTags(client: PoolClient, ownerId: string, documentId: string, ids: string[]): Promise<void> {
  await client.query('DELETE FROM document_tags WHERE owner_id=$1 AND document_id=$2', [ownerId,documentId]);
  await client.query('INSERT INTO document_tags(owner_id,document_id,tag_id) SELECT $1,$2,unnest($3::uuid[])', [ownerId,documentId,ids]);
}
export async function organization(client: PoolClient, ownerId: string, documentId: string): Promise<DocumentOrganization> {
  await assertDocumentActive(client, ownerId, documentId);
  const row = (await client.query(`SELECT o.*,d.title,d.lifecycle_epoch,ARRAY(SELECT tag_id FROM document_tags t WHERE t.owner_id=o.owner_id AND t.document_id=o.document_id ORDER BY tag_id) AS tag_ids
    FROM document_organization o JOIN documents d ON (d.owner_id,d.id)=(o.owner_id,o.document_id) WHERE o.owner_id=$1 AND o.document_id=$2`, [ownerId,documentId])).rows[0];
  if (!row) throw notFound();
  return documentOrganizationSchema.parse({ documentId: row.document_id, revision: Number(row.revision), lifecycleEpoch: Number(row.lifecycle_epoch), title: row.title, collectionId: row.collection_id, tagIds: row.tag_ids, note: row.note, readingStatus: row.reading_status, updatedAt: row.updated_at.toISOString() });
}
