import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readerTestApp, headers } from '../helpers/readers.js';
import { jobFixture, eventually } from '../helpers/web-jobs.js';
import { createLocalObjectStore } from '../../src/storage/local-object-store.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function maintenance(t: { db: import('../../src/db/database.js').Database; config: { dataDir: string } }, store = createLocalObjectStore(t.config.dataDir)) {
  const { runDocumentMaintenance } = await import('../../src/document-lifecycle/maintenance.js');
  return runDocumentMaintenance({ db: t.db, store, dataDir: t.config.dataDir, signal: new AbortController().signal }, { limit: 100 });
}
it('restores retained versions without restarting jobs', async () => {
  const t = await jobFixture(); cleanup.push(t.close); const saved = await t.save(); const base = `/api/v1/documents/${saved.documentId}`;
  const before = (await t.db.pool.query('SELECT * FROM web_reader_versions WHERE document_id=$1', [saved.documentId])).rows;
  expect((await t.request(`${base}/trash`, 'POST', { expectedEpoch: 1 })).statusCode).toBe(200);
  const result = await t.request(`${base}/restore`, 'POST', { expectedEpoch: 2 }); expect(result.statusCode, result.body).toBe(200); expect(result.json().lifecycleEpoch).toBe(3);
  expect((await t.db.pool.query('SELECT * FROM web_reader_versions WHERE document_id=$1', [saved.documentId])).rows).toEqual(before);
  expect((await t.db.pool.query('SELECT status FROM web_jobs WHERE id=$1', [saved.jobId])).rows[0].status).toBe('cancelled');
  expect((await t.request(`${base}/restore`, 'POST', { expectedEpoch: 2 })).statusCode).toBe(409);
});
it.each(['missing','corrupt'])('keeps %s originals in trash', async mode => {
  const t = await readerTestApp(cleanup); const f = await t.ingest(); const store = createLocalObjectStore(t.config.dataDir);
  const key = (await t.db.pool.query('SELECT a.object_key FROM assets a JOIN source_versions s ON s.asset_id=a.id WHERE s.document_id=$1', [f.imported.documentId])).rows[0].object_key;
  expect((await t.app.inject({ method: 'POST', url: `${f.base}/trash`, headers: headers(t.alice), payload: { expectedEpoch: 1 } })).statusCode).toBe(200);
  if (mode === 'missing') await store.deleteUnreferenced(key); else await writeFile(join(t.config.dataDir,'objects',key), 'corrupt');
  const result = await t.app.inject({ method: 'POST', url: `${f.base}/restore`, headers: headers(t.alice), payload: { expectedEpoch: 2 } }); expect(result.statusCode, result.body).toBe(409); expect(result.json().error.code).toBe('RESTORE_MATERIAL_UNAVAILABLE');
  expect((await t.db.pool.query('SELECT lifecycle_epoch,deleted_at FROM documents WHERE id=$1', [f.imported.documentId])).rows[0]).toMatchObject({ lifecycle_epoch: '2', deleted_at: expect.any(Date) });
});
it('purges owned content but retires old operation keys', async () => {
  const t = await readerTestApp(cleanup); const f = await t.ingest(); const other = await t.ingest({}, t.bob);
  await t.db.pool.query(`INSERT INTO web_owner_cache(owner_id,cache_key,entry) VALUES($1,'other-owner','{"private":"keep"}')`,[t.bob.user.id]);
  const store = createLocalObjectStore(t.config.dataDir); const sentinel = randomUUID(); await store.putImmutable(sentinel, (async function* () { yield Buffer.from('sentinel'); })(), 100);
  const keys = (await t.db.pool.query('SELECT object_key FROM assets WHERE document_id=$1', [f.imported.documentId])).rows.map(r=>r.object_key);
  const imported = (await t.db.pool.query('SELECT id,idempotency_key FROM bundle_imports WHERE document_id=$1', [f.imported.documentId])).rows[0];
  expect((await t.app.inject({ method: 'POST', url: `${f.base}/trash`, headers: headers(t.alice), payload: { expectedEpoch: 1 } })).statusCode).toBe(200);
  const list = await t.app.inject({ url: '/api/v1/trash?limit=1', headers: headers(t.alice) }); expect(list.statusCode).toBe(200); expect(list.json().items).toHaveLength(1); expect(JSON.stringify(list.json())).not.toContain('object_key');
  expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/trash/${f.imported.documentId}`, headers: headers(t.bob) })).statusCode).toBe(404);
  const queued = await t.app.inject({ method: 'DELETE', url: `/api/v1/trash/${f.imported.documentId}`, headers: headers(t.alice) }); expect(queued.statusCode).toBe(202); expect(queued.json().status).toBe('processing');
  expect((await t.app.inject({ method: 'POST', url: `${f.base}/restore`, headers: headers(t.alice), payload: { expectedEpoch: 2 } })).statusCode).toBe(409);
  for (let n=0;n<8;n++) await maintenance(t);
  const receipt = await t.app.inject({ method: 'DELETE', url: `/api/v1/trash/${f.imported.documentId}`, headers: headers(t.alice) }); expect(receipt.statusCode).toBe(202); expect(receipt.json()).toMatchObject({ id: queued.json().id, status: 'completed' });
  expect((await t.db.pool.query('SELECT id FROM documents WHERE id=$1', [f.imported.documentId])).rowCount).toBe(0);
  for (const key of keys) await expect(store.stat(key)).rejects.toThrow();
  expect((await t.db.pool.query('SELECT entry FROM web_owner_cache WHERE owner_id=$1',[t.bob.user.id])).rows).toEqual([{ entry:{ private:'keep' } }]);
  expect(await store.stat(sentinel)).toEqual({ bytes: 8 }); expect((await t.app.inject({ url: `${other.base}/reader`, headers: headers(t.bob) })).statusCode).toBe(200);
  expect((await t.app.inject({ method: 'POST', url: '/api/v1/bundle-imports', headers: { ...headers(t.alice), 'idempotency-key': imported.idempotency_key }, payload: {} })).statusCode).toBe(410);
  expect((await t.app.inject({ url: `/api/v1/bundle-imports/${imported.id}`, headers: headers(t.alice) })).statusCode).toBe(410);
  expect((await t.db.pool.query('SELECT * FROM document_metadata_backfill_cursor')).rowCount).toBe(1);
});
it('continues cleanup after one object fails', async () => {
  const t = await readerTestApp(cleanup); const f = await t.ingest(); const store = createLocalObjectStore(t.config.dataDir);
  await t.app.inject({ method: 'POST', url: `${f.base}/trash`, headers: headers(t.alice), payload: { expectedEpoch: 1 } });
  const queued = await t.app.inject({ method: 'DELETE', url: `/api/v1/trash/${f.imported.documentId}`, headers: headers(t.alice) }); expect(queued.statusCode).toBe(202);
  let failed = false; let removed = 0;
  await maintenance(t, { ...store, async deleteUnreferenced(key) { if (!failed) { failed = true; throw new Error('injected unlink failure'); } await store.deleteUnreferenced(key); removed++; } });
  expect(failed).toBe(true); expect(removed).toBeGreaterThan(0);
  const pending = (await t.db.pool.query('SELECT status,attempts,next_attempt_at>clock_timestamp() AS cooling FROM document_purges WHERE id=$1',[queued.json().id])).rows[0]; expect(pending).toMatchObject({ status: 'queued', attempts: 1, cooling: true });
  await t.db.pool.query('UPDATE document_purges SET next_attempt_at=clock_timestamp() WHERE id=$1', [queued.json().id]); await maintenance(t);
  expect((await t.db.pool.query('SELECT status FROM document_purges WHERE id=$1',[queued.json().id])).rows[0].status).toBe('completed');
});
it.each(['expiry','queued'])('advances past a busy owner beyond the bounded %s candidate page', async mode => {
  const t = await readerTestApp(cleanup);
  const docs: Array<{ id: string; owner: string }> = [];
  for (const session of [t.alice,t.alice,t.bob]) {
    const row=(await t.db.pool.query(`INSERT INTO documents(owner_id,kind,title,original_filename,deleted_at,purge_after) VALUES($1,'pdf','expired','a.pdf',clock_timestamp()-interval '31 days',clock_timestamp()-interval '1 day') RETURNING id`,[session.user.id])).rows[0];
    docs.push({ id:row.id,owner:session.user.id });
    if(mode==='queued') expect((await t.app.inject({ method:'DELETE',url:`/api/v1/trash/${row.id}`,headers:headers(session) })).statusCode).toBe(202);
  }
  const { runDocumentMaintenance }=await import('../../src/document-lifecycle/maintenance.js');
  const deps={ db:t.db,store:createLocalObjectStore(t.config.dataDir),dataDir:t.config.dataDir,signal:new AbortController().signal };
  // A real owner lock held by another connection; neither scheduler nor claimant may block on it.
  const busy=await t.db.pool.connect();
  try {
    await busy.query('BEGIN'); await busy.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[t.alice.user.id]);
    for(let i=0;i<4;i++) await runDocumentMaintenance(deps,{ limit:1 });
    expect((await t.db.pool.query('SELECT status FROM document_purges WHERE document_id=$1',[docs[2]!.id])).rows[0]?.status).toBe('completed');
    expect((await t.db.pool.query('SELECT id FROM documents WHERE owner_id=$1',[t.alice.user.id])).rowCount).toBe(2);
  } finally { await busy.query('ROLLBACK'); busy.release(); }
});
it('enforces one total row and file budget while preserving another own document', async () => {
  const t=await readerTestApp(cleanup); const f=await t.ingest();
  const other=(await t.db.pool.query(`INSERT INTO documents(owner_id,kind,title,original_filename) VALUES($1,'pdf','keep','keep.pdf') RETURNING id`,[t.alice.user.id])).rows[0].id;
  const store=createLocalObjectStore(t.config.dataDir);
  for(let i=0;i<105;i++) {
    const key=randomUUID(); const stored=await store.putImmutable(key,(async function*(){ yield Buffer.from('fixture'); })(),100);
    await t.db.pool.query(`INSERT INTO assets(owner_id,document_id,object_key,sha256,bytes,media_type) VALUES($1,$2,$3,$4,$5,'text/plain')`,[t.alice.user.id,f.imported.documentId,key,stored.sha256,stored.bytes]);
  }
  // Many real content rows force a second DB batch without cascading into their target document.
  await t.db.pool.query(`INSERT INTO web_owner_cache(owner_id,cache_key,entry) SELECT $1,'legacy-'||n,'{"text":"old"}'::jsonb FROM generate_series(1,650) n`,[t.alice.user.id]);
  await t.app.inject({ method:'POST',url:`${f.base}/trash`,headers:headers(t.alice),payload:{ expectedEpoch:1 } });
  await t.app.inject({ method:'DELETE',url:`/api/v1/trash/${f.imported.documentId}`,headers:headers(t.alice) });
  const one=await maintenance(t); expect(one.rowsDeleted).toBeLessThanOrEqual(500); expect(one.objectsDeleted).toBe(100);
  expect((await t.db.pool.query('SELECT status FROM document_purges WHERE document_id=$1',[f.imported.documentId])).rows[0].status).toBe('queued');
  for(let i=0;i<4;i++) { const result=await maintenance(t); expect(result.rowsDeleted).toBeLessThanOrEqual(500); expect(result.objectsDeleted).toBeLessThanOrEqual(100); }
  expect((await t.db.pool.query('SELECT status FROM document_purges WHERE document_id=$1',[f.imported.documentId])).rows[0].status).toBe('completed');
  expect((await t.db.pool.query('SELECT id FROM documents WHERE id=$1',[other])).rowCount).toBe(1);
  expect((await t.db.pool.query('SELECT 1 FROM web_owner_cache WHERE owner_id=$1',[t.alice.user.id])).rowCount).toBe(0);
});
it('purges Web Readers, checkpoints and all associated operation domains without invoking a model', async () => {
  const t=await jobFixture(); cleanup.push(t.close); const saved=await t.save();
  const { startWorker }=await import('../helpers/worker-process.js'); const worker=await startWorker(t); cleanup.push(worker.stop);
  await eventually(async ()=>(await t.db.pool.query('SELECT status FROM web_jobs WHERE id=$1',[saved.jobId])).rows[0].status,status=>status==='completed'); await worker.stop();
  expect((await t.db.pool.query('SELECT id FROM web_translation_runs WHERE document_id=$1',[saved.documentId])).rowCount).toBeGreaterThan(0);
  const job=(await t.db.pool.query('SELECT * FROM web_jobs WHERE id=$1',[saved.jobId])).rows[0];
  const requestId=randomUUID();
  // A manual request uses exactly the persisted document/auth/request scope.
  await t.db.pool.query(`INSERT INTO web_jobs(id,owner_id,document_id,auth_version,kind,input_sha256,source_version_id,parse_id,profile_revision,glossary_revision,request_id,document_epoch)
    VALUES($1,$2,$3,$4,'translate',$5,$6,$7,$8,$9,$10,1)`,[randomUUID(),t.actor.userId,saved.documentId,job.auth_version,'f'.repeat(64),job.source_version_id,job.parse_id,job.profile_revision,job.glossary_revision,requestId]);
  await t.db.pool.query('INSERT INTO web_job_checkpoints(owner_id,job_id,epoch,input_sha256,checkpoint) VALUES($1,$2,0,$3,$4) ON CONFLICT(owner_id,job_id) DO UPDATE SET checkpoint=EXCLUDED.checkpoint',[t.actor.userId,saved.jobId,job.input_sha256,{ text:'private checkpoint' }]);
  const captureRow=(await t.db.pool.query('SELECT id,capture_id FROM web_captures WHERE document_id=$1',[saved.documentId])).rows[0];
  await t.request(`/api/v1/documents/${saved.documentId}/trash`,'POST',{ expectedEpoch:1 });
  await t.app.inject({ method:'DELETE',url:`/api/v1/trash/${saved.documentId}`,headers:t.headers });
  for(let i=0;i<4;i++) await maintenance(t);
  expect((await t.db.pool.query('SELECT status FROM document_purges WHERE document_id=$1',[saved.documentId])).rows[0].status).toBe('completed');
  const { assertOperationNotRetired }=await import('../../src/document-lifecycle/retired-identities.js');
  for(const [kind,key] of [['web-capture',captureRow.capture_id],['web-capture-id',captureRow.id],['web-job',saved.jobId]] as const) await expect(t.db.transaction(c=>assertOperationNotRetired(c,t.actor.userId,kind,key.toUpperCase()))).rejects.toMatchObject({ code:'DOCUMENT_PURGED' });
  await expect(t.db.transaction(c=>assertOperationNotRetired(c,t.actor.userId,'web-job-request',requestId.toUpperCase(),{ documentId:saved.documentId.toUpperCase(),authVersion:job.auth_version }))).rejects.toMatchObject({ code:'DOCUMENT_PURGED' });
  for(const table of ['assets','web_sources','web_reader_versions','web_translation_runs','web_parse_runs','web_jobs','web_job_checkpoints','web_captures','web_capture_files']) expect((await t.db.pool.query(`SELECT 1 FROM ${table} WHERE owner_id=$1`,[t.actor.userId])).rowCount,table).toBe(0);
});
it('keeps shared owner cache until its final document reference, clears legacy only once', async () => {
  const t=await jobFixture(); cleanup.push(t.close); const saved=await t.save();
  const other=(await t.db.pool.query(`INSERT INTO documents(owner_id,kind,title,original_filename) VALUES($1,'pdf','keep','keep.pdf') RETURNING id`,[t.actor.userId])).rows[0].id;
  await t.db.pool.query(`INSERT INTO web_owner_cache(owner_id,cache_key,entry) VALUES($1,'shared','{}'),($1,'only','{}'),($1,'legacy','{}')`,[t.actor.userId]);
  await t.db.pool.query(`INSERT INTO web_cache_document_refs(owner_id,document_id,document_epoch,cache_key) VALUES($1,$2,1,'shared'),($1,$2,1,'only'),($1,$3,1,'shared')`,[t.actor.userId,saved.documentId,other]);
  await t.request(`/api/v1/documents/${saved.documentId}/trash`,'POST',{ expectedEpoch:1 }); await t.app.inject({ method:'DELETE',url:`/api/v1/trash/${saved.documentId}`,headers:t.headers }); await maintenance(t);
  expect((await t.db.pool.query('SELECT cache_key FROM web_owner_cache WHERE owner_id=$1',[t.actor.userId])).rows).toEqual([{ cache_key:'shared' }]);
  await t.db.pool.query(`INSERT INTO web_owner_cache(owner_id,cache_key,entry) VALUES($1,'later-unattributed','{}')`,[t.actor.userId]);
  await t.request(`/api/v1/documents/${other}/trash`,'POST',{ expectedEpoch:1 }); await t.app.inject({ method:'DELETE',url:`/api/v1/trash/${other}`,headers:t.headers }); await maintenance(t);
  expect((await t.db.pool.query('SELECT cache_key FROM web_owner_cache WHERE owner_id=$1',[t.actor.userId])).rows).toEqual([{ cache_key:'later-unattributed' }]);
});
it('expires at the database deadline and leaves the not-yet-due document retained', async () => {
  const t=await jobFixture(); cleanup.push(t.close);
  const ids=[];
  for(const delta of ['-1 second','1 day']) {
    ids.push((await t.db.pool.query(`INSERT INTO documents(owner_id,kind,title,original_filename,deleted_at,purge_after) VALUES($1,'pdf','expiry','a.pdf',clock_timestamp()-interval '30 days',clock_timestamp()+$2::interval) RETURNING id`,[t.actor.userId,delta])).rows[0].id);
  }
  const result=await maintenance(t); expect(result.scheduled).toBe(1); expect(result.completed).toBe(1);
  expect((await t.db.pool.query('SELECT id FROM documents WHERE owner_id=$1',[t.actor.userId])).rows).toEqual([{ id:ids[1] }]);
});
it('serializes a restore paused during material hashing against permanent purge', async () => {
  const t=await jobFixture(); cleanup.push(t.close); const saved=await t.save();
  await t.request(`/api/v1/documents/${saved.documentId}/trash`,'POST',{ expectedEpoch:1 });
  const { restoreDocument }=await import('../../src/document-lifecycle/restore.js');
  let entered!:()=>void; let release!:()=>void; let first=true;
  const reached=new Promise<void>(r=>{entered=r;}); const held=new Promise<void>(r=>{release=r;});
  const pending=restoreDocument({ db:t.db,store:{ ...t.store,async *read(key,range) { yield* t.store.read(key,range); if(first) { first=false; entered(); await held; } } } },t.actor,saved.documentId,2).then(value=>({ value }),error=>({ error }));
  await reached;
  try {
    // Hash I/O is outside a transaction and holds no owner lock.
    await expect(t.db.transaction(c=>c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT',[t.actor.userId]))).resolves.toHaveProperty('rowCount',1);
    expect((await t.app.inject({ method:'DELETE',url:`/api/v1/trash/${saved.documentId}`,headers:t.headers })).statusCode).toBe(202);
  } finally { release(); }
  expect(await pending).toMatchObject({ error:{ code:'DOCUMENT_PURGING' } }); await maintenance(t);
  expect((await t.db.pool.query('SELECT id FROM documents WHERE id=$1',[saved.documentId])).rowCount).toBe(0);
});
it('retires old link and PDF keys and permits genuinely fresh operations after purge', async () => {
  const t=await jobFixture(); cleanup.push(t.close);
  const linkKey=randomUUID(); const input={ url:'https://www.zhihu.com/question/purge',translationIntent:'none' };
  const saveLink=(key:string)=>t.app.inject({ method:'POST',url:'/api/v1/documents/links',headers:{ ...t.headers,'idempotency-key':key },payload:input });
  const oldLink=(await saveLink(linkKey)).json();
  await t.request(`/api/v1/documents/${oldLink.documentId}/trash`,'POST',{ expectedEpoch:1 }); await t.app.inject({ method:'DELETE',url:`/api/v1/trash/${oldLink.documentId}`,headers:t.headers }); await maintenance(t);
  expect((await saveLink(linkKey.toUpperCase())).statusCode).toBe(410);
  const newLink=await saveLink(randomUUID()); expect(newLink.statusCode).toBe(201); expect(newLink.json().documentId).not.toBe(oldLink.documentId);
  const { createDocumentsService }=await import('../../src/documents/service.js'); const service=createDocumentsService(t);
  const pdf=(key:string)=>({ idempotencyKey:key,originalFilename:'a.pdf',body:(async function*(){ yield Buffer.from('%PDF-1.7\nretired source'); })() });
  const old=await service.savePdf(t.actor,pdf('Opaque-Key'));
  await t.request(`/api/v1/documents/${old.id}/trash`,'POST',{ expectedEpoch:1 });
  let entered!:()=>void; let release!:()=>void;
  const reached=new Promise<void>(r=>{entered=r;}); const held=new Promise<void>(r=>{release=r;});
  const late=service.savePdf(t.actor,{ ...pdf('Admitted-Before-Purge'),body:(async function*(){ entered(); await held; yield Buffer.from('%PDF-1.7\nretired source'); })() }).then(value=>({ value }),error=>({ error }));
  await reached;
  try { await t.app.inject({ method:'DELETE',url:`/api/v1/trash/${old.id}`,headers:t.headers }); await maintenance(t); } finally { release(); }
  expect(await late).toMatchObject({ error:{ code:'DOCUMENT_RETIRED' } });
  await expect(service.savePdf(t.actor,pdf('Opaque-Key'))).rejects.toMatchObject({ code:'DOCUMENT_PURGED' });
  const fresh=await service.savePdf(t.actor,pdf('opaque-key')); expect(fresh.id).not.toBe(old.id);
});
it('restarts durable cleanup across independent processes after a local unlink failure and abandoned lease', async () => {
  const t=await readerTestApp(cleanup); const f=await t.ingest();
  const key=(await t.db.pool.query('SELECT object_key FROM assets WHERE document_id=$1 ORDER BY object_key LIMIT 1',[f.imported.documentId])).rows[0].object_key;
  await t.app.inject({ method:'POST',url:`${f.base}/trash`,headers:headers(t.alice),payload:{ expectedEpoch:1 } });
  await t.app.inject({ method:'DELETE',url:`/api/v1/trash/${f.imported.documentId}`,headers:headers(t.alice) });
  const schema=(await t.db.pool.query('SELECT current_schema() AS schema')).rows[0].schema;
  const { documentMaintenanceProcess }=await import('../helpers/document-maintenance-process.js');
  const first=await documentMaintenanceProcess(schema,t.config.dataDir,key); expect(first.failed).toBe(1); expect(first.objectsDeleted).toBeGreaterThan(0);
  expect((await t.db.pool.query('SELECT object_key FROM object_deletion_queue')).rows).toEqual([{ object_key:key }]);
  // A killed claimant's durable lease remains authoritative until expiry, then a fresh process resumes.
  await t.db.pool.query(`UPDATE document_purges SET status='running',lease_owner=$1,lease_until=clock_timestamp()+interval '1 hour',next_attempt_at=clock_timestamp()`,[randomUUID()]);
  expect((await documentMaintenanceProcess(schema,t.config.dataDir)).claimed).toBe(0);
  await t.db.pool.query(`UPDATE document_purges SET lease_until=clock_timestamp()-interval '1 second'`);
  const results=await Promise.all([documentMaintenanceProcess(schema,t.config.dataDir),documentMaintenanceProcess(schema,t.config.dataDir)]);
  expect(results.reduce((n,result)=>n+result.completed,0)).toBe(1);
  expect((await t.db.pool.query('SELECT status FROM document_purges')).rows).toEqual([{ status:'completed' }]);
});
it.each(['pdf','web'])('fences a %s progress write held in validation through delete and real restore', async kind => {
  let release!:()=>void; let entered!:()=>void; let first=true;
  const held=new Promise<void>(r=>{release=r;}); const reached=new Promise<void>(r=>{entered=r;});
  const gate=(store:import('../../src/storage/object-store.js').ObjectStore)=>({ ...store,async *read(key:string) { if(first) { first=false; entered(); await held; } yield* store.read(key); } });
  let pending:Promise<unknown>; let lifecycle:(operation:string,epoch:number)=>Promise<{ statusCode:number }>;
  let db:import('../../src/db/database.js').Database;
  if(kind==='web') {
    const t=await jobFixture(); cleanup.push(t.close); const f=await t.save(); db=t.db;
    const descriptor=(await t.request(`/api/v1/documents/${f.documentId}/web-reader`)).json();
    const { createWebReadersService }=await import('../../src/web-readers/service.js');
    const service=createWebReadersService({ db:t.db,store:gate(t.store) });
    pending=service.updateProgress(t.actor,f.documentId,{ expectedRevision:0,position:{ readerVersionId:f.readerVersionId,sourceVersionId:f.sourceVersionId,parseId:descriptor.parseId,blockId:null,blockOffset:0,view:'content',contentMode:'source' } }).then(value=>({value}),error=>({error}));
    lifecycle=(operation,epoch)=>t.request(`/api/v1/documents/${f.documentId}/${operation}`,'POST',{ expectedEpoch:epoch });
  } else {
    const t=await readerTestApp(cleanup); const f=await t.ingest(); db=t.db;
    const descriptor=(await t.app.inject({ url:`${f.base}/reader`,headers:headers(t.alice) })).json();
    const sessionHash=(await t.db.pool.query('SELECT token_hash FROM sessions WHERE user_id=$1',[t.alice.user.id])).rows[0].token_hash;
    const actor={ userId:t.alice.user.id,role:t.alice.user.role,authVersion:1,sessionHash };
    const { createReadersService }=await import('../../src/readers/service.js');
    const service=createReadersService({ db:t.db,store:gate(createLocalObjectStore(t.config.dataDir)) });
    pending=service.updateProgress(actor,f.imported.documentId,{ expectedRevision:0,position:{ readerVersionId:f.version,sourceVersionId:descriptor.source.sourceVersionId,parseId:descriptor.parseId,blockId:null,blockOffset:0,pdfPageIndex:0,view:'split',contentMode:'source' } }).then(value=>({value}),error=>({error}));
    lifecycle=(operation,epoch)=>t.app.inject({ method:'POST',url:`${f.base}/${operation}`,headers:headers(t.alice),payload:{ expectedEpoch:epoch } });
  }
  await reached;
  try { expect((await lifecycle('trash',1)).statusCode).toBe(200); expect((await lifecycle('restore',2)).statusCode).toBe(200); } finally { release(); }
  expect(await pending).toMatchObject({ error:{ code:'DOCUMENT_EPOCH_CONFLICT' } });
  expect((await db.pool.query(`SELECT 1 FROM ${kind==='pdf'?'reading_positions':'web_reading_positions'}`)).rowCount).toBe(0);
});
it('revokes an already-started bundle stream after its first emitted chunk during purge', async () => {
  const { vi }=await import('vitest'); const storage=await import('../../src/storage/local-object-store.js'); const original=storage.createLocalObjectStore;
  let target=''; let release!:()=>void; const held=new Promise<void>(r=>{release=r;});
  const spy=vi.spyOn(storage,'createLocalObjectStore').mockImplementation(root=>{
    const store=original(root);
    return { ...store,async *read(key,range) {
      if(key!==target) { yield* store.read(key,range); return; }
      const chunks=[]; for await(const chunk of store.read(key,range)) chunks.push(Buffer.from(chunk)); const bytes=Buffer.concat(chunks);
      yield bytes.subarray(0,16); await held; yield bytes.subarray(16);
    } };
  });
  try {
    const t=await readerTestApp(cleanup); const f=await t.ingest();
    target=(await t.db.pool.query('SELECT a.object_key FROM assets a JOIN reader_versions r ON r.archive_asset_id=a.id WHERE r.id=$1',[f.version])).rows[0].object_key;
    const url=await t.app.listen({ host:'127.0.0.1',port:0 });
    const response=await fetch(`${url}${f.base}/readers/${f.version}/bundle`,{ headers:{ cookie:t.alice.cookie } });
    expect(response.status).toBe(200); const reader=response.body!.getReader(); const first=await reader.read(); expect(first.value?.byteLength).toBe(16);
    await t.app.inject({ method:'POST',url:`${f.base}/trash`,headers:headers(t.alice),payload:{ expectedEpoch:1 } });
    await t.app.inject({ method:'DELETE',url:`/api/v1/trash/${f.imported.documentId}`,headers:headers(t.alice) }); await maintenance(t,original(t.config.dataDir));
    release(); await expect(reader.read()).rejects.toThrow();
  } finally { release?.(); spy.mockRestore(); }
});
it('retires and removes an untargeted capture admitted after soft delete but before purge', async () => {
  const t=await jobFixture(); cleanup.push(t.close); const saved=await t.save();
  await t.request(`/api/v1/documents/${saved.documentId}/trash`,'POST',{ expectedEpoch:1 });
  const { capture }=await import('../helpers/web-capture.js'); const value=capture();
  const created=await t.app.inject({ method:'POST',url:'/api/v1/captures',headers:{ ...t.headers,'idempotency-key':value.manifest.captureId },payload:{ manifest:value.manifest,translationIntent:'none' } });
  expect(created.statusCode).toBe(201);
  const other=(await t.db.pool.query(`INSERT INTO documents(owner_id,kind,title,source_url) SELECT owner_id,'article','unrelated',source_url FROM documents WHERE id=$1 RETURNING id`,[saved.documentId])).rows[0].id;
  const targeted=capture();
  const otherCapture=await t.app.inject({ method:'POST',url:'/api/v1/captures',headers:{ ...t.headers,'idempotency-key':targeted.manifest.captureId },payload:{ manifest:targeted.manifest,translationIntent:'none',targetDocumentId:other } }); expect(otherCapture.statusCode).toBe(201);
  await t.app.inject({ method:'DELETE',url:`/api/v1/trash/${saved.documentId}`,headers:t.headers });
  // First admission after the exact server cutoff remains fresh even before old rows are gone.
  const fresh=capture(); const admitted=await t.app.inject({ method:'POST',url:'/api/v1/captures',headers:{ ...t.headers,'idempotency-key':fresh.manifest.captureId },payload:{ manifest:fresh.manifest,translationIntent:'none' } }); expect(admitted.statusCode).toBe(201);
  await maintenance(t);
  expect((await t.db.pool.query('SELECT id FROM web_captures WHERE id=$1',[created.json().id])).rowCount).toBe(0);
  expect((await t.db.pool.query('SELECT id FROM web_captures WHERE id=$1',[otherCapture.json().id])).rowCount).toBe(1);
  expect((await t.db.pool.query('SELECT id FROM web_captures WHERE id=$1',[admitted.json().id])).rowCount).toBe(1);
  const replay=await t.app.inject({ method:'POST',url:'/api/v1/captures',headers:{ ...t.headers,'idempotency-key':value.manifest.captureId },payload:{ manifest:value.manifest,translationIntent:'none' } }); expect(replay.statusCode).toBe(410);
  const id=admitted.json().id;
  expect((await t.app.inject({ method:'PUT',url:`/api/v1/captures/${id}/files/html`,headers:{ ...t.headers,'content-type':'text/html' },payload:fresh.body })).statusCode).toBe(200);
  const committed=await t.request(`/api/v1/captures/${id}/commit`,'POST',{}); expect(committed.statusCode).toBe(200); expect(committed.json().documentId).not.toBe(saved.documentId);
});
it('runs the explicit cleanup CLI only against an owned schema and local directory', async () => {
  const t=await jobFixture(); cleanup.push(t.close);
  await t.db.pool.query(`INSERT INTO documents(owner_id,kind,title,original_filename,deleted_at,purge_after) VALUES($1,'pdf','due','a.pdf',clock_timestamp()-interval '31 days',clock_timestamp()-interval '1 day')`,[t.actor.userId]);
  const schema=(await t.db.pool.query('SELECT current_schema() AS schema')).rows[0].schema;
  const databaseUrl=new URL(t.config.databaseUrl); databaseUrl.searchParams.set('options',`-c search_path=${schema}`);
  const { spawn }=await import('node:child_process');
  const result=await new Promise<{ code:number|null; stdout:string; stderr:string }>((resolve,reject)=>{
    const child=spawn(process.execPath,['--import','tsx',new URL('../../src/cli/cleanup-documents.ts',import.meta.url).pathname],{
      env:{ PATH:process.env.PATH,PAGELINGO_SITE_MODE:'test',PAGELINGO_SITE_ORIGIN:t.config.publicOrigin,PAGELINGO_DATA_DIR:t.config.dataDir,DATABASE_URL:databaseUrl.toString(),PAGELINGO_MASTER_KEY_ID:'test',PAGELINGO_MASTER_KEYS_JSON:JSON.stringify({ test:Buffer.alloc(32,9).toString('base64') }) },stdio:['ignore','pipe','pipe'],
    }); let stdout='',stderr=''; child.stdout.on('data',value=>{stdout+=value;}); child.stderr.on('data',value=>{stderr+=value;}); child.once('error',reject); child.once('exit',code=>resolve({ code,stdout,stderr }));
  });
  expect(result.code,result.stderr).toBe(0); expect(JSON.parse(result.stdout).cleanup).toMatchObject({ scheduled:1,completed:1 });
});
it('rejects an unknown-target bundle first admitted before purge and accepts a new admission', async () => {
  const t=await readerTestApp(cleanup); const f=await t.ingest();
  await t.app.inject({ method:'POST',url:`${f.base}/trash`,headers:headers(t.alice),payload:{ expectedEpoch:1 } });
  const key=randomUUID(); const admitted=await t.app.inject({ method:'POST',url:'/api/v1/bundle-imports',headers:{ ...headers(t.alice),'idempotency-key':key },payload:{} }); expect(admitted.statusCode).toBe(201);
  await t.app.inject({ method:'DELETE',url:`/api/v1/trash/${f.imported.documentId}`,headers:headers(t.alice) }); await maintenance(t);
  const receive=(id:string)=>t.app.inject({ method:'PUT',url:`/api/v1/bundle-imports/${id}/content`,headers:{ ...headers(t.alice),'content-type':'application/zip' },payload:f.bytes });
  const old=await receive(admitted.json().id); expect(old.statusCode).toBe(409); expect(old.json().error.code).toBe('DOCUMENT_RETIRED');
  const fresh=await t.app.inject({ method:'POST',url:'/api/v1/bundle-imports',headers:{ ...headers(t.alice),'idempotency-key':randomUUID() },payload:{} }); expect(fresh.statusCode).toBe(201);
  const saved=await receive(fresh.json().id); expect(saved.statusCode,saved.body).toBe(200); expect(saved.json().documentId).not.toBe(f.imported.documentId);
});
it('bounds and resumes normalization of unknown-target captures without sweeping unrelated ingress', async () => {
  const t=await jobFixture(); cleanup.push(t.close); const saved=await t.save();
  const { capture }=await import('../helpers/web-capture.js');
  for(let n=0;n<106;n++) {
    const value=capture(); if(n) value.manifest.source.url=`https://example.com/unrelated/${n}`;
    const result=await t.app.inject({ method:'POST',url:'/api/v1/captures',headers:{ ...t.headers,'idempotency-key':value.manifest.captureId },payload:{ manifest:value.manifest,translationIntent:'none' } }); expect(result.statusCode).toBe(201);
  }
  await t.request(`/api/v1/documents/${saved.documentId}/trash`,'POST',{ expectedEpoch:1 }); await t.app.inject({ method:'DELETE',url:`/api/v1/trash/${saved.documentId}`,headers:t.headers });
  const first=await maintenance(t); expect(first.capturesScanned).toBe(100); expect(first.rowsDeleted).toBe(0); expect(first.completed).toBe(0);
  const second=await maintenance(t); expect(second.capturesScanned).toBe(6); expect(second.completed).toBe(1);
  expect((await t.db.pool.query('SELECT 1 FROM web_captures WHERE owner_id=$1',[t.actor.userId])).rowCount).toBe(105);
});
it('ignores missing unreferenced assets from unfinished work while verifying retained Reader material', async () => {
  const t=await readerTestApp(cleanup); const f=await t.ingest();
  await t.db.pool.query(`INSERT INTO assets(owner_id,document_id,object_key,sha256,bytes,media_type) VALUES($1,$2,$3,$4,0,'application/octet-stream')`,[t.alice.user.id,f.imported.documentId,randomUUID(),'0'.repeat(64)]);
  await t.app.inject({ method:'POST',url:`${f.base}/trash`,headers:headers(t.alice),payload:{ expectedEpoch:1 } });
  const restored=await t.app.inject({ method:'POST',url:`${f.base}/restore`,headers:headers(t.alice),payload:{ expectedEpoch:2 } }); expect(restored.statusCode,restored.body).toBe(200);
  expect((await t.app.inject({ url:`${f.base}/reader`,headers:headers(t.alice) })).statusCode).toBe(200);
});
it('charges automatic expiry and cleanup to one independently counted business mutation budget', async () => {
  const t = await jobFixture(); cleanup.push(t.close);
  await t.db.pool.query(`INSERT INTO documents(owner_id,kind,title,original_filename,deleted_at,purge_after)
    SELECT $1,'pdf','expired','a.pdf',clock_timestamp()-interval '31 days',clock_timestamp()-interval '1 day' FROM generate_series(1,100)`, [t.actor.userId]);
  await t.db.pool.query(`INSERT INTO web_owner_cache(owner_id,cache_key,entry)
    SELECT $1,'legacy-budget-'||n,'{}'::jsonb FROM generate_series(1,650) n`, [t.actor.userId]);
  // Count committed row events independently of maintenance's reported counters.
  // These are the only business tables populated by this fixture; infrastructure is excluded.
  await t.db.pool.query(`CREATE TABLE test_business_mutations(table_name text NOT NULL,operation text NOT NULL);
    CREATE FUNCTION count_test_business_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO test_business_mutations VALUES(TG_TABLE_NAME,TG_OP); RETURN NULL;
    END $$;
    CREATE TRIGGER count_document_mutation AFTER UPDATE OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION count_test_business_mutation();
    CREATE TRIGGER count_cache_mutation AFTER UPDATE OR DELETE ON web_owner_cache FOR EACH ROW EXECUTE FUNCTION count_test_business_mutation();`);
  const result = await maintenance(t);
  const mutations = (await t.db.pool.query('SELECT table_name,operation,count(*)::int AS count FROM test_business_mutations GROUP BY table_name,operation')).rows;
  expect(result.scheduled).toBe(100);
  expect(mutations.find(row => row.table_name === 'documents' && row.operation === 'UPDATE')?.count).toBe(100);
  expect(mutations.filter(row => row.operation === 'DELETE').reduce((n,row) => n+row.count,0)).toBeGreaterThan(0);
  expect(mutations.reduce((n,row) => n+row.count,0)).toBe(500);
  expect((await t.db.pool.query("SELECT 1 FROM document_purges WHERE status='queued'")).rowCount).toBeGreaterThan(0);
});
