import { afterEach, expect, it } from 'vitest';
import type { TranslationProvider } from '@pagelingo/translation-core';
import { claimWebJob } from '../../src/web-jobs/lease.js';
import { runWebJob } from '../../src/web-jobs/translation-runner.js';
import { finalizeWebJob } from '../../src/web-jobs/finalize.js';
import { jobFixture } from '../helpers/web-jobs.js';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
const echo: TranslationProvider = { async generate(request) { return { translations: request.data.blocks.map(b => ({ id: b.id, text: b.protectedText })) }; } };
it('runs the real SDK with confirmed bounded immutable publications and no credentials in artifacts', async () => {
  const t = await jobFixture(); closes.push(t.close); const s = await t.save(24);
  const lease = (await claimWebJob('worker', t.db))!;
  await runWebJob(lease, { ...t, signal: new AbortController().signal, provider: echo });
  const row = (await t.db.pool.query('SELECT * FROM web_jobs WHERE id=$1', [s.jobId])).rows[0];
  expect(row.status).toBe('completed'); expect(row.completed_units).toBe(24);
  expect(row.finalized_epoch).toBe(row.epoch);
  const versions = (await t.db.pool.query('SELECT * FROM web_translation_runs WHERE job_id=$1', [s.jobId])).rows;
  expect(versions.length).toBeGreaterThanOrEqual(2); expect(versions.length).toBeLessThanOrEqual(5);
  expect((await t.request(`/api/v1/documents/${s.documentId}/web-reader`)).json().translationStatus).toBe('completed');
  const checkpoint = (await t.db.pool.query('SELECT checkpoint FROM web_job_checkpoints WHERE job_id=$1', [s.jobId])).rows[0].checkpoint;
  expect(JSON.stringify(checkpoint)).not.toContain('private-test-key');
  expect(checkpoint.units.filter((u: { status: string }) => u.status === 'completed')).toHaveLength(24);
});
it('finalizes only confirmed cancelled work once, rejecting the old worker without decrypting the changed key', async () => {
  const t = await jobFixture(); closes.push(t.close); const s = await t.save(12);
  const lease = (await claimWebJob('worker', t.db))!; let calls = 0;
  const provider: TranslationProvider = { async generate(request) {
    calls++;
    if (calls === 2) await t.request(`/api/v1/web-jobs/${s.jobId}/cancel`, 'POST', {});
    return echo.generate(request, new AbortController().signal);
  } };
  await runWebJob(lease, { ...t, signal: new AbortController().signal, provider });
  await t.profile(1);
  await finalizeWebJob(s.jobId, { db: t.db, store: t.store, generationKind: 'mock' });
  const first = (await t.db.pool.query('SELECT * FROM web_jobs WHERE id=$1', [s.jobId])).rows[0];
  expect(first.status).toBe('cancelled'); expect(first.completed_units).toBeGreaterThan(0);
  expect(first.completed_units).toBeLessThan(12);
  await finalizeWebJob(s.jobId, { db: t.db, store: t.store, generationKind: 'mock' });
  expect((await t.db.pool.query('SELECT reader_version_id FROM web_jobs WHERE id=$1', [s.jobId])).rows[0].reader_version_id).toBe(first.reader_version_id);
  expect((await t.request(`/api/v1/documents/${s.documentId}/web-reader?versionId=${first.reader_version_id}`)).json().translationStatus).toBe('partial');
});
it('test-mode workers reject missing mocks before attempting any endpoint', async () => {
  const t = await jobFixture(); closes.push(t.close); await t.save();
  const lease = (await claimWebJob('worker', t.db))!;
  await expect(runWebJob(lease,{...t,signal:new AbortController().signal})).rejects.toThrow('Test jobs require explicit mocks');
});
it('late old worker and terminal publication cannot replace a newer source Reader', async () => {
  const t = await jobFixture(); closes.push(t.close); const old = await t.save(12);
  const oldLease=(await claimWebJob('old',t.db))!;
  let reached!: () => void, release!: () => void;
  const ready=new Promise<void>(r => {reached=r;}), gate=new Promise<void>(r => {release=r;});
  let held=false;
  const store={...t.store, async putImmutable(...args: Parameters<typeof t.store.putImmutable>) {
    const result=await t.store.putImmutable(...args); if (!held) {held=true;reached();await gate;} return result;
  }};
  const oldWork=runWebJob(oldLease,{...t,store,provider:echo,signal:new AbortController().signal});
  await ready;
  try {
    await t.request(`/api/v1/web-jobs/${old.jobId}/cancel`,'POST',{});
    const fresh=await t.save(14,'New revised source');
    const lease=(await claimWebJob('new',t.db))!;
    await runWebJob(lease,{...t,provider:echo,signal:new AbortController().signal});
    const newVersion=(await t.db.pool.query('SELECT current_web_reader_version_id FROM documents WHERE id=$1',[fresh.documentId])).rows[0].current_web_reader_version_id;
    release();await oldWork;
    await finalizeWebJob(old.jobId,{db:t.db,store:t.store,generationKind:'mock'});
    const currentVersionAfterLateOldPublish=(await t.db.pool.query('SELECT current_web_reader_version_id FROM documents WHERE id=$1',[fresh.documentId])).rows[0].current_web_reader_version_id;
    expect(currentVersionAfterLateOldPublish).toBe(newVersion);
    expect((await t.db.pool.query('SELECT reader_version_id FROM web_jobs WHERE id=$1',[old.jobId])).rows[0].reader_version_id).not.toBeNull();
  } finally {release();await oldWork;}
});
it('GC removing an unregistered artifact before publication prevents dangling Reader references', async () => {
  const { utimes }=await import('node:fs/promises'); const {join}=await import('node:path');
  const { cleanupStaging }=await import('../../src/cli/cleanup-staging.js');
  const t=await jobFixture();closes.push(t.close);const s=await t.save();
  const lease=(await claimWebJob('worker',t.db))!;let collected=false;
  const store={...t.store,async putImmutable(...args:Parameters<typeof t.store.putImmutable>) {
    const stored=await t.store.putImmutable(...args);
    if (!collected) {collected=true;const age=new Date(Date.now()-25*3600000);await utimes(join(t.config.dataDir,'objects',args[0]),age,age);expect((await cleanupStaging({db:t.db,dataDir:t.config.dataDir})).objects).toBe(1);}
    return stored;
  }};
  await runWebJob(lease,{...t,store,provider:echo,signal:new AbortController().signal});
  expect((await t.db.pool.query('SELECT id FROM web_translation_runs WHERE job_id=$1',[s.jobId])).rows).toEqual([]);
  expect((await t.request(`/api/v1/documents/${s.documentId}/web-reader`)).json().versionId).toBe(s.readerVersionId);
  // A fresh finalizer reuses the confirmed checkpoint and produces a new immutable artifact.
  await finalizeWebJob(s.jobId,{db:t.db,store:t.store,generationKind:'mock'});
  expect((await t.db.pool.query('SELECT reader_version_id FROM web_jobs WHERE id=$1',[s.jobId])).rows[0].reader_version_id).not.toBeNull();
});
it('a retry after terminal partial publication retains completed work and publishes the new epoch', async () => {
  const t=await jobFixture();closes.push(t.close);const s=await t.save(12);let calls=0;
  const provider:TranslationProvider={async generate(request,signal) {if(++calls===2) await t.request(`/api/v1/web-jobs/${s.jobId}/cancel`,'POST',{});return echo.generate(request,signal);}};
  await runWebJob((await claimWebJob('first',t.db))!,{...t,provider,signal:new AbortController().signal});
  await finalizeWebJob(s.jobId,{db:t.db,store:t.store,generationKind:'mock'});
  const previous=(await t.db.pool.query('SELECT * FROM web_jobs WHERE id=$1',[s.jobId])).rows[0];
  expect(previous.publication_milestone).toBe(4);
  expect((await t.request(`/api/v1/web-jobs/${s.jobId}/retry`,'POST',{profileRevision:1,glossaryRevision:0})).statusCode).toBe(200);
  await runWebJob((await claimWebJob('retry',t.db))!,{...t,provider:echo,signal:new AbortController().signal});
  const current=(await t.db.pool.query('SELECT * FROM web_jobs WHERE id=$1',[s.jobId])).rows[0];
  expect(current.status).toBe('completed');expect(current.finalized_epoch).toBe(current.epoch);
  expect(current.reader_version_id).not.toBe(previous.reader_version_id);
  expect((await t.request(`/api/v1/documents/${s.documentId}/web-reader`)).json().translationStatus).toBe('completed');
});
it('an in-flight terminal finalizer is fenced by retry before it can register artifacts', async () => {
  const t=await jobFixture();closes.push(t.close);const s=await t.save(12);let calls=0;
  const provider:TranslationProvider={async generate(request,signal) {if(++calls===2) await t.request(`/api/v1/web-jobs/${s.jobId}/cancel`,'POST',{});return echo.generate(request,signal);}};
  await runWebJob((await claimWebJob('first',t.db))!,{...t,provider,signal:new AbortController().signal});
  let retry=false;
  const store={...t.store,async putImmutable(...args:Parameters<typeof t.store.putImmutable>) {const stored=await t.store.putImmutable(...args);if(!retry){retry=true;await t.request(`/api/v1/web-jobs/${s.jobId}/retry`,'POST',{profileRevision:1,glossaryRevision:0});}return stored;}};
  await expect(finalizeWebJob(s.jobId,{db:t.db,store,generationKind:'mock'})).rejects.toThrow('no longer current');
  expect((await t.db.pool.query('SELECT status,finalized_epoch FROM web_jobs WHERE id=$1',[s.jobId])).rows[0]).toMatchObject({status:'queued',finalized_epoch:null});
});
it('fetch worker publication installs the real automatic scheduler exactly once', async () => {
  const {randomUUID}=await import('node:crypto');const t=await jobFixture();closes.push(t.close);
  await t.request('/api/v1/settings/save-preferences','PUT',{expectedRevision:0,autoTranslate:true});
  const created=await t.app.inject({url:'/api/v1/documents/links',method:'POST',headers:{...t.headers,'idempotency-key':randomUUID()},payload:{url:'https://public.example/article',translationIntent:'auto'}});
  expect(created.statusCode,created.body).toBe(201);
  const lease=(await claimWebJob('fetch-worker',t.db))!;expect(lease.kind).toBe('fetch-link');
  await runWebJob(lease,{...t,signal:new AbortController().signal,captureFetch:async () => new Response('<html><title>A technical article</title><article><h1>Original software article</h1>'+Array.from({length:8},()=>'<p>The reader can save this original article and read the source. The software system has several useful features and the following documentation explains how the application works.</p>').join('')+'</article></html>',{headers:{'content-type':'text/html'}})});
  const jobs=(await t.db.pool.query('SELECT * FROM web_jobs ORDER BY created_at')).rows;
  expect(jobs).toHaveLength(2);expect(jobs[0].status).toBe('completed');expect(jobs[1].kind).toBe('translate');expect(jobs[1].status).toBe('queued');
  expect(jobs[1].source_version_id).not.toBeNull();expect(jobs[1].id).not.toBe(jobs[0].id);
});
it('aborts and cancels an active SDK SSE body when the profile changes', async () => {
  const {OpenAICompatibleProvider}=await import('@pagelingo/translation-core');
  const t=await jobFixture();closes.push(t.close);const s=await t.save();
  let started!:()=>void;const ready=new Promise<void>(r=>{started=r;});let cancelled=false;
  const provider=new OpenAICompatibleProvider({baseUrl:'https://mock.example/v1',model:'mock',stream:true,fetch:async()=>new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{\\"translations\\":["}}]}\n\n'));started();},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}})});
  const work=runWebJob((await claimWebJob('worker',t.db))!,{...t,provider,signal:new AbortController().signal});
  await ready;await t.profile(1);await work;
  expect(cancelled).toBe(true);
  expect((await t.db.pool.query('SELECT status FROM web_jobs WHERE id=$1',[s.jobId])).rows[0].status).toBe('paused-config');
});
it('replays immutable glossary snapshots with the public SDK and records honest mock provenance', async () => {
  const t=await jobFixture();closes.push(t.close);
  await t.request('/api/v1/settings/glossary','PUT',{expectedRevision:0,entries:[{source:'software',target:'软件',policy:'translate',domain:'all'}]});
  const s=await t.save(3);
  await t.request('/api/v1/settings/glossary','PUT',{expectedRevision:1,entries:[]});
  await runWebJob((await claimWebJob('worker',t.db))!,{...t,provider:echo,signal:new AbortController().signal});
  const reader=(await t.request(`/api/v1/documents/${s.documentId}/web-reader`)).json();
  expect(reader.translationStatus).toBe('completed');expect(reader.index.generationKind).toBe('mock');
  const artifact=(await t.db.pool.query('SELECT a.object_key FROM web_translation_runs r JOIN assets a ON a.id=r.translation_asset_id WHERE r.job_id=$1 ORDER BY r.created_at DESC LIMIT 1',[s.jobId])).rows[0];
  const chunks=[];for await(const bytes of t.store.read(artifact.object_key)) chunks.push(Buffer.from(bytes));
  const translation=JSON.parse(Buffer.concat(chunks).toString());
  expect(translation.glossary[0].target).toBe('软件');expect(translation.glossary).toHaveLength(1);
  const chunk=(await t.request(`/api/v1/documents/${s.documentId}/web-reader/versions/${reader.versionId}/chunks/${reader.index.chunks[0].id}`)).json();
  expect(JSON.stringify(chunk)).toContain('软件');
});
it('backs off bad terminal artifacts before LIMIT so later healthy jobs and new epochs can finalize', async () => {
  const {runWorker}=await import('../../src/worker/main.js');const {eventually}=await import('../helpers/web-jobs.js');
  const t=await jobFixture();closes.push(t.close);const s=await t.save(14);
  await t.request(`/api/v1/web-jobs/${s.jobId}/cancel`,'POST',{});
  const reader=(await t.request(`/api/v1/documents/${s.documentId}/web-reader`)).json();
  const blocks=Object.keys(reader.index.blockLocations);const ids:string[]=[];
  for(let i=1;i<=11;i++) {
    const result=await t.request(`/api/v1/documents/${s.documentId}/web-jobs`,'POST',{sourceVersionId:s.sourceVersionId,parseId:reader.parseId,profileRevision:1,glossaryRevision:0,selectionBlockIds:blocks.slice(0,i)});
    expect(result.statusCode,result.body).toBe(201);ids.push(result.json().id);
  }
  for(const id of ids) {
    const lease=(await claimWebJob('prepare',t.db))!;expect(lease.jobId).toBe(id);
    await runWebJob(lease,{...t,signal:new AbortController().signal,provider:{async generate(request,signal){await t.request(`/api/v1/web-jobs/${id}/cancel`,'POST',{});return echo.generate(request,signal);}}});
  }
  // Deliberately corrupt ten real confirmed checkpoints; source/IR identities remain immutable.
  for(const id of ids.slice(0,10)) await t.db.pool.query(`UPDATE web_job_checkpoints SET checkpoint=jsonb_set(checkpoint,'{blocks}','{"0":{"text":"","source":"network"}}'::jsonb) WHERE job_id=$1`,[id]);
  let reads=0;const store={...t.store,read(...args:Parameters<typeof t.store.read>){reads++;return t.store.read(...args);}};
  const controller=new AbortController();const work=runWorker({...t,store,signal:controller.signal,provider:echo,captureFetch:async()=>{throw Error('No fetch');}});
  try {
    await eventually(async()=>(await t.db.pool.query('SELECT reader_version_id FROM web_jobs WHERE id=$1',[ids[10]])).rows[0].reader_version_id,v=>v!==null,2500);
    expect(reads).toBeLessThanOrEqual(12);
    await t.db.pool.query(`UPDATE web_job_checkpoints SET checkpoint=jsonb_set(checkpoint,'{blocks}','{}'::jsonb) WHERE job_id=$1`,[ids[0]]);
    await t.request(`/api/v1/web-jobs/${ids[0]}/retry`,'POST',{profileRevision:1,glossaryRevision:0});
    await t.request(`/api/v1/web-jobs/${ids[0]}/cancel`,'POST',{});
    await eventually(async()=>(await t.db.pool.query('SELECT finalized_epoch,epoch FROM web_jobs WHERE id=$1',[ids[0]])).rows[0],v=>v.finalized_epoch===v.epoch,800);
    expect((await t.db.pool.query('SELECT next_request_at FROM web_jobs WHERE id=ANY($1::uuid[])',[ids])).rows.every(r=>r.next_request_at===null)).toBe(true);
  } finally {controller.abort();await work;}
},30000);
