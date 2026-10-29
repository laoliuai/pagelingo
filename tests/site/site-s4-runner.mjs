import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { defaultBundleLimits } from '@pagelingo/document-contracts';
import { createArchiveFileSource, validateWebBundle, readArchive, validateBundle } from '@pagelingo/document-bundle';
import { openDatabase } from '../../apps/document-service/src/db/database.ts';
import { migrateDatabase } from '../../apps/document-service/src/db/migrate.ts';
import { createLocalObjectStore } from '../../apps/document-service/src/storage/local-object-store.ts';
import { verifyLiveSamples } from './site-s4-live.mjs';
import { seedS3, baselineSnapshot } from './site-s4-baseline.mjs';
import { verifiedInput } from '../../scripts/site-s4-inputs.mjs';
import { collectOfflineDiagnostics } from '../../apps/web/tests/helpers/offline-diagnostics.ts';
const [planPath] = process.argv.slice(2), plan = JSON.parse(await readFile(planPath, 'utf8')), output = plan.output;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { schemaVersion: 'pagelingo-site-s4-acceptance/1', status: 'running', startedAt: new Date().toISOString(), samples: [], checks: [], interruptions: [], processes: [], modelRequests: 0, boundaries: ['Sources replay only declared retained response bodies; no translation model or Python.', 'True authenticated X/Zhihu/WeChat and BYOK semantic quality remain S5.', 'Four large original S2 corpus ZIPs unavailable; fixed released synthetic packages only.'] };
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const children = new Set(), logs = [], controller = new AbortController();
let db, api, browser, browserB, context, contextB, root, containerCreated = false, volumeCreated = false;
const container = `pgl-s4-${randomUUID()}`, volume = `${container}-data`, password = randomBytes(24).toString('hex');
const image = 'postgres:17.11@sha256:b8faeff7712663c2773a190181e1246e37e364b887611c04658c28b44e2408fe';
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|TMPDIR|LANG|TZ|DISPLAY|XDG_RUNTIME_DIR|PLAYWRIGHT_BROWSERS_PATH)$/.test(key)));
async function command(program, args) {
  const child = spawn(program, args, { env: cleanEnv, stdio: ['ignore','pipe','pipe'] }); children.add(child);
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit'); children.delete(child);
  assert.equal(code, 0, `${program} ${args[0]} failed: ${stderr}`); return (args[0] === 'logs' ? stdout + stderr : stdout).trim();
}
async function until(read, accepts, name, ms = 30000) {
  const end = Date.now() + ms; let value;
  do { controller.signal.throwIfAborted(); value = await read(); if (accepts(value)) return value; await delay(100); } while (Date.now() < end);
  throw new Error(`${name}: ${JSON.stringify(value)}`);
}
async function stop(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill(signal);
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await exited; } finally { clearTimeout(timer); children.delete(child); }
}
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { controller.abort(new Error(signal)); for (const child of children) child.kill(signal); });
let configPath, origin, owner, other, control, page, extensionId, databaseUrl, port;
function childProcess(mode, sample) {
  const child = spawn(process.execPath, ['--import','tsx','tests/site/site-s4-process.mjs',mode,configPath,planPath,sample?.id ?? ''], { env: cleanEnv, stdio: ['ignore','pipe','pipe','ipc'] });
  children.add(child); const messages = [];
  const path = join(output, `process-${mode}-${child.pid}.log`), log = createWriteStream(path, { flags: 'wx' }); logs.push(log); child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  child.on('message', message => { messages.push(message); if (message.type === 'unexpected-model') report.modelRequests++; });
  child.on('exit', (code, signal) => { children.delete(child); report.processes.push({ mode, pid: child.pid, exit: code, signal, messages, log: path }); log.end(); });
  return { child, messages, wait: async type => until(() => messages.find(m => m.type === type) ?? { exited: child.exitCode, signal: child.signalCode }, value => value.type === type, `${mode} ${type}`) };
}
async function run(mode, sample) {
  const task = childProcess(mode, sample), exited = once(task.child, 'exit');
  const [code] = await exited; assert.equal(code, 0, `${mode} failed; see process log`); return task.messages;
}
async function startApi() { const task = childProcess('api'); api = task.child; await task.wait('ready'); }
async function startDb() {
  await command('docker', ['run','--detach','--name',container,'--publish',`127.0.0.1:${port}:5432`,'--env',`POSTGRES_PASSWORD=${password}`,'--env','POSTGRES_DB=pagelingo_s4','--mount',`type=volume,source=${volume},destination=/var/lib/postgresql/data`,image]); containerCreated = true;
  await until(async () => { try { await command('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres','-d','pagelingo_s4']); return true; } catch { return false; } }, Boolean, 'PostgreSQL ready');
}
async function freePort() { const server = createServer(); await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
async function request(path, { actor = owner, method = 'GET', body, raw, mediaType, headers = {} } = {}) {
  return fetch(origin + path, { method, headers: { Origin: origin, ...(actor ? { Cookie: actor.cookie, 'X-CSRF-Token': actor.csrfToken } : {}), ...((body || raw) ? { 'Content-Type': mediaType ?? 'application/json' } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined), ...(raw ? { duplex: 'half' } : {}), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]) });
}
async function json(path, options, status = 200) { const response = await request(path, options), value = await response.json(); assert.equal(response.status,status,`${path}: ${JSON.stringify(value)}`); return value; }
async function login(username) { const response = await request('/api/v1/auth/login',{ actor:null,method:'POST',body:{username,password} }); assert.equal(response.status,200); return {...await response.json(),cookie:response.headers.get('set-cookie').split(';')[0]}; }
async function browserLogin(target, username) { await target.goto(origin+'/login'); await target.getByLabel('用户名',{exact:true}).fill(username); await target.getByLabel('密码',{exact:true}).fill(password); await target.getByRole('button',{name:'登录',exact:true}).click(); await expect(target).toHaveURL(origin+'/library'); }
async function assertPrivate(path, expectedHash) {
  const response = await request(path); assert.equal(response.status,200,path);
  const h = createHash('sha256'); let bytes = 0; for await (const chunk of response.body) { h.update(chunk); bytes += chunk.length; }
  if (expectedHash) assert.equal(h.digest('hex'),expectedHash,path);
  assert.equal((await request(path,{actor:other})).status,404,path+' other owner'); assert.equal((await request(path,{actor:null})).status,401,path+' anonymous'); return bytes;
}
async function expireLeases() {
  // Explicit acceptance clock advancement after killed owned process; no production clock change.
  await db.pool.query("UPDATE web_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE status='running'");
  await db.pool.query("UPDATE web_worker_slots SET lease_until=clock_timestamp()-interval '1 second' WHERE job_id IS NOT NULL");
  await db.pool.query("UPDATE registered_object_work SET writer_until=clock_timestamp()-interval '1 second'");
}
async function lifecycle(sample, documentId) {
  const base = `/api/v1/documents/${documentId}`;
  const descriptor = await json(base+'/web-reader');
  const collection = await json('/api/v1/collections',{method:'POST',body:{name:sample.id}},201);
  const tag = await json('/api/v1/tags',{method:'POST',body:{name:sample.id}},201);
  const organization = await json(base+'/organization');
  await json(base+'/organization',{method:'PATCH',body:{expectedRevision:organization.revision,collectionId:collection.id,tagIds:[tag.id],note:`S4 ${sample.id}`,readingStatus:'reading'}});
  const found = await json(`/api/v1/library?collectionId=${collection.id}&tagIds=${tag.id}&q=${encodeURIComponent('S4 '+sample.id)}`); assert.equal(found.total,1); assert.equal(found.items[0].document.id,documentId);
  await json('/api/v1/document-relations',{method:'POST',body:{fromDocumentId:documentId,toDocumentId:report.baseline.pdfId,kind:'related'}});
  assert((await json(base+'/relations')).items.length>0);
  await assertPrivate(`${base}/web-reader/versions/${descriptor.versionId}/chunks/${descriptor.index.chunks[0].id}`);
  await page.goto(origin+'/library/'+documentId); await expect(page.getByText('管理资料',{exact:true})).toBeVisible();
  await page.getByText('管理资料',{exact:true}).click(); await expect(page.getByLabel('收藏备注')).toHaveValue(`S4 ${sample.id}`);
  await page.screenshot({path:join(output,`${sample.id}-managed.png`),fullPage:true});
  await page.setViewportSize({width:375,height:900}); await page.screenshot({path:join(output,`${sample.id}-mobile.png`),fullPage:true}); assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)); await page.setViewportSize({width:1440,height:1000});
  let current = await json(base+'/organization'); await json(base+'/trash',{method:'POST',body:{expectedEpoch:current.lifecycleEpoch}});
  assert.equal((await request(base+'/web-reader')).status,404);
  await page.goto(origin+'/trash'); await page.screenshot({path:join(output,`${sample.id}-trash.png`),fullPage:true});
  await json(base+'/restore',{method:'POST',body:{expectedEpoch:current.lifecycleEpoch+1}});
  assert.equal((await json(base+'/web-reader')).versionId,descriptor.versionId);
  const receipt = await json(base+'/web-exports',{method:'POST',body:{readerVersionId:descriptor.versionId},headers:{'Idempotency-Key':randomUUID()}},201);
  if (!report.interruptions.some(item=>item.kind==='export')) {
    const task = childProcess('hold-export'); const held = await task.wait('held');
    await run('maintenance'); assert((await createLocalObjectStore(join(root,'objects')).stat(held.key)).bytes>0);
    await stop(task.child,'SIGKILL'); await expireLeases();
    report.interruptions.push({kind:'export',pid:task.child.pid,boundary:held.boundary,key:held.key,liveWriterProtected:true,clockAdvance:'expired owned lease/slot/writer grace after SIGKILL'});
  }
  await run('job'); const completed = await json(`${base}/web-exports/${receipt.id}`); assert.equal(completed.status,'completed');
  const filePath = `${base}/web-exports/${receipt.id}/file`; await assertPrivate(filePath,completed.sha256);
  const archive = join(output,`${sample.id}.zip`); const response = await request(filePath); await pipeline(Readable.fromWeb(response.body),createWriteStream(archive,{flags:'wx'}));
  const validated = await validateWebBundle(createArchiveFileSource(archive,defaultBundleLimits),{limits:defaultBundleLimits});
  const unpacked = join(output,`${sample.id}-offline`); await mkdir(unpacked);
  for await (const entry of readArchive(archive,defaultBundleLimits)) { const path = join(unpacked,entry.path); await mkdir(dirname(path),{recursive:true}); await pipeline(Readable.from(entry.content),createWriteStream(path,{flags:'wx'})); }
  const offline = await contextB.newPage(), outbound = [], diagnostics = collectOfflineDiagnostics(offline);
  offline.on('request',request=>{if(/^https?:/.test(request.url()))outbound.push(request.url());}); await offline.route(/^https?:/,route=>route.abort());
  await offline.goto(pathToFileURL(join(unpacked,'render/index.html')).href);
  for(const value of sample.expected.contains) await expect(offline.locator('#content')).toContainText(value);
  await offline.getByRole('button',{name:'译文',exact:true}).click(); await expect(offline.locator('#content')).not.toBeEmpty();
  await offline.getByRole('button',{name:'双语',exact:true}).click();
  if(await offline.getByRole('button',{name:'定位快照',exact:true}).count()) { await offline.getByRole('button',{name:'定位快照',exact:true}).first().click(); const frame=offline.frameLocator('iframe'); expect(await offline.locator('iframe').getAttribute('sandbox')).toBe(''); expect(await frame.locator('script,form,iframe').count()).toBe(0); expect(await frame.locator('body').evaluate(()=>{try{return window.parent.document.title;}catch{return 'opaque';}})).toBe('opaque'); }
  await offline.screenshot({path:join(output,`${sample.id}-offline.png`),fullPage:true}); assert.deepEqual(outbound,[]); assert.deepEqual(diagnostics.unexpected(),[]); await offline.close();
  current = await json(base+'/organization'); await json(base+'/trash',{method:'POST',body:{expectedEpoch:current.lifecycleEpoch}});
  const purged = await json(`/api/v1/trash/${documentId}`,{method:'DELETE'},202);
  if(!report.interruptions.some(item=>item.kind==='purge')) {
    const task=childProcess('hold-purge'); const held=await task.wait('held'); await stop(task.child,'SIGKILL');
    report.interruptions.push({kind:'purge',pid:task.child.pid,boundary:held.boundary,key:held.key,receiptId:purged.id});
  }
  await until(async()=>{await run('maintenance'); return (await db.pool.query('SELECT status FROM document_purges WHERE id=$1',[purged.id])).rows[0]?.status;},value=>value==='completed','purge completion',60000);
  assert.equal((await request(base+'/web-reader')).status,404); assert.equal((await request(filePath)).status,404);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM assets WHERE document_id=$1',[documentId])).rows[0].n,0);
  return {documentId,readerVersionId:descriptor.versionId,export:completed,manifestSha256:validated.manifestSha256,purge:purged.id,offline:{outbound,diagnostics:diagnostics.diagnostics},steps:['collection','search','tags','relation','private-read','trash','restore','export','offline','permanent-purge']};
}
try {
  await save(); await verifyLiveSamples(plan); root=await mkdtemp(join(tmpdir(),'pgl-s4-owned-')); configPath=join(root,'runtime.json');
  const bundle = plan.samples.find(s=>s.id===plan.upgradeBaselineId); assert(bundle,'Declare at least one released PDF bundle for the S3 baseline');
  port=await freePort(); const apiPort=await freePort(); origin=`http://127.0.0.1:${apiPort}`; databaseUrl=`postgresql://postgres:${password}@127.0.0.1:${port}/pagelingo_s4`;
  await command('docker',['volume','create',volume]); volumeCreated=true; await startDb(); db=openDatabase(databaseUrl);
  const runtime={PAGELINGO_SITE_MODE:'test',PAGELINGO_SITE_ORIGIN:origin,PAGELINGO_SERVICE_PORT:String(apiPort),PAGELINGO_DATA_DIR:join(root,'objects'),PAGELINGO_WEB_DIR:resolve('apps/web/dist'),DATABASE_URL:databaseUrl,PAGELINGO_MASTER_KEY_ID:'test',PAGELINGO_MASTER_KEYS_JSON:JSON.stringify({test:randomBytes(32).toString('base64')})};
  await writeFile(configPath,JSON.stringify(runtime),{mode:0o600});
  const baseline=await seedS3(db,createLocalObjectStore(runtime.PAGELINGO_DATA_DIR),password,bundle.input.path); report.baseline=baseline;
  const before=await baselineSnapshot(db); await writeFile(join(output,'baseline-before.json'),JSON.stringify(before,null,2));
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,6);
  // No old writer is running: the baseline seeder has completed before migration.
  await migrateDatabase(db); assert.deepEqual(await baselineSnapshot(db),before); report.checks.push('owned 001–006 populated PDF/Web/progress upgraded to 007–009 without original row mutation');
  await startApi(); owner=await login('acceptance'); await json('/api/v1/admin/users',{method:'POST',body:{username:'otherowner',password}},201); other=await login('otherowner');
  await run('backfill');
  const beforeWeb=await json(`/api/v1/documents/${baseline.webId}/web-reader`), beforePdf=await json(`/api/v1/documents/${baseline.pdfId}/reader`);
  await stop(api); await db.close(); db=undefined; await command('docker',['rm','--force',container]); containerCreated=false; await startDb(); db=openDatabase(databaseUrl); await startApi();
  assert.deepEqual(await json(`/api/v1/documents/${baseline.webId}/web-reader`),beforeWeb); assert.deepEqual(await json(`/api/v1/documents/${baseline.pdfId}/reader`),beforePdf);
  await assertPrivate(`/api/v1/documents/${baseline.pdfId}/source`,baseline.pdfSha256); await assertPrivate(`/api/v1/documents/${baseline.pdfId}/readers/${baseline.pdfReader}/bundle`,baseline.archiveSha256);
  await assertPrivate(`/api/v1/documents/${baseline.webId}/web-snapshots/${baseline.webSource}/files/html`,baseline.webManifest.files[0].sha256);
  assert.deepEqual((await json(`/api/v1/documents/${baseline.pdfId}/progress`)).position,baseline.pdfPosition); assert.deepEqual((await json(`/api/v1/documents/${baseline.webId}/web-progress`)).position,baseline.webPosition);
  report.checks.push('API and PostgreSQL recreated over owned retained volume; prior sessions, private downloads, PDF/Web readers and progress survived'); await save();
  browserB=await chromium.launch({headless:true}); contextB=await browserB.newContext({viewport:{width:1440,height:1000}}); const otherPage=await contextB.newPage(); await browserLogin(otherPage,'otherowner');
  const extension=join(root,'extension'); await cp('apps/extension/dist',extension,{recursive:true}); const manifestPath=join(extension,'manifest.json'), manifest=JSON.parse(await readFile(manifestPath,'utf8')); manifest.host_permissions=['http://127.0.0.1/*',...new Set(plan.samples.map(s=>new URL(s.url).origin+'/*'))]; await writeFile(manifestPath,JSON.stringify(manifest));
  context=await chromium.launchPersistentContext(join(root,'profile'),{channel:'chromium',headless:true,viewport:{width:1440,height:1000},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]}); await context.tracing.start({screenshots:true,snapshots:true});
  const nativeWorker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker'); extensionId=new URL(nativeWorker.url()).host; control=await context.newPage(); await control.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  const pairing=await json('/api/v1/devices/pairing-codes',{method:'POST',body:{}},201); assert((await control.evaluate(value=>chrome.runtime.sendMessage(value),{type:'archive:pair',origin,code:pairing.code})).ok);
  page=await context.newPage(); await browserLogin(page,'acceptance');
  for(const sample of plan.samples) {
    const evidence={id:sample.id,kind:sample.kind,url:sample.url,version:sample.version,capturedAt:sample.capturedAt,checkedAt:new Date().toISOString(),inputSha256:sample.sha256,inputBytes:sample.input.bytes,scope:sample.expected.scope,unverified:sample.unverified,status:'running'}; report.samples.push(evidence); await save();
    if(sample.format==='bundle') {
      const valid=await validateBundle(createArchiveFileSource(sample.input.path,defaultBundleLimits),{limits:defaultBundleLimits}); Object.assign(evidence,{packageId:valid.packageId,manifestSha256:valid.manifestSha256,status:'passed'});
    } else if(sample.format==='html') {
      const sourcePage=await context.newPage(); await sourcePage.route(sample.url,async route=>{const chunks=[]; for await(const chunk of verifiedInput(sample.input)) chunks.push(chunk); await route.fulfill({body:Buffer.concat(chunks),contentType:'text/html',headers:{'Content-Security-Policy':"default-src 'none'; img-src data:; style-src 'unsafe-inline'"}});});
      await sourcePage.route('**/*',async route=>{if(route.request().url()===sample.url)return route.fallback(); return route.abort();});
      await sourcePage.goto(sample.url); const tabId=await control.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url).id,sample.url);
      const capture=await control.evaluate(value=>chrome.runtime.sendMessage(value),{type:'archive:capture',tabId}); assert(capture.ok,JSON.stringify(capture));
      const item=await until(async()=>{const state=await control.evaluate(()=>chrome.runtime.sendMessage({type:'archive:status'}));return state.value.items.find(item=>item.id===capture.value.id);},item=>item?.state==='completed','native capture'); await sourcePage.close();
      Object.assign(evidence,await lifecycle(sample,(await db.pool.query('SELECT document_id FROM web_captures WHERE capture_id=$1',[capture.value.id])).rows[0].document_id),{status:'passed',captureId:capture.value.id});
    } else {
      const primaryOwner = owner;
      if (sample.kind === 'synthetic' && sample.format === 'arxiv') owner = other;
      const previous=sample.format==='arxiv'&&report.samples.find(s=>s!==evidence&&s.format==='arxiv'&&s.documentId&&s.version.replace(/v\d+$/, '')===sample.version.replace(/v\d+$/, ''));
      const accepted=previous?await json(`/api/v1/documents/${previous.documentId}/source-refresh`,{method:'POST',body:{ref:sample.version,translationIntent:'none'},headers:{'Idempotency-Key':randomUUID()}},202):await json('/api/v1/documents/links',{method:'POST',body:{url:sample.url,translationIntent:'none'},headers:{'Idempotency-Key':randomUUID()}},201);
      const documentId=previous?.documentId??accepted.documentId; evidence.documentId=documentId; evidence.format=sample.format;
      if(sample.format==='github'&&!report.interruptions.some(item=>item.kind==='acquisition')) {
        const task=childProcess('hold-acquisition',sample), held=await task.wait('held'); const acquired=(await db.pool.query('SELECT id,role,sha256,bytes FROM source_acquisitions WHERE job_id=$1',[accepted.jobId])).rows; assert(acquired.length>0); await stop(task.child,'SIGKILL'); await expireLeases();
        report.interruptions.push({kind:'acquisition',pid:task.child.pid,boundary:held.boundary,acquired});
      }
      await run('job',sample);
      // arXiv's shared limiter may defer between the two durable material requests.
      await until(async()=>{const job=(await db.pool.query('SELECT status,error_code FROM web_jobs WHERE id=$1',[accepted.jobId])).rows[0]; if(job.status==='queued'){await delay(3100);await run('job',sample);} return job;},job=>['completed','failed'].includes(job.status),'source job',60000);
      const job=(await db.pool.query('SELECT status,error_code FROM web_jobs WHERE id=$1',[accepted.jobId])).rows[0]; assert.equal(job.status,'completed',JSON.stringify(job));
      const details=await json(`/api/v1/documents/${documentId}/source-details`); evidence.details=details;
      evidence.acquisitions=(await db.pool.query('SELECT id,role,sha256,bytes FROM source_acquisitions WHERE job_id=$1 ORDER BY role',[accepted.jobId])).rows;
      if(sample.format==='github') {
        const interrupted=report.interruptions.find(item=>item.kind==='acquisition');
        for(const retained of interrupted?.acquired??[])assert(evidence.acquisitions.some(row=>row.id===retained.id&&row.sha256===retained.sha256&&row.bytes===retained.bytes));
        const reads=report.processes.flatMap(process=>process.messages).filter(message=>message.type==='source-read'&&message.url===sample.responseUrl);assert.equal(reads.length,1,'Durable acquired repository response must not be fetched again after restart');
      }
      const sourcePage = owner === other ? otherPage : page;
      await sourcePage.goto(origin+'/library/'+documentId);
      await expect(sourcePage.getByText('管理资料',{exact:true})).toBeVisible();
      await sourcePage.getByText('管理资料',{exact:true}).click();
      const sourceRegion=sourcePage.getByRole('region',{name:'来源详情',exact:true});
      await expect(sourceRegion.getByText('来源原件已保存',{exact:false})).toBeVisible();
      if(sample.format==='arxiv')await expect(sourceRegion.getByRole('link',{name:'下载所选版本 PDF',exact:true})).toBeVisible();
      await sourcePage.screenshot({path:join(output,`${sample.id}-source.png`),fullPage:true});
      if(sample.format==='github') Object.assign(evidence,await lifecycle(sample,documentId));
      else {
        assert(details.current.pdf);
        const response = await request(`/api/v1/documents/${documentId}/source`); assert.equal(response.status,200);
        const digest=createHash('sha256'); for await(const chunk of response.body)digest.update(chunk); assert.equal(digest.digest('hex'),details.current.pdf.sha256);
        assert.equal((await request(`/api/v1/documents/${documentId}/source`,{actor:owner===other?primaryOwner:other})).status,404);
        evidence.pdfSha256=details.current.pdf.sha256;
        if(sample.kind==='synthetic') {
          const archiveSample=plan.samples.find(s=>s.id==='released-s3');
          if(archiveSample) {
            const admitted=await json('/api/v1/bundle-imports',{method:'POST',body:{targetDocumentId:documentId,targetSourceVersionId:details.current.sourceVersionId,targetPaperVersion:details.current.version},headers:{'Idempotency-Key':randomUUID()}},201);
            const imported=await json(`/api/v1/bundle-imports/${admitted.id}/content`,{method:'PUT',raw:Readable.from(verifiedInput(archiveSample.input)),mediaType:'application/zip'});
            assert.equal(imported.status,'completed'); assert.equal(imported.documentId,documentId); evidence.localBundleBinding=imported;
            const paper=await json(`/api/v1/documents/${documentId}`); assert.equal(paper.kind,'paper'); assert.equal(paper.reader.versionId,imported.readerVersionId);
          }
        }
      }
      owner=primaryOwner;
      evidence.status='passed';
    }
    for await(const _ of verifiedInput(sample.input)) {} for(const resource of sample.resources)for await(const _ of verifiedInput(resource.input)){}
    evidence.inputUnchanged=true; await save();
  }
  assert.equal(report.modelRequests,0); report.checks.push('two independent Chromium processes / two owners / independent API and worker processes; zero model calls');
  report.status='passed';
} catch(error) { report.status='failed'; report.error=error.stack; console.error(error.stack); process.exitCode=1; await page?.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{}); }
finally {
  await context?.tracing.stop({path:join(output,'trace.zip')}).catch(error=>{report.traceError=error.message;});
  await context?.close().catch(()=>{}); await contextB?.close().catch(()=>{}); await browserB?.close().catch(()=>{}); await browser?.close().catch(()=>{});
  for(const child of [...children])await stop(child); await db?.close();
  if(containerCreated)await writeFile(join(output,'postgres.log'),await command('docker',['logs',container]).catch(error=>error.message));
  if(containerCreated)await command('docker',['rm','--force',container]).catch(error=>{report.cleanupError=error.message;process.exitCode=1;});
  if(volumeCreated)await command('docker',['volume','rm',volume]).catch(error=>{report.cleanupError=error.message;process.exitCode=1;});
  if(root)await rm(root,{recursive:true,force:true});
  report.finishedAt=new Date().toISOString(); await save();
}
assert.equal(report.status,'passed','S4 acceptance failed; retained report and trace');
console.log(`S4 acceptance passed: ${report.samples.length} declared samples; no real model calls.`);
