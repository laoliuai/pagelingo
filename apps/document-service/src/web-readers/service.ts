import { assertDocumentActive } from '../document-lifecycle/guards.js';
import type { PoolClient } from 'pg';
import { webReaderIndexSchema, webReaderChunkSchema, webReaderIrSchema, webCaptureManifestSchema, webReaderDescriptorSchema, webReaderVersionListSchema, webReadingProgressUpdateSchema, type WebReadingProgressUpdate, type WebReadingProgress } from '@pagelingo/document-contracts';
import { assertActorCurrent, type Actor } from '../auth/guards.js';
import type { Database } from '../db/database.js';
import type { ObjectStore } from '../storage/object-store.js';
import { ServiceError } from '../errors.js';
import * as repo from './repository.js';
import { readWebAsset, webNotFound } from './assets.js';
export function createWebReadersService({ db, store }: { db: Database; store: ObjectStore }) {
  async function owned<T>(actor: Actor, documentId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return db.transaction(async client => { await assertActorCurrent(client, actor); await assertDocumentActive(client, actor.userId, documentId); if (!await repo.findWebDocument(client, actor.userId, documentId)) throw webNotFound(); return fn(client); });
  }
  async function asset(client: PoolClient, ownerId: string, documentId: string, id: string): Promise<repo.WebAssetRow> {
    const row = (await client.query<repo.WebAssetRow>('SELECT id,object_key,sha256,bytes,media_type FROM assets WHERE owner_id=$1 AND document_id=$2 AND id=$3', [ownerId, documentId, id])).rows[0]; if (!row) throw webNotFound(); return row;
  }
  async function data(actor: Actor, documentId: string, versionId?: string) {
    const metadata = await owned(actor, documentId, async client => {
      const version = await repo.findWebReaderVersion(client, actor.userId, documentId, versionId); if (!version) throw webNotFound();
      const source = await repo.findWebSource(client, actor.userId, documentId, version.source_version_id); if (!source) throw webNotFound();
      const indexAsset = await asset(client, actor.userId, documentId, version.index_asset_id);
      const progress = await repo.readWebProgress(client, actor.userId, documentId, version.id);
      const state = (await client.query<{ revision: number; position: WebReadingProgress['position'] }>(`SELECT s.revision,p.position FROM web_reading_state s LEFT JOIN web_reading_positions p ON (p.owner_id,p.document_id,p.reader_version_id)=(s.owner_id,s.document_id,s.reader_version_id) WHERE s.owner_id=$1 AND s.document_id=$2`, [actor.userId, documentId])).rows[0];
      const assets = (await client.query<{ local_id: string; asset_id: string }>('SELECT local_id,asset_id FROM web_reader_assets WHERE owner_id=$1 AND document_id=$2 AND reader_version_id=$3', [actor.userId, documentId, version.id])).rows;
      return { version, source, indexAsset, progress, state, assets, epoch: (await assertDocumentActive(client, actor.userId, documentId)).epoch };
    });
    const index = webReaderIndexSchema.parse(JSON.parse((await readWebAsset(store, metadata.indexAsset)).toString('utf8')));
    const manifest = webCaptureManifestSchema.parse(JSON.parse((await readWebAsset(store, { id: metadata.source.asset_id, object_key: metadata.source.object_key, sha256: metadata.source.sha256, bytes: metadata.source.bytes, media_type: 'application/json' })).toString('utf8')));
    if (index.parseId !== metadata.version.parse_id || index.sourceSha256 !== metadata.source.sha256) throw webNotFound();
    await owned(actor, documentId, async () => {});
    return { ...metadata, index, manifest };
  }
  async function restore(actor: Actor, documentId: string, current: Awaited<ReturnType<typeof data>>) {
    if (current.progress) return { progress: current.progress, restoreHint: null };
    const previous = current.state?.position;
    if (!previous) return { progress: null, restoreHint: null };
    let blockId: string | null = null; let mapped = false;
    if (previous.sourceVersionId === current.version.source_version_id && previous.parseId === current.version.parse_id) {
      blockId = previous.blockId && Object.hasOwn(current.index.blockLocations, previous.blockId) ? previous.blockId : null; mapped = previous.blockId === null || blockId !== null;
    } else if (previous.blockId) {
      const readIr = async (sourceId: string, parseId: string) => {
        const row = await owned(actor, documentId, async client => { const parse = await repo.findWebParse(client, actor.userId, documentId, sourceId, parseId); if (!parse) throw webNotFound(); return asset(client, actor.userId, documentId, parse.ir_asset_id); });
        return webReaderIrSchema.parse(JSON.parse((await readWebAsset(store, row)).toString('utf8')));
      };
      const oldIr = await readIr(previous.sourceVersionId, previous.parseId);
      const newIr = await readIr(current.version.source_version_id, current.version.parse_id);
      const ref = oldIr.blocks.find(b => b.id === previous.blockId)?.sourceRefs[0];
      const matches = ref ? newIr.blocks.filter(b => b.sourceRefs.some(r => r.quote === ref.quote && r.prefix === ref.prefix && r.suffix === ref.suffix)) : [];
      if (matches.length === 1) { blockId = matches[0].id; mapped = true; }
    }
    await owned(actor, documentId, async () => {});
    return { progress: { revision: current.state!.revision, updatedAt: current.version.created_at.toISOString(), position: { ...previous, readerVersionId: current.version.id, sourceVersionId: current.version.source_version_id, parseId: current.version.parse_id, blockId, blockOffset: mapped ? previous.blockOffset : 0 } }, restoreHint: mapped ? null : 'version-updated-source-start' as const };
  }
  return {
    async descriptor(actor: Actor, documentId: string, versionId?: string) {
      const current = await data(actor, documentId, versionId); const { version, source, index, manifest, assets } = current;
      // Public URLs use registered asset UUIDs; local IDs remain source/renderer identifiers.
      const assetMap = Object.fromEntries(assets.map(a => [a.local_id, a.asset_id]));
      if (index.assetIds.some(id => !Object.hasOwn(assetMap, id))) throw webNotFound();
      return webReaderDescriptorSchema.parse({ documentId, versionId: version.id, source: { documentId, sourceVersionId: source.source_version_id, manifestAssetId: source.asset_id, sha256: source.sha256, bytes: Number(source.bytes), snapshotSha256: source.snapshot_sha256 }, parseId: version.parse_id, index, assetMap, snapshots: manifest.snapshots, translationStatus: version.translation_status, warnings: [...new Set([...version.warnings, ...index.warnings])], ...await restore(actor, documentId, current) });
    },
    async versions(actor: Actor, documentId: string, query: { page: number; pageSize: number }) {
      return owned(actor, documentId, async client => {
        const versions = await repo.listWebReaderVersions(client, actor.userId, documentId);
        return webReaderVersionListSchema.parse({ items: versions.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map(v => ({ id: v.id, sourceVersionId: v.source_version_id, parseId: v.parse_id, translationStatus: v.translation_status, warnings: v.warnings, createdAt: v.created_at.toISOString() })), total: versions.length, ...query });
      });
    },
    async chunk(actor: Actor, documentId: string, versionId: string, chunkId: string) {
      const metadata = await owned(actor, documentId, async client => {
        const version = await repo.findWebReaderVersion(client, actor.userId, documentId, versionId);
        const row = await repo.findWebReaderChunk(client, actor.userId, documentId, versionId, chunkId);
        const source = version ? await repo.findWebSource(client, actor.userId, documentId, version.source_version_id) : undefined;
        if (!row || !version || !source) throw webNotFound(); return { row, version, source };
      });
      const chunk = webReaderChunkSchema.parse(JSON.parse((await readWebAsset(store, metadata.row)).toString('utf8')));
      if (chunk.id !== chunkId || chunk.parseId !== metadata.version.parse_id || chunk.sourceSha256 !== metadata.source.sha256) throw webNotFound();
      await owned(actor, documentId, async () => {}); return chunk;
    },
    async image(actor: Actor, documentId: string, versionId: string, assetId: string) {
      const row = await owned(actor, documentId, async client => repo.findWebReaderAsset(client, actor.userId, documentId, versionId, assetId, true));
      if (!row || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(row.media_type)) throw webNotFound();
      const bytes = await readWebAsset(store, row); await owned(actor, documentId, async () => {});
      return { id: row.id, bytes, mediaType: row.media_type };
    },
    async manifest(actor: Actor, documentId: string, sourceId: string) {
      const row = await owned(actor, documentId, client => repo.findWebSource(client, actor.userId, documentId, sourceId)); if (!row) throw webNotFound();
      const manifest = webCaptureManifestSchema.parse(JSON.parse((await readWebAsset(store, { id: row.asset_id, bytes: row.bytes, object_key: row.object_key, sha256: row.sha256, media_type: 'application/json' })).toString('utf8')));
      await owned(actor, documentId, async () => {}); return manifest;
    },
    async file(actor: Actor, documentId: string, sourceId: string, fileId: string) {
      const row = await owned(actor, documentId, client => repo.findWebSourceFile(client, actor.userId, documentId, sourceId, fileId)); if (!row) throw webNotFound();
      const bytes = await readWebAsset(store, row); await owned(actor, documentId, async () => {}); return { id: row.id, bytes, mediaType: row.media_type };
    },
    async progress(actor: Actor, documentId: string, versionId?: string) { const current = await data(actor, documentId, versionId); return (await restore(actor, documentId, current)).progress; },
    async updateProgress(actor: Actor, documentId: string, input: WebReadingProgressUpdate) {
      const result = webReadingProgressUpdateSchema.safeParse(input); if (!result.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid Web progress');
      const { position, expectedRevision } = result.data;
      const current = await data(actor, documentId, position.readerVersionId);
      if (position.sourceVersionId !== current.version.source_version_id || position.parseId !== current.version.parse_id || (position.blockId !== null && !Object.hasOwn(current.index.blockLocations, position.blockId))) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid Web reading position');
      return owned(actor, documentId, async client => {
        await assertDocumentActive(client, actor.userId, documentId, current.epoch);
        const saved = await repo.saveWebProgress(client, actor.userId, documentId, expectedRevision, position);
        if (!saved) throw new ServiceError(409, 'PROGRESS_CONFLICT', 'Reading progress changed'); return saved;
      });
    },
  };
}
