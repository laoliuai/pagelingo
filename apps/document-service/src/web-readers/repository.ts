import type { PoolClient } from 'pg';
import { insertInitialOrganization, type OrganizationHints } from '../document-management/repository.js';
import { documentOrigin, projectSelectedMetadata } from '../document-management/metadata-projection.js';
import { webReadingPositionSchema, type CaptureFile, type CaptureScope, type ReaderTranslationStatus, type WebReadingPosition, type WebReadingProgress } from '@pagelingo/document-contracts';

export interface WebDocumentInput { id: string; ownerId: string; kind: 'article' | 'x-post' | 'repository' | 'paper'; title: string; url: string; titleOrigin?: 'user'|'url'|'source'; hints?: OrganizationHints }
export interface WebAssetInput { id: string; ownerId: string; documentId: string; objectKey: string; sha256: string; bytes: number; mediaType: string }
export interface WebSourceInput {
  ownerId: string; documentId: string; sourceVersionId: string; manifestAssetId: string; sha256: string; bytes: number;
  snapshotSha256: string; url: string; scope: CaptureScope; contentFingerprint: string; metadata: Record<string, unknown>;
}
export interface WebParseInput { ownerId: string; documentId: string; sourceVersionId: string; parseId: string; irAssetId: string; irSha256: string }
export interface WebTranslationInput { id: string; ownerId: string; documentId: string; sourceVersionId: string; parseId: string; jobId: string | null; generationKind?: 'model' | 'import'; translationAssetId: string; sha256: string }
export interface WebReaderVersionInput {
  id: string; ownerId: string; documentId: string; sourceVersionId: string; parseId: string; translationId: string | null;
  indexAssetId: string; translationStatus: ReaderTranslationStatus; warnings: string[];
}
export interface WebReaderVersionRow {
  id: string; owner_id: string; document_id: string; source_version_id: string; parse_id: string; translation_id: string | null;
  index_asset_id: string; translation_status: ReaderTranslationStatus; warnings: string[]; created_at: Date;
}
export interface WebAssetRow { id: string; object_key: string; sha256: string; bytes: string; media_type: string }
export async function insertWebDocument(client: PoolClient, input: WebDocumentInput): Promise<void> {
  await client.query('INSERT INTO documents (id,owner_id,kind,title,source_url) VALUES ($1,$2,$3,$4,$5)', [input.id,input.ownerId,input.kind,input.title,input.url]);
  await client.query('UPDATE documents SET origin=$3,title_origin=$4 WHERE owner_id=$1 AND id=$2', [input.ownerId,input.id,documentOrigin(input.url,input.kind),input.titleOrigin ?? 'source']);
  await insertInitialOrganization(client,input.ownerId,input.id,input.hints);
  await projectSelectedMetadata(client,input.ownerId,input.id);
}
export async function insertWebAsset(client: PoolClient, input: WebAssetInput): Promise<void> {
  await client.query('INSERT INTO assets (id,owner_id,document_id,object_key,sha256,bytes,media_type) VALUES ($1,$2,$3,$4,$5,$6,$7)', [input.id,input.ownerId,input.documentId,input.objectKey,input.sha256,input.bytes,input.mediaType]);
}
/** Manifest SHA/bytes are the actual stored object's identity, enforced by the S2 asset FK. */
export async function insertWebSource(client: PoolClient, input: WebSourceInput): Promise<void> {
  await client.query('INSERT INTO source_versions (id,owner_id,document_id,asset_id,sha256,bytes) VALUES ($1,$2,$3,$4,$5,$6)', [input.sourceVersionId,input.ownerId,input.documentId,input.manifestAssetId,input.sha256,input.bytes]);
  await client.query(`INSERT INTO web_sources (owner_id,document_id,source_version_id,url,scope,content_fingerprint,snapshot_sha256,metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [input.ownerId,input.documentId,input.sourceVersionId,input.url,JSON.stringify(input.scope),input.contentFingerprint,input.snapshotSha256,JSON.stringify(input.metadata)]);
}
export async function registerWebSourceFile(client: PoolClient, input: { ownerId: string; documentId: string; sourceVersionId: string; id: string; path: string; role: CaptureFile['role']; assetId: string }): Promise<void> {
  await client.query('INSERT INTO web_source_files (owner_id,document_id,source_version_id,id,path,role,asset_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [input.ownerId,input.documentId,input.sourceVersionId,input.id,input.path,input.role,input.assetId]);
}
export async function insertWebParse(client: PoolClient, input: WebParseInput): Promise<void> {
  await client.query('INSERT INTO web_parse_runs (owner_id,document_id,source_version_id,id,ir_asset_id,ir_sha256) VALUES ($1,$2,$3,$4,$5,$6)', [input.ownerId,input.documentId,input.sourceVersionId,input.parseId,input.irAssetId,input.irSha256]);
}
export async function insertWebTranslation(client: PoolClient, input: WebTranslationInput): Promise<void> {
  await client.query('INSERT INTO web_translation_runs (id,owner_id,document_id,source_version_id,parse_id,job_id,translation_asset_id,sha256,generation_kind) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [input.id,input.ownerId,input.documentId,input.sourceVersionId,input.parseId,input.jobId,input.translationAssetId,input.sha256,input.generationKind ?? 'model']);
}
export async function insertWebReaderVersion(client: PoolClient, input: WebReaderVersionInput): Promise<void> {
  await client.query(`INSERT INTO web_reader_versions (id,owner_id,document_id,source_version_id,parse_id,translation_id,index_asset_id,translation_status,warnings)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [input.id,input.ownerId,input.documentId,input.sourceVersionId,input.parseId,input.translationId,input.indexAssetId,input.translationStatus,JSON.stringify(input.warnings)]);
}
export async function insertWebReaderChunk(client: PoolClient, input: { ownerId: string; documentId: string; readerVersionId: string; id: string; dataAssetId: string }): Promise<void> {
  await client.query('INSERT INTO web_reader_chunks (owner_id,document_id,reader_version_id,id,data_asset_id) VALUES ($1,$2,$3,$4,$5)', [input.ownerId,input.documentId,input.readerVersionId,input.id,input.dataAssetId]);
}
export async function registerWebReaderAsset(client: PoolClient, input: { ownerId: string; documentId: string; readerVersionId: string; localId: string; assetId: string }): Promise<void> {
  await client.query('INSERT INTO web_reader_assets (owner_id,document_id,reader_version_id,local_id,asset_id) VALUES ($1,$2,$3,$4,$5)', [input.ownerId,input.documentId,input.readerVersionId,input.localId,input.assetId]);
}
export async function setLatestWebSource(client: PoolClient, ownerId: string, documentId: string, sourceId: string): Promise<void> {
  await client.query("UPDATE documents SET latest_web_source_version_id=$3,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2 AND kind IN ('article','x-post','repository')", [ownerId,documentId,sourceId]);
}
/** Caller applies promotion policy while holding user -> document -> publication lock. */
export async function setCurrentWebReader(client: PoolClient, ownerId: string, documentId: string, sourceId: string, readerId: string): Promise<void> {
  await client.query("UPDATE documents SET current_source_version_id=$3,current_web_reader_version_id=$4,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2 AND kind IN ('article','x-post','repository')", [ownerId,documentId,sourceId,readerId]);
  await projectSelectedMetadata(client,ownerId,documentId);
}
export async function findWebReaderVersion(client: PoolClient, ownerId: string, documentId: string, versionId?: string): Promise<WebReaderVersionRow | undefined> {
  return (await client.query<WebReaderVersionRow>(`SELECT r.* FROM web_reader_versions r JOIN documents d ON (d.owner_id,d.id)=(r.owner_id,r.document_id)
    WHERE r.owner_id=$1 AND r.document_id=$2 AND r.id=COALESCE($3::uuid,d.current_web_reader_version_id)`, [ownerId,documentId,versionId ?? null])).rows[0];
}
export async function listWebReaderVersions(client: PoolClient, ownerId: string, documentId: string): Promise<WebReaderVersionRow[]> {
  return (await client.query<WebReaderVersionRow>('SELECT * FROM web_reader_versions WHERE owner_id=$1 AND document_id=$2 ORDER BY created_at DESC,id DESC', [ownerId,documentId])).rows;
}
export async function findWebSourceFile(client: PoolClient, ownerId: string, documentId: string, sourceId: string, fileId: string): Promise<WebAssetRow | undefined> {
  return (await client.query<WebAssetRow>(`SELECT a.id,a.object_key,a.sha256,a.bytes,a.media_type FROM web_source_files f JOIN assets a ON (a.owner_id,a.document_id,a.id)=(f.owner_id,f.document_id,f.asset_id)
    WHERE f.owner_id=$1 AND f.document_id=$2 AND f.source_version_id=$3 AND f.id=$4`, [ownerId,documentId,sourceId,fileId])).rows[0];
}
export async function findWebReaderAsset(client: PoolClient, ownerId: string, documentId: string, versionId: string, localId: string, byAsset = false): Promise<WebAssetRow | undefined> {
  return (await client.query<WebAssetRow>(`SELECT a.id,a.object_key,a.sha256,a.bytes,a.media_type FROM web_reader_assets f JOIN assets a ON (a.owner_id,a.document_id,a.id)=(f.owner_id,f.document_id,f.asset_id)
    WHERE f.owner_id=$1 AND f.document_id=$2 AND f.reader_version_id=$3 AND ${byAsset ? 'f.asset_id' : 'f.local_id'}=$4`, [ownerId,documentId,versionId,localId])).rows[0];
}
export async function findWebReaderChunk(client: PoolClient, ownerId: string, documentId: string, versionId: string, chunkId: string): Promise<WebAssetRow | undefined> {
  return (await client.query<WebAssetRow>(`SELECT a.id,a.object_key,a.sha256,a.bytes,a.media_type FROM web_reader_chunks f JOIN assets a ON (a.owner_id,a.document_id,a.id)=(f.owner_id,f.document_id,f.data_asset_id)
    WHERE f.owner_id=$1 AND f.document_id=$2 AND f.reader_version_id=$3 AND f.id=$4`, [ownerId,documentId,versionId,chunkId])).rows[0];
}
/** Returns the document CAS revision alongside the requested version's retained position. */
export async function readWebProgress(client: PoolClient, ownerId: string, documentId: string, readerId: string): Promise<WebReadingProgress | null> {
  const row = (await client.query<{ revision: number; position: WebReadingPosition; updated_at: Date }>(`SELECT s.revision,p.position,p.updated_at FROM web_reading_state s JOIN web_reading_positions p ON (p.owner_id,p.document_id)=(s.owner_id,s.document_id)
    WHERE s.owner_id=$1 AND s.document_id=$2 AND p.reader_version_id=$3`, [ownerId,documentId,readerId])).rows[0];
  return row ? { revision: row.revision, position: row.position, updatedAt: row.updated_at.toISOString() } : null;
}
export async function saveWebProgress(client: PoolClient, ownerId: string, documentId: string, expectedRevision: number, position: WebReadingPosition): Promise<WebReadingProgress | null> {
  const validated = webReadingPositionSchema.parse(position);
  await client.query('SELECT id FROM documents WHERE owner_id=$1 AND id=$2 FOR UPDATE', [ownerId,documentId]);
  await client.query('INSERT INTO web_reading_state (owner_id,document_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ownerId,documentId]);
  const state = (await client.query<{ revision: number }>('SELECT revision FROM web_reading_state WHERE owner_id=$1 AND document_id=$2 FOR UPDATE', [ownerId,documentId])).rows[0]!;
  if (state.revision !== expectedRevision) return null;
  await client.query(`INSERT INTO web_reading_positions (owner_id,document_id,source_version_id,parse_id,reader_version_id,position) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (owner_id,document_id,reader_version_id) DO UPDATE SET position=EXCLUDED.position,updated_at=clock_timestamp()`, [ownerId,documentId,validated.sourceVersionId,validated.parseId,validated.readerVersionId,JSON.stringify(validated)]);
  await client.query('UPDATE web_reading_state SET revision=revision+1,reader_version_id=$3,updated_at=clock_timestamp() WHERE owner_id=$1 AND document_id=$2', [ownerId,documentId,validated.readerVersionId]);
  return readWebProgress(client,ownerId,documentId,validated.readerVersionId);
}

export interface WebDocumentRow {
  id: string; owner_id: string; kind: WebDocumentInput['kind']; title: string; source_url: string | null; original_filename: string | null;
  current_source_version_id: string | null; current_web_reader_version_id: string | null;
  latest_web_source_version_id: string | null; requested_web_job_id: string | null; created_at: Date; updated_at: Date;
}
export interface WebSourceRow {
  owner_id: string; document_id: string; source_version_id: string; asset_id: string; sha256: string; bytes: string; object_key: string;
  snapshot_sha256: string; content_fingerprint: string; url: string; scope: CaptureScope; metadata: Record<string, unknown>; created_at: Date;
}
export interface WebParseRow { id: string; owner_id: string; document_id: string; source_version_id: string; ir_asset_id: string; ir_sha256: string; created_at: Date }
export async function findWebDocument(client: PoolClient, ownerId: string, id: string): Promise<WebDocumentRow | undefined> {
  return (await client.query<WebDocumentRow>("SELECT * FROM documents WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL AND kind<>'pdf'", [ownerId,id])).rows[0];
}
export async function findWebSource(client: PoolClient, ownerId: string, documentId: string, sourceId: string): Promise<WebSourceRow | undefined> {
  return (await client.query<WebSourceRow>(`SELECT w.*,s.asset_id,s.sha256,s.bytes,a.object_key FROM web_sources w
    JOIN source_versions s ON (s.owner_id,s.document_id,s.id)=(w.owner_id,w.document_id,w.source_version_id)
    JOIN assets a ON (a.owner_id,a.document_id,a.id)=(s.owner_id,s.document_id,s.asset_id)
    WHERE w.owner_id=$1 AND w.document_id=$2 AND w.source_version_id=$3`, [ownerId,documentId,sourceId])).rows[0];
}
export async function findWebParse(client: PoolClient, ownerId: string, documentId: string, sourceId: string, parseId: string): Promise<WebParseRow | undefined> {
  return (await client.query<WebParseRow>('SELECT * FROM web_parse_runs WHERE owner_id=$1 AND document_id=$2 AND source_version_id=$3 AND id=$4', [ownerId,documentId,sourceId,parseId])).rows[0];
}
export async function setRequestedWebJob(client: PoolClient, ownerId: string, documentId: string, jobId: string | null): Promise<void> {
  await client.query("UPDATE documents SET requested_web_job_id=$3,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2 AND kind IN ('article','x-post','repository')", [ownerId,documentId,jobId]);
}
