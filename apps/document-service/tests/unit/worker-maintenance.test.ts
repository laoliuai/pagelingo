import { beforeEach, expect, it, vi } from 'vitest';
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
beforeEach(() => { calls.maintenance.mockReset(); calls.metadata.mockReset(); });
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
it.each(['maintenance','metadata'] as const)('reports sanitized %s failure, continues later runs and awaits held work on shutdown', async phase => {
  vi.useFakeTimers();
  const errorLog = vi.spyOn(console,'error').mockImplementation(() => {});
  const sensitive = new Error('SELECT private_text FROM documents; /private/object-key; credential=private-test-value');
  calls.maintenance.mockResolvedValue({}); calls.metadata.mockResolvedValue({});
  calls[phase].mockRejectedValueOnce(sensitive);
  const controller = new AbortController();
  const deps = { config:{ mode:'test',dataDir:'/unused' },db:{},store:{},provider:{},captureFetch:async()=>{},signal:controller.signal } as unknown as WebJobDependencies;
  let release!: () => void; const held = new Promise<void>(resolve => { release=resolve; });
  const pending = runWorker(deps); let settled = false; void pending.then(() => { settled=true; });
  try {
    await vi.advanceTimersByTimeAsync(200);
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(`Document worker ${phase === 'maintenance' ? 'document maintenance' : 'metadata backfill'} failed; retrying on the next scheduled run.`);
    expect(JSON.stringify(errorLog.mock.calls)).not.toMatch(/private_text|object-key|credential|private-test-value/);
    expect(calls.maintenance).toHaveBeenCalledTimes(1);
    expect(calls.metadata).toHaveBeenCalledTimes(1); // Cleanup failure does not suppress backfill.
    await vi.advanceTimersByTimeAsync(4600); expect(calls.maintenance).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200); expect(calls.maintenance).toHaveBeenCalledTimes(2);
    expect(calls.metadata).toHaveBeenCalledTimes(2); // Both phases recover on the next scheduled run.
    calls.maintenance.mockReturnValueOnce(held);
    await vi.advanceTimersByTimeAsync(5000); expect(calls.maintenance).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(6000); expect(calls.maintenance).toHaveBeenCalledTimes(3);
    controller.abort(); await vi.advanceTimersByTimeAsync(0); expect(settled).toBe(false);
    release(); await pending; expect(settled).toBe(true);
    expect(calls.metadata).toHaveBeenCalledTimes(2); // No new phase after shutdown starts.
    expect(errorLog).toHaveBeenCalledTimes(1);
  } finally { controller.abort(); release(); await pending; errorLog.mockRestore(); vi.useRealTimers(); }
});
