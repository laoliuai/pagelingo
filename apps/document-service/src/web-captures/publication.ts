import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CaptureFile } from '@pagelingo/document-contracts';
import type { ObjectStore, StoredObject } from '../storage/object-store.js';
import { lockObjectPublication } from '../documents/repository.js';
import * as readers from '../web-readers/repository.js';
import { completeWebCapture, type WebCaptureRow } from './repository.js';
import type { PreparedCapture } from './worker-client.js';
import { ServiceError } from '../errors.js';
export interface CaptureAsset extends StoredObject { id: string; key: string; mediaType: string; kind: 'file' | 'manifest' | 'ir' | 'index' | 'chunk' | 'translation' | 'original'; localId?: string }
const conflict = () => new ServiceError(409, 'CAPTURE_SUPERSEDED', 'Capture is no longer current');
export async function publishCapture(client: PoolClient, store: ObjectStore, row: WebCaptureRow, prepared: PreparedCapture, assets: CaptureAsset[]) {
  const ownerId = row.owner_id; const manifest = prepared.manifest;
  let document = row.target_document_id ? await readers.findWebDocument(client, ownerId, row.target_document_id)
    : (await client.query<readers.WebDocumentRow>(`SELECT * FROM documents WHERE owner_id=$1 AND source_url=$2 AND kind=$3 ORDER BY created_at,id LIMIT 1`, [ownerId, manifest.source.url, manifest.source.kind === 'x-post' ? 'x-post' : 'article'])).rows[0];
  if (row.target_document_id && (!document || !['article', 'x-post'].includes(document.kind) || document.source_url !== manifest.source.url)) throw new ServiceError(409, 'CAPTURE_SOURCE_CONFLICT', 'Capture source does not match target');
  if (document) await client.query('SELECT id FROM documents WHERE owner_id=$1 AND id=$2 FOR UPDATE', [ownerId, document.id]);
  await lockObjectPublication(client);
  // All staged objects are immutable and checked while holding the same lock as orphan collection.
  for (const asset of assets) if ((await store.stat(asset.key)).bytes !== asset.bytes) throw new Error('Missing capture object');
  const documentId = document?.id ?? randomUUID();
  if (!document) {
    await readers.insertWebDocument(client, { id: documentId, ownerId, title: manifest.metadata.title, url: manifest.source.url, kind: manifest.source.kind === 'x-post' ? 'x-post' : 'article' });
    document = (await readers.findWebDocument(client, ownerId, documentId))!;
  }
  const previous = (await client.query<{ source_version_id: string; reader_version_id: string }>(`SELECT s.source_version_id,r.id AS reader_version_id FROM web_sources s
    JOIN web_reader_versions r ON (r.owner_id,r.document_id,r.source_version_id)=(s.owner_id,s.document_id,s.source_version_id)
    WHERE s.owner_id=$1 AND s.document_id=$2 AND s.url=$3 AND s.scope->>'kind'=$4 AND s.content_fingerprint=$5 ORDER BY r.created_at DESC,r.id DESC LIMIT 1`, [ownerId, documentId, manifest.source.url, manifest.scope.kind, prepared.fingerprint])).rows[0];
  if (previous) {
    // A duplicate save is a new capture event, never a rollback of current pointers.
    const dependencies = (await client.query<{ object_key: string; bytes: string }>('SELECT object_key,bytes FROM assets WHERE owner_id=$1 AND document_id=$2', [ownerId, documentId])).rows;
    for (const dependency of dependencies) if ((await store.stat(dependency.object_key)).bytes !== Number(dependency.bytes)) throw new Error('Missing retained Web object');
    if (!prepared.translation) { await finish(previous.source_version_id, previous.reader_version_id); return; }
    const source = await readers.findWebSource(client, ownerId, documentId, previous.source_version_id);
    const parse = await readers.findWebParse(client, ownerId, documentId, previous.source_version_id, prepared.ir.parse.id);
    if (prepared.retainedSourceVersionId !== previous.source_version_id || source?.sha256 !== prepared.ir.source.manifestSha256 || !parse || parse.ir_sha256 !== prepared.translation.readerIrSha256) {
      throw new ServiceError(409, 'CAPTURE_REBASE_REQUIRED', 'Source was published concurrently; retry this capture commit');
    }
    const versionId = randomUUID(), translation = assets.find(a => a.kind === 'translation')!;
    for (const asset of assets.filter(a => ['translation', 'index', 'chunk', 'original'].includes(a.kind))) {
      await readers.insertWebAsset(client, { id: asset.id, ownerId, documentId, objectKey: asset.key, sha256: asset.sha256, bytes: asset.bytes, mediaType: asset.mediaType });
      if (asset.kind === 'original') await readers.registerWebSourceFile(client, { ownerId, documentId, sourceVersionId: previous.source_version_id, id: `uploaded:${asset.id}`, path: `uploaded/${asset.id}`, role: row.manifest.files.find(f => f.id === asset.localId)!.role, assetId: asset.id });
    }
    await readers.insertWebTranslation(client, { id: prepared.translation.id, ownerId, documentId, sourceVersionId: previous.source_version_id, parseId: prepared.ir.parse.id, jobId: null, generationKind: 'import', translationAssetId: translation.id, sha256: translation.sha256 });
    await readers.insertWebReaderVersion(client, { id: versionId, ownerId, documentId, sourceVersionId: previous.source_version_id, parseId: prepared.ir.parse.id, translationId: prepared.translation.id, indexAssetId: assets.find(a => a.kind === 'index')!.id, translationStatus: prepared.build.index.translationStatus, warnings: prepared.warnings });
    for (const asset of assets.filter(a => a.kind === 'chunk')) await readers.insertWebReaderChunk(client, { ownerId, documentId, readerVersionId: versionId, id: asset.localId!, dataAssetId: asset.id });
    await client.query(`INSERT INTO web_reader_assets (owner_id,document_id,reader_version_id,local_id,asset_id)
      SELECT owner_id,document_id,$4,local_id,asset_id FROM web_reader_assets WHERE owner_id=$1 AND document_id=$2 AND reader_version_id=$3`, [ownerId, documentId, previous.reader_version_id, versionId]);
    const current = await readers.findWebReaderVersion(client, ownerId, documentId);
    const rank = (status: string) => ['completed', 'not-required'].includes(status) ? 2 : status === 'partial' ? 1 : 0;
    if (current?.source_version_id === previous.source_version_id && rank(prepared.build.index.translationStatus) >= rank(current.translation_status)) await readers.setCurrentWebReader(client, ownerId, documentId, previous.source_version_id, versionId);
    await finish(previous.source_version_id, versionId); return;
  }
  const sourceVersionId = randomUUID(), readerVersionId = randomUUID();
  for (const asset of assets) await readers.insertWebAsset(client, { id: asset.id, ownerId, documentId, objectKey: asset.key, sha256: asset.sha256, bytes: asset.bytes, mediaType: asset.mediaType });
  const manifestAsset = assets.find(a => a.kind === 'manifest')!;
  await readers.insertWebSource(client, { ownerId, documentId, sourceVersionId, manifestAssetId: manifestAsset.id, sha256: manifestAsset.sha256, bytes: manifestAsset.bytes, snapshotSha256: prepared.ir.source.snapshotSha256, url: manifest.source.url, scope: manifest.scope, contentFingerprint: prepared.fingerprint, metadata: { ...manifest.metadata, blockCount: prepared.ir.blocks.length, coverage: prepared.ir.parse.coverage, saveStatus: manifest.resources.some(r => r.status === 'missing') ? 'partial-resources' : 'original-saved', capturedAt: manifest.metadata.capturedAt } });
  for (const file of manifest.files) await readers.registerWebSourceFile(client, { ownerId, documentId, sourceVersionId, id: file.id, path: file.path, role: file.role, assetId: assets.find(a => a.kind === 'file' && a.localId === file.id)!.id });
  // Preserve exact uploaded bytes under an internal, registered namespace. Client paths never become filesystem paths.
  for (const asset of assets.filter(a => a.kind === 'original')) await readers.registerWebSourceFile(client, { ownerId, documentId, sourceVersionId, id: `uploaded:${asset.id}`, path: `uploaded/${asset.id}`, role: row.manifest.files.find(f => f.id === asset.localId)!.role as CaptureFile['role'], assetId: asset.id });
  const ir = assets.find(a => a.kind === 'ir')!;
  if (prepared.translation && prepared.translation.readerIrSha256 !== ir.sha256) throw new Error('Translation IR byte identity mismatch');
  await readers.insertWebParse(client, { ownerId, documentId, sourceVersionId, parseId: prepared.ir.parse.id, irAssetId: ir.id, irSha256: ir.sha256 });
  let translationId: string | null = null;
  if (prepared.translation) {
    translationId = prepared.translation.id; const artifact = assets.find(a => a.kind === 'translation')!;
    await readers.insertWebTranslation(client, { id: translationId, ownerId, documentId, sourceVersionId, parseId: prepared.ir.parse.id, jobId: null, generationKind: 'import', translationAssetId: artifact.id, sha256: artifact.sha256 });
  }
  await readers.insertWebReaderVersion(client, { id: readerVersionId, ownerId, documentId, sourceVersionId, parseId: prepared.ir.parse.id, translationId, indexAssetId: assets.find(a => a.kind === 'index')!.id, translationStatus: prepared.build.index.translationStatus, warnings: prepared.warnings });
  for (const asset of assets.filter(a => a.kind === 'chunk')) await readers.insertWebReaderChunk(client, { ownerId, documentId, readerVersionId, id: asset.localId!, dataAssetId: asset.id });
  for (const asset of prepared.ir.assets) await readers.registerWebReaderAsset(client, { ownerId, documentId, readerVersionId, localId: asset.id, assetId: assets.find(a => a.kind === 'file' && a.localId === asset.id)!.id });
  const current = await readers.findWebReaderVersion(client, ownerId, documentId);
  const rank = (status: string) => ['completed', 'not-required'].includes(status) ? 2 : status === 'partial' ? 1 : 0;
  // Do not let a late capture replace a newer source, or degrade useful translation/coverage.
  const currentSource = current ? await readers.findWebSource(client, ownerId, documentId, current.source_version_id) : undefined;
  const fresh = !currentSource || String(currentSource.metadata.capturedAt ?? '') <= manifest.metadata.capturedAt;
  const promote = !current || currentSource?.metadata.blockCount === 0 || (prepared.ir.blocks.length > 0 && fresh && rank(prepared.build.index.translationStatus) >= rank(current.translation_status)
    && !(currentSource?.scope.completeWithinScope && !manifest.scope.completeWithinScope)
    && !(currentSource?.metadata.coverage === 'full' && prepared.ir.parse.coverage !== 'full'));
  const latest = document.latest_web_source_version_id ? await readers.findWebSource(client, ownerId, documentId, document.latest_web_source_version_id) : undefined;
  if (!latest || String(latest.metadata.capturedAt ?? '') <= manifest.metadata.capturedAt) await readers.setLatestWebSource(client, ownerId, documentId, sourceVersionId);
  if (promote) await readers.setCurrentWebReader(client, ownerId, documentId, sourceVersionId, readerVersionId);
  await finish(sourceVersionId, readerVersionId);
  async function finish(sourceVersionId: string, readerVersionId: string) {
    if (!await completeWebCapture(client, ownerId, row.id, Number(row.epoch), { documentId, sourceVersionId, readerVersionId, jobId: null, saveStatus: manifest.resources.some(r => r.status === 'missing') ? 'partial-resources' : 'original-saved', warnings: prepared.warnings })) throw conflict();
  }
}
