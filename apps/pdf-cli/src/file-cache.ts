import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { type CacheEntry, type TranslationCache } from '@pagelingo/translation-core';
import { serializeBundleJson } from '@pagelingo/document-bundle';
import type { RunLock } from './run-lock.js';
import { atomicWrite, readJson, privateDirectory } from './file-checkpoints.js';
/** Cache text is untrusted: SDK validates structure and evicts poisoned entries. */
export class FileTranslationCache implements TranslationCache {
  constructor(readonly directory: string, private readonly lock?: RunLock) {}
  private path(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('TRANSLATION_CACHE_KEY_INVALID');
    return join(this.directory, `${key}.json`);
  }
  async get(key: string): Promise<CacheEntry | undefined> {
    try {
      const entry = await readJson(this.path(key)) as CacheEntry;
      if (entry?.schemaVersion === 1 && entry.key === key && typeof entry.text === 'string' && Number.isFinite(entry.bytes) && Number.isFinite(entry.createdAt) && Number.isFinite(entry.lastAccessedAt)) return entry;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; }
    await this.delete(key); return undefined;
  }
  async putMany(entries: CacheEntry[]): Promise<void> {
    if (!entries.length) return;
    await privateDirectory(this.directory);
    for (const entry of entries) await atomicWrite(this.path(entry.key), serializeBundleJson({
      key: entry.key, text: entry.text, schemaVersion: entry.schemaVersion, createdAt: entry.createdAt,
      lastAccessedAt: entry.lastAccessedAt, bytes: entry.bytes,
    }), false, this.lock ? () => this.lock!.assertCurrent() : undefined);
  }
  async delete(key: string): Promise<void> {
    await this.lock?.assertCurrent();
    try { await unlink(this.path(key)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
