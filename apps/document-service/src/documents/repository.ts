import { assertDocumentActive } from '../document-lifecycle/guards.js';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { PdfDocumentSummary, PaperPdfDocumentSummary } from '@pagelingo/document-contracts';
import { ServiceError } from '../errors.js';
import type { StoredObject } from '../storage/object-store.js';
import { insertInitialOrganization, type OrganizationHints } from '../document-management/repository.js';
import { projectSelectedMetadata } from '../document-management/metadata-projection.js';

export interface DocumentRow {
  kind: 'pdf' | 'paper'; source_url: string | null; id: string; title: string; original_filename: string; created_at: Date;
  source_version_id: string; asset_id: string; sha256: string; bytes: string; object_key: string;
  reader_version_id: string | null; translation_status: NonNullable<PdfDocumentSummary['reader']>['translationStatus'];
  parse_coverage: NonNullable<PdfDocumentSummary['reader']>['parseCoverage']; reader_warnings: string[];
}
const documentSelect = `SELECT d.kind, d.source_url, d.id, d.title, d.original_filename, d.created_at,
  s.id AS source_version_id, s.asset_id, s.sha256, s.bytes, a.object_key,
  r.id AS reader_version_id,t.status AS translation_status,p.coverage AS parse_coverage,p.warnings AS reader_warnings
  FROM documents d JOIN source_versions s ON (s.owner_id, s.document_id, s.id) =
    (d.owner_id, d.id, d.current_source_version_id)
  JOIN assets a ON (a.owner_id, a.document_id, a.id) = (s.owner_id, s.document_id, s.asset_id)
  LEFT JOIN reader_versions r ON (r.owner_id,r.document_id,r.id)=(d.owner_id,d.id,d.current_reader_version_id) AND r.source_version_id=s.id
  LEFT JOIN translation_runs t ON (t.owner_id,t.id)=(r.owner_id,r.translation_id)
  LEFT JOIN parse_runs p ON (p.owner_id,p.id)=(r.owner_id,r.parse_id)`;
