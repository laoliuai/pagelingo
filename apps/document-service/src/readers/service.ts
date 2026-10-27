import type { PoolClient } from 'pg';
import { readerChunkSchema, readerDescriptorSchema, readerIrSchema, readerVersionListSchema, readingProgressUpdateSchema, type ReadingProgressUpdate } from '@pagelingo/document-contracts';
import { assertActorCurrent, type Actor } from '../auth/guards.js';
import type { Database } from '../db/database.js';
import { findDocument } from '../documents/repository.js';
import { ServiceError } from '../errors.js';
import type { ObjectStore } from '../storage/object-store.js';
import { findAsset, findImageAsset, findVersion, listVersions, notFound, type VersionRow } from './repository.js';
import { imageAssets, readJson, versionData } from './data.js';
import { progressView, readState, restoreProgress, saveProgress, validatePosition } from './progress.js';
import { createImageMetadataCache } from './image-metadata-cache.js';

export function createReadersService({ db, store }: { db: Database; store: ObjectStore }) {
  const images = createImageMetadataCache();
  function owned<T>(actor: Actor, documentId: string, fn: (client: PoolClient) => Promise<T>) {
    return db.transaction(async client => { await assertActorCurrent(client, actor); await findDocument(client, actor.userId, documentId); return fn(client); });
  }
  function withVersion<T>(actor: Actor, documentId: string, versionId: string | undefined, fn: (client: PoolClient, version: VersionRow) => Promise<T>) {
    return owned(actor, documentId, async client => fn(client, await findVersion(client, actor.userId, documentId, versionId)));
  }
  return {
    descriptor(actor: Actor, documentId: string, versionId?: string) {
      return withVersion(actor, documentId, versionId, async (client, version) => {
        const { ir, index } = await versionData(client, actor.userId, version, store);
        const assets = await imageAssets(client, actor.userId, version, ir);
        return readerDescriptorSchema.parse({ documentId, versionId: version.id,
          source: { documentId, sourceVersionId: version.source_version_id, assetId: version.source_asset_id, sha256: version.source_sha256, bytes: Number(version.source_bytes) },
          parseId: version.parse_id, index, pages: ir.pages, assetMap: Object.fromEntries([...assets].map(([logicalId, asset]) => [logicalId, asset.id])),
          translationStatus: version.translation_status, parseCoverage: version.parse_coverage, warnings: [...new Set([...version.warnings, ...index.warnings])],
          ...await restoreProgress(client, actor.userId, version, index, ir.source.pageCount) });
      });
    },
    versions(actor: Actor, documentId: string, query: { page: number; pageSize: number }) {
      return owned(actor, documentId, async client => readerVersionListSchema.parse(await listVersions(client, actor.userId, documentId, query.page, query.pageSize)));
    },
    chunk(actor: Actor, documentId: string, versionId: string, chunkId: string) {
      return withVersion(actor, documentId, versionId, async (client, version) => {
        const row = (await client.query<{ data_asset_id: string }>('SELECT data_asset_id FROM reader_chunks WHERE owner_id=$1 AND document_id=$2 AND reader_version_id=$3 AND id=$4', [actor.userId, documentId, versionId, chunkId])).rows[0];
        if (!row) throw notFound();
        const chunk = await readJson(store, await findAsset(client, actor.userId, documentId, row.data_asset_id), readerChunkSchema);
        if (chunk.id !== chunkId || chunk.parseId !== version.parse_id || chunk.sourceSha256 !== version.source_sha256) throw notFound();
        return chunk;
      });
    },
    async image(actor: Actor, documentId: string, versionId: string, assetId: string) {
      const version = await withVersion(actor, documentId, versionId, async (_client, row) => row);
      const allowed = await images.get(`${actor.userId}/${documentId}/${versionId}/${version.ir_asset_id}`, async () => {
        const asset = await db.transaction(client => findAsset(client, actor.userId, documentId, version.ir_asset_id));
        // The admitted IR is immutable. Hash/schema work is outside the user's FOR UPDATE lock,
        // and image delivery never needs the whole ReaderIndex.
        const ir = await readJson(store, asset, readerIrSchema);
        if (ir.parse.id !== version.parse_id || ir.source.sha256 !== version.source_sha256) throw notFound();
        const logical = await db.transaction(client => imageAssets(client, actor.userId, version, ir));
        return new Map([...logical.values()].map(image => [image.id, image]));
      });
      // Revocation or version deletion during cold validation must still deny delivery.
      return withVersion(actor, documentId, versionId, async (client, current) => {
        const expected = allowed.get(assetId);
        if (!expected || current.ir_asset_id !== version.ir_asset_id) throw notFound();
        const actual = await findImageAsset(client, actor.userId, documentId, versionId, assetId);
        if (actual.object_key !== expected.object_key || actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes || actual.media_type !== expected.media_type) throw notFound();
        return actual;
      });
    },
    archive(actor: Actor, documentId: string, versionId: string) {
      return withVersion(actor, documentId, versionId, async (client, version) => findAsset(client, actor.userId, documentId, version.archive_asset_id));
    },
    progress(actor: Actor, documentId: string) {
      return owned(actor, documentId, async client => progressView(await readState(client, actor.userId, documentId)));
    },
    updateProgress(actor: Actor, documentId: string, input: ReadingProgressUpdate) {
      const parsed = readingProgressUpdateSchema.safeParse(input);
      if (!parsed.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid reading progress');
      return owned(actor, documentId, async client => {
        const state = await readState(client, actor.userId, documentId, true);
        let version: VersionRow;
        try { version = await findVersion(client, actor.userId, documentId, parsed.data.position.readerVersionId); }
        catch (error) { if (error instanceof ServiceError && error.statusCode === 404) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid reading position'); throw error; }
        const { ir, index } = await versionData(client, actor.userId, version, store);
        validatePosition(parsed.data.position, version, index, ir.source.pageCount);
        return saveProgress(client, actor.userId, documentId, parsed.data.expectedRevision, parsed.data.position, state);
      });
    },
  };
}
