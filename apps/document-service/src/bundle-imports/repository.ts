import { assertOperationNotRetired } from '../document-lifecycle/retired-identities.js';
import { assertDocumentActive, lockDocument } from '../document-lifecycle/guards.js';
import type { PoolClient } from 'pg';
import type { BundleImport, BundleImportStatus, CreateBundleImportRequest } from '@pagelingo/document-contracts';
import { findDocument } from '../documents/repository.js';
import { ServiceError } from '../errors.js';
export interface ImportRow {
  id: string; owner_id: string; status: BundleImportStatus; epoch: string; target_document_id: string | null; document_epoch: string | null;
  target_source_version_id: string | null; target_arxiv_version_id: string | null;
  admitted_request: CreateBundleImportRequest | null; warnings: string[];
  request_hash: string; document_id: string | null; reader_version_id: string | null;
  error_code: string | null; created_at: Date; updated_at: Date; staging_key: string | null;
}
export function importView(row: ImportRow): BundleImport {
  return { id: row.id, status: row.status, epoch: Number(row.epoch),
    ...(row.document_id ? { documentId: row.document_id } : {}),
    ...(row.reader_version_id ? { readerVersionId: row.reader_version_id } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.warnings?.length ? { warnings: row.warnings } : {}),
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

/** Resolve admitted targets from owned rows, never infer an arXiv version from source bytes. */
export async function resolveBundleTarget(client: PoolClient, owner: string, input: CreateBundleImportRequest) {
  if (!input.targetDocumentId) return undefined;
  const active = await assertDocumentActive(client, owner, input.targetDocumentId);
  let sourceId = input.targetSourceVersionId, paperId: string | undefined;
  if (active.kind === 'paper') {
    if (input.targetPaperVersion === undefined) throw new ServiceError(400, 'INVALID_REQUEST', 'Paper version required');
    if (input.targetPaperVersion > 2147483647) throw conflict('BUNDLE_SOURCE_CONFLICT');
    const paper = (await client.query('SELECT id,source_version_id FROM arxiv_versions WHERE owner_id=$1 AND document_id=$2 AND version=$3 AND source_version_id IS NOT NULL', [owner, input.targetDocumentId, input.targetPaperVersion])).rows[0];
    if (!paper || (sourceId && sourceId.toLowerCase() !== paper.source_version_id)) throw conflict('BUNDLE_SOURCE_CONFLICT');
    sourceId = paper.source_version_id; paperId = paper.id;
  } else if (input.targetPaperVersion !== undefined) throw new ServiceError(400, 'INVALID_REQUEST', 'Paper version requires a paper');
  const document = await findDocument(client, owner, input.targetDocumentId, false, sourceId);
  return { document, sourceId: sourceId ? document.source_version_id : null, paperId: paperId ?? null };
}
