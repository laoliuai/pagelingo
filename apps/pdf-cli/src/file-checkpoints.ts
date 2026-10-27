import { randomUUID } from 'node:crypto';
import { open, rename, unlink, link, readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CheckpointConflictError, type TranslationCheckpoint, type TranslationStateStore, type CacheEntry } from '@pagelingo/translation-core';
import { serializeBundleJson } from '@pagelingo/document-bundle';
import type { RunLock } from './run-lock.js';
import type { FileTranslationCache } from './file-cache.js';
export type AtomicWrite = (path: string, bytes: Uint8Array, exclusive?: boolean, beforePublish?: () => Promise<void>) => Promise<void>;
export async function atomicWrite(path: string, bytes: Uint8Array, exclusive = false, beforePublish?: () => Promise<void>): Promise<void> {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
    await beforePublish?.();
    if (exclusive) { await link(temp, path); await unlink(temp); } else await rename(temp, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await handle?.close(); await unlink(temp).catch(() => {}); }
}
export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}
export async function privateDirectory(path: string): Promise<void> { await mkdir(path, { recursive: true, mode: 0o700 }); }
export class FileCheckpointStore implements TranslationStateStore {
  constructor(readonly path: string, private readonly lock: RunLock, private readonly cache: FileTranslationCache, private readonly write: AtomicWrite = atomicWrite) {}
  async load(): Promise<TranslationCheckpoint | undefined> {
    await this.lock.assertCurrent();
    try { return await readJson(this.path) as TranslationCheckpoint; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new CheckpointConflictError('TRANSLATION_STATE_UNREADABLE');
    }
  }
  async save(checkpoint: TranslationCheckpoint, entries: CacheEntry[]): Promise<void> {
    try {
      await this.lock.assertCurrent();
      await this.cache.putMany(entries);
      await this.lock.assertCurrent();
      await this.write(this.path, serializeBundleJson(checkpoint), false, () => this.lock.assertCurrent());
      await this.lock.assertCurrent();
    } catch (error) {
      if (error instanceof CheckpointConflictError) throw error;
      throw new CheckpointConflictError('TRANSLATION_DISK_WRITE_FAILED');
    }
  }
}
