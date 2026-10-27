import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ObjectStore, StoredObject } from '../storage/object-store.js';
import { findDocument, findSamePdf, insertDocument, lockObjectPublication } from '../documents/repository.js';
import { conflict, importView, type ImportRow } from './repository.js';
import type { PreparedBundle } from './worker-client.js';
export interface StagedAsset extends StoredObject { id: string; key: string; mediaType: string; path?: string; chunkId?: string; kind: 'file' | 'index' | 'chunk' | 'archive' }
export async function publishBundle(client: PoolClient, store: ObjectStore, row: ImportRow, bundle: PreparedBundle, assets: StagedAsset[]) {
  const owner = row.owner_id; const manifest = bundle.manifest;
  let document = row.target_document_id ? await findDocument(client, owner, row.target_document_id) : await findSamePdf(client, owner, manifest.source.sha256);
  if (document && (document.sha256 !== manifest.source.sha256 || Number(document.bytes) !== manifest.source.bytes)) throw conflict('BUNDLE_SOURCE_CONFLICT');
  if (document) await client.query('SELECT id FROM documents WHERE owner_id=$1 AND id=$2 FOR UPDATE', [owner, document.id]);
  const duplicate = (await client.query<{ id: string; document_id: string; manifest_sha256: string }>('SELECT id,document_id,manifest_sha256 FROM reader_versions WHERE owner_id=$1 AND package_id=$2', [owner, manifest.packageId])).rows[0];
  if (duplicate && (duplicate.manifest_sha256 !== bundle.manifestSha256 || (document && duplicate.document_id !== document.id))) throw conflict('BUNDLE_IDENTITY_CONFLICT');
  await lockObjectPublication(client);
  if (duplicate) {
    // Existing references must still resolve, and duplicate packages never promote current again.
    const existing = await client.query<{ object_key: string; bytes: string }>(`SELECT DISTINCT a.object_key,a.bytes FROM assets a
      WHERE a.owner_id=$1 AND a.document_id=$2 AND a.id IN (
        SELECT asset_id FROM bundle_files WHERE owner_id=$1 AND reader_version_id=$3
        UNION SELECT data_asset_id FROM reader_chunks WHERE owner_id=$1 AND reader_version_id=$3
        UNION SELECT archive_asset_id FROM reader_versions WHERE owner_id=$1 AND id=$3
        UNION SELECT index_asset_id FROM reader_versions WHERE owner_id=$1 AND id=$3
        UNION SELECT p.ir_asset_id FROM reader_versions r JOIN parse_runs p ON (p.owner_id,p.id)=(r.owner_id,r.parse_id) WHERE r.owner_id=$1 AND r.id=$3
        UNION SELECT t.translation_asset_id FROM reader_versions r JOIN translation_runs t ON (t.owner_id,t.id)=(r.owner_id,r.translation_id) WHERE r.owner_id=$1 AND r.id=$3)`, [owner, duplicate.document_id, duplicate.id]);
    for (const asset of existing.rows) if ((await store.stat(asset.object_key)).bytes !== Number(asset.bytes)) throw new Error('Stored object mismatch');
    return complete(duplicate.document_id, duplicate.id);
  }
  for (const asset of assets) if ((await store.stat(asset.key)).bytes !== asset.bytes) throw new Error('Stored object mismatch');
  if (document && (await store.stat(document.object_key)).bytes !== Number(document.bytes)) throw new Error('Stored source mismatch');
  const source = assets.find(asset => asset.path === 'source.pdf')!;
  if (!document) document = await insertDocument(client, owner, { title: manifest.title, originalFilename: manifest.originalFilename, ...source });
  const doc = document.id; const sourceId = document.source_version_id;
  // Reuse the document's original source asset; never make duplicate bytes another source version.
  source.id = document.asset_id;
  const inserted = assets.filter(asset => asset !== source);
  await client.query(`INSERT INTO assets (id,owner_id,document_id,object_key,sha256,bytes,media_type)
    SELECT x.id,$1,$2,x.key,x.sha256,x.bytes,x.media_type FROM jsonb_to_recordset($3::jsonb)
      AS x(id uuid,key text,sha256 text,bytes bigint,media_type text)`, [owner, doc, JSON.stringify(inserted.map(a => ({ id: a.id, key: a.key, sha256: a.sha256, bytes: a.bytes, media_type: a.mediaType })))]);
  const ir = assets.find(asset => asset.path === 'source-ir.json')!;
  const translation = assets.find(asset => asset.path === 'translation.json')!;
  const previousParse = (await client.query('SELECT document_id,source_version_id,ir_sha256,ir_asset_id FROM parse_runs WHERE owner_id=$1 AND id=$2', [owner, manifest.parse.id])).rows[0];
  if (previousParse && (previousParse.ir_sha256 !== ir.sha256 || previousParse.document_id !== doc || previousParse.source_version_id !== sourceId)) throw conflict('BUNDLE_IDENTITY_CONFLICT');
  if (!previousParse) await client.query(`INSERT INTO parse_runs (id,owner_id,document_id,source_version_id,ir_asset_id,ir_sha256,status,coverage,warnings)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [manifest.parse.id, owner, doc, sourceId, ir.id, ir.sha256, bundle.parseStatus, bundle.parseCoverage, JSON.stringify(bundle.warnings)]);
  const previousTranslation = (await client.query('SELECT document_id,source_version_id,parse_id,sha256,translation_asset_id FROM translation_runs WHERE owner_id=$1 AND id=$2', [owner, manifest.translation.id])).rows[0];
  if (previousTranslation && (previousTranslation.sha256 !== translation.sha256 || previousTranslation.document_id !== doc || previousTranslation.source_version_id !== sourceId || previousTranslation.parse_id !== manifest.parse.id)) throw conflict('BUNDLE_IDENTITY_CONFLICT');
  if (!previousTranslation) await client.query(`INSERT INTO translation_runs (id,owner_id,document_id,source_version_id,parse_id,translation_asset_id,sha256,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [manifest.translation.id, owner, doc, sourceId, manifest.parse.id, translation.id, translation.sha256, manifest.translation.status]);
  const retainedIds: string[] = [previousParse?.ir_asset_id, previousTranslation?.translation_asset_id].filter((id): id is string => typeof id === 'string');
  const retained = await client.query<{ object_key: string; bytes: string }>('SELECT object_key,bytes FROM assets WHERE owner_id=$1 AND document_id=$2 AND id=ANY($3::uuid[])', [owner, doc, retainedIds]);
  for (const asset of retained.rows) if ((await store.stat(asset.object_key)).bytes !== Number(asset.bytes)) throw new Error('Stored logical object mismatch');
  const version = randomUUID();
  await client.query(`INSERT INTO reader_versions (id,owner_id,document_id,source_version_id,parse_id,translation_id,package_id,manifest_sha256,archive_asset_id,index_asset_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [version, owner, doc, sourceId, manifest.parse.id, manifest.translation.id, manifest.packageId, bundle.manifestSha256, assets.find(a => a.kind === 'archive')!.id, assets.find(a => a.kind === 'index')!.id]);
  await client.query(`INSERT INTO bundle_files (owner_id,document_id,reader_version_id,path,asset_id)
    SELECT $1,$2,$3,x.path,x.id FROM jsonb_to_recordset($4::jsonb) AS x(path text,id uuid)`, [owner, doc, version, JSON.stringify(assets.filter(a => a.kind === 'file').map(a => ({ path: a.path, id: a.id })))]);
  await client.query(`INSERT INTO reader_chunks (owner_id,document_id,reader_version_id,id,data_asset_id)
    SELECT $1,$2,$3,x.chunk,x.id FROM jsonb_to_recordset($4::jsonb) AS x(chunk text,id uuid)`, [owner, doc, version, JSON.stringify(assets.filter(a => a.kind === 'chunk').map(a => ({ chunk: a.chunkId, id: a.id })))]);
  const current = (await client.query(`SELECT t.status,p.coverage FROM documents d
    JOIN reader_versions r ON (r.owner_id,r.document_id,r.id)=(d.owner_id,d.id,d.current_reader_version_id)
    JOIN translation_runs t ON (t.owner_id,t.id)=(r.owner_id,r.translation_id)
    JOIN parse_runs p ON (p.owner_id,p.id)=(r.owner_id,r.parse_id) WHERE d.owner_id=$1 AND d.id=$2`, [owner, doc])).rows[0];
  const rank = (status: string) => ['completed', 'not-required'].includes(status) ? 2 : status === 'partial' ? 1 : 0;
  const promote = !current || (rank(manifest.translation.status) >= rank(current.status) &&
    !(rank(current.status) === 2 && current.coverage === 'full' && bundle.parseCoverage !== 'full'));
  if (promote) await client.query('UPDATE documents SET current_reader_version_id=$3,updated_at=now() WHERE owner_id=$1 AND id=$2', [owner, doc, version]);
  await client.query('INSERT INTO reading_state (owner_id,document_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [owner, doc]);
  return complete(doc, version);

  async function complete(documentId: string, versionId: string) {
    const result = await client.query<ImportRow>(`UPDATE bundle_imports SET status='completed',document_id=$4,reader_version_id=$5,error_code=NULL,staging_key=NULL,updated_at=now(),heartbeat_at=now()
      WHERE owner_id=$1 AND id=$2 AND epoch=$3 AND status='validating' RETURNING *`, [owner, row.id, row.epoch, documentId, versionId]);
    if (!result.rows[0]) throw conflict('BUNDLE_IMPORT_SUPERSEDED');
    return importView(result.rows[0]);
  }
}
