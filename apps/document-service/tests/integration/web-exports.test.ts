import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { claimWebJob, reconcileWebJobs } from '../../src/web-jobs/lease.js';
import { runWebJob } from '../../src/web-jobs/translation-runner.js';
import { jobFixture } from '../helpers/web-jobs.js';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
async function fixture() {
  const t = await jobFixture(); closes.push(t.close);
  const saved = await t.save(2);
  await t.request(`/api/v1/web-jobs/${saved.jobId}/cancel`, 'POST', {});
  const url = `/api/v1/documents/${saved.documentId}/web-exports`;
  const create = (key = randomUUID(), readerVersionId = saved.readerVersionId) => t.app.inject({ method: 'POST', url, headers: { ...t.headers, 'idempotency-key': key }, payload: { readerVersionId } });
  return { ...t, saved, url, create };
}
it('exports the selected immutable version with no model calls', async () => {
  const t = await fixture();
  await t.db.pool.query('DELETE FROM provider_profiles WHERE owner_id=$1',[t.actor.userId]);
  const accepted = await t.create();
  expect(accepted.statusCode, accepted.body).toBe(201);
  const receipt = accepted.json();
  expect(receipt).toMatchObject({ status: 'queued', readerVersionId: t.saved.readerVersionId });
  const lease = await claimWebJob('export-worker', t.db);
  expect(lease?.kind).toBe('export-web');
  await runWebJob(lease!, { db: t.db, store: t.store, config: t.config, signal: new AbortController().signal });
  const state = await t.request(`${t.url}/${receipt.id}`);
  expect(state.json()).toMatchObject({ status: 'completed', packageId: receipt.packageId, readerVersionId: t.saved.readerVersionId });
  const file = await t.request(`${t.url}/${receipt.id}/file`);
  expect(file.statusCode, file.body).toBe(200);
  expect(file.rawPayload.subarray(0, 2).toString()).toBe('PK');
  expect(file.headers['content-disposition']).toContain('attachment');
  expect((await t.db.pool.query('SELECT current_web_reader_version_id FROM documents WHERE id=$1', [t.saved.documentId])).rows[0].current_web_reader_version_id).toBe(t.saved.readerVersionId);
  expect((await t.db.pool.query('SELECT * FROM web_job_checkpoints')).rowCount).toBe(0);
});
it('recovers lost create acknowledgement and worker restart', async () => {
  const t = await fixture(); const key = randomUUID();
  const first = await t.create(key);
  expect(first.statusCode, first.body).toBe(201);
  await t.db.pool.query("UPDATE documents SET title='Changed header after admission' WHERE id=$1", [t.saved.documentId]);
  const second = await t.create(key);
  expect(second.json()).toEqual(first.json());
  const lease = (await claimWebJob('crashed-worker', t.db))!;
  await t.db.pool.query("UPDATE web_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [lease.jobId]);
  await t.db.pool.query("UPDATE web_worker_slots SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [lease.slotId]);
  await reconcileWebJobs(t.db);
  const recovered = (await claimWebJob('replacement-worker', t.db))!;
  await runWebJob(recovered, { db: t.db, store: t.store, config: t.config, signal: new AbortController().signal });
  expect((await t.request(`${t.url}/${first.json().id}`)).json().status).toBe('completed');
  expect((await t.create(key)).json().id).toBe(first.json().id);
});
it('expires only temporary exports through shared maintenance and restores retained originals', async () => {
  const { runDocumentMaintenance } = await import('../../src/document-lifecycle/maintenance.js');
  const t = await fixture(); const accepted = await t.create();
  expect(accepted.statusCode,accepted.body).toBe(201);
  const lease = (await claimWebJob('expiry-worker',t.db))!;
  await runWebJob(lease,{ db: t.db,store: t.store,config: t.config,signal: new AbortController().signal });
  const output = (await t.db.pool.query('SELECT a.object_key FROM web_exports e JOIN assets a ON a.id=e.asset_id WHERE e.id=$1',[accepted.json().id])).rows[0];
  expect(output).toBeDefined();
  await t.db.pool.query("UPDATE web_exports SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[accepted.json().id]);
  for (let i=0;i<4;i++) await runDocumentMaintenance({ db: t.db,store: t.store,dataDir: t.config.dataDir,signal: new AbortController().signal });
  await expect(t.store.stat(output.object_key)).rejects.toThrow();
  expect((await t.request(`${t.url}/${accepted.json().id}`)).json().status).toBe('expired');
  expect((await t.request(`${t.url}/${accepted.json().id}/file`)).statusCode).toBe(404);
  expect((await t.db.pool.query('SELECT * FROM document_purges')).rowCount).toBe(0);
  expect((await t.request(`/api/v1/documents/${t.saved.documentId}/trash`,'POST',{expectedEpoch:1})).statusCode).toBe(200);
  expect((await t.request(`/api/v1/documents/${t.saved.documentId}/restore`,'POST',{expectedEpoch:2})).statusCode).toBe(200);
});
it('keeps admission title and source bytes fixed when a newer Reader becomes current', async () => {
  const { writeFile } = await import('node:fs/promises'); const { join } = await import('node:path');
  const { createArchiveFileSource,validateWebBundle } = await import('@pagelingo/document-bundle');
  const { readWebAsset } = await import('../../src/web-readers/assets.js');
  const t=await fixture(), first=await t.create(); expect(first.statusCode).toBe(201);
  const original=(await t.db.pool.query('SELECT a.* FROM assets a JOIN source_versions s ON s.asset_id=a.id WHERE s.id=$1',[t.saved.sourceVersionId])).rows[0];
  const bytes=await readWebAsset(t.store,original);
  const newer=await t.save(3,'A newer source snapshot.'); await t.request(`/api/v1/web-jobs/${newer.jobId}/cancel`,'POST',{});
  expect(newer.documentId).toBe(t.saved.documentId); expect(newer.readerVersionId).not.toBe(t.saved.readerVersionId);
  await t.db.pool.query("UPDATE documents SET title='New mutable header' WHERE id=$1",[t.saved.documentId]);
  await runWebJob((await claimWebJob('version-worker',t.db))!,{ db:t.db,store:t.store,config:t.config,signal:new AbortController().signal });
  const downloaded=await t.request(`${t.url}/${first.json().id}/file`); expect(downloaded.statusCode).toBe(200);
  const path=join(t.config.dataDir,'download.zip'); await writeFile(path,downloaded.rawPayload);
  const { defaultBundleLimits }=await import('@pagelingo/document-contracts');
  const source=createArchiveFileSource(path,defaultBundleLimits); const validated=await validateWebBundle(source,{limits:defaultBundleLimits});
  expect(validated.manifest.packageId).toBe(first.json().packageId); expect(validated.manifest.title).toBe('Test article');
  expect(validated.manifest.source.manifestSha256).toBe(original.sha256);
  const chunks=[]; for await(const chunk of source.read('source/manifest.json')) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(bytes);
  expect((await t.db.pool.query('SELECT current_web_reader_version_id FROM documents WHERE id=$1',[t.saved.documentId])).rows[0].current_web_reader_version_id).toBe(newer.readerVersionId);
});
it.each(['trash','account'])('rejects a late export after %s changes',async mode=>{
  const t=await fixture(), created=await t.create(); expect(created.statusCode).toBe(201);
  const lease=(await claimWebJob('late-worker',t.db))!;
  const { eventually }=await import('../helpers/web-jobs.js');
  let release!:()=>void; const held=new Promise<void>(resolve=>{release=resolve;}); let waiting=false;
  const store={...t.store,async *read(key:string,range?:import('../../src/storage/object-store.js').ByteRange){ waiting=true; await held; yield* t.store.read(key,range); }};
  const running=runWebJob(lease,{db:t.db,store,config:t.config,signal:new AbortController().signal});
  await eventually(async()=>waiting,Boolean);
  if(mode==='trash') expect((await t.request(`/api/v1/documents/${t.saved.documentId}/trash`,'POST',{expectedEpoch:1})).statusCode).toBe(200);
  else await t.db.pool.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1',[t.actor.userId]);
  release(); await running;
  expect((await t.db.pool.query('SELECT asset_id FROM web_exports WHERE id=$1',[created.json().id])).rows[0].asset_id).toBeNull();
  expect((await t.db.pool.query('SELECT status FROM web_jobs WHERE id=$1',[lease.jobId])).rows[0].status).toBe('cancelled');
});
it('keeps state GET pure and blocks other owners, administrators, anonymous and expired file reads',async()=>{
  const {login}=await import('../helpers/session.js');
  const t=await fixture(), created=await t.create(); expect(created.statusCode).toBe(201);
  const before=(await t.db.pool.query('SELECT * FROM web_jobs ORDER BY id')).rows;
  for(let i=0;i<3;i++) expect((await t.request(`${t.url}/${created.json().id}`)).statusCode).toBe(200);
  expect((await t.db.pool.query('SELECT * FROM web_jobs ORDER BY id')).rows).toEqual(before);
  await runWebJob((await claimWebJob('download-worker',t.db))!,{db:t.db,store:t.store,config:t.config,signal:new AbortController().signal});
  const url=`${t.url}/${created.json().id}/file`;
  for(const role of ['user','admin']) {
    const username=`other-${role}`;
    await t.db.pool.query('INSERT INTO users(username,password_hash,role) SELECT $1,password_hash,$2 FROM users WHERE id=$3',[username,role,t.actor.userId]);
    const other=await login(t.app,username,'correct password 123456');
    for(const method of ['GET','HEAD'] as const) for(const range of [undefined,'bytes=0-9']) {
      const denied=await t.app.inject({url,method,headers:{cookie:other.cookie,...(range?{range}:{})}}); expect(denied.statusCode).toBe(404); expect(denied.headers['cache-control']).toBe('no-store');
    }
  }
  expect((await t.app.inject({url})).statusCode).toBe(401);
  const part=await t.app.inject({url,headers:{...t.headers,range:'bytes=0-9'}}); expect(part.statusCode).toBe(206); expect(part.rawPayload.length).toBe(10);
  const asset=(await t.db.pool.query('SELECT asset_id FROM web_exports WHERE id=$1',[created.json().id])).rows[0].asset_id;
  expect((await t.request(`/api/v1/assets/${asset}/content`)).statusCode).toBe(404);
  await t.db.pool.query("UPDATE web_exports SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[created.json().id]);
  for(const method of ['GET','HEAD'] as const) expect((await t.app.inject({url,method,headers:{...t.headers,range:'bytes=0-9'}})).statusCode).toBe(404);
});
it('returns original PDF and historical bundle bytes without rebuilding',async()=>{
  const {readerTestApp,headers}=await import('../helpers/readers.js'); const t=await readerTestApp(closes); const f=await t.ingest();
  const zip=await t.app.inject({url:`${f.base}/readers/${f.version}/bundle`,headers:headers(t.alice)});
  expect(zip.statusCode).toBe(200); expect(zip.rawPayload).toEqual(f.bytes);
  const pdf=await t.app.inject({url:`${f.base}/source?download=true`,headers:headers(t.alice)});
  expect(pdf.statusCode).toBe(200); expect(pdf.rawPayload).toEqual(f.files.get('source.pdf'));
});
it('fails cleanly on a corrupt source object without publishing an attachment',async()=>{
  const {writeFile}=await import('node:fs/promises'); const {join}=await import('node:path');
  const t=await fixture(), created=await t.create(); expect(created.statusCode).toBe(201);
  const asset=(await t.db.pool.query('SELECT a.object_key FROM assets a JOIN web_parse_runs p ON p.ir_asset_id=a.id WHERE p.document_id=$1',[t.saved.documentId])).rows[0];
  await writeFile(join(t.config.dataDir,'objects',asset.object_key),'corrupt');
  await runWebJob((await claimWebJob('corrupt-worker',t.db))!,{db:t.db,store:t.store,config:t.config,signal:new AbortController().signal});
  expect((await t.request(`${t.url}/${created.json().id}`)).json()).toMatchObject({status:'failed',errorCode:'EXPORT_FAILED',bytes:null});
});
it('does not allow generic job retry to restart a terminal export operation',async()=>{
  const t=await fixture(), created=await t.create(); expect(created.statusCode).toBe(201);
  const job=(await t.db.pool.query('SELECT job_id FROM web_exports WHERE id=$1',[created.json().id])).rows[0].job_id;
  await t.request(`/api/v1/web-jobs/${job}/cancel`,'POST',{});
  const retried=await t.request(`/api/v1/web-jobs/${job}/retry`,'POST',{profileRevision:1,glossaryRevision:0});
  expect(retried.statusCode).toBe(409);
  expect((await t.db.pool.query('SELECT status FROM web_jobs WHERE id=$1',[job])).rows[0].status).toBe('cancelled');
});
it('recovers an owned writer process killed after durable output and protects its live attempt from cleanup',async()=>{
  const {once}=await import('node:events'); const {exportProcess}=await import('../helpers/export-process.js');
  const {runDocumentMaintenance}=await import('../../src/document-lifecycle/maintenance.js');
  const t=await fixture(), created=await t.create(); expect(created.statusCode).toBe(201);
  const schema=(await t.db.pool.query('SELECT current_schema() AS name')).rows[0].name;
  const worker=exportProcess(schema,t.config.dataDir); let oldKey:string;
  const maintenance=()=>runDocumentMaintenance({db:t.db,store:t.store,dataDir:t.config.dataDir,signal:new AbortController().signal});
  try {
    oldKey=await worker.ready;
    await maintenance(); expect((await t.store.stat(oldKey)).bytes).toBeGreaterThan(0);
    // Even elapsed grace does not permit deleting a currently leased writer's key.
    await t.db.pool.query("UPDATE registered_object_work SET writer_until=clock_timestamp()-interval '1 second'");
    await maintenance(); expect((await t.store.stat(oldKey)).bytes).toBeGreaterThan(0);
  } finally { const exited=once(worker.child,'exit'); worker.child.kill('SIGKILL'); await exited; }
  await t.db.pool.query("UPDATE web_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE status='running'");
  await t.db.pool.query("UPDATE web_worker_slots SET lease_until=clock_timestamp()-interval '1 second' WHERE job_id IS NOT NULL");
  await reconcileWebJobs(t.db); const lease=(await claimWebJob('restarted-export',t.db))!;
  await runWebJob(lease,{db:t.db,store:t.store,config:t.config,signal:new AbortController().signal});
  await maintenance(); await expect(t.store.stat(oldKey!)).rejects.toThrow();
  expect((await t.request(`${t.url}/${created.json().id}`)).json()).toMatchObject({status:'completed',packageId:created.json().packageId});
});
it('preserves permanent purge receipts while cleaning failed and completed export attempts',async()=>{
  const {runDocumentMaintenance}=await import('../../src/document-lifecycle/maintenance.js');
  const t=await fixture(), key=randomUUID(), created=await t.create(key); expect(created.statusCode).toBe(201);
  await runWebJob((await claimWebJob('purged-export',t.db))!,{db:t.db,store:t.store,config:t.config,signal:new AbortController().signal});
  const keys=(await t.db.pool.query('SELECT object_key FROM assets WHERE document_id=$1',[t.saved.documentId])).rows.map(r=>r.object_key);
  await t.request(`/api/v1/documents/${t.saved.documentId}/trash`,'POST',{expectedEpoch:1});
  const purged=await t.app.inject({method:'DELETE',url:`/api/v1/trash/${t.saved.documentId}`,headers:t.headers}); expect(purged.statusCode).toBe(202);
  for(let i=0;i<5;i++) await runDocumentMaintenance({db:t.db,store:t.store,dataDir:t.config.dataDir,signal:new AbortController().signal});
  expect((await t.db.pool.query('SELECT status FROM document_purges WHERE id=$1',[purged.json().id])).rows[0].status).toBe('completed');
  for(const objectKey of keys) await expect(t.store.stat(objectKey)).rejects.toThrow();
  expect((await t.db.pool.query('SELECT 1 FROM registered_object_work')).rowCount).toBe(0);
  expect((await t.create(key)).statusCode).toBe(410);
});
it('terminates unsupported historical capture configurations without a model retry',async()=>{
  const t=await jobFixture(); closes.push(t.close); t.config.captureLimits.maxHtmlBytes=Math.floor(t.config.captureLimits.maxHtmlBytes/2);
  const saved=await t.save(2); await t.request(`/api/v1/web-jobs/${saved.jobId}/cancel`,'POST',{});
  const base=`/api/v1/documents/${saved.documentId}/web-exports`;
  const created=await t.app.inject({method:'POST',url:base,headers:{...t.headers,'idempotency-key':randomUUID()},payload:{readerVersionId:saved.readerVersionId}}); expect(created.statusCode).toBe(201);
  await runWebJob((await claimWebJob('unsupported-export',t.db))!,{db:t.db,store:t.store,config:t.config,signal:new AbortController().signal});
  expect((await t.request(`${base}/${created.json().id}`)).json()).toMatchObject({status:'failed',errorCode:'BUNDLE_UNSUPPORTED_SOURCE'});
  expect((await t.request(`/api/v1/documents/${saved.documentId}/web-reader?versionId=${saved.readerVersionId}`)).statusCode).toBe(200);
});
it.each(['reader','chunk','resource'])('refuses restore when a non-current historical %s object is missing',async kind=>{
  const t=await fixture(); const newer=await t.save(3,'new source'); await t.request(`/api/v1/web-jobs/${newer.jobId}/cancel`,'POST',{});
  const query = kind==='reader' ? 'SELECT a.object_key FROM web_reader_versions r JOIN assets a ON a.id=r.index_asset_id WHERE r.id=$1' : kind==='chunk' ? 'SELECT a.object_key FROM web_reader_chunks r JOIN assets a ON a.id=r.data_asset_id WHERE r.reader_version_id=$1' : 'SELECT a.object_key FROM web_source_files f JOIN assets a ON a.id=f.asset_id JOIN web_reader_versions r ON r.source_version_id=f.source_version_id WHERE r.id=$1';
  const old=(await t.db.pool.query(query,[t.saved.readerVersionId])).rows[0];
  await t.store.deleteUnreferenced(old.object_key);
  expect((await t.request(`/api/v1/documents/${t.saved.documentId}/trash`,'POST',{expectedEpoch:1})).statusCode).toBe(200);
  const restored=await t.request(`/api/v1/documents/${t.saved.documentId}/restore`,'POST',{expectedEpoch:2});
  expect(restored.statusCode).toBe(409); expect(restored.json().error.code).toBe('RESTORE_MATERIAL_UNAVAILABLE');
});
it('retains durable work on a local disk failure and cleans it after repair',async()=>{
  const {writeFile,unlink,mkdir}=await import('node:fs/promises'); const {join}=await import('node:path');
  const {documentMaintenanceProcess}=await import('../helpers/document-maintenance-process.js');
  const t=await fixture(),created=await t.create(); expect(created.statusCode).toBe(201);
  const directory=join(t.config.dataDir,'export-staging'); await writeFile(directory,'owned obstruction');
  await runWebJob((await claimWebJob('disk-failure',t.db))!,{db:t.db,store:t.store,config:t.config,signal:new AbortController().signal});
  expect((await t.request(`${t.url}/${created.json().id}`)).json()).toMatchObject({status:'failed',errorCode:'EXPORT_FAILED'});
  const schema=(await t.db.pool.query('SELECT current_schema() AS name')).rows[0].name;
  const failed=await documentMaintenanceProcess(schema,t.config.dataDir); expect(failed.failed).toBe(1);
  expect((await t.db.pool.query('SELECT attempts,error_code FROM registered_object_work')).rows[0]).toMatchObject({attempts:1,error_code:'CLEANUP_RETRY'});
  await unlink(directory); await mkdir(directory,{mode:0o700});
  await t.db.pool.query('UPDATE registered_object_work SET next_attempt_at=clock_timestamp()');
  await documentMaintenanceProcess(schema,t.config.dataDir);
  expect((await t.db.pool.query('SELECT 1 FROM registered_object_work')).rowCount).toBe(0);
});
it('charges nested workspace files and purges to the same whole-call deletion budget',async()=>{
  const {mkdir,writeFile,readdir}=await import('node:fs/promises'); const {join}=await import('node:path');
  const {runDocumentMaintenance}=await import('../../src/document-lifecycle/maintenance.js');
  const t=await fixture(),created=await t.create(); expect(created.statusCode).toBe(201);
  const lease=(await claimWebJob('budget-writer',t.db))!;
  const base=join(t.config.dataDir,'export-staging'); await mkdir(base,{mode:0o700});
  for(let i=0;i<30;i++) {
    const id=randomUUID(),key=randomUUID(),folder=join(base,key),nested=join(folder,`.pagelingo-bundle-${randomUUID()}`);
    await mkdir(nested,{recursive:true,mode:0o700}); await writeFile(join(folder,'output.zip'),'zip'); await writeFile(join(nested,'archive.zip'),'temp');
    await t.db.pool.query(`INSERT INTO registered_object_work(id,owner_id,document_id,job_id,job_epoch,writer_owner,slot_id,slot_epoch,writer_until,writer_stopped)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp(),true)`,[id,t.actor.userId,t.saved.documentId,lease.jobId,lease.epoch,lease.leaseOwner,lease.slotId,lease.slotEpoch]);
    await t.db.pool.query("INSERT INTO object_deletion_queue(owner_id,work_id,storage_kind,object_key) VALUES($1,$2,'export-staging',$3)",[t.actor.userId,id,key]);
  }
  const other=(await t.db.pool.query("INSERT INTO documents(owner_id,kind,title,original_filename) VALUES($1,'pdf','Purge fairness','fair.pdf') RETURNING id",[t.actor.userId])).rows[0].id;
  const objectKey=randomUUID(), stored=await t.store.putImmutable(objectKey,(async function*(){yield Buffer.from('owned');})(),100);
  await t.db.pool.query("INSERT INTO assets(owner_id,document_id,object_key,sha256,bytes,media_type) VALUES($1,$2,$3,$4,$5,'text/plain')",[t.actor.userId,other,objectKey,stored.sha256,stored.bytes]);
  await t.request(`/api/v1/documents/${other}/trash`,'POST',{expectedEpoch:1});
  await t.app.inject({method:'DELETE',url:`/api/v1/trash/${other}`,headers:t.headers});
  const result=await runDocumentMaintenance({db:t.db,store:t.store,dataDir:t.config.dataDir,signal:new AbortController().signal});
  await expect(t.store.stat(objectKey)).rejects.toThrow();
  // A busy temporary-work class must leave capacity for permanent purges in this call.
  expect((await readdir(base)).length).toBeGreaterThanOrEqual(10); expect(result.rowsDeleted).toBeLessThanOrEqual(500);
  expect(result.objectsDeleted).toBeLessThanOrEqual(100);
});
it('keeps writer-attempt lease identities immutable in the database',async()=>{
  const t=await fixture(),created=await t.create(); expect(created.statusCode).toBe(201);
  await runWebJob((await claimWebJob('immutable-attempt',t.db))!,{db:t.db,store:t.store,config:t.config,signal:new AbortController().signal});
  await expect(t.db.pool.query('UPDATE registered_object_work SET job_epoch=job_epoch+1')).rejects.toThrow('Immutable registered writer');
});
it('exports partial imported translations and preserves their original registered bytes',async()=>{
  const {withCandidates}=await import('../helpers/web-capture.js'); const {createHash}=await import('node:crypto');
  const {writeFile}=await import('node:fs/promises'); const {join}=await import('node:path');
  const {createArchiveFileSource,validateWebBundle}=await import('@pagelingo/document-bundle'); const {defaultBundleLimits}=await import('@pagelingo/document-contracts');
  const t=await jobFixture(); closes.push(t.close);
  const captured=await withCandidates('<article><p>First original paragraph.</p><p>Second original paragraph.</p></article>');
  const payload=JSON.parse(captured.translation.toString()); payload.blocks=payload.blocks.slice(0,1); captured.translation=Buffer.from(JSON.stringify(payload));
  Object.assign(captured.manifest.files.find(f=>f.id==='translation')!,{bytes:captured.translation.length,sha256:createHash('sha256').update(captured.translation).digest('hex')});
  const admission=await t.app.inject({method:'POST',url:'/api/v1/captures',headers:{...t.headers,'idempotency-key':captured.manifest.captureId},payload:{manifest:captured.manifest,translationIntent:'none'}}); expect(admission.statusCode).toBe(201);
  for(const file of captured.manifest.files) expect((await t.app.inject({method:'PUT',url:`/api/v1/captures/${admission.json().id}/files/${file.id}`,headers:{...t.headers,'content-type':file.mediaType},payload:file.id==='html'?captured.body:captured.translation})).statusCode).toBe(200);
  const committed=await t.request(`/api/v1/captures/${admission.json().id}/commit`,'POST',{}); expect(committed.statusCode).toBe(200); const saved=committed.json();
  const base=`/api/v1/documents/${saved.documentId}/web-exports`;
  const created=await t.app.inject({method:'POST',url:base,headers:{...t.headers,'idempotency-key':randomUUID()},payload:{readerVersionId:saved.readerVersionId}}); expect(created.statusCode).toBe(201);
  await runWebJob((await claimWebJob('partial-export',t.db))!,{db:t.db,store:t.store,config:t.config,signal:new AbortController().signal});
  const file=await t.request(`${base}/${created.json().id}/file`); expect(file.statusCode,file.body).toBe(200);
  const path=join(t.config.dataDir,'partial.zip'); await writeFile(path,file.rawPayload);
  const source=createArchiveFileSource(path,defaultBundleLimits), validated=await validateWebBundle(source,{limits:defaultBundleLimits});
  expect(validated.translation?.status).toBe('partial'); expect(validated.translation?.generationKind).toBe('import');
  const registered=(await t.db.pool.query('SELECT a.* FROM web_translation_runs t JOIN assets a ON a.id=t.translation_asset_id WHERE t.document_id=$1',[saved.documentId])).rows[0];
  expect(validated.manifest.translation?.sha256).toBe(registered.sha256);
  const {readWebAsset}=await import('../../src/web-readers/assets.js'); const chunks=[]; for await(const chunk of source.read('translation.json')) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(await readWebAsset(t.store,registered));
});
it('refuses a symlinked export workspace instead of writing outside registered storage',async()=>{
  const {mkdir,symlink,readdir}=await import('node:fs/promises'); const {join}=await import('node:path');
  const t=await fixture(),created=await t.create(); expect(created.statusCode).toBe(201);
  const outside=join(t.config.dataDir,'outside'); await mkdir(outside); await symlink(outside,join(t.config.dataDir,'export-staging'));
  await runWebJob((await claimWebJob('symlink-worker',t.db))!,{db:t.db,store:t.store,config:t.config,signal:new AbortController().signal});
  expect((await t.request(`${t.url}/${created.json().id}`)).json().status).toBe('failed');
  expect(await readdir(outside)).toEqual([]);
});
it('treats capture local IDs as data and safely encodes a non-BMP download title',async()=>{
  const {capture}=await import('../helpers/web-capture.js'); const t=await jobFixture(); closes.push(t.close);
  const captured=capture(); captured.manifest.htmlFileId='constructor'; captured.manifest.files[0]!.id='constructor';
  const admission=await t.app.inject({method:'POST',url:'/api/v1/captures',headers:{...t.headers,'idempotency-key':captured.manifest.captureId},payload:{manifest:captured.manifest,translationIntent:'none'}}); expect(admission.statusCode).toBe(201);
  expect((await t.app.inject({method:'PUT',url:`/api/v1/captures/${admission.json().id}/files/constructor`,headers:{...t.headers,'content-type':'text/html'},payload:captured.body})).statusCode).toBe(200);
  const committed=await t.request(`/api/v1/captures/${admission.json().id}/commit`,'POST',{}); expect(committed.statusCode).toBe(200); const saved=committed.json();
  await t.db.pool.query('UPDATE documents SET title=$2 WHERE id=$1',[saved.documentId,'a'.repeat(149)+'😀']);
  const base=`/api/v1/documents/${saved.documentId}/web-exports`;
  const created=await t.app.inject({method:'POST',url:base,headers:{...t.headers,'idempotency-key':randomUUID()},payload:{readerVersionId:saved.readerVersionId}}); expect(created.statusCode).toBe(201);
  await runWebJob((await claimWebJob('opaque-local-id',t.db))!,{db:t.db,store:t.store,config:t.config,signal:new AbortController().signal});
  const state=await t.request(`${base}/${created.json().id}`); expect(state.json().status).toBe('completed');
  const file=await t.request(`${base}/${created.json().id}/file`); expect(file.statusCode).toBe(200); expect(file.headers['content-disposition']).toContain('%F0%9F%98%80');
});
