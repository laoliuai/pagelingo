import type { SourceTransport } from '../source-adapters/types.js';
import { runSourceFetchJob } from '../source-adapters/service.js';
import { createHash, randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import type { WebCaptureManifest, CreateDocumentLinkRequest } from '@pagelingo/document-contracts';
import { canonicalManifestBytes } from '@pagelingo/web-capture';
import { ServiceError } from '../errors.js';
import type { Database } from '../db/database.js';
import type { RuntimeConfig } from '../config.js';
import type { ObjectStore } from '../storage/object-store.js';
import { lockObjectPublication } from '../documents/repository.js';
import { assertJobLeaseCurrent, releaseWebJobSlot, type JobLease } from '../web-jobs/repository.js';
import { insertWebAsset, registerWebSourceFile } from '../web-readers/repository.js';
import { isFakeIpRejection } from '../network/address-policy.js';
import { createCaptureFetch } from '../network/capture-fetch.js';
import { classifyDocumentLink } from './links.js';
import { findWebCapture, insertWebCapture, type WebCaptureRow } from './repository.js';
import { receiveCaptureFile, stagingPath } from './staging.js';
import { validateCaptureInWorker } from './worker-client.js';
import { publishCapture, type CaptureAsset } from './publication.js';
import { CAPTURE_USER_AGENT, capturePublicImages } from './public-resources.js';
import type { CapturePublicationHook } from './service.js';
interface Acquisition { ingestion_id: string; raw_asset_id: string; raw_sha256: string; raw_bytes: string; final_url: string; object_key: string }
export interface FetchRunnerDependencies {
  db: Database; store: ObjectStore; config: RuntimeConfig; signal: AbortSignal;
  /** Test-only replacement; production uses the pinned public transport. */
  captureFetch?: typeof fetch;
  sourceTransport?: SourceTransport;
  /** Task 9/11 may wire durable scheduling; called once under publication locks. */
  onPublication?: CapturePublicationHook;
}
/** Task 11 owns claim, heartbeat and cancellation monitoring. No session/device identity enters this runner. */
export async function runFetchJob(lease: JobLease, dependencies: FetchRunnerDependencies): Promise<void> {
  if (lease.kind !== 'fetch-link') throw new Error('Fetch runner requires a fetch-link lease');
  const { db, store, config, signal, onPublication } = dependencies;
  const sourceJob = await db.pool.query('SELECT 1 FROM source_requests WHERE owner_id=$1 AND job_id=$2', [lease.ownerId, lease.jobId]);
  if (sourceJob.rowCount) return runSourceFetchJob(lease, dependencies);
  if (dependencies.captureFetch && config.mode !== 'test') throw new Error('Capture fetch injection requires test mode');
  const captureFetch = dependencies.captureFetch ?? createCaptureFetch({ timeoutMs: config.captureLimits.requestTimeoutMs, maxResponseBytes: config.captureLimits.maxHtmlBytes });
  const check = async () => { signal.throwIfAborted(); await db.transaction(c => assertJobLeaseCurrent(c, lease)); signal.throwIfAborted(); };
  const load = () => db.transaction(async client => {
    await assertJobLeaseCurrent(client, lease); signal.throwIfAborted();
    return (await client.query<Acquisition>(`SELECT f.*,a.object_key FROM web_fetch_acquisitions f JOIN assets a ON a.id=f.raw_asset_id
      WHERE f.owner_id=$1 AND f.job_id=$2`, [lease.ownerId, lease.jobId])).rows[0];
  });
  const temporary = randomUUID();
  try {
    let acquisition = await load();
    if (!acquisition) {
      if (classifyDocumentLink(lease.url).reason) throw new ServiceError(400, 'FETCH_BROWSER_REQUIRED', 'Public page requires browser capture');
      await check();
      const response = await captureFetch(lease.url, { method: 'GET', signal, headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': CAPTURE_USER_AGENT } });
      const finalUrl = response.url || lease.url;
      if (classifyDocumentLink(finalUrl).reason) { await response.body?.cancel(); throw new ServiceError(400, 'FETCH_BROWSER_REQUIRED', 'Public page requires browser capture'); }
      if (!response.ok || !/^text\/html(?:;|$)|^application\/xhtml\+xml(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel(); throw new Error('Public article unavailable');
      }
      // The pinned transport enforces this too; retain an independent limit before persistent IO.
      const chunks: Uint8Array[] = []; let bytes = 0; const reader = response.body?.getReader();
      try { if (reader) while (true) { signal.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > config.captureLimits.maxHtmlBytes) throw new Error('Article too large'); chunks.push(chunk.value); } }
      finally { await reader?.cancel().catch(() => {}); }
      const raw = Buffer.concat(chunks); if (!raw.length) throw new Error('Empty article');
      const key = randomUUID(), rawAssetId = randomUUID(), ingestionId = randomUUID();
      const stored = await store.putImmutable(key, (async function* () { yield raw; })(), config.captureLimits.maxHtmlBytes);
      const manifest: WebCaptureManifest = {
        schemaVersion: 'web-capture/1', captureId: randomUUID(),
        source: { url: lease.url, canonicalUrl: null, kind: 'article', method: 'public-fetch' },
        metadata: { title: lease.url.slice(0, 2000), author: null, publishedAt: null, capturedAt: new Date().toISOString() },
        scope: { kind: 'article', rootNodeId: 'root', completeWithinScope: true, warnings: [] },
        htmlFileId: 'html', files: [{ id: 'html', path: 'source.html', role: 'html', mediaType: 'text/html', ...stored }],
        resources: [], stylesheetFileIds: [], snapshots: { previews: [], nodeLocations: {} }, existingTranslation: null,
      };
      // Bytes/metadata become immutable at this first successful acquisition, before extraction.
      await db.transaction(async client => {
        await assertJobLeaseCurrent(client, lease); signal.throwIfAborted();
        const request = (await client.query<{ request: CreateDocumentLinkRequest }>('SELECT request FROM web_link_requests WHERE owner_id=$1 AND job_id=$2 ORDER BY created_at,idempotency_key LIMIT 1', [lease.ownerId, lease.jobId])).rows[0]?.request;
        if (!request) throw new Error('Missing immutable link input');
        manifest.metadata.title = request.title ?? manifest.metadata.title;
        await lockObjectPublication(client);
        if ((await store.stat(key)).bytes !== stored.bytes) throw new Error('Missing raw acquisition');
        await insertWebAsset(client, { id: rawAssetId, ownerId: lease.ownerId, documentId: lease.documentId, objectKey: key, ...stored, mediaType: 'text/html' });
        await insertWebCapture(client, { id: ingestionId, ownerId: lease.ownerId, authVersion: lease.authVersion, deviceId: null, sessionId: null, fetchJobId: lease.jobId,
          manifest, requestHash: createHash('sha256').update(canonicalManifestBytes(manifest)).digest('hex'), targetDocumentId: lease.documentId, translationIntent: request.translationIntent, stagingKey: randomUUID() });
        await client.query(`UPDATE web_capture_files SET received_sha256=descriptor->>'sha256',received_bytes=(descriptor->>'bytes')::bigint,received_at=clock_timestamp() WHERE owner_id=$1 AND capture_id=$2`, [lease.ownerId, ingestionId]);
        await client.query("UPDATE web_captures SET status='validating' WHERE owner_id=$1 AND id=$2", [lease.ownerId, ingestionId]);
        await client.query(`INSERT INTO web_fetch_acquisitions (owner_id,document_id,auth_version,job_id,ingestion_id,raw_asset_id,raw_sha256,raw_bytes,final_url)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [lease.ownerId, lease.documentId, lease.authVersion, lease.jobId, ingestionId, rawAssetId, stored.sha256, stored.bytes, finalUrl]);
      });
      acquisition = (await load())!;
    }
    const row = await db.transaction(async client => {
      await assertJobLeaseCurrent(client, lease); signal.throwIfAborted();
      const current = (await findWebCapture(client, lease.ownerId, acquisition!.ingestion_id))!;
      if (current.fetch_job_id !== lease.jobId || current.status === 'completed') throw new Error('Invalid fetch acquisition state');
      return (await client.query<WebCaptureRow>("UPDATE web_captures SET status='validating',epoch=epoch+1,error_code=NULL,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2 RETURNING *", [lease.ownerId, current.id])).rows[0]!;
    });
    const rawFile = row.manifest.files.find(file => file.id === row.manifest.htmlFileId)!;
    await receiveCaptureFile(config.dataDir, temporary, store.read(acquisition.object_key), rawFile, signal);
    await check();
    let prepared = await validateCaptureInWorker({ manifest: row.manifest, files: [{ id: rawFile.id, path: stagingPath(config.dataDir, temporary) }], limits: config.captureLimits, publicArticle: { finalUrl: acquisition.final_url } }, signal);
    const fetchImage = dependencies.captureFetch ?? createCaptureFetch({ timeoutMs: config.captureLimits.requestTimeoutMs, maxResponseBytes: config.captureLimits.maxResourceBytes });
    if (await capturePublicImages(prepared, { fetchImage, limits: config.captureLimits, signal })) {
      await check();
      // Previews and the IR depend on which images are now available, so the capture is validated again from its cleaned bytes.
      prepared.manifest.files = prepared.manifest.files.filter(file => file.role !== 'preview');
      prepared.manifest.snapshots = { previews: [], nodeLocations: {} };
      const staged: string[] = [];
      try {
        const files = [];
        for (const descriptor of prepared.manifest.files) {
          const key = randomUUID(); staged.push(key);
          const bytes = prepared.files.find(file => file.id === descriptor.id)!.bytes;
          await receiveCaptureFile(config.dataDir, key, (async function* () { yield bytes; })(), descriptor, signal);
          files.push({ id: descriptor.id, path: stagingPath(config.dataDir, key) });
        }
        prepared = await validateCaptureInWorker({ manifest: prepared.manifest, files, limits: config.captureLimits }, signal);
      } finally { for (const key of staged) await unlink(stagingPath(config.dataDir, key)).catch(() => {}); }
    }
    const assets: CaptureAsset[] = [];
    async function stage(kind: CaptureAsset['kind'], mediaType: string, bytes: Uint8Array, localId?: string) {
      signal.throwIfAborted(); const key = randomUUID(); const value = await store.putImmutable(key, (async function* () { yield bytes; })(), Math.max(config.captureLimits.maxTotalBytes, config.captureLimits.maxIrBytes));
      assets.push({ id: randomUUID(), key, ...value, kind, mediaType, localId });
    }
    for (const file of prepared.files) await stage('file', prepared.manifest.files.find(f => f.id === file.id)!.mediaType, file.bytes, file.id);
    await stage('manifest', 'application/json', prepared.manifestBytes);
    await stage('ir', 'application/json', Buffer.from(JSON.stringify(prepared.ir)));
    await stage('index', 'application/json', Buffer.from(JSON.stringify(prepared.build.index)));
    for (const chunk of prepared.build.chunks) await stage('chunk', 'application/json', Buffer.from(JSON.stringify(chunk)), chunk.id);
    await db.transaction(async client => {
      await assertJobLeaseCurrent(client, lease); signal.throwIfAborted();
      const current = (await client.query<WebCaptureRow>('SELECT * FROM web_captures WHERE owner_id=$1 AND id=$2 FOR UPDATE', [lease.ownerId, row.id])).rows[0]!;
      if (current.epoch !== row.epoch || current.status !== 'validating' || current.fetch_job_id !== lease.jobId) throw new Error('Fetch capture superseded');
      await publishCapture(client, store, current, prepared, assets);
      if ((await store.stat(acquisition!.object_key)).bytes !== Number(acquisition!.raw_bytes)) throw new Error('Missing retained raw acquisition');
      const completed = (await findWebCapture(client, lease.ownerId, row.id))!;
      await registerWebSourceFile(client, { ownerId: lease.ownerId, documentId: lease.documentId, sourceVersionId: completed.source_version_id!, id: `uploaded:${acquisition!.raw_asset_id}`, path: `uploaded/${acquisition!.raw_asset_id}`, role: 'html', assetId: acquisition!.raw_asset_id });
      if (onPublication) {
        const jobId = await onPublication(client, { ownerId: lease.ownerId, authVersion: lease.authVersion, ingestionId: row.id, captureId: row.capture_id, documentId: lease.documentId, sourceVersionId: completed.source_version_id!, readerVersionId: completed.reader_version_id!, translationIntent: row.translation_intent });
        if (jobId) await client.query('UPDATE web_captures SET job_id=$3 WHERE owner_id=$1 AND id=$2', [lease.ownerId, row.id, jobId]);
      }
      await assertJobLeaseCurrent(client, lease); signal.throwIfAborted();
      await client.query("UPDATE web_jobs SET status='completed',reader_version_id=$3,error_code=NULL,warnings=$4,lease_owner=NULL,lease_until=NULL,slot_id=NULL,slot_epoch=NULL,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2", [lease.ownerId, lease.jobId, completed.reader_version_id, JSON.stringify(prepared.warnings)]);
      await releaseWebJobSlot(client, lease);
    });
  } catch (error) {
    // Stale/revoked workers cannot finalize even a failure. Task 11 reconciles those leases.
    signal.throwIfAborted();
    const errorCode = error instanceof ServiceError && error.code === 'FETCH_BROWSER_REQUIRED' ? error.code : isFakeIpRejection(error) ? 'OUTBOUND_FAKE_IP' : 'FETCH_CAPTURE_UNAVAILABLE';
    await db.transaction(async client => {
      await assertJobLeaseCurrent(client, lease); signal.throwIfAborted();
      await client.query("UPDATE web_captures SET status='failed',error_code=$3,updated_at=clock_timestamp() WHERE owner_id=$1 AND fetch_job_id=$2 AND status<>'completed'", [lease.ownerId, lease.jobId, errorCode]);
      await client.query("UPDATE web_jobs SET status='failed',error_code=$4,warnings=$3,lease_owner=NULL,lease_until=NULL,slot_id=NULL,slot_epoch=NULL,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2", [lease.ownerId, lease.jobId, JSON.stringify(['Public article unavailable; saved link retained. Capture the readable page in the browser.']), errorCode]);
      await releaseWebJobSlot(client, lease);
    });
  } finally { await unlink(stagingPath(config.dataDir, temporary)).catch(() => {}); }
}
