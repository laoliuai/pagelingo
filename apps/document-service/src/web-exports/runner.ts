import { randomUUID,createHash } from 'node:crypto';
import { mkdir, realpath, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defaultBundleLimits } from '@pagelingo/document-contracts';
import type { WebJobDependencies } from '../web-jobs/translation-runner.js';
import { assertJobLeaseCurrent,releaseWebJobSlot,type JobLease } from '../web-jobs/repository.js';
import { lockObjectPublication } from '../documents/repository.js';
import { findExport } from './repository.js';
import { exportInWorker } from './worker-client.js';
import type { ExportMaterial } from './assembly.js';
import type { WebAssetRow } from '../web-readers/repository.js';
/** Called only within the shared runner's 500ms monitor and five-second heartbeat. */
export async function runWebExportJob(lease: Extract<JobLease,{ kind: 'export-web' }>,deps: WebJobDependencies): Promise<void> {
  deps = { ...deps,signal: AbortSignal.any([deps.signal,AbortSignal.timeout(120_000)]) };
  const workId = randomUUID(), objectKey = randomUUID(), workspaceKey = randomUUID();
  const material = await deps.db.transaction(async client => {
    await assertJobLeaseCurrent(client,lease);
    const row = (await findExport(client,lease.ownerId,lease.documentId,lease.exportId))!;
    const selected = (await client.query<{ index_asset_id: string; translation_id: string | null }>('SELECT index_asset_id,translation_id FROM web_reader_versions WHERE owner_id=$1 AND document_id=$2 AND id=$3 AND source_version_id=$4 AND parse_id=$5',[lease.ownerId,lease.documentId,row.reader_version_id,lease.sourceVersionId,lease.parseId])).rows[0];
    if (!selected) throw Error('Selected export Reader missing');
    const assets = async (sql: string,values: unknown[]) => (await client.query<WebAssetRow>(sql,values)).rows;
    const prefix = 'SELECT a.id,a.object_key,a.bytes,a.sha256,a.media_type FROM assets a ';
    const binding = [lease.ownerId,lease.documentId,lease.sourceVersionId,lease.parseId];
    const manifest = (await assets(prefix+'JOIN source_versions s ON(s.owner_id,s.document_id,s.asset_id)=(a.owner_id,a.document_id,a.id) WHERE s.owner_id=$1 AND s.document_id=$2 AND s.id=$3',binding.slice(0,3)))[0]!;
    const ir = (await assets(prefix+'JOIN web_parse_runs p ON(p.owner_id,p.document_id,p.ir_asset_id)=(a.owner_id,a.document_id,a.id) WHERE p.owner_id=$1 AND p.document_id=$2 AND p.source_version_id=$3 AND p.id=$4',binding))[0]!;
    const translation = selected.translation_id ? (await assets(prefix+'JOIN web_translation_runs t ON(t.owner_id,t.document_id,t.translation_asset_id)=(a.owner_id,a.document_id,a.id) WHERE t.owner_id=$1 AND t.document_id=$2 AND t.id=$3',[lease.ownerId,lease.documentId,selected.translation_id]))[0]! : null;
    const index = (await assets(prefix+'WHERE a.owner_id=$1 AND a.document_id=$2 AND a.id=$3',[lease.ownerId,lease.documentId,selected.index_asset_id]))[0]!;
    const chunks = await assets(prefix+'JOIN web_reader_chunks c ON(c.owner_id,c.document_id,c.data_asset_id)=(a.owner_id,a.document_id,a.id) WHERE c.owner_id=$1 AND c.document_id=$2 AND c.reader_version_id=$3 ORDER BY c.id LIMIT 20001',[lease.ownerId,lease.documentId,row.reader_version_id]);
    const source = (await client.query<ExportMaterial['source'][number]>(`SELECT a.id,a.object_key,a.bytes,a.sha256,a.media_type,f.id AS local_id,f.path FROM web_source_files f
      JOIN assets a ON(a.owner_id,a.document_id,a.id)=(f.owner_id,f.document_id,f.asset_id) WHERE f.owner_id=$1 AND f.document_id=$2 AND f.source_version_id=$3 AND f.id NOT LIKE 'uploaded:%' LIMIT 257`,binding.slice(0,3))).rows;
    if (source.length > 256 || chunks.length > 20000) throw Error('Export membership limit');
    await client.query(`INSERT INTO registered_object_work(id,owner_id,document_id,job_id,job_epoch,writer_owner,slot_id,slot_epoch,writer_until)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '125 seconds')`,[workId,lease.ownerId,lease.documentId,lease.jobId,lease.epoch,lease.leaseOwner,lease.slotId,lease.slotEpoch]);
    for (const [kind,key] of [['objects',objectKey],['export-staging',workspaceKey]]) await client.query('INSERT INTO object_deletion_queue(owner_id,work_id,storage_kind,object_key) VALUES($1,$2,$3,$4)',[lease.ownerId,workId,kind,key]);
    const fingerprint = (await client.query<{ content_fingerprint: string }>('SELECT content_fingerprint FROM web_sources WHERE owner_id=$1 AND document_id=$2 AND source_version_id=$3',binding.slice(0,3))).rows[0]!.content_fingerprint;
    return { contentFingerprint: fingerprint,packageId: row.package_id,title: row.title,createdAt: row.created_at.toISOString(),rendererVersion: row.renderer_version,rendererSha256: row.renderer_sha256,manifest,ir,translation,index,chunks,source } satisfies ExportMaterial;
  });
  try {
    deps.signal.throwIfAborted();
    const staging = join(resolve(deps.config.dataDir),'export-staging');
    await mkdir(staging,{ recursive: true,mode: 0o700 });
    const info = await lstat(staging);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(staging) !== staging) throw Error('Unsafe export staging');
    await exportInWorker({ material,dataDir: deps.config.dataDir,workspace: join(deps.config.dataDir,'export-staging',workspaceKey),objectKey },deps.signal);
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of deps.store.read(objectKey)) { deps.signal.throwIfAborted(); bytes += chunk.byteLength; if (bytes > defaultBundleLimits.maxArchiveBytes) throw Error('Export size limit'); hash.update(chunk); }
    const sha256 = hash.digest('hex');
    await deps.db.transaction(async client => {
      deps.signal.throwIfAborted(); await assertJobLeaseCurrent(client,lease); await lockObjectPublication(client);
      const assetId = randomUUID();
      await client.query('INSERT INTO assets(id,owner_id,document_id,object_key,sha256,bytes,media_type) VALUES($1,$2,$3,$4,$5,$6,$7)',[assetId,lease.ownerId,lease.documentId,objectKey,sha256,bytes,'application/zip']);
      await client.query("UPDATE web_exports SET asset_id=$2,expires_at=clock_timestamp()+interval '24 hours' WHERE id=$1",[lease.exportId,assetId]);
      await client.query("UPDATE object_deletion_queue SET available_at=(SELECT expires_at FROM web_exports WHERE id=$1) WHERE work_id=$2 AND storage_kind='objects'",[lease.exportId,workId]);
      await releaseWebJobSlot(client,lease);
      await client.query("UPDATE web_jobs SET status='completed',lease_owner=NULL,lease_until=NULL,slot_id=NULL,slot_epoch=NULL,updated_at=clock_timestamp() WHERE id=$1",[lease.jobId]);
    });
  } finally {
    // The worker promise settles only after termination. This durable release is safe even after cancellation.
    await deps.db.transaction(async client => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[lease.ownerId]);
      await client.query('UPDATE registered_object_work SET writer_stopped=true,next_attempt_at=clock_timestamp() WHERE owner_id=$1 AND id=$2',[lease.ownerId,workId]);
    });
  }
}
