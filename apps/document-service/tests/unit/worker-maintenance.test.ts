import { expect, it, vi } from 'vitest';
import { runWorker } from '../../src/worker/main.js';
import type { WebJobDependencies } from '../../src/web-jobs/translation-runner.js';
const calls=vi.hoisted(()=>({ maintenance:vi.fn(),metadata:vi.fn() }));
vi.mock('../../src/document-lifecycle/maintenance.js',()=>({ runDocumentMaintenance:calls.maintenance }));
vi.mock('../../src/document-management/metadata-projection.js',()=>({ runMetadataBackfill:calls.metadata }));
vi.mock('../../src/db/migrate.js',()=>({ verifyDatabaseSchema:async()=>{} }));
vi.mock('../../src/web-jobs/lease.js',()=>({ reconcileWebJobs:async()=>{},claimWebJob:async()=>null }));
vi.mock('../../src/worker/finalizer-schedule.js',()=>({ FinalizerSchedule:class { async next(){return [];} } }));
// Keep the process loop deterministic without waiting real seconds.
vi.mock('node:timers/promises',()=>({ setTimeout:(ms:number,_value:unknown,{ signal }:{ signal:AbortSignal })=>new Promise<void>(resolve=>{ const timer=setTimeout(resolve,ms); signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true}); }) }));
it('starts maintenance at most once per five seconds and never overlaps a pending run', async()=>{
  vi.useFakeTimers(); let release!:()=>void; const held=new Promise<void>(r=>{release=r;});
  calls.maintenance.mockReturnValueOnce(held).mockResolvedValue({}); calls.metadata.mockResolvedValue({});
  const controller=new AbortController();
  const deps={ config:{ mode:'test',dataDir:'/unused' },db:{},store:{},provider:{},captureFetch:async()=>{},signal:controller.signal } as unknown as WebJobDependencies;
  const pending=runWorker(deps);
  try {
    await vi.advanceTimersByTimeAsync(12000); expect(calls.maintenance).toHaveBeenCalledTimes(1); expect(calls.metadata).not.toHaveBeenCalled();
    release(); await vi.advanceTimersByTimeAsync(200); expect(calls.maintenance).toHaveBeenCalledTimes(2); expect(calls.metadata).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4600); expect(calls.maintenance).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(400); expect(calls.maintenance).toHaveBeenCalledTimes(3);
  } finally { controller.abort(); release(); await pending; vi.useRealTimers(); }
});
