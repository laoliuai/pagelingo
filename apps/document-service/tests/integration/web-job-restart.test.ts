import { afterEach, expect, it } from 'vitest';
import { jobFixture, eventually } from '../helpers/web-jobs.js';
import { startWorker } from '../helpers/worker-process.js';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
it('survives a killed worker with no replay of completed units after the browser session closes', async () => {
  const t = await jobFixture(); closes.push(t.close); const s = await t.save(16);
  const first = await startWorker(t,{holdPublication:true}); closes.push(first.stop);
  await eventually(async () => first.messages, v => v.some(m=>m.type==='publication'));
  expect((await t.db.pool.query('SELECT id FROM web_translation_runs WHERE job_id=$1',[s.jobId])).rows).toEqual([]);
  const checkpoint = (await t.db.pool.query('SELECT checkpoint FROM web_job_checkpoints WHERE job_id=$1',[s.jobId])).rows[0].checkpoint;
  const completed = new Set<string>(checkpoint.units.filter((u: { status: string }) => u.status === 'completed').map((u: { id: string }) => u.id));
  expect(completed.size).toBeGreaterThan(0);
  await first.stop('SIGKILL');
  await t.request('/api/v1/auth/logout','POST',{});
  await t.db.pool.query("UPDATE web_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[s.jobId]);
  await t.db.pool.query("UPDATE web_worker_slots SET lease_until=clock_timestamp()-interval '1 second' WHERE job_id=$1",[s.jobId]);
  const second = await startWorker(t); closes.push(second.stop);
  await eventually(async () => (await t.db.pool.query('SELECT status FROM web_jobs WHERE id=$1',[s.jobId])).rows[0].status, v => v==='completed');
  const replayedCompletedUnitRequests = second.messages.flatMap(m => m.units ?? []).filter(id => completed.has(id)).length;
  expect(replayedCompletedUnitRequests).toBe(0);
  expect(second.output()).toBe('');
});
it('retains the SDK 429 cooldown across process restart and accounts only to the owner', async () => {
  const t = await jobFixture(); closes.push(t.close); const s = await t.save(8);
  const first = await startWorker(t,{rateLimit:true}); closes.push(first.stop);
  const until = await eventually(async () => (await t.db.pool.query('SELECT next_request_at FROM web_jobs WHERE id=$1',[s.jobId])).rows[0].next_request_at as Date | null,v => v !== null);
  await first.stop('SIGKILL');
  await t.db.pool.query("UPDATE web_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[s.jobId]);
  await t.db.pool.query("UPDATE web_worker_slots SET lease_until=clock_timestamp()-interval '1 second' WHERE job_id=$1",[s.jobId]);
  const second = await startWorker(t); closes.push(second.stop);
  await new Promise(resolve => setTimeout(resolve,300));
  expect(Date.now()).toBeLessThan(until!.getTime()); expect(second.messages).toEqual([]);
  await eventually(async () => (await t.db.pool.query('SELECT status FROM web_jobs WHERE id=$1',[s.jobId])).rows[0].status,v => v==='completed');
  const saved = (await t.db.pool.query('SELECT checkpoint FROM web_job_checkpoints WHERE job_id=$1',[s.jobId])).rows[0].checkpoint;
  expect(saved.metrics.requests).toBe(3); expect(saved.metrics.usageRequests).toBe(2); expect(saved.metrics.totalTokens).toBe(30);
});
it('actively aborts an outstanding provider call and pauses after configuration changes', async () => {
  const t = await jobFixture(); closes.push(t.close); const s = await t.save();
  const worker = await startWorker(t,{delay:10000}); closes.push(worker.stop);
  await eventually(async () => worker.messages,v => v.some(m => m.type==='request'));
  await t.profile(1);
  await eventually(async () => worker.messages,v => v.some(m => m.type==='aborted'));
  expect((await t.db.pool.query('SELECT status FROM web_jobs WHERE id=$1',[s.jobId])).rows[0].status).toBe('paused-config');
  expect(worker.messages.filter(m => m.type==='request')).toHaveLength(1);
});
it('two independent workers enforce global two and owner one while cache and usage stay owner-scoped', async () => {
  const t = await jobFixture(); closes.push(t.close);
  expect((await t.request('/api/v1/admin/users','POST',{username:'alice',password:'correct password 123456'})).statusCode).toBe(201);
  const alice = await jobFixture(t,'alice');
  const a = await t.save(8), a2 = await t.save(12);
  const left=await startWorker(t,{delay:1000});closes.push(left.stop);
  await eventually(async()=>left.messages,v=>v.some(m=>m.type==='request'));
  let right!:Awaited<ReturnType<typeof startWorker>>, b!:typeof a, b2!:typeof a;
  left.child.kill('SIGSTOP');
  const pausedAt=Date.now();
  try {
    b=await alice.save(8);b2=await alice.save(12);
    right=await startWorker(t,{delay:1000});closes.push(right.stop);
    await eventually(async()=>right.messages,v=>v.some(m=>m.type==='request'),10000);
  } finally {left.child.kill('SIGCONT');}
  expect(Date.now()-pausedAt).toBeLessThan(15000);
  expect(left.messages.some(m=>m.type==='request')).toBe(true);
  expect(right.messages.some(m=>m.type==='request')).toBe(true);
  let maxRunningGlobal=0, maxRunningPerOwner=0;
  await eventually(async () => {
    const rows = (await t.db.pool.query('SELECT owner_id,status FROM web_jobs')).rows;
    const running = rows.filter(j => j.status==='running');
    maxRunningGlobal=Math.max(maxRunningGlobal,running.length);
    for (const owner of new Set(running.map(j => j.owner_id))) maxRunningPerOwner=Math.max(maxRunningPerOwner,running.filter(j => j.owner_id===owner).length);
    return rows.every(j => j.status==='completed');
  },v => v);
  expect(maxRunningGlobal).toBe(2); expect(maxRunningGlobal).toBeLessThanOrEqual(2); expect(maxRunningPerOwner).toBe(1);
  expect(new Set([left.child.pid,right.child.pid]).size).toBe(2);
  const rows = (await t.db.pool.query('SELECT job_id,owner_id,checkpoint FROM web_job_checkpoints')).rows;
  for (const job of [a,b]) { const row=rows.find(r => r.job_id===job.jobId)!; expect(row.checkpoint.metrics.requests).toBeGreaterThan(0); expect(row.checkpoint.metrics.cacheHits).toBe(0); expect(row.checkpoint.metrics.totalTokens).toBeGreaterThan(0); }
  for (const job of [a2,b2]) { const row=rows.find(r => r.job_id===job.jobId)!; expect(row.checkpoint.metrics.cacheHits).toBe(8); expect(row.checkpoint.metrics.totalTokens).toBeLessThan(rows.find(r => r.job_id===(job===a2 ? a.jobId : b.jobId))!.checkpoint.metrics.totalTokens); }
  expect((await t.db.pool.query('SELECT DISTINCT owner_id FROM web_owner_cache')).rows).toHaveLength(2);
  const progress=(await t.db.pool.query('SELECT completed_units,total_units FROM web_jobs')).rows;
  for(const job of progress) expect(job.completed_units).toBe(job.total_units);
  expect((await alice.request(`/api/v1/web-jobs/${a.jobId}`)).statusCode).toBe(404);
},30000);
it('account disable actively aborts outstanding work and cannot publish a terminal result', async () => {
  const t=await jobFixture();closes.push(t.close);
  const created=await t.request('/api/v1/admin/users','POST',{username:'alice',password:'correct password 123456'});
  const alice=await jobFixture(t,'alice');const s=await alice.save();
  const worker=await startWorker(t,{delay:10000});closes.push(worker.stop);
  await eventually(async()=>worker.messages,v=>v.some(m=>m.type==='request'));
  const disabled=await t.app.inject({method:'PATCH',url:`/api/v1/admin/users/${created.json().id}`,headers:t.headers,payload:{active:false}});
  expect(disabled.statusCode,disabled.body).toBe(200);
  await eventually(async()=>worker.messages,v=>v.some(m=>m.type==='aborted'));
  const row=(await t.db.pool.query('SELECT status,reader_version_id FROM web_jobs WHERE id=$1',[s.jobId])).rows[0];
  expect(row.status).toBe('paused-config');expect(row.reader_version_id).toBeNull();
  expect((await t.db.pool.query('SELECT id FROM web_translation_runs WHERE job_id=$1',[s.jobId])).rows).toEqual([]);
});
