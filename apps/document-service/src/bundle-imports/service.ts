import { lockDocument } from '../document-lifecycle/guards.js';
import { assertOperationNotRetired } from '../document-lifecycle/retired-identities.js';
import { assertSaveHintsOwned, replaySaveHints } from '../document-management/repository.js';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { createArchiveFileSource, BundleError } from '@pagelingo/document-bundle';
import { createBundleImportRequestSchema, type BundleImport, type CreateBundleImportRequest } from '@pagelingo/document-contracts';
import { z } from 'zod';
import { assertActorCurrent, type Actor } from '../auth/guards.js';
import type { Database } from '../db/database.js';
import type { RuntimeConfig } from '../config.js';
import type { ObjectStore } from '../storage/object-store.js';
import { findDocument, findSamePdf } from '../documents/repository.js';
import { ServiceError } from '../errors.js';
import { conflict, expireImports, importView, lockImport, type ImportRow } from './repository.js';
import { aborted, abortable, receiveArchive } from './staging.js';
import { validateInWorker } from './worker-client.js';
import { publishBundle, type StagedAsset } from './publication.js';
import { maintainLease } from './lease.js';

// One processing slot per API process, shared by all service instances.
let processing = false;
const active = new Map<string, AbortController>();
const idSchema = z.uuid();
const abortedError = () => new ServiceError(409, 'BUNDLE_ABORTED', 'Bundle import was cancelled');
function validId(id: string) { if (!idSchema.safeParse(id).success) throw new ServiceError(404, 'NOT_FOUND', 'Bundle import not found'); }
function safeError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  if (error instanceof BundleError) return new ServiceError(error.code === 'BUNDLE_TOO_LARGE' ? 413 : 400, error.code, 'Bundle validation failed');
  return new ServiceError(500, 'BUNDLE_IMPORT_FAILED', 'Bundle import failed');
}
export function createBundleImportsService({ db, store, config }: { db: Database; store: ObjectStore; config: RuntimeConfig }) {
  async function read(actor: Actor, id: string): Promise<BundleImport> {
    validId(id);
    return db.transaction(async client => { await assertActorCurrent(client, actor); await expireImports(client, actor.userId); return importView(await lockImport(client, actor.userId, id)); });
  }
  return {
    async create(actor: Actor, input: CreateBundleImportRequest, idempotencyKey: string): Promise<BundleImport> {
      const parsed = createBundleImportRequestSchema.safeParse(input);
      if (!parsed.success || typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(idempotencyKey)) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid bundle import request');
      const hash = (value: CreateBundleImportRequest) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
      return db.transaction(async client => {
        await assertActorCurrent(client, actor); await expireImports(client, actor.userId);
        await assertOperationNotRetired(client, actor.userId, 'bundle-import', idempotencyKey);
        const existing = (await client.query<ImportRow>('SELECT * FROM bundle_imports WHERE owner_id=$1 AND idempotency_key=$2 FOR UPDATE', [actor.userId, idempotencyKey])).rows[0];
        if (existing) {
          const replay = existing.admitted_request ? { ...parsed.data, ...replaySaveHints(parsed.data,existing.admitted_request) } : parsed.data;
          if (existing.request_hash !== hash(replay)) throw conflict('IDEMPOTENCY_CONFLICT'); return importView(existing);
        }
        const hints = await assertSaveHintsOwned(client, actor.userId, parsed.data);
        const admitted = { ...parsed.data, ...hints };
        const requestHash = hash(admitted);
        if (parsed.data.targetDocumentId) await findDocument(client, actor.userId, parsed.data.targetDocumentId);
        if ((await client.query("SELECT id FROM bundle_imports WHERE owner_id=$1 AND status IN ('created','receiving','validating')", [actor.userId])).rowCount) throw conflict('BUNDLE_IMPORT_BUSY');
        return importView((await client.query<ImportRow>(`INSERT INTO bundle_imports (owner_id,idempotency_key,request_hash,target_document_id,admitted_request)
          VALUES ($1,$2,$3,$4,$5) RETURNING *`, [actor.userId, idempotencyKey, requestHash, parsed.data.targetDocumentId ?? null, JSON.stringify(admitted)])).rows[0]!);
      });
    },
    get: read,
    async list(actor: Actor): Promise<BundleImport[]> {
      return db.transaction(async client => {
        await assertActorCurrent(client, actor); await expireImports(client, actor.userId);
        return (await client.query<ImportRow>('SELECT * FROM bundle_imports WHERE owner_id=$1 ORDER BY created_at DESC,id DESC', [actor.userId])).rows.map(importView);
      });
    },
    async cancel(actor: Actor, id: string): Promise<BundleImport> {
      validId(id);
      const result = await db.transaction(async client => {
        await assertActorCurrent(client, actor); const row = await lockImport(client, actor.userId, id);
        if (row.status === 'completed') throw conflict('BUNDLE_IMPORT_COMPLETED');
        if (row.status === 'cancelled') return importView(row);
        return importView((await client.query<ImportRow>(`UPDATE bundle_imports SET status='cancelled',epoch=epoch+1,error_code='BUNDLE_ABORTED',updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *`, [actor.userId, id])).rows[0]!);
      });
      active.get(id)?.abort(abortedError()); return result;
    },
    async receive(actor: Actor, id: string, body: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<BundleImport> {
      validId(id);
      // Authenticate before revealing process-wide contention.
      const initial = await read(actor, id);
      if (initial.status === 'completed') return initial;
      if (processing) throw conflict('BUNDLE_IMPORT_BUSY');
      processing = true;
      const controller = new AbortController(); const cancel = () => controller.abort(abortedError());
      signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
      let row: ImportRow | undefined; let archivePath: string | undefined; let stopLease: (() => Promise<void>) | undefined;
      let deadline = setTimeout(() => controller.abort(new ServiceError(408, 'BUNDLE_UPLOAD_TIMEOUT', 'Bundle upload timed out')), 15 * 60_000);
      try {
        aborted(controller.signal);
        row = await db.transaction(async client => {
          await assertActorCurrent(client, actor); await expireImports(client, actor.userId);
          const claim = await lockImport(client, actor.userId, id);
          if (!['created', 'failed'].includes(claim.status)) throw conflict();
          if ((await client.query("SELECT id FROM bundle_imports WHERE owner_id=$1 AND id<>$2 AND status IN ('created','receiving','validating')", [actor.userId, id])).rowCount) throw conflict('BUNDLE_IMPORT_BUSY');
          return (await client.query<ImportRow>(`UPDATE bundle_imports SET status='receiving',epoch=epoch+1,staging_key=$3,error_code=NULL,heartbeat_at=now(),updated_at=now()
            WHERE owner_id=$1 AND id=$2 RETURNING *`, [actor.userId, id, randomUUID()])).rows[0]!;
        });
        active.set(id, controller); stopLease = maintainLease(db, actor, id, row.epoch, controller);
        archivePath = await receiveArchive(config.dataDir, row.staging_key!, body, config.bundleLimits.maxArchiveBytes, controller.signal);
        clearTimeout(deadline);
        deadline = setTimeout(() => controller.abort(new ServiceError(408, 'BUNDLE_VALIDATION_TIMEOUT', 'Bundle validation timed out')), 5 * 60_000);
        await db.transaction(async client => {
          await assertActorCurrent(client, actor); await expireImports(client, actor.userId); await lockImport(client, actor.userId, id, row!.epoch);
          await client.query("UPDATE bundle_imports SET status='validating',updated_at=now(),heartbeat_at=now() WHERE owner_id=$1 AND id=$2", [actor.userId, id]);
        });
        const bundle = await validateInWorker(archivePath, config.bundleLimits, controller.signal);
        const files = createArchiveFileSource(archivePath, config.bundleLimits, controller.signal);
        const assets: StagedAsset[] = [];
        async function stage(kind: StagedAsset['kind'], content: AsyncIterable<Uint8Array>, mediaType: string, details: { path?: string; chunkId?: string } = {}) {
          aborted(controller.signal);
          const key = randomUUID(); const stored = await store.putImmutable(key, abortable(content, controller.signal), kind === 'archive' ? config.bundleLimits.maxArchiveBytes : config.bundleLimits.maxExpandedBytes);
          assets.push({ id: randomUUID(), key, ...stored, kind, mediaType, ...details }); return stored;
        }
        await stage('archive', createReadStream(archivePath), 'application/zip');
        const expectedFiles = new Map(bundle.manifest.files.map(item => [item.path, item]));
        for (const file of await files.list()) {
          const expected = expectedFiles.get(file.path);
          const stored = await stage('file', files.read(file.path), expected?.mediaType ?? 'application/json', { path: file.path });
          if (expected && (stored.sha256 !== expected.sha256 || stored.bytes !== expected.bytes)) throw new ServiceError(400, 'INVALID_BUNDLE', 'Bundle content changed');
        }
        for (const generated of bundle.generated) {
          await stage(generated.kind, (async function* () { yield generated.content; })(), 'application/json', generated.kind === 'chunk' ? { chunkId: generated.id } : {});
        }
        aborted(controller.signal);
        return await db.transaction(async client => {
          await assertActorCurrent(client, actor); await expireImports(client, actor.userId);
          const document = row!.target_document_id ? await findDocument(client, actor.userId, row!.target_document_id) : await findSamePdf(client, actor.userId, bundle.manifest.source.sha256);
          if (document) await lockDocument(client, actor.userId, document.id);
          const current = await lockImport(client, actor.userId, id, row!.epoch); aborted(controller.signal);
          const result = await publishBundle(client, store, current, bundle, assets);
          aborted(controller.signal); return result;
        });
      } catch (error) {
        const safe = safeError(error);
        if (row) await db.pool.query(`UPDATE bundle_imports SET status='failed',error_code=$4,updated_at=now(),staging_key=NULL
          WHERE owner_id=$1 AND id=$2 AND epoch=$3 AND status IN ('receiving','validating')`, [actor.userId, id, row.epoch, safe.code]).catch(() => {});
        throw safe;
      } finally {
        clearTimeout(deadline); signal?.removeEventListener('abort', cancel); await stopLease?.();
        active.delete(id); if (archivePath) await unlink(archivePath).catch(() => {}); processing = false;
      }
    },
  };
}
