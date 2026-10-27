import type { PoolClient } from 'pg';
import { readerChunkSchema, readerDescriptorSchema, readerVersionListSchema, readingProgressUpdateSchema, type ReadingProgressUpdate } from '@pagelingo/document-contracts';
import { assertActorCurrent, type Actor } from '../auth/guards.js';
import type { Database } from '../db/database.js';
import { findDocument } from '../documents/repository.js';
import { ServiceError } from '../errors.js';
import type { ObjectStore } from '../storage/object-store.js';
import { findAsset, findVersion, listVersions, notFound, type VersionRow } from './repository.js';
import { imageAssets, readJson, versionData } from './data.js';
import { progressView, readState, restoreProgress, saveProgress, validatePosition } from './progress.js';

export function createReadersService({ db, store }: { db: Database; store: ObjectStore }) {
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
          parseId: version.parse_id, index, assetMap: Object.fromEntries([...assets].map(([logicalId, asset]) => [logicalId, asset.id])),
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
    image(actor: Actor, documentId: string, versionId: string, assetId: string) {
      return withVersion(actor, documentId, versionId, async (client, version) => {
        const { ir } = await versionData(client, actor.userId, version, store);
        const image = [...(await imageAssets(client, actor.userId, version, ir)).values()].find(asset => asset.id === assetId);
        if (!image) throw notFound(); return image;
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
