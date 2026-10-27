import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CaptureFile } from '@pagelingo/document-contracts';
import { abortable } from '../bundle-imports/staging.js';
import { ServiceError } from '../errors.js';
export function stagingPath(dataDir: string, key: string): string {
  if (!/^[a-f0-9-]{36}$/.test(key)) throw new Error('Invalid staging key');
  return join(resolve(dataDir), 'web-staging', key);
}
/** Each attempt has an exclusive random path; only fully verified attempts get DB references. */
export async function receiveCaptureFile(dataDir: string, key: string, body: AsyncIterable<Uint8Array>, descriptor: CaptureFile, signal: AbortSignal): Promise<void> {
  const directory = join(resolve(dataDir), 'web-staging');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await realpath(directory)) !== directory || !(await lstat(directory)).isDirectory()) throw new Error('Unsafe staging directory');
  const path = stagingPath(dataDir, key);
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const hash = createHash('sha256'); let bytes = 0;
  try {
    for await (const chunk of abortable(body, signal)) {
      bytes += chunk.byteLength;
      if (bytes > descriptor.bytes) throw new ServiceError(400, 'CAPTURE_FILE_MISMATCH', 'Capture file does not match manifest');
      hash.update(chunk); let offset = 0;
      while (offset < chunk.byteLength) { signal.throwIfAborted(); offset += (await file.write(chunk, offset, chunk.byteLength - offset)).bytesWritten; }
    }
    if (bytes !== descriptor.bytes || hash.digest('hex') !== descriptor.sha256) throw new ServiceError(400, 'CAPTURE_FILE_MISMATCH', 'Capture file does not match manifest');
    await file.sync();
  } catch (error) { await unlink(path).catch(() => {}); throw error; }
  finally { await file.close(); }
}
