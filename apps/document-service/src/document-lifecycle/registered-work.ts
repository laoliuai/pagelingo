import { randomUUID } from 'node:crypto';
import { lstat, opendir, realpath, rmdir, unlink } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { lockObjectPublication } from '../documents/repository.js';
import { isObjectKey } from '../storage/local-object-store.js';
import { lockDocument } from './guards.js';
import { purgeBackoffMs } from './purge-plan.js';
import type { MaintenanceDependencies, MaintenanceResult } from './maintenance.js';
export interface MaintenanceBudget { rows: number; objects: number }
interface Work { id: string; owner_id: string; document_id: string; job_id: string; job_epoch: string; writer_owner: string; slot_id: number; slot_epoch: string; attempts: number }
/** A current lease or the conservative hard-deadline window keeps unpublished keys private to its writer. */
async function lockWork(client: PoolClient,work: Work,token?: string) {
  await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[work.owner_id]);
  await lockDocument(client,work.owner_id,work.document_id);
  await client.query('SELECT id FROM web_worker_slots WHERE id=$1 FOR UPDATE',[work.slot_id]);
  await client.query('SELECT id FROM web_jobs WHERE owner_id=$1 AND id=$2 FOR UPDATE',[work.owner_id,work.job_id]);
  return !!(await client.query(`SELECT w.id FROM registered_object_work w WHERE w.id=$1
    AND ($2::uuid IS NULL OR (w.lease_owner=$2 AND w.lease_until>clock_timestamp()))
    AND (w.writer_stopped OR (w.writer_until<=clock_timestamp() AND NOT EXISTS(
      SELECT 1 FROM web_jobs j JOIN web_worker_slots s ON s.id=j.slot_id WHERE j.owner_id=w.owner_id AND j.id=w.job_id
      AND j.epoch=w.job_epoch AND j.lease_owner=w.writer_owner AND j.status='running' AND j.lease_until>clock_timestamp()
      AND s.epoch=w.slot_epoch AND s.job_id=w.job_id AND s.lease_until>clock_timestamp()))) FOR UPDATE`,[work.id,token ?? null])).rowCount;
}
/** Read no more than the fixed entry bound plus one sentinel, closing on every exit. */
async function boundedEntries(path: string, limit: number, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted();
  const directory = await opendir(path, { bufferSize: limit + 1 });
  try {
    const names: string[] = [];
    while (true) {
      signal.throwIfAborted();
      const entry = await directory.read();
      signal.throwIfAborted();
      if (!entry) return names;
      if (names.length === limit) throw Error('Unexpected workspace entries');
      names.push(entry.name);
    }
  } finally { await directory.close(); }
}
/** No recursive walk. At most output.zip and one private writer directory/archive.zip.
 * Each unlink/rmdir attempt consumes the same invocation-wide object allowance. */
