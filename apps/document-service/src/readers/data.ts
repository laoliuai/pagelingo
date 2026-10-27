import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { readerIndexSchema, readerIrSchema } from '@pagelingo/document-contracts';
import type { ObjectStore } from '../storage/object-store.js';
import { findAsset, notFound, type AssetRow, type VersionRow } from './repository.js';

/** Publication already enforced upload budgets. Bound reads to the immutable registered size,
 * so tightening future upload limits cannot hide an existing validated version. */
export async function readJson<T>(store: ObjectStore, asset: AssetRow, schema: z.ZodType<T>): Promise<T> {
  const size = Number(asset.bytes);
  if (!Number.isSafeInteger(size) || size <= 0) throw notFound();
  try {
    if ((await store.stat(asset.object_key)).bytes !== size) throw notFound();
    const parts: Buffer[] = []; const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of store.read(asset.object_key)) {
      bytes += chunk.byteLength; if (bytes > size) throw notFound();
      parts.push(Buffer.from(chunk)); hash.update(chunk);
    }
    if (bytes !== size || hash.digest('hex') !== asset.sha256) throw notFound();
    return schema.parse(JSON.parse(Buffer.concat(parts).toString('utf8')));
  } catch { throw notFound(); }
}
export async function versionData(client: PoolClient, owner: string, version: VersionRow, store: ObjectStore) {
  const index = await readJson(store, await findAsset(client, owner, version.document_id, version.index_asset_id), readerIndexSchema);
  const ir = await readJson(store, await findAsset(client, owner, version.document_id, version.ir_asset_id), readerIrSchema);
  if (index.parseId !== version.parse_id || index.sourceSha256 !== version.source_sha256 || ir.parse.id !== version.parse_id || ir.source.sha256 !== version.source_sha256) throw notFound();
  return { index, ir };
}
export async function imageAssets(client: PoolClient, owner: string, version: VersionRow, ir: Awaited<ReturnType<typeof versionData>>['ir']) {
  const rows = (await client.query<AssetRow & { path: string }>(`SELECT a.id,a.object_key,a.bytes,a.sha256,a.media_type,f.path FROM bundle_files f
    JOIN assets a ON (a.owner_id,a.document_id,a.id)=(f.owner_id,f.document_id,f.asset_id)
    WHERE f.owner_id=$1 AND f.document_id=$2 AND f.reader_version_id=$3 AND a.media_type IN ('image/png','image/jpeg','image/webp')`, [owner, version.document_id, version.id])).rows;
  const byPath = new Map(rows.map(row => [row.path, row]));
  const result = new Map<string, AssetRow>();
  for (const image of ir.assets) {
    const row = byPath.get(image.path);
    if (!row || row.sha256 !== image.sha256 || Number(row.bytes) !== image.bytes || row.media_type !== image.mediaType) throw notFound();
    result.set(image.id, { id: row.id, object_key: row.object_key, bytes: row.bytes, sha256: row.sha256, media_type: row.media_type });
  }
  return result;
}
