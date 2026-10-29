import type { PoolClient } from 'pg';
import type { WebExport } from '@pagelingo/document-contracts';
export interface WebExportRow {
  id: string; owner_id: string; document_id: string; auth_version: number; document_epoch: string;
  idempotency_key: string; job_id: string; reader_version_id: string; source_version_id: string; parse_id: string;
  package_id: string; title: string; renderer_version: string; renderer_sha256: string;
  asset_id: string | null; expires_at: Date | null; created_at: Date;
  status: WebExport['status']; error_code: string | null; bytes: string | null; sha256: string | null; object_key: string | null;
}
export async function findExport(client: PoolClient, owner: string, document: string, id: string) {
  return (await client.query<WebExportRow>(`SELECT e.*, a.bytes,a.sha256,a.object_key,
    CASE WHEN e.expires_at<=clock_timestamp() THEN 'expired' WHEN j.status='paused-config' THEN 'cancelled' ELSE j.status END AS status,j.error_code
    FROM web_exports e JOIN web_jobs j ON(j.owner_id,j.id)=(e.owner_id,e.job_id)
    LEFT JOIN assets a ON(a.owner_id,a.document_id,a.id)=(e.owner_id,e.document_id,e.asset_id)
    WHERE e.owner_id=$1 AND e.document_id=$2 AND e.id=$3`, [owner,document,id])).rows[0];
}
export function exportView(row: WebExportRow): WebExport {
  return { id: row.id, packageId: row.package_id, documentId: row.document_id, readerVersionId: row.reader_version_id,
    status: row.status, bytes: row.bytes === null ? null : Number(row.bytes), sha256: row.sha256,
    expiresAt: row.expires_at?.toISOString() ?? null, errorCode: row.error_code };
}
