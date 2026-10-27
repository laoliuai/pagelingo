import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ServiceError } from '../errors.js';

export function aborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason; }
/** Race next(), rather than waiting for a disconnected/uncooperative producer to return. */
export async function* abortable(body: AsyncIterable<Uint8Array>, signal: AbortSignal): AsyncIterable<Uint8Array> {
  const iterator = body[Symbol.asyncIterator](); let onAbort!: () => void;
  const stopped = new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); });
  try {
    aborted(signal);
    while (true) {
      const next = await Promise.race([iterator.next(), stopped]);
      if (next.done) break;
      aborted(signal); yield next.value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    // An arbitrary async iterator may be stuck in next(); do not block cancellation on return().
    void iterator.return?.().catch(() => {});
  }
}
export async function receiveArchive(dataDir: string, key: string, body: AsyncIterable<Uint8Array>, maxBytes: number, signal: AbortSignal): Promise<string> {
  const directory = join(resolve(dataDir), 'bundle-staging');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await realpath(directory)) !== directory || !(await lstat(directory)).isDirectory()) throw new Error('Unsafe staging directory');
  const path = join(directory, key);
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let bytes = 0;
  try {
    for await (const chunk of abortable(body, signal)) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new ServiceError(413, 'BUNDLE_TOO_LARGE', 'Bundle exceeds the upload limit');
      let offset = 0;
      while (offset < chunk.byteLength) { aborted(signal); offset += (await file.write(chunk, offset, chunk.byteLength - offset)).bytesWritten; }
    }
    await file.sync(); return path;
  } catch (error) { await unlink(path).catch(() => {}); throw error; }
  finally { await file.close(); }
}
