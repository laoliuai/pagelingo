import type { PoolClient } from 'pg';
import { webCaptureManifestSchema, type CaptureFile, type CaptureStatus, type TranslationIntent, type WebCaptureManifest } from '@pagelingo/document-contracts';

export interface WebCaptureInput {
  id: string; ownerId: string; authVersion: number; deviceId: string | null; sessionId: string | null;
  manifest: WebCaptureManifest; requestHash: string; targetDocumentId: string | null; translationIntent: TranslationIntent; stagingKey: string;
}
export interface WebCaptureRow {
  id: string; capture_id: string; owner_id: string; auth_version: number; device_id: string | null; session_id: string | null;
  idempotency_key: string; request_hash: string; manifest: WebCaptureManifest; target_document_id: string | null;
  translation_intent: TranslationIntent; status: CaptureStatus; epoch: string; staging_key: string;
  document_id: string | null; source_version_id: string | null; reader_version_id: string | null; job_id: string | null;
  save_status: 'original-saved' | 'partial-resources' | null; error_code: string | null; warnings: string[]; created_at: Date; updated_at: Date;
}
export interface CaptureFileRow {
  id: string; descriptor: CaptureFile; received_sha256: string | null; received_bytes: string | null; received_at: Date | null;
}
/** All mutations run in the caller's transaction after user/device/session revalidation. */
export async function insertWebCapture(client: PoolClient, input: WebCaptureInput): Promise<void> {
  const manifest = webCaptureManifestSchema.parse(input.manifest);
  await client.query(`INSERT INTO web_captures (id,capture_id,owner_id,auth_version,device_id,session_id,idempotency_key,request_hash,manifest,target_document_id,translation_intent,staging_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [input.id,manifest.captureId,input.ownerId,input.authVersion,input.deviceId,input.sessionId,manifest.captureId,input.requestHash,JSON.stringify(manifest),input.targetDocumentId,input.translationIntent,input.stagingKey]);
  for (const file of manifest.files) await client.query('INSERT INTO web_capture_files (owner_id,capture_id,id,descriptor) VALUES ($1,$2,$3,$4)', [input.ownerId,input.id,file.id,JSON.stringify(file)]);
}
export async function findWebCapture(client: PoolClient, ownerId: string, id: string): Promise<WebCaptureRow | undefined> {
  return (await client.query<WebCaptureRow>('SELECT * FROM web_captures WHERE owner_id=$1 AND id=$2', [ownerId,id])).rows[0];
}
export async function findWebCaptureByKey(client: PoolClient, ownerId: string, key: string): Promise<WebCaptureRow | undefined> {
  return (await client.query<WebCaptureRow>('SELECT * FROM web_captures WHERE owner_id=$1 AND idempotency_key=$2', [ownerId,key])).rows[0];
}
export async function listCaptureFiles(client: PoolClient, ownerId: string, id: string): Promise<CaptureFileRow[]> {
  return (await client.query<CaptureFileRow>('SELECT id,descriptor,received_sha256,received_bytes,received_at FROM web_capture_files WHERE owner_id=$1 AND capture_id=$2 ORDER BY id', [ownerId,id])).rows;
}
export async function recordCaptureFile(client: PoolClient, ownerId: string, id: string, epoch: number, fileId: string, sha256: string, bytes: number): Promise<boolean> {
  const capture = (await client.query(`SELECT 1 FROM web_captures WHERE owner_id=$1 AND id=$2 AND epoch=$3
    AND status IN ('created','receiving') FOR UPDATE`, [ownerId,id,epoch])).rowCount;
  if (!capture) return false;
  return (await client.query(`UPDATE web_capture_files SET received_sha256=$4,received_bytes=$5,received_at=clock_timestamp()
    WHERE owner_id=$1 AND capture_id=$2 AND id=$3 AND descriptor->>'sha256'=$4 AND (descriptor->>'bytes')::bigint=$5`, [ownerId,id,fileId,sha256,bytes])).rowCount === 1;
}
export async function transitionWebCapture(client: PoolClient, ownerId: string, id: string, epoch: number, from: CaptureStatus, to: Exclude<CaptureStatus, 'completed'>): Promise<boolean> {
  return (await client.query(`UPDATE web_captures SET status=$5,epoch=epoch+CASE WHEN $5 IN ('cancelled','failed') THEN 1 ELSE 0 END,updated_at=clock_timestamp()
    WHERE owner_id=$1 AND id=$2 AND epoch=$3 AND status=$4 AND status NOT IN ('completed','cancelled','failed')`, [ownerId,id,epoch,from,to])).rowCount === 1;
}
export interface CaptureCompletion {
  documentId: string; sourceVersionId: string; readerVersionId: string; jobId: string | null;
  saveStatus: 'original-saved' | 'partial-resources'; warnings: string[];
}
export async function completeWebCapture(client: PoolClient, ownerId: string, id: string, epoch: number, result: CaptureCompletion): Promise<boolean> {
  return (await client.query(`UPDATE web_captures c SET status='completed',document_id=$4,source_version_id=$5,reader_version_id=$6,job_id=$7,save_status=$8,warnings=$9,updated_at=clock_timestamp()
    WHERE owner_id=$1 AND id=$2 AND epoch=$3 AND status='validating'
    AND NOT EXISTS (SELECT 1 FROM web_capture_files f WHERE (f.owner_id,f.capture_id)=(c.owner_id,c.id) AND f.received_at IS NULL)`,
  [ownerId,id,epoch,result.documentId,result.sourceVersionId,result.readerVersionId,result.jobId,result.saveStatus,JSON.stringify(result.warnings)])).rowCount === 1;
}
