import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { webCaptureResultSchema, documentLinkResultSchema } from '@pagelingo/document-contracts';
import type { CaptureDraft, CaptureFile, CaptureResource, TranslationIntent, CreateWebCaptureRequest, CreateDocumentLinkRequest, WebCaptureResult, DocumentLinkResult } from '@pagelingo/document-contracts';
import { partition, sameBinding, siteBindingSchema, type SiteBinding } from './binding.js';
import type { CaptureGrant } from './grants.js';
import { splitArchiveEntry, joinArchiveEntry, type ArchiveHeader, type ArchivePayload } from './outbox-payloads.js';
export type { ArchiveHeader, ArchivePayload } from './outbox-payloads.js';

export interface ArchiveEntry {
  id: string; partition: string; kind: 'capture' | 'link'; state: 'permission' | 'pending' | 'retry' | 'manual' | 'completed' | 'cancelled';
  translationIntent?: TranslationIntent; draft?: CaptureDraft; grant?: CaptureGrant; grantGeneration?: string; request?: CreateWebCaptureRequest; linkRequest?: CreateDocumentLinkRequest; linkAttempted?: boolean;
  resources: CaptureResource[]; ingestionId?: string; result?: WebCaptureResult; linkResult?: DocumentLinkResult;
  attempts: number; nextAttemptAt: number; createdAt: number; warnings: string[]; error?: string; cancelRequested?: boolean;
  completedBinding?: SiteBinding; compactedAt?: number;
}
export interface ArchiveFile { partition: string; captureId: string; descriptor: CaptureFile; bytes: Uint8Array }
interface ArchiveSchema extends DBSchema {
  entries: { key: [string, string]; value: ArchiveHeader; indexes: { partition: string; partitionCreatedAt: [string, number, string] } };
  payloads: { key: [string, string]; value: ArchivePayload };
  files: { key: [string, string, string]; value: ArchiveFile; indexes: { capture: [string, string] } };
}
export type ArchivePageCursor = [number, string];
async function abortWrite(tx: { abort(): void; done: Promise<unknown> }, error: unknown): Promise<never> {
  try { tx.abort(); } catch { /* A request failure may already have aborted it. */ }
  await tx.done.catch(() => {}); throw error;
}
export class ArchiveDatabase {
  private readonly db: Promise<IDBPDatabase<ArchiveSchema>>;
  constructor(name = 'pagelingo-archives-v1') {
    this.db = openDB<ArchiveSchema>(name, 2, { upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion === 0) {
        db.createObjectStore('entries', { keyPath: ['partition', 'id'] }).createIndex('partition', 'partition');
        db.createObjectStore('files', { keyPath: ['partition', 'captureId', 'descriptor.id'] }).createIndex('capture', ['partition', 'captureId']);
      }
      tx.objectStore('entries').createIndex('partitionCreatedAt', ['partition', 'createdAt', 'id']);
      const payloads = db.createObjectStore('payloads', { keyPath: ['partition', 'id'] });
      // A versionchange transaction is atomic, including all row moves and the new schema.
      void (async () => {
        let cursor = await tx.objectStore('entries').openCursor();
        while (cursor) {
          const { header, payload } = splitArchiveEntry(cursor.value as unknown as ArchiveEntry);
          await payloads.put(payload); await cursor.update(header); cursor = await cursor.continue();
        }
      })().catch(() => { try { tx.abort(); } catch { /* Request errors can abort before this continuation. */ } });
    } });
  }
  async get(binding: SiteBinding, id: string): Promise<ArchiveEntry | undefined> {
    const tx = (await this.db).transaction(['entries', 'payloads']); const key: [string, string] = [partition(binding), id];
    const [header, payload] = await Promise.all([tx.objectStore('entries').get(key), tx.objectStore('payloads').get(key)]);
    await tx.done; return header ? joinArchiveEntry(header, payload) : undefined;
  }
  /** At most 50 bounded headers. Cursor is the last returned [createdAt,id], exclusive. */
  async list(binding: SiteBinding, before?: ArchivePageCursor): Promise<ArchiveHeader[]> {
    const owner = partition(binding); const upper = before ? [owner, ...before] : [owner, Number.MAX_SAFE_INTEGER, '\uffff'];
    const tx = (await this.db).transaction('entries'); const entries: ArchiveHeader[] = [];
    let cursor = await tx.store.index('partitionCreatedAt').openCursor(IDBKeyRange.bound([owner, 0, ''], upper, false, !!before), 'prev');
    while (cursor && entries.length < 50) { entries.push(cursor.value); cursor = await cursor.continue(); }
    await tx.done; return entries;
  }
  async put(binding: SiteBinding, entry: ArchiveEntry): Promise<void> {
    if (entry.partition !== partition(binding)) throw new Error('Archive owner mismatch');
    const tx = (await this.db).transaction(['entries', 'payloads'], 'readwrite');
    try {
      const prior = await tx.objectStore('entries').get([partition(binding), entry.id]);
      if (prior?.compactedAt !== undefined) { await tx.done; return; }
      const { header, payload } = splitArchiveEntry({ ...entry, cancelRequested: entry.cancelRequested || prior?.cancelRequested });
      await tx.objectStore('payloads').put(payload); await tx.objectStore('entries').put(header); await tx.done;
    } catch (error) { return abortWrite(tx, error); }
  }

  async requestCancel(binding: SiteBinding, id: string): Promise<void> {
    const tx = (await this.db).transaction('entries', 'readwrite'); const entry = await tx.store.get([partition(binding), id]);
    if (entry && !['completed','cancelled'].includes(entry.state)) await tx.store.put({ ...entry, cancelRequested: true, state: 'pending', nextAttemptAt: 0 });
    await tx.done;
  }
  async compactCompletedEntry(binding: SiteBinding, id: string): Promise<boolean> {
    const tx = (await this.db).transaction(['entries', 'payloads', 'files'], 'readwrite'); const key: [string, string] = [partition(binding), id];
    try {
      const header = await tx.objectStore('entries').get(key);
      const proof = siteBindingSchema.safeParse(header?.completedBinding);
      const receipt = webCaptureResultSchema.safeParse(header?.result);
      const confirmed = header?.state === 'completed' && proof.success && sameBinding(proof.data, binding) &&
        (header.kind === 'link' ? documentLinkResultSchema.safeParse(header.linkResult).success :
          receipt.success && receipt.data.status === 'completed' && receipt.data.captureId === id && receipt.data.id === header.ingestionId);
      if (!confirmed) { await tx.done; return false; }
      await tx.objectStore('entries').put({ ...header, compactedAt: header.compactedAt ?? Date.now() });
      await tx.objectStore('payloads').delete(key);
      let cursor = await tx.objectStore('files').index('capture').openCursor(IDBKeyRange.only(key));
      while (cursor) { await cursor.delete(); cursor = await cursor.continue(); }
      await tx.done; return true;
    } catch (error) { return abortWrite(tx, error); }
  }

  async removeLocalEntry(binding: SiteBinding, id: string): Promise<void> {
    const tx = (await this.db).transaction(['entries', 'payloads', 'files'], 'readwrite'); const key: [string, string] = [partition(binding), id];
    try {
      await tx.objectStore('entries').delete(key); await tx.objectStore('payloads').delete(key);
      let cursor = await tx.objectStore('files').index('capture').openCursor(IDBKeyRange.only(key));
      while (cursor) { await cursor.delete(); cursor = await cursor.continue(); }
      await tx.done;
    } catch (error) { return abortWrite(tx, error); }
  }

  async files(binding: SiteBinding, id: string): Promise<ArchiveFile[]> { return (await this.db).getAllFromIndex('files', 'capture', [partition(binding), id]); }
  async putFile(binding: SiteBinding, id: string, descriptor: CaptureFile, bytes: Uint8Array): Promise<void> {
    const tx = (await this.db).transaction(['entries', 'files'], 'readwrite'); const header = await tx.objectStore('entries').get([partition(binding), id]);
    try {
      if (!header || header.compactedAt !== undefined) { throw new Error('Persist source before bytes'); }
      const key: [string, string, string] = [partition(binding), id, descriptor.id]; const prior = await tx.objectStore('files').get(key);
      if (prior && (prior.descriptor.sha256 !== descriptor.sha256 || prior.descriptor.bytes !== descriptor.bytes)) { throw new Error('Immutable archive file changed'); }
      await tx.objectStore('files').put({ partition: partition(binding), captureId: id, descriptor, bytes }); await tx.done;
    } catch (error) { return abortWrite(tx, error); }
  }
}
