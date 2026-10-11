import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import { CheckpointConflictError, type CacheEntry, type TranslationCache, type TranslationCheckpoint, type TranslationDocument, type TranslationStateStore } from '@pagelingo/translation-core';
import type { UserSettings } from '../settings/schema';

export type PublicSettings = Omit<UserSettings, 'apiKey'>;
export type JobStatus = 'granted' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed' | 'superseded';
export interface JobRecord {
  id: string; tabId: number; documentId?: string; pageSessionId?: string; url?: string;
  fingerprint?: string; configSignature: string; settings: PublicSettings;
  status: JobStatus; epoch: number; owner?: string; createdAt: number; updatedAt: number; expiresAt: number;
  document?: TranslationDocument; checkpoint?: TranslationCheckpoint;
}
export interface DocumentRecord { key: string; fingerprint: string; updatedAt: number; total: number }
interface DatabaseSchema extends DBSchema {
  translations: { key: string; value: CacheEntry };
  documents: { key: string; value: DocumentRecord };
  jobs: { key: string; value: JobRecord };
}

/** Owned by the extension origin. Never instantiated in a content script. */
export class TranslationDatabase implements TranslationCache {
  readonly name: string;
  private database?: Promise<IDBPDatabase<DatabaseSchema>>;
  private warning?: string;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly jobs = new Map<string, JobRecord>();
  private readonly documents = new Map<string, DocumentRecord>();
  private maxBytes: number;
  private readonly ttlMs: number;
  constructor(options: { name?: string; maxBytes?: number; ttlMs?: number } = {}) {
    this.name = options.name ?? 'pagelingo'; this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.ttlMs = options.ttlMs ?? 30 * 24 * 60 * 60 * 1000;
  }
  setMaxBytes(bytes: number): void { this.maxBytes = bytes; }
  private open(): Promise<IDBPDatabase<DatabaseSchema>> {
    this.database ??= new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Database opening timed out')), 3000);
      const pending = openDB<DatabaseSchema>(this.name, 2, {
        upgrade(db) { for (const name of ['translations', 'documents', 'jobs'] as const) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: name === 'jobs' ? 'id' : 'key' }); },
        blocking: () => { void this.database?.then((db) => db.close()).catch(() => {}); },
      });
      void pending.then((db) => { clearTimeout(timer); resolve(db); }, (error: unknown) => { clearTimeout(timer); reject(error); });
    });
    return this.database;
  }
  private degrade(): void { this.warning = '本地缓存写入受限，已使用临时内存；关闭后台后这些结果可能无法恢复。'; }
  async get(key: string): Promise<CacheEntry | undefined> {
    let entry: CacheEntry | undefined;
    try { entry = this.warning ? this.cache.get(key) : await (await this.open()).get('translations', key); }
    catch { this.degrade(); entry = this.cache.get(key); }
    if (!entry) return undefined;
    if (entry.schemaVersion !== 1 || typeof entry.text !== 'string' || !Number.isFinite(entry.createdAt) || entry.createdAt + this.ttlMs < Date.now()) { await this.delete(key); return undefined; }
    entry.lastAccessedAt = Date.now(); this.cache.set(key, entry);
    try { if (!this.warning) await (await this.open()).put('translations', entry); } catch { this.degrade(); }
    return structuredClone(entry);
  }
  async putMany(entries: CacheEntry[]): Promise<void> {
    if (!entries.length) return;
    try {
      if (!this.warning) {
        const tx = (await this.open()).transaction('translations', 'readwrite');
        const done = tx.done; void done.catch(() => {});
        for (const entry of entries) await tx.store.put(entry);
        await done;
      }
    } catch { this.degrade(); }
    entries.forEach((entry) => this.cache.set(entry.key, structuredClone(entry)));
    await this.prune();
  }
  async delete(key: string): Promise<void> {
    this.cache.delete(key);
    try { if (!this.warning) await (await this.open()).delete('translations', key); } catch { this.degrade(); }
  }
  async getJob(id: string): Promise<JobRecord | undefined> {
    try {
      const job = this.warning ? this.jobs.get(id) : await (await this.open()).get('jobs', id);
      if (job) this.jobs.set(id, structuredClone(job)); return job && structuredClone(job);
    } catch { this.degrade(); return structuredClone(this.jobs.get(id)); }
  }
  async listJobs(): Promise<JobRecord[]> {
    try {
      const jobs = this.warning ? [...this.jobs.values()] : await (await this.open()).getAll('jobs');
      jobs.forEach((job) => this.jobs.set(job.id, job)); return structuredClone(jobs);
    } catch { this.degrade(); return structuredClone([...this.jobs.values()]); }
  }
  async putJob(job: JobRecord): Promise<void> {
    // Defense at the persistence boundary, even if a caller passes UserSettings.
    const { apiKey: _secret, ...settings } = job.settings as UserSettings;
    const record = structuredClone({ ...job, settings });
    try { if (!this.warning) await (await this.open()).put('jobs', record); } catch { this.degrade(); }
    this.jobs.set(job.id, record);
  }
  async updateJob(id: string, epoch: number, patch: Partial<JobRecord>): Promise<JobRecord> {
    let job: JobRecord | undefined;
    try {
      if (!this.warning) {
        const tx = (await this.open()).transaction('jobs', 'readwrite'); const done = tx.done; void done.catch(() => {});
        job = await tx.store.get(id);
        if (!job || job.epoch !== epoch || job.status === 'cancelled' || job.status === 'superseded') { tx.abort(); throw new CheckpointConflictError('任务已停止或已被更新。'); }
        job = { ...job, ...patch, id, updatedAt: Date.now() }; await tx.store.put(job); await done;
      }
    } catch (error) { if (error instanceof CheckpointConflictError) throw error; this.degrade(); }
    if (this.warning) {
      job = this.jobs.get(id);
      if (!job || job.epoch !== epoch || job.status === 'cancelled' || job.status === 'superseded') throw new CheckpointConflictError('任务已停止或已被更新。');
      job = { ...job, ...patch, id, updatedAt: Date.now() };
    }
    this.jobs.set(id, structuredClone(job!)); return structuredClone(job!);
  }
  async cancelJob(id: string): Promise<void> {
    const job = await this.getJob(id);
    if (job && job.status !== 'cancelled' && job.status !== 'superseded') await this.updateJob(id, job.epoch, { status: 'cancelled', epoch: job.epoch + 1 });
  }
  stateStore(id: string, epoch: number): TranslationStateStore {
    const check = (job?: JobRecord) => {
      if (!job || job.epoch !== epoch || job.status !== 'running') throw new CheckpointConflictError('任务已停止或已被更新。');
      return job;
    };
    return {
      load: async () => check(await this.getJob(id)).checkpoint,
      save: async (checkpoint, entries) => {
        let job: JobRecord | undefined;
        try {
          if (!this.warning) {
            const tx = (await this.open()).transaction(['jobs', 'translations', 'documents'], 'readwrite'); const done = tx.done; void done.catch(() => {});
            try {
              job = check(await tx.objectStore('jobs').get(id));
              job = { ...job, checkpoint, updatedAt: Date.now() };
              await tx.objectStore('jobs').put(job);
              for (const entry of entries) await tx.objectStore('translations').put(entry);
              if (job.url && job.fingerprint) await tx.objectStore('documents').put({ key: job.url, fingerprint: job.fingerprint, updatedAt: Date.now(), total: job.document?.blocks.length ?? 0 });
              await done;
            } catch (error) { try { tx.abort(); } catch { /* Already aborted/committed. */ } throw error; }
          }
        } catch (error) { if (error instanceof CheckpointConflictError) throw error; this.degrade(); }
        if (this.warning) job = { ...check(this.jobs.get(id)), checkpoint, updatedAt: Date.now() };
        this.jobs.set(id, structuredClone(job!)); entries.forEach((entry) => this.cache.set(entry.key, structuredClone(entry)));
        await this.prune();
      },
    };
  }
  async putDocument(record: DocumentRecord): Promise<void> {
    this.documents.set(record.key, structuredClone(record));
    try { if (!this.warning) await (await this.open()).put('documents', record); } catch { this.degrade(); }
  }
  async clear(kind: 'translations' | 'documents' | 'all'): Promise<void> {
    if (kind !== 'documents') this.cache.clear(); if (kind !== 'translations') this.documents.clear();
    let tx: IDBPTransaction<DatabaseSchema, ['translations', 'documents', 'jobs'], 'readwrite'> | undefined;
    try {
      // A failed write does not mean existing persistent data has disappeared.
      // Deletion must still reach IDB, and must not report success if it fails.
      tx = (await this.open()).transaction(['translations', 'documents', 'jobs'], 'readwrite');
      void tx.done.catch(() => {});
      if (kind !== 'documents') await tx.objectStore('translations').clear();
      if (kind !== 'translations') await tx.objectStore('documents').clear();
      if (kind === 'all') for (const job of await tx.objectStore('jobs').getAll()) if (!['running', 'granted', 'paused'].includes(job.status)) {
        await tx.objectStore('jobs').delete(job.id);
      }
      await tx.done;
    } catch {
      try { tx?.abort(); } catch { /* The transaction may already have ended. */ }
      this.degrade();
      throw new Error('持久化缓存清理失败，请稍后重试。');
    }
    if (kind === 'all') for (const job of this.jobs.values()) if (!['running', 'granted', 'paused'].includes(job.status)) this.jobs.delete(job.id);
  }
  async stats(): Promise<{ translations: number; documents: number; jobs: number; bytes: number; warning?: string }> {
    try {
      if (!this.warning) {
        const db = await this.open(); const tx = db.transaction(['translations', 'documents', 'jobs']);
        const [entries, documents, jobs] = await Promise.all([tx.objectStore('translations').getAll(), tx.objectStore('documents').count(), tx.objectStore('jobs').count()]);
        return { translations: entries.length, documents, jobs, bytes: entries.reduce((sum, e) => sum + e.bytes, 0) };
      }
    } catch { this.degrade(); }
    return { translations: this.cache.size, documents: this.documents.size, jobs: this.jobs.size,
      bytes: [...this.cache.values()].reduce((sum, e) => sum + e.bytes, 0), warning: this.warning };
  }
  private async prune(): Promise<void> {
    let limit = this.maxBytes;
    try { const quota = (await globalThis.navigator?.storage?.estimate())?.quota; if (quota) limit = Math.min(limit, Math.floor(quota * 0.2)); } catch { /* Application budget is still enforced. */ }
    try {
      const entries = this.warning ? [...this.cache.values()] : await (await this.open()).getAll('translations');
      entries.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
      let bytes = entries.reduce((sum, e) => sum + (Number.isFinite(e.bytes) ? e.bytes : limit + 1), 0);
      for (const entry of entries) if (bytes > limit || entry.schemaVersion !== 1 || entry.createdAt + this.ttlMs < Date.now()) { await this.delete(entry.key); bytes -= entry.bytes || 0; }
      const jobs = (await this.listJobs()).filter((job) => job.status !== 'running' && !(job.status === 'granted' && job.expiresAt >= Date.now())).sort((a, b) => b.updatedAt - a.updatedAt);
      for (const [index, job] of jobs.entries()) if (index >= 50 || job.updatedAt + 7 * 86400000 < Date.now() || (job.status === 'granted' && job.expiresAt < Date.now())) {
        this.jobs.delete(job.id); if (!this.warning) await (await this.open()).delete('jobs', job.id);
      }
      const documents = this.warning ? [...this.documents.values()] : await (await this.open()).getAll('documents');
      documents.sort((a, b) => b.updatedAt - a.updatedAt);
      for (const [index, doc] of documents.entries()) if (index >= 1000 || doc.updatedAt + this.ttlMs < Date.now()) {
        this.documents.delete(doc.key); if (!this.warning) await (await this.open()).delete('documents', doc.key);
      }
    } catch { this.degrade(); }
  }
  async close(): Promise<void> { try { (await this.database)?.close(); } catch { /* Unavailable database. */ } }
}