export function summary(row: DocumentRow): PdfDocumentSummary | PaperPdfDocumentSummary {
  return { id: row.id, ...(row.kind === 'paper' ? { kind: 'paper' as const, url: row.source_url! } : { kind: 'pdf' as const }), title: row.title, originalFilename: row.original_filename,
    createdAt: row.created_at.toISOString(), source: { documentId: row.id,
      sourceVersionId: row.source_version_id, assetId: row.asset_id, sha256: row.sha256, bytes: Number(row.bytes) },
    saveStatus: 'original-saved', reader: row.reader_version_id ? { versionId: row.reader_version_id, translationStatus: row.translation_status, parseCoverage: row.parse_coverage, warnings: row.reader_warnings } : null,
    processingStatus: row.reader_version_id ? 'reader-ready' : 'awaiting-local-processing' };
}
export async function findDocument(client: PoolClient, owner: string, id: string, byAsset = false, sourceVersionId?: string): Promise<DocumentRow> {
  let select = byAsset || sourceVersionId ? documentSelect.replace('(d.owner_id, d.id, d.current_source_version_id)', '(d.owner_id, d.id, s.id)') : documentSelect;
  if (byAsset) select = select
    .replace('d.original_filename,', "COALESCE((SELECT filename FROM source_acquisitions WHERE owner_id=d.owner_id AND document_id=d.id AND asset_id=a.id LIMIT 1),d.original_filename) AS original_filename,")
    .replace('s.asset_id, s.sha256, s.bytes,', 'a.id AS asset_id, a.sha256, a.bytes,')
    .replace('(a.owner_id, a.document_id, a.id) = (s.owner_id, s.document_id, s.asset_id)', `(a.owner_id,a.document_id)=(s.owner_id,s.document_id) AND (a.id=s.asset_id OR EXISTS(
      SELECT 1 FROM arxiv_versions v WHERE (v.owner_id,v.document_id,v.source_version_id,v.pdf_asset_id)=(s.owner_id,s.document_id,s.id,a.id)))`);
  const row = (await client.query<DocumentRow>(`${select} WHERE d.kind IN ('pdf','paper') AND a.media_type='application/pdf' AND d.deleted_at IS NULL AND d.owner_id=$1 AND ${byAsset ? 'a.id' : 'd.id'}=$2 ${sourceVersionId ? 'AND s.id=$3' : ''}`, sourceVersionId ? [owner, id, sourceVersionId] : [owner, id])).rows[0];
  if (!row) throw new ServiceError(404, 'NOT_FOUND', 'Document not found');
  await assertDocumentActive(client, owner, row.id);
  return row;
}
export async function findSamePdf(client: PoolClient, owner: string, sha256: string): Promise<DocumentRow | undefined> {
  return (await client.query<DocumentRow>(`${documentSelect} WHERE d.kind = 'pdf' AND d.owner_id = $1 AND s.sha256 = $2 ORDER BY d.created_at, d.id LIMIT 1`, [owner, sha256])).rows[0];
}
export async function listDocuments(client: PoolClient, owner: string, query: { q?: string; page: number; pageSize: number }) {
  const pattern = `%${(query.q ?? '').replace(/[\\%_]/g, value => `\\${value}`)}%`;
  const where = "d.kind = 'pdf' AND d.deleted_at IS NULL AND d.owner_id = $1 AND d.title ILIKE $2 ESCAPE '\\'";
  const count = await client.query<{ total: number }>(`SELECT count(*)::int AS total FROM documents d WHERE ${where}`, [owner, pattern]);
  const rows = await client.query<DocumentRow>(`${documentSelect} WHERE ${where} ORDER BY d.created_at DESC, d.id DESC LIMIT $3 OFFSET $4`, [owner, pattern, query.pageSize, (query.page - 1) * query.pageSize]);
  return { items: rows.rows.map(summary), total: count.rows[0]!.total, page: query.page, pageSize: query.pageSize };
}
export interface Ingestion { status: 'receiving' | 'completed' | 'failed'; epoch: string; request_hash: string; document_id: string | null; updated_at: Date }
export async function claimIngestion(client: PoolClient, owner: string, key: string): Promise<Ingestion> {
  const inserted = await client.query(`INSERT INTO ingestions (owner_id, idempotency_key, request_hash)
    VALUES ($1, $2, $3) ON CONFLICT (owner_id, idempotency_key) DO NOTHING RETURNING id`, [owner, key, '0'.repeat(64)]);
  const row = (await client.query<Ingestion>('SELECT * FROM ingestions WHERE owner_id = $1 AND idempotency_key = $2 FOR UPDATE', [owner, key])).rows[0]!;
  if (row.status === 'completed') return row;
  const claimed = await client.query<Ingestion>(`UPDATE ingestions SET status = 'receiving', epoch = epoch + 1, updated_at = now()
    WHERE owner_id = $1 AND idempotency_key = $2 AND
    (status = 'failed' OR updated_at < now() - interval '15 minutes' OR $3) RETURNING *`, [owner, key, inserted.rowCount === 1]);
  if (!claimed.rows[0]) throw new ServiceError(409, 'UPLOAD_IN_PROGRESS', 'Upload is already in progress', 1);
  return claimed.rows[0];
}
export async function lockIngestion(client: PoolClient, owner: string, key: string, epoch: string): Promise<Ingestion> {
  const row = (await client.query<Ingestion>('SELECT * FROM ingestions WHERE owner_id = $1 AND idempotency_key = $2 FOR UPDATE', [owner, key])).rows[0];
  if (!row || row.epoch !== epoch) throw new ServiceError(409, 'UPLOAD_SUPERSEDED', 'Upload has been superseded');
  return row;
}
export async function insertDocument(client: PoolClient, owner: string, input: { title: string; originalFilename: string; key: string; titleOrigin?: 'user'|'filename'|'source'; hints?: OrganizationHints } & StoredObject): Promise<DocumentRow> {
  const id = randomUUID(); const asset = randomUUID(); const source = randomUUID();
  await client.query('INSERT INTO documents (id, owner_id, title, original_filename) VALUES ($1,$2,$3,$4)', [id, owner, input.title, input.originalFilename]);
  await client.query("UPDATE documents SET origin='upload',title_origin=$3 WHERE owner_id=$1 AND id=$2", [owner,id,input.titleOrigin ?? 'source']);
  await insertInitialOrganization(client, owner, id, input.hints);
  await client.query(`INSERT INTO assets (id, owner_id, document_id, object_key, sha256, bytes, media_type)
    VALUES ($1,$2,$3,$4,$5,$6,'application/pdf')`, [asset, owner, id, input.key, input.sha256, input.bytes]);
  await client.query(`INSERT INTO source_versions (id, owner_id, document_id, asset_id, sha256, bytes)
    VALUES ($1,$2,$3,$4,$5,$6)`, [source, owner, id, asset, input.sha256, input.bytes]);
  await client.query('UPDATE documents SET current_source_version_id = $2 WHERE id = $1 AND owner_id = $3', [id, source, owner]);
  await projectSelectedMetadata(client, owner, id);
  return findDocument(client, owner, id);
}
/** Shared by reference publication and cleanup; never delete between stat and commit. */
export async function lockObjectPublication(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(204716, 2)');
}
