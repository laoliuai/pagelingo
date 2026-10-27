import type { PoolClient } from 'pg';
import type { ObjectStore } from '../storage/object-store.js';

/** Caller holds the shared publication/GC lock. Check one retained source/parse/Reader closure,
 * never document history. Ingress reserves `uploaded:`; only server-preserved raw uploads use
 * that namespace. Every other source-file registration belongs to the immutable manifest.
 */
export async function checkRetainedDependencies(client: PoolClient, store: ObjectStore, ownerId: string, documentId: string, sourceId: string, readerId: string, extending: boolean): Promise<void> {
  const dependencies = (await client.query<{ object_key: string; bytes: string }>(`WITH retained AS (
      SELECT r.* FROM web_reader_versions r WHERE r.owner_id=$1 AND r.document_id=$2 AND r.source_version_id=$3 AND r.id=$4
    ), required AS (
      SELECT s.asset_id FROM source_versions s JOIN retained r ON (s.owner_id,s.document_id,s.id)=(r.owner_id,r.document_id,r.source_version_id)
      UNION SELECT f.asset_id FROM web_source_files f JOIN retained r ON (f.owner_id,f.document_id,f.source_version_id)=(r.owner_id,r.document_id,r.source_version_id) WHERE f.id NOT LIKE 'uploaded:%'
      UNION SELECT p.ir_asset_id FROM web_parse_runs p JOIN retained r ON (p.owner_id,p.document_id,p.source_version_id,p.id)=(r.owner_id,r.document_id,r.source_version_id,r.parse_id)
      UNION SELECT a.asset_id FROM web_reader_assets a JOIN retained r ON (a.owner_id,a.document_id,a.reader_version_id)=(r.owner_id,r.document_id,r.id)
      UNION SELECT r.index_asset_id FROM retained r WHERE NOT $5
      UNION SELECT c.data_asset_id FROM web_reader_chunks c JOIN retained r ON (c.owner_id,c.document_id,c.reader_version_id)=(r.owner_id,r.document_id,r.id) WHERE NOT $5
      UNION SELECT t.translation_asset_id FROM web_translation_runs t JOIN retained r ON (t.owner_id,t.document_id,t.id)=(r.owner_id,r.document_id,r.translation_id) WHERE NOT $5
    ) SELECT a.object_key,a.bytes FROM assets a JOIN required d ON a.id=d.asset_id WHERE a.owner_id=$1 AND a.document_id=$2`, [ownerId, documentId, sourceId, readerId, extending])).rows;
  for (const dependency of dependencies) if ((await store.stat(dependency.object_key)).bytes !== Number(dependency.bytes)) throw new Error('Missing retained Web object');
}
