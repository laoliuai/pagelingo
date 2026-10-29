import { assertDuplicateSaveActive, assertDocumentActive, lockDocument } from '../document-lifecycle/guards.js';
import { assertIdentityNotRetired, assertOperationNotRetired } from '../document-lifecycle/retired-identities.js';
import { randomUUID, createHash } from 'node:crypto';
import { assertSaveHintsOwned, replaySaveHints } from '../document-management/repository.js';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { createWebCaptureRequestSchema, webCaptureResultSchema, type CreateWebCaptureRequest, type WebCaptureResult, type TranslationIntent } from '@pagelingo/document-contracts';
import { canonicalManifestBytes, normalizeCaptureUrl } from '@pagelingo/web-capture';
import { assertCapturePrincipalCurrent, type CapturePrincipal } from '../devices/guards.js';
import type { Database } from '../db/database.js';
import type { RuntimeConfig } from '../config.js';
import type { ObjectStore } from '../storage/object-store.js';
import { ServiceError } from '../errors.js';
import { readWebAsset } from '../web-readers/assets.js';
import { findWebDocument } from '../web-readers/repository.js';
import { findWebCapture, findWebCaptureByKey, insertWebCapture, listCaptureFiles, type WebCaptureRow } from './repository.js';
import { receiveCaptureFile, stagingPath } from './staging.js';
import { validateCaptureInWorker } from './worker-client.js';
import { publishCapture, type CaptureAsset } from './publication.js';
const active = new Map<string, AbortController>();
const missing = () => new ServiceError(404, 'NOT_FOUND', 'Capture not found');
const conflict = (code = 'CAPTURE_BUSY') => new ServiceError(409, code, 'Capture state conflicts with request');
const owner = (p: CapturePrincipal) => p.kind === 'session' ? p.actor.userId : p.userId;
const authVersion = (p: CapturePrincipal) => p.kind === 'session' ? p.actor.authVersion : p.authVersion;
export interface CapturePublicationEvent { ownerId: string; authVersion: number; ingestionId: string; captureId: string; documentId: string; sourceVersionId: string; readerVersionId: string; translationIntent: TranslationIntent }
/** Optional durable scheduling adapter. Called inside the final short transaction; no network/CPU work.
 * Future wiring must itself enforce preferences, provider revisions, language and unique job identity.
 * It must return a real matching job ID or null. Existing captures never replay this hook. */
