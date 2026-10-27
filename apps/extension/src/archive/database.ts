import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { CaptureDraft, CaptureFile, CaptureResource, TranslationIntent, CreateWebCaptureRequest, CreateDocumentLinkRequest, WebCaptureResult, DocumentLinkResult } from '@pagelingo/document-contracts';
import { partition, type SiteBinding } from './binding.js';
import type { CaptureGrant } from './grants.js';

export interface ArchiveEntry {
  id: string; partition: string; kind: 'capture' | 'link'; state: 'permission' | 'pending' | 'retry' | 'manual' | 'completed' | 'cancelled';
  translationIntent?: TranslationIntent; draft?: CaptureDraft; grant?: CaptureGrant; grantGeneration?: string; request?: CreateWebCaptureRequest; linkRequest?: CreateDocumentLinkRequest; linkAttempted?: boolean;
  resources: CaptureResource[]; ingestionId?: string; result?: WebCaptureResult; linkResult?: DocumentLinkResult;
  attempts: number; nextAttemptAt: number; createdAt: number; warnings: string[]; error?: string; cancelRequested?: boolean;
}
export interface ArchiveFile { partition: string; captureId: string; descriptor: CaptureFile; bytes: Uint8Array }
interface ArchiveSchema extends DBSchema {
  entries: { key: [string, string]; value: ArchiveEntry; indexes: { partition: string } };
  files: { key: [string, string, string]; value: ArchiveFile; indexes: { capture: [string, string] } };
}
export class ArchiveDatabase {
  private readonly db: Promise<IDBPDatabase<ArchiveSchema>>;
  constructor(name = 'pagelingo-archives-v1') {
    this.db = openDB<ArchiveSchema>(name, 1, { upgrade(db) {
      db.createObjectStore('entries', { keyPath: ['partition', 'id'] }).createIndex('partition', 'partition');
      db.createObjectStore('files', { keyPath: ['partition', 'captureId', 'descriptor.id'] }).createIndex('capture', ['partition', 'captureId']);
    } });
  }
  async get(binding: SiteBinding, id: string): Promise<ArchiveEntry | undefined> { return (await this.db).get('entries', [partition(binding), id]); }
  async list(binding: SiteBinding): Promise<ArchiveEntry[]> { return (await this.db).getAllFromIndex('entries', 'partition', partition(binding)); }
  async put(binding: SiteBinding, entry: ArchiveEntry): Promise<void> {
    if (entry.partition !== partition(binding)) throw new Error('Archive owner mismatch');
    const tx = (await this.db).transaction('entries', 'readwrite');
    const prior = await tx.store.get([partition(binding), entry.id]);
    await tx.store.put({ ...entry, cancelRequested: entry.cancelRequested || prior?.cancelRequested });
    await tx.done;
  }
  async requestCancel(binding: SiteBinding, id: string): Promise<void> {
    const tx = (await this.db).transaction('entries', 'readwrite');
    const entry = await tx.store.get([partition(binding), id]);
    if (entry && !['completed','cancelled'].includes(entry.state)) {
      await tx.store.put({ ...entry, cancelRequested: true, state: 'pending', nextAttemptAt: 0 });
    }
    await tx.done;
  }
  async files(binding: SiteBinding, id: string): Promise<ArchiveFile[]> { return (await this.db).getAllFromIndex('files', 'capture', [partition(binding), id]); }
  async putFile(binding: SiteBinding, id: string, descriptor: CaptureFile, bytes: Uint8Array): Promise<void> {
    const db = await this.db; const tx = db.transaction(['entries', 'files'], 'readwrite');
    if (!await tx.objectStore('entries').get([partition(binding), id])) { tx.abort(); throw new Error('Persist source before bytes'); }
    const key: [string, string, string] = [partition(binding), id, descriptor.id];
    const prior = await tx.objectStore('files').get(key);
    if (prior && (prior.descriptor.sha256 !== descriptor.sha256 || prior.descriptor.bytes !== descriptor.bytes)) { tx.abort(); throw new Error('Immutable archive file changed'); }
    await tx.objectStore('files').put({ partition: partition(binding), captureId: id, descriptor, bytes }); await tx.done;
  }
}
