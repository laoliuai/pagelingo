import { randomUUID } from 'node:crypto';
import { lstat, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Database } from '../db/database.js';
import type { ObjectStore } from '../storage/object-store.js';
import { isObjectKey } from '../storage/local-object-store.js';
import { lockObjectPublication } from '../documents/repository.js';
import { lockDocument } from './guards.js';
import { schedulePurge, scheduleAliasPurges, type PurgeRow } from './repository.js';
import { deleteContentBatch, deleteCacheBatch, scanUntargetedCaptures, PURGE_OBJECT_LIMIT, PURGE_ROW_LIMIT, purgeBackoffMs, purgePlan } from './purge-plan.js';
import type { PoolClient } from 'pg';
export interface MaintenanceDependencies { db: Database; store: ObjectStore; dataDir: string; signal: AbortSignal }
export interface MaintenanceResult { scheduled: number; claimed: number; rowsDeleted: number; capturesScanned: number; objectsDeleted: number; completed: number; failed: number }
async function lockTask(client: PoolClient, task: PurgeRow, token: string): Promise<boolean> {
  await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[task.owner_id]);
  await lockDocument(client,task.owner_id,task.document_id);
  return !!(await client.query(`SELECT id FROM document_purges WHERE id=$1 AND lease_owner=$2 AND status='running' FOR UPDATE`,[task.id,token])).rowCount;
}
async function unlinkStaging(dataDir: string, kind: string, key: string) {
  if (!isObjectKey(key) || !['web-staging','bundle-staging'].includes(kind)) throw new Error('Invalid registered staging key');
  const directory = join(resolve(dataDir),kind); const path = join(directory,key);
  try {
    if (await realpath(directory)!==directory) throw new Error('Unsafe staging directory');
    const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe staging file');
    await unlink(path);
  } catch(error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
}
async function removeObject(deps: MaintenanceDependencies, task: PurgeRow, token: string, object: { storage_kind: string; object_key: string }): Promise<boolean> {
  return deps.db.transaction(async client => {
    if (!await lockTask(client,task,token)) return false;
    await lockObjectPublication(client);
    // Global references, including another owner's publication, always win over a queued key.
    const key = object.object_key;
    const referenced = object.storage_kind==='objects'
      ? await client.query('SELECT 1 FROM assets WHERE object_key=$1 LIMIT 1',[key])
      : object.storage_kind==='bundle-staging'
        ? await client.query('SELECT 1 FROM bundle_imports WHERE staging_key=$1 LIMIT 1',[key])
        : await client.query('SELECT 1 FROM web_capture_files WHERE staging_key=$1 OR upload_token=$1 LIMIT 1',[key]);
    if (referenced.rowCount) return false;
    if (object.storage_kind==='objects') await deps.store.deleteUnreferenced(key); else await unlinkStaging(deps.dataDir,object.storage_kind,key);
    await client.query('DELETE FROM object_deletion_queue WHERE owner_id=$1 AND task_id=$2 AND storage_kind=$3 AND object_key=$4',[task.owner_id,task.id,object.storage_kind,key]);
    return true;
  });
}
/** A single call mutates/deletes at most 500 business rows and removes at most 100 registered files.
 * Due time + UUID provides persistent fairness; claims are restartable after 30 seconds. */
export async function runDocumentMaintenance(deps: MaintenanceDependencies, { limit=100 }: { limit?: number } = {}): Promise<MaintenanceResult> {
  if (!Number.isInteger(limit) || limit<1 || limit>100) throw new Error('Maintenance limit must be between 1 and 100');
  const { db,signal } = deps; const result: MaintenanceResult = { scheduled:0,claimed:0,rowsDeleted:0,capturesScanned:0,objectsDeleted:0,completed:0,failed:0 };
  // Scheduling clears document pointers too; charge it before offering cleanup its allowance.
  let rowsMutated = 0;
  const expired = await db.transaction(async client => {
    await client.query('SELECT singleton FROM document_maintenance_cursor WHERE singleton FOR UPDATE');
    const rows = (await client.query<{ owner_id: string; id: string; due: string }>(`SELECT d.owner_id,d.id,d.purge_after::text AS due FROM documents d CROSS JOIN document_maintenance_cursor c
      WHERE d.deleted_at IS NOT NULL AND d.purge_after<=clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM document_purges p WHERE(p.owner_id,p.document_id)=(d.owner_id,d.id))
      ORDER BY CASE WHEN c.last_document_id IS NULL OR (d.purge_after,d.id)>(c.last_expiry_at,c.last_document_id) THEN 0 ELSE 1 END,d.purge_after,d.id LIMIT $1`,[limit])).rows;
    const last=rows.at(-1);
    if(last) await client.query('UPDATE document_maintenance_cursor SET last_expiry_at=$1::timestamptz,last_document_id=$2 WHERE singleton',[last.due,last.id]);
    return rows;
  });
  for (const row of expired) {
    if (signal.aborted) return result;
    const scheduled = await db.transaction(async client => {
      if (!(await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE SKIP LOCKED',[row.owner_id])).rowCount) return false;
      await lockDocument(client,row.owner_id,row.id);
      if (!(await client.query(`SELECT 1 FROM documents WHERE owner_id=$1 AND id=$2 AND deleted_at IS NOT NULL AND purge_after<=clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM document_purges WHERE owner_id=$1 AND document_id=$2)`,[row.owner_id,row.id])).rowCount) return false;
      await schedulePurge(client,row.owner_id,row.id); return true;
    });
    if (scheduled) { result.scheduled++; rowsMutated++; }
  }
  const candidates = await db.transaction(async client => {
    await client.query('SELECT singleton FROM document_maintenance_cursor WHERE singleton FOR UPDATE');
    const rows = (await client.query<PurgeRow & { due: string }>(`SELECT p.*,p.next_attempt_at::text AS due FROM document_purges p CROSS JOIN document_maintenance_cursor c
      WHERE p.status<>'completed' AND p.next_attempt_at<=clock_timestamp() AND (p.lease_until IS NULL OR p.lease_until<=clock_timestamp())
      ORDER BY CASE WHEN c.last_task_id IS NULL OR (p.next_attempt_at,p.id)>(c.last_due_at,c.last_task_id) THEN 0 ELSE 1 END,p.next_attempt_at,p.id LIMIT $1`,[limit])).rows;
    const last=rows.at(-1);
    if(last) await client.query('UPDATE document_maintenance_cursor SET last_due_at=$1::timestamptz,last_task_id=$2 WHERE singleton',[last.due,last.id]);
    return rows;
  });
  let filesAttempted = 0;
  for (const candidate of candidates) {
    if (signal.aborted || (rowsMutated>=PURGE_ROW_LIMIT && filesAttempted>=PURGE_OBJECT_LIMIT)) break;
    const token = randomUUID();
    const task = await db.transaction(async client => {
      if (!(await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE SKIP LOCKED',[candidate.owner_id])).rowCount) return undefined;
      await lockDocument(client,candidate.owner_id,candidate.document_id);
      return (await client.query<PurgeRow>(`UPDATE document_purges SET status='running',lease_owner=$2,lease_until=clock_timestamp()+interval '30 seconds'
        WHERE id=$1 AND status<>'completed' AND next_attempt_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING *`,[candidate.id,token])).rows[0];
    });
    if (!task) continue;
    result.claimed++; let failed = false;
    try {
      const used = await db.transaction(async client => {
        if (!await lockTask(client,task,token)) return 0;
        const scheduled=await scheduleAliasPurges(client,task.owner_id,task.document_id,PURGE_ROW_LIMIT-rowsMutated);
        if ((await client.query(`SELECT 1 FROM document_source_aliases WHERE owner_id=$1 AND canonical_document_id=$2 AND resolution='alias'
          UNION ALL SELECT 1 FROM document_purges WHERE owner_id=$1 AND group_document_id=$2 AND status<>'completed'`,[task.owner_id,task.document_id])).rowCount) return scheduled;
        const scan = await scanUntargetedCaptures(client,task,limit-result.capturesScanned);
        result.capturesScanned+=scan.scanned;
        if(!scan.done) return scheduled;
        let count = scheduled + await deleteContentBatch(client,task,PURGE_ROW_LIMIT-rowsMutated-scheduled);
        const phase = (await client.query('SELECT cursor FROM document_purges WHERE id=$1',[task.id])).rows[0].cursor;
        if (Number(phase)>=purgePlan.length) count += await deleteCacheBatch(client,task,PURGE_ROW_LIMIT-rowsMutated-count);
        return count;
      });
      result.rowsDeleted+=used; rowsMutated+=used;
      const objects = (await db.pool.query<{ storage_kind: string; object_key: string }>('SELECT storage_kind,object_key FROM object_deletion_queue WHERE owner_id=$1 AND task_id=$2 ORDER BY storage_kind,object_key LIMIT $3',[task.owner_id,task.id,PURGE_OBJECT_LIMIT-filesAttempted])).rows;
      for (const object of objects) {
        if (signal.aborted) break;
        filesAttempted++;
        try { if (await removeObject(deps,task,token,object)) result.objectsDeleted++; }
        catch { failed=true; }
      }
    } catch { failed=true; }
    await db.transaction(async client => {
      if (!await lockTask(client,task,token)) return;
      const remaining = (await client.query(`SELECT EXISTS(SELECT 1 FROM documents WHERE owner_id=$1 AND id=$2)
        OR EXISTS(SELECT 1 FROM object_deletion_queue WHERE owner_id=$1 AND task_id=$3)
        OR EXISTS(SELECT 1 FROM web_owner_cache c JOIN document_cache_cleanup_state s USING(owner_id) WHERE c.owner_id=$1
          AND NOT EXISTS(SELECT 1 FROM web_cache_document_refs r WHERE(r.owner_id,r.cache_key)=(c.owner_id,c.cache_key))
          AND (EXISTS(SELECT 1 FROM document_purge_cache_keys k WHERE(k.owner_id,k.task_id,k.cache_key)=(c.owner_id,$3,c.cache_key))
            OR(s.legacy_cache_cleared_at IS NULL AND c.updated_at<=s.legacy_cache_cutoff))) AS pending`,[task.owner_id,task.document_id,task.id])).rows[0].pending;
      const phase = (await client.query('SELECT cursor FROM document_purges WHERE id=$1',[task.id])).rows[0].cursor;
      const cacheReady = !!(await client.query('SELECT 1 FROM document_cache_cleanup_state WHERE owner_id=$1 AND legacy_cache_cleared_at IS NOT NULL',[task.owner_id])).rowCount;
      const complete = !remaining && !failed && Number(phase)>=purgePlan.length && cacheReady;
      // Cache key bookkeeping has no payload; retain only the minimal final receipt.
      if (complete) {
        await client.query('DELETE FROM document_purge_cache_keys WHERE owner_id=$1 AND task_id=$2',[task.owner_id,task.id]);
        await client.query('DELETE FROM document_purge_captures WHERE owner_id=$1 AND task_id=$2',[task.owner_id,task.id]);
      }
      await client.query(`UPDATE document_purges SET status=$3,lease_owner=NULL,lease_until=NULL,attempts=CASE WHEN $4 THEN attempts+1 ELSE 0 END,
        next_attempt_at=clock_timestamp()+($5*interval '1 millisecond'),error_code=CASE WHEN $4 THEN 'CLEANUP_RETRY' ELSE NULL END,
        completed_at=CASE WHEN $3='completed' THEN clock_timestamp() ELSE NULL END WHERE id=$1 AND lease_owner=$2`,[task.id,token,complete?'completed':'queued',failed,failed?purgeBackoffMs(task.attempts+1):0]);
      if (complete) result.completed++;
    });
    if (failed) result.failed++;
  }
  return result;
}
