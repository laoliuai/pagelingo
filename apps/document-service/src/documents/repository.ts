import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DocumentSummary } from '@pagelingo/document-contracts';
import { ServiceError } from '../errors.js';
import type { StoredObject } from '../storage/object-store.js';

export interface DocumentRow {
  id: string; title: string; original_filename: string; created_at: Date;
  source_version_id: string; asset_id: string; sha256: string; bytes: string; object_key: string;
}
const documentSelect = `SELECT d.id, d.title, d.original_filename, d.created_at,
  s.id AS source_version_id, s.asset_id, s.sha256, s.bytes, a.object_key
  FROM documents d JOIN source_versions s ON (s.owner_id, s.document_id, s.id) =
    (d.owner_id, d.id, d.current_source_version_id)
  JOIN assets a ON (a.owner_id, a.document_id, a.id) = (s.owner_id, s.document_id, s.asset_id)`;
export function summary(row: DocumentRow): DocumentSummary {
  return { id: row.id, kind: 'pdf', title: row.title, originalFilename: row.original_filename,
    createdAt: row.created_at.toISOString(), source: { documentId: row.id,
      sourceVersionId: row.source_version_id, assetId: row.asset_id, sha256: row.sha256, bytes: Number(row.bytes) },
    saveStatus: 'original-saved', reader: null, processingStatus: 'awaiting-local-processing' };
}
export async function findDocument(client: PoolClient, owner: string, id: string, byAsset = false): Promise<DocumentRow> {
  const row = (await client.query<DocumentRow>(`${documentSelect} WHERE d.owner_id = $1 AND ${byAsset ? 'a.id' : 'd.id'} = $2`, [owner, id])).rows[0];
  if (!row) throw new ServiceError(404, 'NOT_FOUND', 'Document not found');
  return row;
}
export async function findSamePdf(client: PoolClient, owner: string, sha256: string): Promise<DocumentRow | undefined> {
  return (await client.query<DocumentRow>(`${documentSelect} WHERE d.owner_id = $1 AND s.sha256 = $2 ORDER BY d.created_at, d.id LIMIT 1`, [owner, sha256])).rows[0];
}
export async function listDocuments(client: PoolClient, owner: string, query: { q?: string; page: number; pageSize: number }) {
  const pattern = `%${(query.q ?? '').replace(/[\\%_]/g, value => `\\${value}`)}%`;
  const where = "d.owner_id = $1 AND d.title ILIKE $2 ESCAPE '\\'";
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
export async function insertDocument(client: PoolClient, owner: string, input: { title: string; originalFilename: string; key: string } & StoredObject): Promise<DocumentRow> {
  const id = randomUUID(); const asset = randomUUID(); const source = randomUUID();
  await client.query('INSERT INTO documents (id, owner_id, title, original_filename) VALUES ($1,$2,$3,$4)', [id, owner, input.title, input.originalFilename]);
  await client.query(`INSERT INTO assets (id, owner_id, document_id, object_key, sha256, bytes, media_type)
    VALUES ($1,$2,$3,$4,$5,$6,'application/pdf')`, [asset, owner, id, input.key, input.sha256, input.bytes]);
  await client.query(`INSERT INTO source_versions (id, owner_id, document_id, asset_id, sha256, bytes)
    VALUES ($1,$2,$3,$4,$5,$6)`, [source, owner, id, asset, input.sha256, input.bytes]);
  await client.query('UPDATE documents SET current_source_version_id = $2 WHERE id = $1 AND owner_id = $3', [id, source, owner]);
  return findDocument(client, owner, id);
}
/** Shared by reference publication and cleanup; never delete between stat and commit. */
export async function lockObjectPublication(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(204716, 2)');
}
