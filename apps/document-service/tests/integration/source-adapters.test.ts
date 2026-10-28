import { join, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { bootstrapAdmin } from '../../src/cli/bootstrap-admin.js';
import { createServiceTestApp } from '../helpers/app.js';
import { login } from '../helpers/session.js';
import { startWebJobLease } from '../../src/web-jobs/repository.js';
import { createLocalObjectStore } from '../../src/storage/local-object-store.js';
import { createDocumentLifecycleService } from '../../src/document-lifecycle/trash.js';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
async function setup() {
  const t = await createServiceTestApp(); closes.push(t.close);
  await bootstrapAdmin(t.db, { username: 'admin', password: 'correct password 123456' });
  const session = await login(t.app, 'admin', 'correct password 123456');
  const headers = { cookie: session.cookie, origin: t.config.publicOrigin, 'x-csrf-token': session.csrfToken };
  const actor = { userId: session.user.id, role: session.user.role, authVersion: 1, sessionHash: createHash('sha256').update(session.cookie.split('=')[1]!).digest('hex') };
  const save = async (url: string, extra = {}) => {
    const result = await t.app.inject({ method: 'POST', url: '/api/v1/documents/links', headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { url, translationIntent: 'none', ...extra } });
    expect(result.statusCode, result.body).toBe(201); return result.json() as { documentId: string; jobId: string };
  };
  const lease = (jobId: string) => t.db.transaction(c => startWebJobLease(c, { ownerId: actor.userId, jobId, slotId: 1, leaseOwner: randomUUID() }));
  return { ...t, headers, actor, save, lease, store: createLocalObjectStore(t.config.dataDir) };
}
it('queues provider fetches with a real immutable request ledger and strictly scoped refresh replay', async () => {
  const t = await setup(); const first = await t.save('https://github.com/Org/Repo');
  expect(first.jobId).toEqual(expect.any(String));
  expect((await t.db.pool.query('SELECT reference,translation_intent FROM source_requests WHERE job_id=$1', [first.jobId])).rows).toEqual([{ reference: { provider: 'github', owner: 'Org', repo: 'Repo', url: 'https://github.com/Org/Repo' }, translation_intent: 'none' }]);
  const key = randomUUID(); const refresh = (ref: string) => t.app.inject({ method: 'POST', url: `/api/v1/documents/${first.documentId}/source-refresh`, headers: { ...t.headers, 'idempotency-key': key }, payload: { ref, translationIntent: 'none' } });
  const next = await refresh('Release/CaseSensitive'); expect(next.statusCode, next.body).toBe(202); expect(next.json().jobId).not.toBe(first.jobId);
  expect((await refresh('Release/CaseSensitive')).json()).toEqual(next.json()); expect((await refresh('release/casesensitive')).statusCode).toBe(409);
  const details = await t.app.inject({ url: `/api/v1/documents/${first.documentId}/source-details`, headers: t.headers });
  expect(details.statusCode).toBe(200); expect(details.json()).toMatchObject({ kind: 'github', current: null, resolution: 'self', status: 'link-only', latestAttempt: { jobId: next.json().jobId, requestedRef: 'Release/CaseSensitive' } });
  await expect(t.db.pool.query("UPDATE source_requests SET translation_intent='auto'")).rejects.toThrow(/immutable/i);
  const paper = await t.save('https://arxiv.org/abs/2401.12345v2');
  expect((await t.app.inject({ method: 'POST', url: `/api/v1/documents/${paper.documentId}/source-refresh`, headers: { ...t.headers, 'idempotency-key': randomUUID() }, payload: { ref: 'main', translationIntent: 'none' } })).statusCode).toBe(400);
});
it('does not retarget a pre-existing article when the same URL now identifies a repository', async () => {
  const t = await setup();
  const { insertWebDocument } = await import('../../src/web-readers/repository.js');
  const oldId = randomUUID(); await t.db.transaction(c => insertWebDocument(c, { id: oldId, ownerId: t.actor.userId, kind: 'article', url: 'https://github.com/Org/Repo', title: 'Retained article' }));
  const saved = await t.save('https://github.com/Org/Repo'); expect(saved.documentId).not.toBe(oldId);
  expect((await t.db.pool.query('SELECT kind,title FROM documents WHERE id=$1', [oldId])).rows[0]).toEqual({ kind: 'article', title: 'Retained article' });
});
it('refuses arXiv test dispatch without an explicit source transport', async () => {
  const t = await setup(); const saved = await t.save('https://arxiv.org/abs/2401.12345v1'); const lease = await t.lease(saved.jobId); expect(lease).not.toBeNull();
  const { runFetchJob } = await import('../../src/web-captures/fetch-runner.js');
  const network = await import('../../src/source-adapters/network.js');
  const production = vi.spyOn(network, 'createSourceTransport').mockImplementation(() => { throw new Error('Unexpected production source transport'); });
  try {
    await expect(runFetchJob(lease!, { db: t.db, config: t.config, store: t.store, signal: new AbortController().signal })).rejects.toThrow('Test source jobs require explicit source transport');
    expect(production).not.toHaveBeenCalled();
    expect((await t.db.pool.query('SELECT status,error_code FROM web_jobs WHERE id=$1', [saved.jobId])).rows[0]).toEqual({ status: 'running', error_code: null });
    for (const table of ['source_versions', 'source_acquisitions', 'arxiv_versions', 'reader_versions']) expect((await t.db.pool.query(`SELECT 1 FROM ${table}`)).rowCount).toBe(0);
  } finally { production.mockRestore(); }
});
it('keeps one canonical identity without retargeting old jobs and preserves edited conflicts', async () => {
  const t = await setup(); const canonical = await t.save('https://github.com/Old/Name'); const duplicate = await t.save('https://github.com/New/Name'); const edited = await t.save('https://github.com/Third/Name', { title: 'My notes' });
  const { resolveSourceIdentity } = await import('../../src/source-adapters/identity.js');
  const { finishWebJob } = await import('../../src/web-jobs/lease.js');
  for (const [saved, expected] of [[canonical, 'self'], [duplicate, 'alias'], [edited, 'conflict']] as const) {
    const lease = (await t.lease(saved.jobId))!;
    expect(await resolveSourceIdentity(t.db, lease, { provider: 'github', id: '12345' })).toEqual({ resolution: expected, canonicalDocumentId: canonical.documentId });
    await finishWebJob(lease, t.db, 'failed', 'UNSUPPORTED_SOURCE');
  }
  expect((await t.db.pool.query('SELECT document_id FROM web_jobs WHERE id=$1', [duplicate.jobId])).rows[0].document_id).toBe(duplicate.documentId);
  const listed = await t.app.inject({ url: '/api/v1/documents', headers: t.headers });
  expect(JSON.stringify(listed.json())).not.toContain(duplicate.documentId); expect(JSON.stringify(listed.json())).toContain(edited.documentId);
  const duplicateKey=(await t.db.pool.query('SELECT idempotency_key FROM source_requests WHERE job_id=$1',[duplicate.jobId])).rows[0].idempotency_key;
  const replay=await t.app.inject({method:'POST',url:`/api/v1/documents/${duplicate.documentId}/source-refresh`,headers:{...t.headers,'idempotency-key':duplicateKey},payload:{translationIntent:'none'}});
  expect(replay.statusCode,replay.body).toBe(202); expect(replay.json()).toEqual(duplicate);
  const lifecycle = createDocumentLifecycleService({ db: t.db, store: t.store });
  await lifecycle.trashDocument(t.actor, canonical.documentId, 1);
  await expect(lifecycle.restoreDocument(t.actor,duplicate.documentId,2)).rejects.toMatchObject({code:'SOURCE_IDENTITY_CONFLICT'});
  expect((await t.db.pool.query('SELECT id FROM documents WHERE deleted_at IS NOT NULL ORDER BY id')).rows.map(r => r.id).sort()).toEqual([canonical.documentId, duplicate.documentId].sort());
  await lifecycle.restoreDocument(t.actor, canonical.documentId, 2);
  expect((await t.db.pool.query('SELECT id FROM documents WHERE deleted_at IS NOT NULL')).rowCount).toBe(0);
});
it('retains first acquired bytes across worker restart and verifies historical raw material on restore', async () => {
  const t = await setup(); const saved = await t.save('https://github.com/Org/Repo');
  const { execFile }=await import('node:child_process'); const {promisify}=await import('node:util'); const {writeFile,readFile,mkdir}=await import('node:fs/promises');
  const evidenceDirectory = process.env.PAGELINGO_TEST_SOURCE_EVIDENCE_DIR ?? join(t.config.dataDir, 'source-evidence');
  await mkdir(evidenceDirectory, { recursive: true });
  const { reconcileWebJobs } = await import('../../src/web-jobs/lease.js');
  const schema=(await t.db.pool.query('SELECT current_schema() AS schema')).rows[0].schema;
  async function worker(mode:string) {
    const result=await promisify(execFile)(process.execPath,['--import','tsx',new URL('../helpers/source-acquisition-process.ts',import.meta.url).pathname,schema,t.actor.userId,saved.jobId,t.config.dataDir,mode],{env:{PATH:process.env.PATH,PAGELINGO_TEST_DATABASE_URL:process.env.PAGELINGO_TEST_DATABASE_URL}});
    const path = join(evidenceDirectory, `acquisition-${mode}-${randomUUID()}.json`);
    await writeFile(path,JSON.stringify(result));
    expect.soft(await readFile(join(evidenceDirectory,basename(path)), 'utf8').catch(() => null)).toBe(JSON.stringify(result));
    return JSON.parse(result.stdout);
  }
  const firstProcess=await worker('initial'); const first=firstProcess.acquisition;
  await t.db.pool.query("UPDATE web_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [saved.jobId]); await reconcileWebJobs(t.db);
  const secondProcess=await worker('restart'); expect(secondProcess.pid).not.toBe(firstProcess.pid); expect(secondProcess.acquisition).toEqual(first);
  await t.db.pool.query("UPDATE web_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [saved.jobId]); await reconcileWebJobs(t.db);
  const lease=(await t.lease(saved.jobId))!; const {acquireSourceMaterial}=await import('../../src/source-adapters/repository.js');
  const current=await acquireSourceMaterial(lease,{db:t.db,store:t.store,signal:new AbortController().signal},{role:'current-readme',filename:'README.md',mediaType:'text/markdown',url:'https://api.github.com/repos/Org/Repo/readme',maxBytes:1024,body:(async function*(){yield Buffer.from('# Current');})()});
  const revision=randomUUID();
  await t.db.pool.query(`INSERT INTO github_versions(id,owner_id,document_id,job_id,repository_id,repository_owner,repository_name,original_url,canonical_url,readme_path,blob_sha,raw_asset_id,content_digest)
    VALUES($1,$2,$3,$4,'12345','Org','Repo','https://github.com/Org/Repo','https://github.com/Org/Repo','README.md',$5,$6,$7)`,[revision,t.actor.userId,saved.documentId,saved.jobId,'a'.repeat(40),current.assetId,'b'.repeat(64)]);
  await t.db.pool.query('UPDATE documents SET current_github_revision_id=$2 WHERE id=$1',[saved.documentId,revision]);
  expect((await t.store.stat(current.objectKey)).bytes).toBe(9);
  expect(first.sha256).toBe('a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e');
  await expect(t.db.pool.query("UPDATE source_acquisitions SET filename='replacement'")).rejects.toThrow(/immutable/i);
  await t.store.deleteUnreferenced(first.objectKey);
  const lifecycle = createDocumentLifecycleService({ db: t.db, store: t.store }); await lifecycle.trashDocument(t.actor, saved.documentId, 1);
  await expect(lifecycle.restoreDocument(t.actor, saved.documentId, 2)).rejects.toMatchObject({ code: 'RESTORE_MATERIAL_UNAVAILABLE' });
});
it.each([{ provider: 'github' as const, id: '12345', urls: ['https://github.com/Old/Repo', 'https://github.com/Unknown/Renamed'] }, { provider: 'arxiv' as const, id: '2401.12345', urls: ['https://arxiv.org/abs/2401.12345v1', 'https://arxiv.org/abs/2401.12345v9'] }])('retires unknown URLs by exact admitted provider identity: $provider', async identity => {
  const t = await setup(); const first = await t.save(identity.urls[0]!); const old = await t.save(identity.urls[1]!);
  const { resolveSourceIdentity } = await import('../../src/source-adapters/identity.js'); const { finishWebJob } = await import('../../src/web-jobs/lease.js');
  const lease = (await t.lease(first.jobId))!; await resolveSourceIdentity(t.db, lease, identity); await finishWebJob(lease, t.db, 'failed');
  const lifecycle = createDocumentLifecycleService({ db: t.db, store: t.store }); await lifecycle.trashDocument(t.actor, first.documentId, 1); await lifecycle.requestDocumentPurge(t.actor, first.documentId);
  const stale = (await t.lease(old.jobId))!; await expect(resolveSourceIdentity(t.db, stale, identity)).rejects.toMatchObject({ code: 'DOCUMENT_RETIRED' }); await finishWebJob(stale, t.db, 'failed');
  const fresh = await t.app.inject({ method: 'POST', url: `/api/v1/documents/${old.documentId}/source-refresh`, headers: { ...t.headers, 'idempotency-key': randomUUID() }, payload: { translationIntent: 'none' } }); expect(fresh.statusCode).toBe(202);
  // Cleanup removes the retired canonical row; only the digest cutoff survives.
  const { runDocumentMaintenance } = await import('../../src/document-lifecycle/maintenance.js');
  for (let n = 0; n < 5; n++) await runDocumentMaintenance({ db: t.db, store: t.store, dataDir: t.config.dataDir, signal: new AbortController().signal }, { limit: 100 });
  expect((await t.db.pool.query('SELECT id FROM documents WHERE id=$1', [first.documentId])).rowCount).toBe(0);
  const current = (await t.lease(fresh.json().jobId))!; expect(await resolveSourceIdentity(t.db, current, identity)).toMatchObject({ resolution: 'self', canonicalDocumentId: old.documentId });
});
it('serializes arxiv requests across processes and releases denied slots through durable cooldown', async () => {
  const { spawn } = await import('node:child_process'); const { once } = await import('node:events');
  const { appendFile, readFile, mkdir } = await import('node:fs/promises'); const { eventually } = await import('../helpers/web-jobs.js');
  const t = await setup(); const first = await t.save('https://arxiv.org/abs/2401.12345v1');
  await t.db.pool.query("INSERT INTO users(username,password_hash,role) SELECT 'alice',password_hash,'user' FROM users WHERE username='admin'");
  const other = await login(t.app,'alice','correct password 123456');
  const saved = await t.app.inject({method:'POST',url:'/api/v1/documents/links',headers:{cookie:other.cookie,origin:t.config.publicOrigin,'x-csrf-token':other.csrfToken,'idempotency-key':randomUUID()},payload:{url:'https://arxiv.org/abs/2402.12345v1',translationIntent:'none'}}); expect(saved.statusCode).toBe(201);
  const schema = (await t.db.pool.query('SELECT current_schema() AS schema')).rows[0].schema;
  const traces: Array<{type:string;at:number;pid:number;executed?:boolean;closed?:boolean}> = [];
  const evidenceDirectory = process.env.PAGELINGO_TEST_SOURCE_EVIDENCE_DIR ?? join(t.config.dataDir, 'source-evidence');
  await mkdir(evidenceDirectory, { recursive: true });
  const path = join(evidenceDirectory, `limiter-${randomUUID()}.jsonl`);
  const processOutput: string[] = [];
  const children = [ [t.actor.userId,first.jobId,'1'], [other.user.id,saved.json().jobId,'2'] ].map(args => {
    const child = spawn(process.execPath,['--import','tsx',new URL('../helpers/source-limit-process.ts',import.meta.url).pathname,schema,...args],{env:{PATH:process.env.PATH,PAGELINGO_TEST_DATABASE_URL:process.env.PAGELINGO_TEST_DATABASE_URL},stdio:['ignore','pipe','pipe','ipc']});
    child.on('message',value => { traces.push(value as typeof traces[number]); });
    child.stdout!.on('data',v => { processOutput.push(JSON.stringify({ stream: 'stdout', pid: child.pid, text: String(v) })); });
    child.stderr!.on('data',v => { processOutput.push(JSON.stringify({ stream: 'stderr', pid: child.pid, text: String(v) })); }); return child;
  });
  try {
    await eventually(async () => traces.filter(v=>v.type==='ready').length,n=>n===2);
    children[0]!.send('run'); await eventually(async () => traces.find(v=>v.type==='started'&&v.pid===children[0]!.pid),Boolean);
    children[1]!.send('run'); const denied = await eventually(async () => traces.find(v=>v.pid===children[1]!.pid&&['result','started','error'].includes(v.type)),Boolean);
    expect(denied).toMatchObject({type:'result',executed:false});
    const deferred=(await t.db.pool.query('SELECT status,slot_id,next_request_at>clock_timestamp() AS future FROM web_jobs WHERE id=$1',[saved.json().jobId])).rows[0]; expect(deferred).toEqual({status:'queued',slot_id:null,future:true});
    children[0]!.send('finish'); await eventually(async () => traces.find(v=>v.type==='result'&&v.pid===children[0]!.pid),Boolean);
    const closed=traces.find(v=>v.type==='http-closed'&&v.pid===children[0]!.pid)!; expect(closed.closed).toBe(true);
    await eventually(async () => (await t.db.pool.query("SELECT next_request_at<=clock_timestamp() AS ready FROM external_request_limits WHERE provider='arxiv'")).rows[0].ready,Boolean,5000);
    children[1]!.send('run'); const started=await eventually(async () => traces.find(v=>v.type==='started'&&v.pid===children[1]!.pid),Boolean);
    expect(started!.at-closed.at).toBeGreaterThanOrEqual(2990);
    children[1]!.send('finish'); await eventually(async () => traces.find(v=>v.type==='result'&&v.pid===children[1]!.pid&&v.executed),Boolean);
    expect(traces.filter(v=>v.type==='error')).toEqual([]);
  } finally {
    for(const child of children) { if(child.exitCode===null&&child.signalCode===null) { const exit=once(child,'exit'); child.kill('SIGTERM'); await exit; } }
    await appendFile(path,[...processOutput, ...traces.map(v=>JSON.stringify(v))].join('\n')+'\n');
    expect(await readFile(join(evidenceDirectory,basename(path)), 'utf8').catch(() => null)).toContain('"type":"started"');
  }
},20000);
it('shows the selected revision independently of a failed latest attempt and pages registered revisions', async () => {
  const t=await setup(); const saved=await t.save('https://github.com/Org/Repo'); const lease=(await t.lease(saved.jobId))!;
  const { resolveSourceIdentity }=await import('../../src/source-adapters/identity.js'); const { acquireSourceMaterial }=await import('../../src/source-adapters/repository.js'); const { finishWebJob }=await import('../../src/web-jobs/lease.js');
  await resolveSourceIdentity(t.db,lease,{provider:'github',id:'12345'});
  const raw=await acquireSourceMaterial(lease,{db:t.db,store:t.store,signal:new AbortController().signal},{role:'readme',filename:'README.md',mediaType:'text/markdown',url:'https://api.github.com/repos/Org/Repo/readme',maxBytes:1024,body:(async function*(){yield Buffer.from('# Original');})()});
  const revisions=[randomUUID(),randomUUID()];
  for(let n=0;n<2;n++) await t.db.pool.query(`INSERT INTO github_versions(id,owner_id,document_id,job_id,repository_id,repository_owner,repository_name,original_url,canonical_url,commit_sha,readme_path,blob_sha,raw_asset_id,content_digest,captured_at)
    VALUES($1,$2,$3,$4,'12345','Org','Repo','https://github.com/Org/Repo','https://github.com/Org/Repo',$5,'README.md',$6,$7,$8,$9)`,[revisions[n],t.actor.userId,saved.documentId,saved.jobId,'a'.repeat(40),'b'.repeat(40),raw.assetId,String(n).repeat(64),`2026-10-${20+n}T00:00:00Z`]);
  await t.db.pool.query('UPDATE documents SET current_github_revision_id=$2 WHERE id=$1',[saved.documentId,revisions[0]]); await finishWebJob(lease,t.db,'completed');
  const next=await t.app.inject({method:'POST',url:`/api/v1/documents/${saved.documentId}/source-refresh`,headers:{...t.headers,'idempotency-key':randomUUID()},payload:{ref:'new',translationIntent:'none'}});
  await t.db.pool.query('UPDATE web_jobs SET source_github_revision_id=$2 WHERE id=$1',[next.json().jobId,revisions[0]]);
  await finishWebJob((await t.lease(next.json().jobId))!,t.db,'failed','UPSTREAM_UNAVAILABLE');
  const details=await t.app.inject({url:`/api/v1/documents/${saved.documentId}/source-details`,headers:t.headers});
  expect(details.json()).toMatchObject({status:'metadata-saved',current:{id:revisions[0],readme:{raw:{assetId:raw.assetId,filename:'README.md'}}},latestAttempt:{jobId:next.json().jobId,status:'failed',errorCode:'UPSTREAM_UNAVAILABLE',resolvedRevision:revisions[0]}});
  const page=await t.app.inject({url:`/api/v1/documents/${saved.documentId}/source-versions?limit=1`,headers:t.headers}); expect(page.statusCode).toBe(200); expect(page.json().items.map((r:{id:string})=>r.id)).toEqual([revisions[1]]); expect(page.json().nextCursor).toBe(revisions[1]);
  const rest=await t.app.inject({url:`/api/v1/documents/${saved.documentId}/source-versions?limit=1&cursor=${page.json().nextCursor}`,headers:t.headers}); expect(rest.json().items.map((r:{id:string})=>r.id)).toEqual([revisions[0]]); expect(rest.json().nextCursor).toBeNull();
  expect((await t.app.inject({url:`/api/v1/documents/${saved.documentId}/source-details?revisionId=${revisions[1]}`,headers:t.headers})).json().current.id).toBe(revisions[1]);
  const asset=await t.app.inject({url:`/api/v1/documents/${saved.documentId}/source-assets/${raw.assetId}`,headers:t.headers}); expect(asset.statusCode).toBe(200); expect(asset.body).toBe('# Original'); expect(asset.headers['content-disposition']).toContain('attachment'); expect(asset.headers['x-content-type-options']).toBe('nosniff'); expect(asset.headers['cache-control']).toBe('no-store'); expect(JSON.stringify(details.json())).not.toContain(raw.objectKey);
  await t.store.deleteUnreferenced(raw.objectKey); await t.store.putImmutable(raw.objectKey,(async function*(){yield Buffer.from('# Tampered');})(),1024);
  expect((await t.app.inject({url:`/api/v1/documents/${saved.documentId}/source-assets/${raw.assetId}`,headers:t.headers})).statusCode).toBe(409);
  const lifecycle=createDocumentLifecycleService({db:t.db,store:t.store});await lifecycle.trashDocument(t.actor,saved.documentId,1);await lifecycle.requestDocumentPurge(t.actor,saved.documentId);
  const {runDocumentMaintenance}=await import('../../src/document-lifecycle/maintenance.js');
  for(let n=0;n<3;n++) await runDocumentMaintenance({db:t.db,store:t.store,dataDir:t.config.dataDir,signal:new AbortController().signal},{limit:100});
  expect((await t.db.pool.query('SELECT id FROM documents WHERE id=$1',[saved.documentId])).rowCount).toBe(0);
  expect((await t.app.inject({url:`/api/v1/trash/${saved.documentId}/receipt`,headers:t.headers})).json().status).toBe('completed');
});
it('preserves revision-zero save hints as conflicts and disallows adding data to a hidden minimum alias', async () => {
  const t=await setup(); const canonical=await t.save('https://github.com/Org/Repo');
  const collection=(await t.app.inject({method:'POST',url:'/api/v1/collections',headers:t.headers,payload:{name:'Keep this'}})).json();
  const hinted=await t.save('https://github.com/Renamed/Repo',{organization:{collectionId:collection.id,tagIds:[]}}); const minimal=await t.save('https://github.com/Alias/Repo');
  const { resolveSourceIdentity }=await import('../../src/source-adapters/identity.js'); const { finishWebJob }=await import('../../src/web-jobs/lease.js');
  for(const [saved,resolution] of [[canonical,'self'],[hinted,'conflict'],[minimal,'alias']] as const) { const lease=(await t.lease(saved.jobId))!; expect(await resolveSourceIdentity(t.db,lease,{provider:'github',id:'12345'})).toMatchObject({resolution}); await finishWebJob(lease,t.db,'failed'); }
  const patch=await t.app.inject({method:'PATCH',url:`/api/v1/documents/${minimal.documentId}/organization`,headers:t.headers,payload:{expectedRevision:0,note:'Do not hide this'}}); expect(patch.statusCode,patch.body).toBe(409);
  const lifecycle=createDocumentLifecycleService({db:t.db,store:t.store}); await lifecycle.trashDocument(t.actor,canonical.documentId,1); await lifecycle.requestDocumentPurge(t.actor,canonical.documentId);
  const {runDocumentMaintenance}=await import('../../src/document-lifecycle/maintenance.js');
  for(let n=0;n<6;n++) await runDocumentMaintenance({db:t.db,store:t.store,dataDir:t.config.dataDir,signal:new AbortController().signal},{limit:100});
  expect((await t.db.pool.query('SELECT document_id,collection_id FROM document_organization')).rows).toEqual([{document_id:hinted.documentId,collection_id:collection.id}]);
  expect((await t.app.inject({url:`/api/v1/trash/${canonical.documentId}/receipt`,headers:t.headers})).json().status).toBe('completed');
});
it('honors longer Retry-After and releases the session lock after failed managed HTTP', async () => {
  const t=await setup(); const saved=await t.save('https://arxiv.org/abs/2401.12345v1'); const lease=(await t.lease(saved.jobId))!;
  const {withArxivRequest}=await import('../../src/source-adapters/rate-limit.js');
  const result=await withArxivRequest(t.db,lease,async()=>new Response(null,{status:429,headers:{'retry-after':'9'}}),r=>r.headers.get('retry-after')); expect(result.executed).toBe(true);
  expect(Number((await t.db.pool.query("SELECT extract(epoch FROM next_request_at-clock_timestamp()) AS remaining FROM external_request_limits WHERE provider='arxiv'")).rows[0].remaining)).toBeGreaterThan(8);
  await t.db.pool.query("UPDATE external_request_limits SET next_request_at=clock_timestamp()-interval '1 second'");
  await expect(withArxivRequest(t.db,lease,async()=>{throw new Error('HTTP closed after timeout');})).rejects.toThrow('HTTP closed');
  const client=await t.db.pool.connect(); try { expect((await client.query('SELECT pg_try_advisory_lock(204716,40) AS available')).rows[0].available).toBe(true); await client.query('SELECT pg_advisory_unlock(204716,40)'); } finally {client.release();}
  expect(Number((await t.db.pool.query("SELECT extract(epoch FROM next_request_at-clock_timestamp()) AS remaining FROM external_request_limits WHERE provider='arxiv'")).rows[0].remaining)).toBeGreaterThan(2);
});
it('rejects revoked leases and unregistered or cross-document source assets', async () => {
  const t=await setup(); const saved=await t.save('https://github.com/Org/Repo'); const other=await t.save('https://github.com/Org/Other'); const lease=(await t.lease(saved.jobId))!;
  const {resolveSourceIdentity}=await import('../../src/source-adapters/identity.js'); const {acquireSourceMaterial}=await import('../../src/source-adapters/repository.js');
  await resolveSourceIdentity(t.db,lease,{provider:'github',id:'12345'});
  const input={role:'metadata',filename:'repo.json',mediaType:'application/json',url:'https://api.github.com/repos/Org/Repo',maxBytes:1024};
  const asset=await acquireSourceMaterial(lease,{db:t.db,store:t.store,signal:new AbortController().signal},{...input,body:(async function*(){yield Buffer.from('{}');})()});
  expect((await t.app.inject({url:`/api/v1/documents/${other.documentId}/source-assets/${asset.assetId}`,headers:t.headers})).statusCode).toBe(404);
  const orphan=randomUUID(); await t.db.pool.query('INSERT INTO assets(id,owner_id,document_id,object_key,sha256,bytes,media_type) VALUES($1,$2,$3,$4,$5,0,$6)',[orphan,t.actor.userId,saved.documentId,randomUUID(),'a'.repeat(64),'text/plain']);
  expect((await t.app.inject({url:`/api/v1/documents/${saved.documentId}/source-assets/${orphan}`,headers:t.headers})).statusCode).toBe(404);
  await t.db.pool.query('UPDATE web_jobs SET epoch=epoch+1 WHERE id=$1',[saved.jobId]);
  await expect(acquireSourceMaterial(lease,{db:t.db,store:t.store,signal:new AbortController().signal},{...input,role:'readme',body:(async function*(){throw new Error('Stale worker consumed bytes');})()})).rejects.toThrow('lease is no longer current');
  expect((await t.db.pool.query('SELECT id FROM source_acquisitions')).rowCount).toBe(1);
});
it('bounds canonical alias purge scheduling within the shared mutation budget and fences group restore', async () => {
  const t=await setup(); const saved=await t.save('https://github.com/Org/Repo'); const lease=(await t.lease(saved.jobId))!;
  const {resolveSourceIdentity}=await import('../../src/source-adapters/identity.js'); const {finishWebJob}=await import('../../src/web-jobs/lease.js'); await resolveSourceIdentity(t.db,lease,{provider:'github',id:'12345'}); await finishWebJob(lease,t.db,'failed');
  // Direct fixture inserts preserve actual graph FKs; this represents hundreds of accepted name aliases.
  const ids=Array.from({length:501},()=>randomUUID());
  await t.db.pool.query("INSERT INTO documents(id,owner_id,kind,title,source_url) SELECT id,$1,'repository','link','https://github.com/Alias/Repo' FROM unnest($2::uuid[]) id",[t.actor.userId,ids]);
  await t.db.pool.query('INSERT INTO document_organization(owner_id,document_id) SELECT $1,id FROM unnest($2::uuid[]) id',[t.actor.userId,ids]);
  await t.db.pool.query("INSERT INTO document_source_aliases(owner_id,document_id,canonical_document_id,resolution) SELECT $1,id,$2,'alias' FROM unnest($3::uuid[]) id",[t.actor.userId,saved.documentId,ids]);
  const lifecycle=createDocumentLifecycleService({db:t.db,store:t.store}); await lifecycle.trashDocument(t.actor,saved.documentId,1);
  await t.db.pool.query("UPDATE documents SET purge_after=clock_timestamp()-interval '1 second',deleted_at=clock_timestamp()-interval '31 days' WHERE id=$1",[saved.documentId]);
  const {runDocumentMaintenance}=await import('../../src/document-lifecycle/maintenance.js');
  await runDocumentMaintenance({db:t.db,store:t.store,dataDir:t.config.dataDir,signal:new AbortController().signal},{limit:1});
  expect((await t.db.pool.query('SELECT id FROM document_purges')).rowCount).toBeLessThanOrEqual(500);
  await lifecycle.requestDocumentPurge(t.actor,saved.documentId);
  await expect(lifecycle.restoreDocument(t.actor,ids[0]!,2)).rejects.toMatchObject({code:'DOCUMENT_PURGING'});
});
it('enforces source ledger job kinds and PDF revision byte bindings in the database', async () => {
  const t=await setup(); const saved=await t.save('https://arxiv.org/abs/2401.12345v1'); const lease=(await t.lease(saved.jobId))!;
  const {resolveSourceIdentity}=await import('../../src/source-adapters/identity.js'); const {acquireSourceMaterial}=await import('../../src/source-adapters/repository.js');
  await resolveSourceIdentity(t.db,lease,{provider:'arxiv',id:'2401.12345'});
  const assets=[];
  for(const role of ['pdf','different']) assets.push(await acquireSourceMaterial(lease,{db:t.db,store:t.store,signal:new AbortController().signal},{role,filename:`${role}.pdf`,mediaType:'application/pdf',url:'https://arxiv.org/pdf/2401.12345v1',maxBytes:1024,body:(async function*(){yield Buffer.from(`%PDF-${role}`);})()}));
  const source=randomUUID(),first=assets[0]!,other=assets[1]!;
  await t.db.pool.query('INSERT INTO source_versions(id,owner_id,document_id,asset_id,sha256,bytes) VALUES($1,$2,$3,$4,$5,$6)',[source,t.actor.userId,saved.documentId,other.assetId,other.sha256,other.bytes]);
  await expect(t.db.pool.query(`INSERT INTO arxiv_versions(owner_id,document_id,job_id,base_id,version,title,authors,summary,published_at,updated_at,pdf_asset_id,pdf_sha256,pdf_bytes,source_version_id)
    VALUES($1,$2,$3,'2401.12345',1,'Paper','[]','Summary',clock_timestamp(),clock_timestamp(),$4,$5,$6,$7)`,[t.actor.userId,saved.documentId,saved.jobId,first.assetId,first.sha256,first.bytes,source])).rejects.toMatchObject({code:'23503'});
});
it('reports real article fetch attempts through the link details variant',async()=>{
  const t=await setup();const saved=await t.save('https://public.example/read');
  const result=await t.app.inject({url:`/api/v1/documents/${saved.documentId}/source-details`,headers:t.headers});
  expect(result.json()).toMatchObject({kind:'link',fetchJobId:saved.jobId,latestAttempt:{jobId:saved.jobId,status:'queued'}});expect(result.json()).not.toHaveProperty('current');
});
it('dispatches a source lease through the shared worker with only an explicit source transport',async()=>{
  const t=await setup();const saved=await t.save('https://github.com/Org/Repo');const lease=(await t.lease(saved.jobId))!;
  const {runWebJob}=await import('../../src/web-jobs/translation-runner.js');const {createSourceTransport}=await import('../../src/source-adapters/network.js');
  await runWebJob(lease,{db:t.db,store:t.store,config:t.config,signal:new AbortController().signal,sourceTransport:createSourceTransport({lookup:async()=>{throw new Error('Fixture refuses external DNS');}})});
  expect((await t.db.pool.query('SELECT status,error_code FROM web_jobs WHERE id=$1',[saved.jobId])).rows[0]).toEqual({status:'failed',error_code:'GITHUB_SOURCE_UNAVAILABLE'});
});
it.each([false, true])('canonicalizes uppercase trash and restore IDs with aliases=%s', async grouped => {
  const t = await setup();
  const rootId = 'abcde123-4567-489a-8bcd-123456789abc';
  const url = grouped ? 'https://github.com/Uppercase/Root' : 'https://public.example/uppercase';
  const { insertWebDocument } = await import('../../src/web-readers/repository.js');
  await t.db.transaction(client => insertWebDocument(client, { id: rootId, ownerId: t.actor.userId, kind: grouped ? 'repository' : 'article', url, title: url, titleOrigin: 'url' }));
  const root = await t.save(url);
  let aliasId: string | undefined, conflictId: string | undefined;
  if (grouped) {
    const alias = await t.save('https://github.com/Uppercase/Alias');
    const conflict = await t.save('https://github.com/Uppercase/Edited', { title: 'Retain this title' });
    aliasId = alias.documentId; conflictId = conflict.documentId;
    const { resolveSourceIdentity } = await import('../../src/source-adapters/identity.js');
    const { finishWebJob } = await import('../../src/web-jobs/lease.js');
    for (const [saved, resolution] of [[root, 'self'], [alias, 'alias'], [conflict, 'conflict']] as const) {
      const lease = (await t.lease(saved.jobId))!;
      expect(await resolveSourceIdentity(t.db, lease, { provider: 'github', id: '12345' })).toMatchObject({ resolution, canonicalDocumentId: rootId });
      await finishWebJob(lease, t.db, 'failed', 'UNSUPPORTED_SOURCE');
    }
  }
  const readState = async (id: string) => (await t.db.pool.query('SELECT id,lifecycle_epoch,source_trash_parent_id,deleted_at IS NOT NULL AS trashed,title FROM documents WHERE owner_id=$1 AND id=$2', [t.actor.userId,id])).rows[0];
  const trash = await t.app.inject({ method: 'POST', url: `/api/v1/documents/${rootId.toUpperCase()}/trash`, headers: t.headers, payload: { expectedEpoch: 1 } });
  expect(trash.statusCode, trash.body).toBe(200);
  expect.soft(trash.body ? trash.json() : null).toMatchObject({ documentId: rootId, lifecycleEpoch: 2 });
  expect.soft(await readState(rootId)).toMatchObject({ id: rootId, lifecycle_epoch: '2', source_trash_parent_id: null, trashed: true });
  if (aliasId) expect.soft(await readState(aliasId)).toMatchObject({ lifecycle_epoch: '2', source_trash_parent_id: rootId, trashed: true });
  if (conflictId) expect.soft(await readState(conflictId)).toMatchObject({ lifecycle_epoch: '1', source_trash_parent_id: null, trashed: false, title: 'Retain this title' });
  const restored = await t.app.inject({ method: 'POST', url: `/api/v1/documents/${rootId.toUpperCase()}/restore`, headers: t.headers, payload: { expectedEpoch: 2 } });
  expect(restored.statusCode, restored.body).toBe(200);
  expect.soft(restored.json()).toEqual({ documentId: rootId, lifecycleEpoch: 3 });
  expect.soft(await readState(rootId)).toMatchObject({ id: rootId, lifecycle_epoch: '3', source_trash_parent_id: null, trashed: false });
  if (aliasId) expect.soft(await readState(aliasId)).toMatchObject({ lifecycle_epoch: '3', source_trash_parent_id: null, trashed: false });
  if (conflictId) expect.soft(await readState(conflictId)).toMatchObject({ lifecycle_epoch: '1', source_trash_parent_id: null, trashed: false, title: 'Retain this title' });
});
