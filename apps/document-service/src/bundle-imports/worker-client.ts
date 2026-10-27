import { Worker } from 'node:worker_threads';
import type { BundleLimits, DocumentBundleManifest } from '@pagelingo/document-contracts';
import { ServiceError } from '../errors.js';
export interface PreparedBundle {
  manifest: DocumentBundleManifest; manifestSha256: string;
  parseStatus: 'complete' | 'partial'; parseCoverage: 'full' | 'partial'; warnings: string[];
  generated: Array<{ kind: 'index' | 'chunk'; id: string; content: Uint8Array }>;
}
const defaultEntry = new URL(import.meta.url.endsWith('.ts') ? './validation-worker.ts' : './validation-worker.js', import.meta.url);
/** Focused worker boundary. The parent deadline kills synchronous SDK/renderer work. */
export function validateInWorker(path: string, limits: BundleLimits, signal: AbortSignal,
  options: { deadlineMs?: number; entry?: URL } = {}): Promise<PreparedBundle> {
  signal.throwIfAborted();
  const entry = options.entry ?? defaultEntry;
  // Positive allowlist: never inherit NODE_OPTIONS, provider credentials, DB URL or master keys.
  const env = { LANG: 'C.UTF-8', TZ: 'UTC' };
  const worker = entry.pathname.endsWith('.ts')
    ? new Worker(`import('tsx/esm/api').then(({ tsImport }) => tsImport(${JSON.stringify(entry.href)}, ${JSON.stringify(import.meta.url)}))`, { eval: true, env, execArgv: [], workerData: { path, limits } })
    : new Worker(entry, { env, execArgv: [], workerData: { path, limits } });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: PreparedBundle) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal.removeEventListener('abort', cancel);
      // Await termination before releasing the instance processing slot.
      void worker.terminate().then(() => { if (error) reject(error); else resolve(value!); }, reject);
    };
    const cancel = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new ServiceError(408, 'BUNDLE_VALIDATION_TIMEOUT', 'Bundle validation timed out')), options.deadlineMs ?? 5 * 60_000);
    signal.addEventListener('abort', cancel, { once: true });
    worker.once('message', (message: { ok: boolean; code?: string; value?: PreparedBundle }) => {
      if (message.ok) finish(undefined, message.value);
      else finish(new ServiceError(message.code === 'BUNDLE_TOO_LARGE' ? 413 : 400, message.code ?? 'INVALID_BUNDLE', 'Bundle validation failed'));
    });
    worker.once('error', () => finish(new ServiceError(400, 'INVALID_BUNDLE', 'Bundle validation failed')));
    worker.once('exit', () => { if (!settled) finish(new ServiceError(400, 'INVALID_BUNDLE', 'Bundle validation stopped')); });
    if (signal.aborted) cancel();
  });
}
