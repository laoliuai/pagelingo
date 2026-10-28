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
  await client.query('SELECT id FROM documents WHERE owner_id=$1 AND id=$2 FOR UPDATE', [ownerId, documentId]);
}