export type CapturePublicationHook = (client: PoolClient, event: CapturePublicationEvent) => Promise<string | null>;
export function createWebCapturesService({ db, store, config, onPublication }: { db: Database; store: ObjectStore; config: RuntimeConfig; onPublication?: CapturePublicationHook }) {
  async function locked(client: PoolClient, p: CapturePrincipal, id: string): Promise<WebCaptureRow> {
    if (!z.uuid().safeParse(id).success) throw missing();
    await assertCapturePrincipalCurrent(client, p);
    await assertOperationNotRetired(client, owner(p), 'web-capture-id', id);
    const target = await findWebCapture(client, owner(p), id);
    if (target?.target_document_id) await lockDocument(client, owner(p), target.target_document_id);
    const row = (await client.query<WebCaptureRow>('SELECT * FROM web_captures WHERE owner_id=$1 AND id=$2 FOR UPDATE', [owner(p), id])).rows[0];
    if (!row || row.fetch_job_id) throw missing();
    if (row.auth_version !== authVersion(p)) throw conflict('CAPTURE_AUTH_CHANGED');
    return row;
  }
  async function view(client: PoolClient, row: WebCaptureRow): Promise<WebCaptureResult> {
    const files = await listCaptureFiles(client, row.owner_id, row.id);
    return webCaptureResultSchema.parse({ id: row.id, captureId: row.capture_id, status: row.status,
      receivedFileIds: files.filter(f => f.received_at).map(f => f.id), missingFileIds: files.filter(f => !f.received_at).map(f => f.id),
      documentId: row.document_id, sourceVersionId: row.source_version_id, readerVersionId: row.reader_version_id, jobId: row.job_id,
      saveStatus: row.save_status, errorCode: row.error_code, warnings: row.warnings, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
  }
  const status = (p: CapturePrincipal, id: string) => db.transaction(async c => view(c, await locked(c, p, id)));
  return {
    async create(p: CapturePrincipal, input: CreateWebCaptureRequest, key: string) {
      const parsed = createWebCaptureRequestSchema.safeParse(input);
      if (!parsed.success || typeof key !== 'string' || key.toLowerCase() !== parsed.data.manifest.captureId.toLowerCase() || parsed.data.manifest.files.some(f => f.id.startsWith('uploaded:'))) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid capture request');
      const value = parsed.data; const limits = config.captureLimits;
      if (value.manifest.files.length > limits.maxFiles || value.manifest.files.reduce((n, f) => n + f.bytes, 0) > limits.maxTotalBytes || value.manifest.files.some(f => f.bytes > (f.role === 'html' ? limits.maxHtmlBytes : limits.maxResourceBytes))) throw new ServiceError(413, 'CAPTURE_TOO_LARGE', 'Capture exceeds configured limits');
      return db.transaction(async client => {
        await assertCapturePrincipalCurrent(client, p);
        await assertOperationNotRetired(client, owner(p), 'web-capture', key);
        const existing = await findWebCaptureByKey(client, owner(p), key.toLowerCase());
        if (existing) {
          const replayHash = createHash('sha256').update(canonicalManifestBytes({ ...value,...replaySaveHints(value,existing.save_hints) })).digest('hex');
          if (existing.request_hash !== replayHash) throw conflict('IDEMPOTENCY_CONFLICT');
          return view(client, await locked(client, p, existing.id));
        }
        const hints = await assertSaveHintsOwned(client,owner(p),value);
        const requestHash = createHash('sha256').update(canonicalManifestBytes({ ...value,...hints })).digest('hex');
        const duplicateId = value.targetDocumentId ?? (await client.query<{ id: string }>(
          'SELECT id FROM documents WHERE owner_id=$1 AND source_url=$2 AND kind=$3 ORDER BY created_at,id LIMIT 1',
          [owner(p), normalizeCaptureUrl(value.manifest.source.url), value.manifest.source.kind === 'x-post' ? 'x-post' : 'article'],
        )).rows[0]?.id;
        if (duplicateId) { await lockDocument(client, owner(p), duplicateId); await assertDuplicateSaveActive(client, owner(p), duplicateId); }
        if (value.targetDocumentId) {
          const target = await findWebDocument(client, owner(p), value.targetDocumentId);
          if (!target || !['article', 'x-post'].includes(target.kind)) throw missing();
          if (target.source_url !== normalizeCaptureUrl(value.manifest.source.url)) throw conflict('CAPTURE_SOURCE_CONFLICT');
        }
        const sessionId = p.kind === 'session' ? (await client.query<{ id: string }>('SELECT id FROM sessions WHERE token_hash=$1', [p.actor.sessionHash])).rows[0]!.id : null;
        const id = randomUUID();
        await insertWebCapture(client, { id, ownerId: owner(p), authVersion: authVersion(p), deviceId: p.kind === 'device' ? p.deviceId : null, sessionId,
          manifest: value.manifest, admittedRequest: { ...value, ...hints }, requestHash, targetDocumentId: value.targetDocumentId ?? null, translationIntent: value.translationIntent, stagingKey: randomUUID(), saveHints: hints });
        return view(client, (await findWebCapture(client, owner(p), id))!);
      });
    },
    status,
    async receiveFile(p: CapturePrincipal, id: string, fileId: string, body: AsyncIterable<Uint8Array>, mediaType: string, signal?: AbortSignal) {
      const token = randomUUID();
      const claim = await db.transaction(async client => {
        const row = await locked(client, p, id);
        const file = (await listCaptureFiles(client, owner(p), id)).find(f => f.id === fileId); if (!file) throw missing();
        if (file.descriptor.mediaType !== mediaType.split(';')[0].trim().toLowerCase()) throw new ServiceError(415, 'UNSUPPORTED_MEDIA_TYPE', 'File media type differs from manifest');
        if (row.status === 'completed') return { row, file, done: true };
        if (row.target_document_id) await assertDocumentActive(client, owner(p), row.target_document_id, Number(row.document_epoch));
        else await assertIdentityNotRetired(client, owner(p), 'url', normalizeCaptureUrl(row.manifest.source.url), { table: 'web_captures', key: row.id });
        if (!['created', 'receiving', 'failed'].includes(row.status)) throw conflict();
        if (file.received_at) return { row, file, done: true };
        if (file.upload_until && file.upload_until.getTime() > Date.now()) throw conflict('CAPTURE_FILE_BUSY');
        await client.query('UPDATE web_capture_files SET upload_token=$4,upload_until=clock_timestamp()+interval \'25 seconds\' WHERE owner_id=$1 AND capture_id=$2 AND id=$3', [owner(p), id, fileId, token]);
        await client.query("UPDATE web_captures SET status='receiving',error_code=NULL,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2", [owner(p), id]);
        return { row, file, done: false };
      });
      const controller = new AbortController(); const abort = () => controller.abort(signal?.reason); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      const timer = setTimeout(() => controller.abort(new ServiceError(408, 'CAPTURE_UPLOAD_TIMEOUT', 'Capture upload timed out')), config.captureLimits.requestTimeoutMs);
      let monitoring: Promise<void> | undefined;
      const monitor = setInterval(() => {
        if (monitoring || claim.done || controller.signal.aborted) return;
        monitoring = db.transaction(async client => {
          const current = await locked(client, p, id);
          if (current.epoch !== claim.row.epoch || !['created','receiving'].includes(current.status)) throw conflict('CAPTURE_SUPERSEDED');
          if (current.target_document_id) await assertDocumentActive(client, owner(p), current.target_document_id, Number(current.document_epoch));
          else await assertIdentityNotRetired(client, owner(p), 'url', normalizeCaptureUrl(current.manifest.source.url), { table: 'web_captures', key: current.id });
        }).catch(error => controller.abort(error)).finally(() => { monitoring = undefined; });
      }, 500);
      let retained = false;
      try {
        await receiveCaptureFile(config.dataDir, token, body, claim.file.descriptor, controller.signal);
        if (claim.done) return await status(p, id);
        await db.transaction(async client => {
          const row = await locked(client, p, id); controller.signal.throwIfAborted();
          if (row.epoch !== claim.row.epoch || !['created', 'receiving'].includes(row.status)) throw conflict('CAPTURE_SUPERSEDED');
          if (row.target_document_id) await assertDocumentActive(client, owner(p), row.target_document_id, Number(row.document_epoch));
          else await assertIdentityNotRetired(client, owner(p), 'url', normalizeCaptureUrl(row.manifest.source.url), { table: 'web_captures', key: row.id });
          const result = await client.query(`UPDATE web_capture_files SET staging_key=$4,received_sha256=$5,received_bytes=$6,received_at=clock_timestamp(),upload_token=NULL,upload_until=NULL
            WHERE owner_id=$1 AND capture_id=$2 AND id=$3 AND upload_token=$4 AND upload_until>clock_timestamp()`, [owner(p), id, fileId, token, claim.file.descriptor.sha256, claim.file.descriptor.bytes]);
          if (result.rowCount !== 1) throw conflict('CAPTURE_SUPERSEDED');
          await client.query('UPDATE web_captures SET updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2', [owner(p), id]);
        }); retained = true; return await status(p, id);
      } finally {
        clearTimeout(timer); clearInterval(monitor); await monitoring; signal?.removeEventListener('abort', abort);
        if (!retained) { await unlink(stagingPath(config.dataDir, token)).catch(() => {}); await db.pool.query('UPDATE web_capture_files SET upload_token=NULL,upload_until=NULL WHERE owner_id=$1 AND capture_id=$2 AND id=$3 AND upload_token=$4', [owner(p), id, fileId, token]); }
      }
    },
    async cancel(p: CapturePrincipal, id: string) {
      const result = await db.transaction(async client => {
        const row = await locked(client, p, id);
        if (row.status === 'completed') throw conflict('CAPTURE_COMPLETED');
        if (row.status !== 'cancelled') await client.query("UPDATE web_captures SET status='cancelled',epoch=epoch+1,error_code='CAPTURE_CANCELLED',updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2", [owner(p), id]);
        return view(client, (await findWebCapture(client, owner(p), id))!);
      }); active.get(id)?.abort(conflict('CAPTURE_CANCELLED')); return result;
    },
    async commit(p: CapturePrincipal, id: string) {
      const claim = await db.transaction(async client => {
        const row = await locked(client, p, id);
        if (row.status === 'completed') return { row, done: true, files: [] };
        if (row.status === 'cancelled') throw conflict('CAPTURE_CANCELLED');
        if (row.target_document_id) await assertDocumentActive(client, owner(p), row.target_document_id, Number(row.document_epoch));
        else await assertIdentityNotRetired(client, owner(p), 'url', normalizeCaptureUrl(row.manifest.source.url), { table: 'web_captures', key: row.id });
        if (row.status === 'validating' && row.updated_at.getTime() > Date.now() - 120_000) throw conflict();
        const files = await listCaptureFiles(client, owner(p), id); if (files.some(f => !f.received_at || !f.staging_key)) throw conflict('CAPTURE_FILES_MISSING');
        const updated = (await client.query<WebCaptureRow>("UPDATE web_captures SET status='validating',epoch=epoch+1,error_code=NULL,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2 RETURNING *", [owner(p), id])).rows[0]!;
        return { row: updated, done: false, files };
      });
      if (claim.done) return status(p, id);
      const controller = new AbortController(); active.set(id, controller);
      const assets: CaptureAsset[] = [];
      const monitor = setInterval(() => { void db.transaction(async client => {
        const current = await locked(client, p, id);
        if (current.epoch !== claim.row.epoch || current.status !== 'validating') throw conflict('CAPTURE_SUPERSEDED');
        if (current.target_document_id) await assertDocumentActive(client, owner(p), current.target_document_id, Number(current.document_epoch));
        else await assertIdentityNotRetired(client, owner(p), 'url', normalizeCaptureUrl(current.manifest.source.url), { table: 'web_captures', key: current.id });
      }).catch(error => controller.abort(error)); }, 500);
      try {
        let prepared = await validateCaptureInWorker({ manifest: claim.row.manifest, files: claim.files.map(f => ({ id: f.id, path: stagingPath(config.dataDir, f.staging_key!) })), limits: config.captureLimits }, controller.signal);
        if (prepared.translation) {
          const retained = await db.transaction(async client => {
            await locked(client, p, id);
            return (await client.query<{ source_version_id: string; manifest_key: string; manifest_sha: string; manifest_bytes: string; ir_key: string; ir_sha: string; ir_bytes: string }>(`SELECT s.source_version_id,a.object_key AS manifest_key,a.sha256 AS manifest_sha,a.bytes AS manifest_bytes,ia.object_key AS ir_key,ia.sha256 AS ir_sha,ia.bytes AS ir_bytes
              FROM web_sources s JOIN source_versions v ON (v.owner_id,v.document_id,v.id)=(s.owner_id,s.document_id,s.source_version_id)
              JOIN assets a ON (a.owner_id,a.document_id,a.id)=(v.owner_id,v.document_id,v.asset_id)
              JOIN web_parse_runs p ON (p.owner_id,p.document_id,p.source_version_id)=(s.owner_id,s.document_id,s.source_version_id)
              JOIN assets ia ON (ia.owner_id,ia.document_id,ia.id)=(p.owner_id,p.document_id,p.ir_asset_id)
              WHERE s.owner_id=$1 AND s.url=$2 AND s.scope->>'kind'=$3 AND s.content_fingerprint=$4 AND ($5::uuid IS NULL OR s.document_id=$5)
              ORDER BY s.created_at,s.source_version_id LIMIT 1`, [owner(p), prepared.manifest.source.url, prepared.manifest.scope.kind, prepared.fingerprint, claim.row.target_document_id])).rows[0];
          });
          if (retained) {
            const manifestBytes = await readWebAsset(store, { id: '', object_key: retained.manifest_key, sha256: retained.manifest_sha, bytes: retained.manifest_bytes, media_type: 'application/json' });
            const irBytes = await readWebAsset(store, { id: '', object_key: retained.ir_key, sha256: retained.ir_sha, bytes: retained.ir_bytes, media_type: 'application/json' });
            prepared = await validateCaptureInWorker({ manifest: claim.row.manifest, files: claim.files.map(f => ({ id: f.id, path: stagingPath(config.dataDir, f.staging_key!) })), limits: config.captureLimits,
              retained: { sourceVersionId: retained.source_version_id, manifestBytes, irBytes } }, controller.signal);
          }
        }
        async function stage(kind: CaptureAsset['kind'], mediaType: string, bytes: Uint8Array | AsyncIterable<Uint8Array>, localId?: string) {
          controller.signal.throwIfAborted(); const key = randomUUID();
          const body = bytes instanceof Uint8Array ? (async function* () { yield bytes; })() : bytes;
          const stored = await store.putImmutable(key, body, Math.max(config.captureLimits.maxTotalBytes, config.captureLimits.maxIrBytes));
          assets.push({ id: randomUUID(), key, ...stored, kind, mediaType, localId });
        }
        for (const file of claim.files) {
          await stage('original', file.descriptor.mediaType, createReadStream(stagingPath(config.dataDir, file.staging_key!)), file.id);
          const stored = assets.at(-1)!; if (stored.sha256 !== file.descriptor.sha256 || stored.bytes !== file.descriptor.bytes) throw new ServiceError(400, 'CAPTURE_FILE_MISMATCH', 'Staged original changed');
        }
        for (const file of prepared.files) await stage('file', prepared.manifest.files.find(f => f.id === file.id)!.mediaType, file.bytes, file.id);
        await stage('manifest', 'application/json', prepared.manifestBytes);
        await stage('ir', 'application/json', Buffer.from(JSON.stringify(prepared.ir)));
        if (prepared.translation) await stage('translation', 'application/json', Buffer.from(JSON.stringify(prepared.translation)));
        await stage('index', 'application/json', Buffer.from(JSON.stringify(prepared.build.index)));
        for (const chunk of prepared.build.chunks) await stage('chunk', 'application/json', Buffer.from(JSON.stringify(chunk)), chunk.id);
        return await db.transaction(async client => {
          await assertCapturePrincipalCurrent(client, p);
          const target = claim.row.target_document_id ?? (await client.query<{ id: string }>('SELECT id FROM documents WHERE owner_id=$1 AND source_url=$2 ORDER BY created_at,id LIMIT 1', [owner(p),prepared.manifest.source.url])).rows[0]?.id;
          if (target) await lockDocument(client, owner(p), target);
          const current = await locked(client, p, id); controller.signal.throwIfAborted();
          if (current.epoch !== claim.row.epoch || current.status !== 'validating') throw conflict('CAPTURE_SUPERSEDED');
          await publishCapture(client, store, current, prepared, assets);
          const completed = (await findWebCapture(client, owner(p), id))!;
          if (onPublication) {
            const jobId = await onPublication(client, { ownerId: owner(p), authVersion: authVersion(p), ingestionId: id, captureId: current.capture_id, documentId: completed.document_id!, sourceVersionId: completed.source_version_id!, readerVersionId: completed.reader_version_id!, translationIntent: current.translation_intent });
            if (jobId) await client.query('UPDATE web_captures SET job_id=$3 WHERE owner_id=$1 AND id=$2', [owner(p), id, jobId]);
          }
          await assertCapturePrincipalCurrent(client, p); controller.signal.throwIfAborted();
          return view(client, (await findWebCapture(client, owner(p), id))!);
        });
      } catch (error) {
        await db.pool.query("UPDATE web_captures SET status='failed',error_code=$4,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2 AND epoch=$3 AND status='validating'", [owner(p), id, claim.row.epoch, error instanceof ServiceError ? error.code : 'CAPTURE_FAILED']);
        throw error;
      } finally { clearInterval(monitor); if (active.get(id) === controller) active.delete(id); }
    },
  };
}
