import { sourceRequestDigest } from '../source-adapters/receipts.js';
import { normalizeCaptureUrl } from '@pagelingo/web-capture';
import type { PoolClient } from 'pg';
import { operationKeyDigest, type OperationKind } from './retired-identities.js';
import type { PurgeRow } from './repository.js';
export const PURGE_ROW_LIMIT = 500;
export const PURGE_OBJECT_LIMIT = 100;
export const purgeBackoffMs = (attempts: number) => Math.min(60_000, 1000 * 2 ** Math.min(6, Math.max(0, attempts - 1)));
const capturePredicate = '(document_id=$2 OR target_document_id=$2)';
const webCapturePredicate = `(document_id=$2 OR target_document_id=$2 OR id IN (SELECT capture_id FROM document_purge_captures WHERE owner_id=$1 AND task_id=$4))`;
const byDocument = 'document_id=$2';
/** Retained material FK graph, including every historical version. Extend together
 * with purgePlan when adding source adapters/exports; orphan asset rows are not originals. */
export const retainedAssetReferences: readonly { table: string; columns: readonly string[] }[] = [
  { table: 'source_versions', columns: ['asset_id'] },
  { table: 'source_acquisitions', columns: ['asset_id'] },
  { table: 'github_versions', columns: ['raw_asset_id','html_asset_id'] },
  { table: 'arxiv_versions', columns: ['pdf_asset_id'] },
  { table: 'parse_runs', columns: ['ir_asset_id'] },
  { table: 'translation_runs', columns: ['translation_asset_id'] },
  { table: 'reader_versions', columns: ['archive_asset_id', 'index_asset_id'] },
  { table: 'reader_chunks', columns: ['data_asset_id'] },
  { table: 'bundle_files', columns: ['asset_id'] },
  { table: 'web_source_files', columns: ['asset_id'] },
  { table: 'web_parse_runs', columns: ['ir_asset_id'] },
  { table: 'web_translation_runs', columns: ['translation_asset_id'] },
  { table: 'web_reader_versions', columns: ['index_asset_id'] },
  { table: 'web_reader_chunks', columns: ['data_asset_id'] },
  { table: 'web_reader_assets', columns: ['asset_id'] },
  { table: 'web_fetch_acquisitions', columns: ['raw_asset_id'] },
];
interface PurgeStep { table: string; predicate: string }
/** Explicit FK graph; Task 7 source aliases and Task 13 exports must register here.
 * Mutable job result pointers are detached first, breaking the job/Reader cycle.
 * Global users, configuration, taxonomy, slots and backfill cursor are never deleted. */
