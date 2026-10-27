import { Worker } from 'node:worker_threads';
import type { CaptureLimits, WebCaptureManifest, WebReaderIR, WebTranslation } from '@pagelingo/document-contracts';
import type { WebReaderBuild } from '@pagelingo/document-renderer';
import { ServiceError } from '../errors.js';
export interface ValidationInput { manifest: WebCaptureManifest; files: Array<{ id: string; path: string }>; limits: CaptureLimits; retained?: { sourceVersionId: string; manifestBytes: Uint8Array; irBytes: Uint8Array } }
export interface PreparedCapture {
  retainedSourceVersionId?: string; manifest: WebCaptureManifest; manifestBytes: Uint8Array; fingerprint: string; ir: WebReaderIR;
  translation: WebTranslation | null; build: WebReaderBuild; warnings: string[];
  files: Array<{ id: string; bytes: Uint8Array }>;
}
const entry = new URL(import.meta.url.endsWith('.ts') ? './validation-worker.ts' : './validation-worker.js', import.meta.url);
/** No principal, DB connection, provider configuration or ambient secrets enter this worker. */
export function validateCaptureInWorker(input: ValidationInput, signal: AbortSignal, deadlineMs = 60_000): Promise<PreparedCapture> {
  signal.throwIfAborted();
  const options = { env: { LANG: 'C.UTF-8', TZ: 'UTC' }, execArgv: [], workerData: input, resourceLimits: { maxOldGenerationSizeMb: 512 } };
  const worker = entry.pathname.endsWith('.ts')
    ? new Worker(`import('tsx/esm/api').then(({ tsImport }) => tsImport(${JSON.stringify(entry.href)}, ${JSON.stringify(import.meta.url)}))`, { ...options, eval: true })
    : new Worker(entry, options);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: PreparedCapture) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
      void worker.terminate().then(() => error ? reject(error) : resolve(value!), reject);
    };
    const cancel = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new ServiceError(408, 'CAPTURE_VALIDATION_TIMEOUT', 'Capture validation timed out')), deadlineMs);
    signal.addEventListener('abort', cancel, { once: true });
    worker.once('message', (message: { ok: boolean; value?: PreparedCapture }) => message.ok ? finish(undefined, message.value) : finish(new ServiceError(400, 'INVALID_CAPTURE', 'Capture validation failed')));
    worker.once('error', () => finish(new ServiceError(400, 'INVALID_CAPTURE', 'Capture validation failed')));
    worker.once('exit', () => { if (!settled) finish(new ServiceError(400, 'INVALID_CAPTURE', 'Capture validation stopped')); });
    if (signal.aborted) cancel();
  });
}
