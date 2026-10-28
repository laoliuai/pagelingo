import { assertOperationNotRetired } from '../document-lifecycle/retired-identities.js';
import { assertDocumentActive, lockDocument } from '../document-lifecycle/guards.js';
import type { PoolClient } from 'pg';
import type { BundleImport, BundleImportStatus } from '@pagelingo/document-contracts';
import { ServiceError } from '../errors.js';
export interface ImportRow {
  id: string; owner_id: string; status: BundleImportStatus; epoch: string; target_document_id: string | null; document_epoch: string | null;
  request_hash: string; document_id: string | null; reader_version_id: string | null;
  error_code: string | null; created_at: Date; updated_at: Date; staging_key: string | null;
}
export function importView(row: ImportRow): BundleImport {
  return { id: row.id, status: row.status, epoch: Number(row.epoch),
    ...(row.document_id ? { documentId: row.document_id } : {}),
    ...(row.reader_version_id ? { readerVersionId: row.reader_version_id } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
export function conflict(code = 'BUNDLE_IMPORT_CONFLICT'): ServiceError { return new ServiceError(409, code, 'Bundle import conflicts with current state'); }
export async function expireImports(client: PoolClient, owner?: string): Promise<void> {
  await client.query(`UPDATE bundle_imports SET status='failed', error_code='BUNDLE_LEASE_EXPIRED', updated_at=now()
    WHERE status IN ('created','receiving','validating') AND heartbeat_at < now() - interval '15 minutes'
    ${owner ? 'AND owner_id=$1' : ''}`, owner ? [owner] : []);
}
export async function lockImport(client: PoolClient, owner: string, id: string, epoch?: string): Promise<ImportRow> {
  await assertOperationNotRetired(client, owner, 'bundle-import-id', id);
  const target = (await client.query<ImportRow>('SELECT * FROM bundle_imports WHERE owner_id=$1 AND id=$2', [owner,id])).rows[0];
  if (target?.target_document_id) {
    await lockDocument(client, owner, target.target_document_id);
    if (epoch !== undefined || target.status !== 'completed') await assertDocumentActive(client, owner, target.target_document_id, Number(target.document_epoch));
  }
  const row = (await client.query<ImportRow>('SELECT * FROM bundle_imports WHERE owner_id=$1 AND id=$2 FOR UPDATE', [owner, id])).rows[0];
  if (!row) throw new ServiceError(404, 'NOT_FOUND', 'Bundle import not found');
  if (epoch !== undefined && (row.epoch !== epoch || !['receiving', 'validating'].includes(row.status))) throw conflict('BUNDLE_IMPORT_SUPERSEDED');
  return row;
}
