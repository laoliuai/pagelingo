import { Worker } from 'node:worker_threads';

const entry = new URL(import.meta.url.endsWith('.ts') ? './rasterize-worker.ts' : './rasterize-worker.js', import.meta.url);

/** Archived images are verified raster files. SVG is rendered in a terminable worker because its content is untrusted. */
export function rasterizeSvg(svg: Uint8Array, signal: AbortSignal, deadlineMs = 20_000): Promise<Uint8Array> {
  signal.throwIfAborted();
  const options = { env: { LANG: 'C.UTF-8', TZ: 'UTC' }, execArgv: [], workerData: { svg }, resourceLimits: { maxOldGenerationSizeMb: 256 } };
  const worker = entry.pathname.endsWith('.ts')
    ? new Worker(`import('tsx/esm/api').then(({ tsImport }) => tsImport(${JSON.stringify(entry.href)}, ${JSON.stringify(import.meta.url)}))`, { ...options, eval: true })
    : new Worker(entry, options);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: Uint8Array) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      void worker.terminate().then(() => error ? reject(error) : resolve(value!), reject);
    };
    const cancel = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error('SVG rendering timed out')), deadlineMs);
    signal.addEventListener('abort', cancel, { once: true });
    worker.once('message', (message: { ok: boolean; png?: Uint8Array }) => message.ok ? finish(undefined, message.png) : finish(new Error('SVG could not be rendered')));
    worker.once('error', () => finish(new Error('SVG rendering failed')));
    worker.once('exit', () => finish(new Error('SVG rendering stopped')));
  });
}
