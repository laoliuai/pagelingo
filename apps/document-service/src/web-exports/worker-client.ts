import { Worker } from 'node:worker_threads';
import { ServiceError } from '../errors.js';
import type { ExportMaterial } from './assembly.js';
const entry = new URL(import.meta.url.endsWith('.ts') ? './export-worker.ts' : './export-worker.js',import.meta.url);
export async function exportInWorker(input: { material: ExportMaterial; dataDir: string; workspace: string; objectKey: string }, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const options = { env: { LANG: 'C.UTF-8',TZ: 'UTC' },execArgv: [],workerData: input,resourceLimits: { maxOldGenerationSizeMb: 768 } };
  const worker = entry.pathname.endsWith('.ts')
    ? new Worker(`import('tsx/esm/api').then(({ tsImport }) => tsImport(${JSON.stringify(entry.href)}, ${JSON.stringify(import.meta.url)}))`,{ ...options,eval: true })
    : new Worker(entry,options);
  return new Promise((resolve,reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort',cancel);
      void worker.terminate().then(() => error ? reject(error) : resolve(),reject);
    };
    const cancel = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new ServiceError(408,'EXPORT_TIMEOUT','Export timed out')),120_000);
    signal.addEventListener('abort',cancel,{ once: true });
    worker.once('message',(m: { ok: boolean; code?: string }) => finish(m.ok ? undefined : new ServiceError(400,['BUNDLE_UNSUPPORTED_SOURCE', 'EXPORT_ORIGINALS_UNAVAILABLE'].includes(m.code ?? '') ? m.code! : 'EXPORT_FAILED','Export could not be generated')));
    worker.once('error',() => finish(new ServiceError(400,'EXPORT_FAILED','Export could not be generated')));
    worker.once('exit',() => { if (!settled) finish(new ServiceError(400,'EXPORT_FAILED','Export stopped')); });
    if (signal.aborted) cancel();
  });
}