export const purgePlan: readonly PurgeStep[] = [
  { table:'bundle_imports',predicate:capturePredicate },
  { table:'paper_reader_bindings',predicate:byDocument },
  { table:'github_versions',predicate:byDocument },
  { table:'arxiv_versions',predicate:byDocument },
  { table:'source_acquisitions',predicate:byDocument },
  { table:'source_requests',predicate:byDocument },
  { table:'document_source_aliases',predicate:"(document_id=$2 OR (canonical_document_id=$2 AND resolution='conflict'))" },
  { table:'document_source_identities',predicate:byDocument },
  { table:'web_fetch_acquisitions',predicate:byDocument },
  { table:'web_capture_files',predicate:`capture_id IN (SELECT id FROM web_captures WHERE owner_id=$1 AND ${webCapturePredicate})` },
  { table:'web_captures',predicate:webCapturePredicate },
  { table:'ingestions',predicate:byDocument },
  { table:'web_link_requests',predicate:byDocument },
  { table:'web_job_checkpoints',predicate:'job_id IN (SELECT id FROM web_jobs WHERE owner_id=$1 AND document_id=$2)' },
  { table:'web_reading_state',predicate:byDocument },
  { table:'web_reading_positions',predicate:byDocument },
  { table:'reading_state',predicate:byDocument },
  { table:'reading_positions',predicate:byDocument },
  { table:'reader_chunks',predicate:byDocument },
  { table:'bundle_files',predicate:byDocument },
  { table:'reader_versions',predicate:byDocument },
  { table:'translation_runs',predicate:byDocument },
  { table:'parse_runs',predicate:byDocument },
  { table:'web_reader_chunks',predicate:byDocument },
  { table:'web_reader_assets',predicate:byDocument },
  { table:'web_reader_versions',predicate:byDocument },
  { table:'web_translation_runs',predicate:byDocument },
  { table:'web_jobs',predicate:byDocument },
  { table:'web_parse_runs',predicate:byDocument },
  { table:'web_source_files',predicate:byDocument },
  { table:'web_sources',predicate:byDocument },
  { table:'document_search_metadata',predicate:byDocument },
  { table:'source_versions',predicate:byDocument },
  { table:'assets',predicate:byDocument },
  { table:'document_relations',predicate:'(from_document_id=$2 OR to_document_id=$2)' },
  { table:'document_tags',predicate:byDocument },
  { table:'document_organization',predicate:byDocument },
  { table:'web_cache_document_refs',predicate:byDocument },
  { table:'documents',predicate:'id=$2' },
];
// Cleanup needs identities and registered keys only, never manifest/checkpoint/Reader payloads.
const retirementColumns: Readonly<Record<string, readonly string[]>> = {
  source_requests: ['idempotency_key','auth_version'],
  ingestions: ['idempotency_key'],
  bundle_imports: ['id', 'idempotency_key', 'staging_key'],
  web_captures: ['id', 'capture_id'],
  web_link_requests: ['idempotency_key'],
  web_jobs: ['id', 'request_id', 'auth_version'],
  web_capture_files: ['staging_key', 'upload_token'],
  assets: ['object_key'],
  web_cache_document_refs: ['cache_key'],
};
type ContentRow = Record<string, string | number | null>;
export async function queueObject(client: PoolClient, task: PurgeRow, key: string | null | undefined, kind = 'objects') {
  if (key) await client.query('INSERT INTO object_deletion_queue(owner_id,task_id,object_key,storage_kind) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[task.owner_id,task.id,key,kind]);
}
async function retire(client: PoolClient, task: PurgeRow, table: string, row: ContentRow, kind: OperationKind, key: string) {
  const digest = operationKeyDigest(kind,key,kind === 'web-job-request' ? { documentId:task.document_id,authVersion:Number(row.auth_version) } : undefined);
  // accepted_at is copied in SQL, preserving its exact database precision.
  await client.query(`INSERT INTO retired_operations(owner_id,operation_kind,key_digest,document_id,accepted_at,retired_at)
    SELECT $1,$3,$4,$2,r.created_at,t.purged_at FROM ${table} r JOIN document_tombstones t ON(t.owner_id,t.document_id)=($1,$2)
    WHERE r.owner_id=$1 AND r.ctid=$5::tid ON CONFLICT DO NOTHING`,[task.owner_id,task.document_id,kind,digest,row.row_tid]);
}
async function beforeDelete(client: PoolClient, task: PurgeRow, table: string, row: ContentRow) {
  const key = String(row.idempotency_key);
  if (table==='source_requests') await client.query(`INSERT INTO retired_operations(owner_id,operation_kind,key_digest,document_id,accepted_at,retired_at)
    SELECT $1,'source-request',$3,$2,r.created_at,t.purged_at FROM source_requests r JOIN document_tombstones t ON(t.owner_id,t.document_id)=($1,$2)
    WHERE r.owner_id=$1 AND r.ctid=$4::tid ON CONFLICT DO NOTHING`, [task.owner_id,task.document_id,sourceRequestDigest(task.document_id,Number(row.auth_version),key),row.row_tid]);
  if (table==='ingestions') await retire(client,task,table,row,'pdf-upload',key);
  if (table==='bundle_imports') {
    await retire(client,task,table,row,'bundle-import',key); await retire(client,task,table,row,'bundle-import-id',String(row.id));
    await queueObject(client,task,row.staging_key as string|null,'bundle-staging');
  }
  if (table==='web_captures') {
    await retire(client,task,table,row,'web-capture',String(row.capture_id)); await retire(client,task,table,row,'web-capture-id',String(row.id));
  }
  if (table==='web_link_requests') await retire(client,task,table,row,'document-link',key);
  if (table==='web_jobs') {
    await retire(client,task,table,row,'web-job',String(row.id));
    if (row.request_id) await retire(client,task,table,row,'web-job-request',String(row.request_id));
  }
  if (table==='assets') await queueObject(client,task,String(row.object_key));
  if (table==='web_capture_files') {
    await queueObject(client,task,row.staging_key as string|null,'web-staging'); await queueObject(client,task,row.upload_token as string|null,'web-staging');
  }
  if (table==='web_cache_document_refs') await client.query('INSERT INTO document_purge_cache_keys(owner_id,task_id,cache_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[task.owner_id,task.id,row.cache_key]);
}
/** Normalize only a bounded slice; preserve an exact non-content association across restart. */
export async function scanUntargetedCaptures(client: PoolClient, task: PurgeRow, limit: number): Promise<{ scanned: number; done: boolean }> {
  const state=(await client.query('SELECT capture_cursor,captures_scanned FROM document_purges WHERE id=$1',[task.id])).rows[0];
  if(state.captures_scanned) return { scanned:0,done:true };
  if(limit<=0) return { scanned:0,done:false };
  const document=(await client.query('SELECT source_url FROM documents WHERE owner_id=$1 AND id=$2',[task.owner_id,task.document_id])).rows[0];
  if(!document?.source_url) {
    await client.query('UPDATE document_purges SET captures_scanned=true WHERE id=$1',[task.id]); return { scanned:0,done:true };
  }
  const rows=(await client.query<{ id:string; url:string }>(`SELECT id,manifest->'source'->>'url' AS url FROM web_captures
    WHERE owner_id=$1 AND target_document_id IS NULL AND document_id IS NULL AND ($3::uuid IS NULL OR id>$3)
    AND created_at<=(SELECT purged_at FROM document_tombstones WHERE owner_id=$1 AND document_id=$2) ORDER BY id LIMIT $4`,[task.owner_id,task.document_id,state.capture_cursor,limit])).rows;
  for(const row of rows) {
    if(normalizeCaptureUrl(row.url)===document.source_url) await client.query('INSERT INTO document_purge_captures(owner_id,task_id,capture_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[task.owner_id,task.id,row.id]);
  }
  const done=rows.length<limit;
  await client.query('UPDATE document_purges SET capture_cursor=COALESCE($2,capture_cursor),captures_scanned=$3 WHERE id=$1',[task.id,rows.at(-1)?.id ?? null,done]);
  return { scanned:rows.length,done };
}
/** All statements execute under owner/document/task locks; the caller owns a shared run budget. */
export async function deleteContentBatch(client: PoolClient, task: PurgeRow, budget: number): Promise<number> {
  let used = 0;
  const detached = await client.query(`UPDATE web_jobs SET reader_version_id=NULL,source_github_revision_id=NULL,source_arxiv_revision_id=NULL WHERE ctid IN
    (SELECT ctid FROM web_jobs WHERE owner_id=$1 AND document_id=$2 AND (reader_version_id IS NOT NULL OR source_github_revision_id IS NOT NULL OR source_arxiv_revision_id IS NOT NULL) LIMIT $3)`,[task.owner_id,task.document_id,budget]);
  used += detached.rowCount ?? 0;
  let phase = Number(task.cursor ?? 0);
  for (; phase<purgePlan.length && used<budget; phase++) {
    const step = purgePlan[phase]!;
    const columns = [...(retirementColumns[step.table] ?? []), 'ctid::text AS row_tid'].join(',');
    const rows = (await client.query<ContentRow>(`SELECT ${columns} FROM ${step.table} WHERE owner_id=$1 AND ${step.predicate} ORDER BY ctid LIMIT $3`,[task.owner_id,task.document_id,budget-used, ...(step.table==='web_captures' || step.table==='web_capture_files' ? [task.id] : [])])).rows;
    for (const row of rows) await beforeDelete(client,task,step.table,row);
    if (rows.length) await client.query(`DELETE FROM ${step.table} WHERE owner_id=$1 AND ctid=ANY($2::tid[])`,[task.owner_id,rows.map(row=>row.row_tid)]);
    used += rows.length;
    if (used===budget) break; // Revisit this phase to prove it empty before advancing.
  }
  await client.query('UPDATE document_purges SET cursor=$2 WHERE id=$1',[task.id,String(phase)]);
  return used;
}
/** The legacy cutoff is established once; newly attributable cache references survive. */
export async function deleteCacheBatch(client: PoolClient, task: PurgeRow, budget: number): Promise<number> {
  if (budget<=0) return 0;
  await client.query(`INSERT INTO document_cache_cleanup_state(owner_id,legacy_cache_cutoff) VALUES($1,clock_timestamp()) ON CONFLICT DO NOTHING`,[task.owner_id]);
  const rows = (await client.query<{ cache_key: string }>(`SELECT c.cache_key FROM web_owner_cache c JOIN document_cache_cleanup_state s USING(owner_id)
    WHERE c.owner_id=$1 AND NOT EXISTS(SELECT 1 FROM web_cache_document_refs r WHERE(r.owner_id,r.cache_key)=(c.owner_id,c.cache_key))
    AND (EXISTS(SELECT 1 FROM document_purge_cache_keys k WHERE(k.owner_id,k.task_id,k.cache_key)=(c.owner_id,$2,c.cache_key))
      OR (s.legacy_cache_cleared_at IS NULL AND c.updated_at<=s.legacy_cache_cutoff)) ORDER BY c.cache_key LIMIT $3`,[task.owner_id,task.id,budget])).rows;
  if (rows.length) await client.query('DELETE FROM web_owner_cache WHERE owner_id=$1 AND cache_key=ANY($2::text[])',[task.owner_id,rows.map(r=>r.cache_key)]);
  if (rows.length<budget) {
    await client.query('UPDATE document_cache_cleanup_state SET legacy_cache_cleared_at=COALESCE(legacy_cache_cleared_at,clock_timestamp()) WHERE owner_id=$1',[task.owner_id]);
  }
  return rows.length;
}
