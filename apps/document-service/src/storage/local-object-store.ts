import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { ServiceError } from '../errors.js';
import type { ObjectStore } from './object-store.js';

const keyPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function isObjectKey(key: string): boolean { return keyPattern.test(key); }

/** Flat random keys and no-follow opens avoid trusting any user-supplied path. */
export function createLocalObjectStore(dataDir: string): ObjectStore {
  const root = resolve(dataDir);
  async function directory(path: string): Promise<void> {
    const parent = dirname(path);
    if (path !== parse(path).root) await directory(parent);
    try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe storage directory');
  }
  async function paths(key: string) {
    if (!isObjectKey(key)) throw new Error('Invalid object key');
    await directory(root); await directory(join(root, 'objects')); await directory(join(root, 'staging'));
    return { object: join(root, 'objects', key), staging: join(root, 'staging', randomUUID()) };
  }
  async function openObject(key: string) {
    const { object } = await paths(key);
    const file = await open(object, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (!(await file.stat()).isFile()) throw new Error('Invalid object file'); return file; }
    catch (error) { await file.close(); throw error; }
  }
  return {
    async putImmutable(key, body, maxBytes) {
      const { object, staging } = await paths(key);
      const file = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let bytes = 0; const hash = createHash('sha256');
      try {
        for await (const chunk of body) {
          bytes += chunk.byteLength;
          if (bytes > maxBytes) throw new ServiceError(413, 'PDF_TOO_LARGE', 'PDF exceeds the upload limit');
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.byteLength) { const result = await file.write(chunk, offset, chunk.byteLength - offset); offset += result.bytesWritten; }
        }
        await file.sync(); await file.close();
        // Hard-link publication is atomic and fails rather than replacing any destination.
        await link(staging, object);
        const objectDir = await open(join(root, 'objects'), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await objectDir.sync(); } finally { await objectDir.close(); }
        return { bytes, sha256: hash.digest('hex') };
      } finally { await file.close(); await unlink(staging).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
    },
    async stat(key) { const file = await openObject(key); try { return { bytes: (await file.stat()).size }; } finally { await file.close(); } },
    async *read(key, range) {
      const file = await openObject(key);
      try { yield* file.createReadStream({ autoClose: false, ...(range ? { start: range.start, end: range.end } : {}) }); }
      finally { await file.close(); }
    },
    async deleteUnreferenced(key) {
      const { object } = await paths(key);
      try { const file = await openObject(key); await file.close(); await unlink(object); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    },
  };
}