async function removeWorkspace(dataDir: string,key: string,budget: MaintenanceBudget,signal: AbortSignal): Promise<boolean> {
  if (!budget.objects) return false; budget.objects--;
  if (!isObjectKey(key)) throw Error('Invalid workspace key');
  const base = join(resolve(dataDir),'export-staging'), path = join(base,key);
  try {
    if (await realpath(base) !== base) throw Error('Unsafe workspace parent');
    const root = await lstat(path); if (!root.isDirectory() || root.isSymbolicLink()) throw Error('Unsafe workspace');
    const names = await boundedEntries(path,2,signal);
    const files: string[] = [],directories: string[] = [];
    for (const name of names) {
      const entry = join(path,name), stat = await lstat(entry);
      if (stat.isSymbolicLink()) throw Error('Unsafe workspace entry');
      if (name==='output.zip' && stat.isFile()) files.push(entry);
      else if (/^\.pagelingo-bundle-[a-f0-9-]{36}$/.test(name) && stat.isDirectory()) {
        const nested = await boundedEntries(entry,1,signal); if (nested.some(n=>n!=='archive.zip')) throw Error('Unexpected writer entries');
        if (nested.length) { const inner = join(entry,'archive.zip'), info = await lstat(inner); if (!info.isFile() || info.isSymbolicLink()) throw Error('Unsafe writer file'); files.push(inner); }
        directories.push(entry);
      } else throw Error('Unexpected workspace entry');
    }
    for (const file of files) { signal.throwIfAborted(); if (!budget.objects) return false; budget.objects--; await unlink(file); }
    for (const directory of [...directories,path]) { signal.throwIfAborted(); if (!budget.objects) return false; budget.objects--; await rmdir(directory); }
    return true;
  } catch(error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return true; throw error; }
}
/** Part of runDocumentMaintenance: shares its counters, promise, scheduling and object-publication fence. */
export async function maintainRegisteredWork(deps: MaintenanceDependencies,budget: MaintenanceBudget,result: MaintenanceResult,limit: number): Promise<void> {
  const { db,signal } = deps; const initialRows = budget.rows;
  const expired = await db.transaction(async client => {
    await client.query('SELECT singleton FROM document_maintenance_cursor WHERE singleton FOR UPDATE');
    const rows = (await client.query<{ id: string; owner_id: string; document_id: string; due: string }>(`SELECT e.id,e.owner_id,e.document_id,e.expires_at::text AS due FROM web_exports e CROSS JOIN document_maintenance_cursor c
      WHERE e.asset_id IS NOT NULL AND e.expires_at<=clock_timestamp()
      ORDER BY CASE WHEN c.last_export_id IS NULL OR (e.expires_at,e.id)>(c.last_export_expiry_at,c.last_export_id) THEN 0 ELSE 1 END,e.expires_at,e.id LIMIT $1`,[Math.min(limit,Math.floor(budget.rows/5))])).rows;
    const last = rows.at(-1); if (last) await client.query('UPDATE document_maintenance_cursor SET last_export_expiry_at=$1::timestamptz,last_export_id=$2 WHERE singleton',[last.due,last.id]);
    return rows;
  });
  for (const row of expired) {
    if (signal.aborted || budget.rows<5) break;
    const used = await db.transaction(async client => {
      if (!(await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE SKIP LOCKED',[row.owner_id])).rowCount) return 0;
      await lockDocument(client,row.owner_id,row.document_id); await lockObjectPublication(client);
      const item = (await client.query<{ asset_id: string; object_key: string }>(`SELECT e.asset_id,a.object_key FROM web_exports e JOIN assets a ON(a.owner_id,a.id)=(e.owner_id,e.asset_id)
        WHERE e.id=$1 AND e.expires_at<=clock_timestamp() FOR UPDATE OF e`,[row.id])).rows[0];
      if (!item) return 0;
      // Existing durable attempt queue owns this exact output. Never schedule a document purge for expiry.
      await client.query('UPDATE web_exports SET asset_id=NULL WHERE id=$1',[row.id]);
      await client.query('DELETE FROM assets WHERE owner_id=$1 AND id=$2',[row.owner_id,item.asset_id]);
      const changed = await client.query(`UPDATE object_deletion_queue SET available_at=clock_timestamp() WHERE owner_id=$1 AND object_key=$2 AND storage_kind='objects' RETURNING work_id`,[row.owner_id,item.object_key]);
      await client.query('UPDATE registered_object_work SET next_attempt_at=clock_timestamp() WHERE owner_id=$1 AND id=ANY($2::uuid[])',[row.owner_id,changed.rows.map(r=>r.work_id).filter(Boolean)]);
      return 2+2*(changed.rowCount ?? 0);
    });
    budget.rows-=used; if (used) result.scheduled++;
  }
  const candidates = await db.transaction(async client => {
    await client.query('SELECT singleton FROM document_maintenance_cursor WHERE singleton FOR UPDATE');
    const rows = (await client.query<Work & { due: string }>(`SELECT w.*,w.next_attempt_at::text AS due FROM registered_object_work w CROSS JOIN document_maintenance_cursor c
      WHERE (w.next_attempt_at<=clock_timestamp() OR (w.attempts=0 AND EXISTS(SELECT 1 FROM document_purges p WHERE p.owner_id=w.owner_id AND p.document_id=w.document_id AND p.status<>'completed'))) AND (w.lease_until IS NULL OR w.lease_until<=clock_timestamp())
      AND (w.writer_stopped OR w.writer_until<=clock_timestamp())
      ORDER BY CASE WHEN c.last_work_id IS NULL OR(w.next_attempt_at,w.id)>(c.last_work_due_at,c.last_work_id) THEN 0 ELSE 1 END,w.next_attempt_at,w.id LIMIT $1`,[limit])).rows;
    const last=rows.at(-1); if(last) await client.query('UPDATE document_maintenance_cursor SET last_work_due_at=$1::timestamptz,last_work_id=$2 WHERE singleton',[last.due,last.id]);
    return rows;
  });
  for (const work of candidates) {
    if (signal.aborted || budget.rows<5 || !budget.objects) break;
    const token = randomUUID();
    const claimed = await db.transaction(async client => {
      if (!(await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE SKIP LOCKED',[work.owner_id])).rowCount || !await lockWork(client,work)) return false;
      return !!(await client.query(`UPDATE registered_object_work SET lease_owner=$2,lease_until=clock_timestamp()+interval '30 seconds' WHERE id=$1
        AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING id`,[work.id,token])).rowCount;
    });
    if (!claimed) continue;
    budget.rows--; result.claimed++; let failed=false;
    const objects=(await db.pool.query<{ storage_kind: string; object_key: string }>(`SELECT storage_kind,object_key FROM object_deletion_queue WHERE owner_id=$1 AND work_id=$2 AND (available_at<=clock_timestamp() OR EXISTS(SELECT 1 FROM registered_object_work w JOIN document_purges p ON(p.owner_id,p.document_id)=(w.owner_id,w.document_id) WHERE w.id=$2 AND p.status<>'completed'))
      ORDER BY storage_kind,object_key LIMIT 2`,[work.owner_id,work.id])).rows;
    for (const object of objects) {
      if (signal.aborted || !budget.objects || budget.rows<2) break;
      try {
        await db.transaction(async client => {
          if (!await lockWork(client,work,token)) return;
          await lockObjectPublication(client);
          if (object.storage_kind==='objects') {
            if ((await client.query('SELECT 1 FROM assets WHERE object_key=$1 LIMIT 1',[object.object_key])).rowCount) return;
            budget.objects--; await deps.store.deleteUnreferenced(object.object_key);
          } else if (object.storage_kind==='export-staging') {
            if (!await removeWorkspace(deps.dataDir,object.object_key,budget,signal)) return;
          } else throw Error('Unexpected work kind');
          await client.query('DELETE FROM object_deletion_queue WHERE owner_id=$1 AND work_id=$2 AND storage_kind=$3 AND object_key=$4',[work.owner_id,work.id,object.storage_kind,object.object_key]);
          budget.rows--; result.objectsDeleted++;
        });
      } catch { failed=true; }
    }
    await db.transaction(async client => {
      if (!await lockWork(client,work,token)) return;
      const next = (await client.query<{ due: Date | null }>('SELECT min(available_at) AS due FROM object_deletion_queue WHERE work_id=$1',[work.id])).rows[0]!.due;
      if (!next) { await client.query('DELETE FROM registered_object_work WHERE id=$1',[work.id]); result.completed++; }
      else await client.query(`UPDATE registered_object_work SET lease_owner=NULL,lease_until=NULL,attempts=CASE WHEN $2 THEN attempts+1 ELSE 0 END,error_code=CASE WHEN $2 THEN 'CLEANUP_RETRY' ELSE NULL END,
        next_attempt_at=GREATEST($3,clock_timestamp()+($4*interval '1 millisecond')) WHERE id=$1`,[work.id,failed,next,failed?purgeBackoffMs(work.attempts+1):1000]);
      budget.rows--;
    });
    if (failed) result.failed++;
  }
  result.rowsDeleted += initialRows-budget.rows;
}
