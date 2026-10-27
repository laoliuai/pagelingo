import type { PoolClient } from 'pg';
import type { ParseCoverage, ReaderTranslationStatus } from '@pagelingo/document-contracts';
import { ServiceError } from '../errors.js';

export interface AssetRow { id: string; object_key: string; bytes: string; sha256: string; media_type: string }
export interface VersionRow {
  id: string; document_id: string; source_version_id: string; parse_id: string; created_at: Date;
  translation_status: ReaderTranslationStatus; parse_coverage: ParseCoverage; warnings: string[];
  source_asset_id: string; source_sha256: string; source_bytes: string;
  index_asset_id: string; ir_asset_id: string; archive_asset_id: string;
}
const selectVersion = `SELECT r.*, t.status AS translation_status,p.coverage AS parse_coverage,p.warnings,p.ir_asset_id,
  s.asset_id AS source_asset_id,s.sha256 AS source_sha256,s.bytes AS source_bytes
  FROM reader_versions r JOIN parse_runs p ON (p.owner_id,p.document_id,p.source_version_id,p.id)=(r.owner_id,r.document_id,r.source_version_id,r.parse_id)
  JOIN translation_runs t ON (t.owner_id,t.id)=(r.owner_id,r.translation_id)
  JOIN source_versions s ON (s.owner_id,s.document_id,s.id)=(r.owner_id,r.document_id,r.source_version_id)`;
export function notFound(): ServiceError { return new ServiceError(404, 'NOT_FOUND', 'Reader resource not found'); }
export async function findVersion(client: PoolClient, owner: string, documentId: string, versionId?: string): Promise<VersionRow> {
  const row = (await client.query<VersionRow>(`${selectVersion} WHERE r.owner_id=$1 AND r.document_id=$2 AND r.id=${versionId ? '$3' : '(SELECT current_reader_version_id FROM documents WHERE owner_id=$1 AND id=$2)'}`, versionId ? [owner, documentId, versionId] : [owner, documentId])).rows[0];
  if (!row) throw notFound();
  return row;
}
export async function listVersions(client: PoolClient, owner: string, documentId: string, page: number, pageSize: number) {
  const total = (await client.query<{ total: number }>('SELECT count(*)::int AS total FROM reader_versions WHERE owner_id=$1 AND document_id=$2', [owner, documentId])).rows[0]!.total;
  const rows = (await client.query<VersionRow>(`${selectVersion} WHERE r.owner_id=$1 AND r.document_id=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT $3 OFFSET $4`, [owner, documentId, pageSize, (page - 1) * pageSize])).rows;
  return { items: rows.map(row => ({ id: row.id, createdAt: row.created_at.toISOString(), sourceVersionId: row.source_version_id, parseId: row.parse_id, translationStatus: row.translation_status, parseCoverage: row.parse_coverage, warnings: row.warnings })), total, page, pageSize };
}
export async function findAsset(client: PoolClient, owner: string, documentId: string, assetId: string): Promise<AssetRow> {
  const row = (await client.query<AssetRow>('SELECT id,object_key,bytes,sha256,media_type FROM assets WHERE owner_id=$1 AND document_id=$2 AND id=$3', [owner, documentId, assetId])).rows[0];
  if (!row) throw notFound(); return row;
}
