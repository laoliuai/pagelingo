import { assertDocumentActive, lockDocument } from '../document-lifecycle/guards.js';
import { assertIdentityNotRetired, assertOperationNotRetired } from '../document-lifecycle/retired-identities.js';
import { libraryDocument, libraryList } from './library.js';
import { createHash, randomUUID } from 'node:crypto';
import { documentListQuerySchema } from '@pagelingo/document-contracts';
import { z } from 'zod';
import { assertActorCurrent } from '../auth/guards.js';
import type { Actor } from '../auth/guards.js';
import type { Database } from '../db/database.js';
import { ServiceError } from '../errors.js';
import type { ObjectStore } from '../storage/object-store.js';
import { claimIngestion, findDocument, findSamePdf, insertDocument, lockIngestion, lockObjectPublication, summary } from './repository.js';

export interface SavePdfInput {
  idempotencyKey: string; title?: string; originalFilename: string; body: AsyncIterable<Uint8Array>;
  /** HTTP adapter finishes multipart validation before reference publication. Called exactly once. */
  finalize?: () => Promise<{ title?: string }>;
}
export function cleanFilename(value: string): string {
  return value.replace(/\\/g, '/').split('/').at(-1)!.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 255) || 'document.pdf';
}
const metadataSchema = z.strictObject({ title: z.string().trim().min(1).max(500).optional() });
const idSchema = z.uuid();
function invalid(): ServiceError { return new ServiceError(400, 'INVALID_REQUEST', 'Invalid PDF upload'); }

export function createDocumentsService({ db, store, maxPdfBytes = 256 * 1024 * 1024 }: { db: Database; store: ObjectStore; maxPdfBytes?: number }) {
  async function owned(actor: Actor, id: string, byAsset = false) {
    if (!idSchema.safeParse(id).success) throw new ServiceError(404, 'NOT_FOUND', 'Document not found');
    return db.transaction(async client => { await assertActorCurrent(client, actor); return findDocument(client, actor.userId, id, byAsset); });
  }
  return {
    async savePdf(actor: Actor, input: SavePdfInput) {
      if (!/^[\x21-\x7e]{1,200}$/.test(input.idempotencyKey) || typeof input.originalFilename !== 'string') throw invalid();
      const initial = metadataSchema.safeParse({ ...(input.title !== undefined ? { title: input.title } : {}) });
      if (!initial.success) throw invalid();
      const claim = await db.transaction(async client => { await assertActorCurrent(client, actor); await assertOperationNotRetired(client, actor.userId, 'pdf-upload', input.idempotencyKey); return claimIngestion(client, actor.userId, input.idempotencyKey); });
      const key = randomUUID(); const hash = createHash('sha256'); let bytes = 0;
      async function* pdfBody() {
        let prefix = Buffer.alloc(0); let recognized = false;
        for await (const chunk of input.body) {
          bytes += chunk.byteLength;
          if (bytes > maxPdfBytes) throw new ServiceError(413, 'PDF_TOO_LARGE', 'PDF exceeds the upload limit');
          hash.update(chunk);
          if (recognized) { yield chunk; continue; }
          const needed = Math.min(1024 - prefix.length, chunk.byteLength);
          prefix = Buffer.concat([prefix, chunk.subarray(0, needed)]);
          if (prefix.includes(Buffer.from('%PDF-'))) {
            recognized = true; yield prefix; if (needed < chunk.byteLength) yield chunk.subarray(needed);
          } else if (prefix.length === 1024) throw new ServiceError(400, 'INVALID_PDF', 'PDF header was not found');
        }
        if (!recognized) throw new ServiceError(400, 'INVALID_PDF', 'PDF header was not found');
      }
      try {
        const stored = await store.putImmutable(key, pdfBody(), maxPdfBytes);
        const final = input.finalize ? await input.finalize() : initial.data;
        const metadata = metadataSchema.safeParse(final);
        if (!metadata.success) throw invalid();
        const sha256 = hash.digest('hex');
        if (stored.sha256 !== sha256 || stored.bytes !== bytes) throw new Error('Stored PDF identity mismatch');
        return await db.transaction(async client => {
          await assertActorCurrent(client, actor);
          await assertOperationNotRetired(client, actor.userId, 'pdf-upload', input.idempotencyKey);
          const same = await findSamePdf(client, actor.userId, sha256);
          if (same) await lockDocument(client, actor.userId, same.id);
          const current = await lockIngestion(client, actor.userId, input.idempotencyKey, claim.epoch);
          if (current.status === 'completed') {
            if (current.request_hash !== sha256) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key belongs to different content');
            return summary(await findDocument(client, actor.userId, current.document_id!));
          }
          if (current.status !== 'receiving') throw new ServiceError(409, 'UPLOAD_SUPERSEDED', 'Upload has been superseded');
          await assertIdentityNotRetired(client, actor.userId, 'source-sha256', sha256, { table: 'ingestions', key: input.idempotencyKey });
          if (same) await assertDocumentActive(client, actor.userId, same.id);
          await lockObjectPublication(client);
          if ((await store.stat(key)).bytes !== bytes) throw new Error('Stored PDF size mismatch');
          const originalFilename = cleanFilename(input.originalFilename);
          const document = same ?? await insertDocument(client, actor.userId, {
            title: metadata.data.title ?? originalFilename, originalFilename, key, bytes, sha256,
            titleOrigin: metadata.data.title === undefined ? 'filename' : 'user',
          });
          await client.query(`UPDATE ingestions SET status = 'completed', document_id = $3, request_hash = $4,
            updated_at = now() WHERE owner_id = $1 AND idempotency_key = $2 AND epoch = $5 AND status = 'receiving'`, [actor.userId, input.idempotencyKey, document.id, sha256, claim.epoch]);
          return summary(document);
        });
      } catch (error) {
        // Do not alter completed retries or a newer claimant after a lost epoch.
        await db.pool.query(`UPDATE ingestions SET status = 'failed', updated_at = now()
          WHERE owner_id = $1 AND idempotency_key = $2 AND epoch = $3 AND status = 'receiving'`, [actor.userId, input.idempotencyKey, claim.epoch]).catch(() => {});
        throw error;
      }
    },
    async list(actor: Actor, query: { q?: string; page: number; pageSize: number }) {
      const parsed = documentListQuerySchema.safeParse(query); if (!parsed.success) throw invalid();
      return db.transaction(async client => { await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); await assertActorCurrent(client, actor); return libraryList(client, actor.userId, parsed.data); });
    },
    async get(actor: Actor, id: string) {
      if (!idSchema.safeParse(id).success) throw new ServiceError(404, 'NOT_FOUND', 'Document not found');
      return db.transaction(async client => { await assertActorCurrent(client, actor); return libraryDocument(client, actor.userId, id); });
    },
    async getPdf(actor: Actor, id: string) { return summary(await owned(actor, id)); },
    async getAsset(actor: Actor, id: string) { return owned(actor, id, true); },
  };
}
