import type { PoolClient } from 'pg';
import type { DocumentKind } from '@pagelingo/document-contracts';
import { ServiceError } from '../errors.js';

/** Reads accept any retained version; continued operations require their admitted epoch. */
export async function assertDocumentActive(client: PoolClient, ownerId: string, documentId: string, expectedEpoch?: number): Promise<{ epoch: number; kind: DocumentKind }> {
  const row = (await client.query<{ lifecycle_epoch: string; kind: DocumentKind }>('SELECT lifecycle_epoch,kind FROM documents WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL', [ownerId, documentId])).rows[0];
  if (!row) {
    if (expectedEpoch !== undefined && (await client.query('SELECT 1 FROM document_tombstones WHERE owner_id=$1 AND document_id=$2', [ownerId, documentId])).rowCount) throw new ServiceError(410, 'DOCUMENT_PURGED', 'Document was purged');
    throw new ServiceError(404, 'NOT_FOUND', 'Document not found');
  }
  if (expectedEpoch !== undefined && Number(row.lifecycle_epoch) !== expectedEpoch) throw new ServiceError(409, 'DOCUMENT_EPOCH_CONFLICT', 'Document lifecycle changed');
  return { epoch: Number(row.lifecycle_epoch), kind: row.kind };
}
/** Call after acquiring the owner lock and before slot/job/object locks. */
export async function lockDocument(client: PoolClient, ownerId: string, documentId: string): Promise<void> {
  await lockDocuments(client,ownerId,[documentId]);
}
/** Hidden minimum aliases cannot acquire edits/material through another ingress route. */
export async function assertDocumentWritable(client: PoolClient, ownerId: string, documentId: string): Promise<void> {
  await assertDocumentActive(client,ownerId,documentId);
  if ((await client.query("SELECT 1 FROM document_source_aliases WHERE owner_id=$1 AND document_id=$2 AND resolution='alias'",[ownerId,documentId])).rowCount) throw new ServiceError(409,'SOURCE_IDENTITY_CONFLICT','Use the canonical document for edits');
}

/** Locks the complete union once, including siblings when entering through a minimum alias. */
export async function lockDocuments(client: PoolClient, ownerId: string, documentIds: string[]): Promise<void> {
  await client.query(`WITH roots AS (SELECT unnest($2::uuid[]) AS id UNION SELECT canonical_document_id FROM document_source_aliases
    WHERE owner_id=$1 AND document_id=ANY($2::uuid[]) AND resolution='alias')
    SELECT id FROM documents WHERE owner_id=$1 AND (id IN(SELECT id FROM roots) OR id IN
    (SELECT document_id FROM document_source_aliases WHERE owner_id=$1 AND canonical_document_id IN(SELECT id FROM roots) AND resolution='alias')) ORDER BY id FOR UPDATE`,[ownerId,documentIds]);
}

/** Fresh owner-scoped save admission only; ordinary reads and admitted work keep their fences. */
export async function assertDuplicateSaveActive(client: PoolClient, ownerId: string, documentId: string) {
  const row = (await client.query('SELECT deleted_at FROM documents WHERE owner_id=$1 AND id=$2', [ownerId, documentId])).rows[0];
  if (row?.deleted_at) throw new ServiceError(409, 'DOCUMENT_IN_TRASH', 'Restore this document from trash before saving it again');
  return assertDocumentActive(client, ownerId, documentId);
}
