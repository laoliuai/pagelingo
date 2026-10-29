import type { PoolClient } from 'pg';
import { defaultCaptureLimits, type CaptureFile, type CreateWebCaptureRequest, type WebCaptureManifest, type WebDocumentBundleManifest } from '@pagelingo/document-contracts';
import { ServiceError } from '../errors.js';
import type { WebAssetRow } from '../web-readers/repository.js';
import type { WebCaptureRow } from '../web-captures/repository.js';
import { readerSourceRevision } from '../source-adapters/reader-revision.js';
import { sourceRevision } from '../source-adapters/repository.js';
type GithubOriginals = Extract<NonNullable<WebDocumentBundleManifest['originals']>, { github: unknown }>;
export interface CaptureOriginals {
  prefix: 'capture' | 'reader-capture'; manifest: WebCaptureManifest; request: CreateWebCaptureRequest | null;
  requestHash: string; translationSha256?: string;
  files: Array<{ descriptor: CaptureFile; asset: WebAssetRow }>;
}
export type ExportOriginals = { captures: CaptureOriginals[] } | {
  declaration: GithubOriginals; files: Array<{ path: string; asset: WebAssetRow; ceiling: number }>;
};
const unavailable = () => new ServiceError(409, 'EXPORT_ORIGINALS_UNAVAILABLE', 'Original material identity is unavailable');
/** Only bounded immutable SQL selection under the lease lock. Hashing/JSON validation belongs to the isolated assembler. */
export async function loadExportOriginals(client: PoolClient, ownerId: string, documentId: string, sourceId: string, readerId: string, capture: WebCaptureManifest, manifestSha256: string): Promise<ExportOriginals> {
  const kind = (await client.query('SELECT kind FROM documents WHERE owner_id=$1 AND id=$2', [ownerId, documentId])).rows[0]?.kind;
  if (kind === 'repository') {
    const selected = await readerSourceRevision(client, ownerId, documentId, 'github', readerId);
    if (!selected.revisionId) throw unavailable();
    const revision = await sourceRevision(client, ownerId, documentId, 'github', selected.revisionId);
    if (!revision || revision.kind !== 'github' || revision.sourceVersionId !== sourceId || !revision.readme?.renderedHtml) throw unavailable();
    const row = (await client.query('SELECT job_id FROM github_versions WHERE owner_id=$1 AND document_id=$2 AND id=$3', [ownerId, documentId, revision.id])).rows[0];
    const acquisitions = (await client.query<WebAssetRow & { acquisition_id: string; asset_id: string; role: string; filename: string; url: string }>(`SELECT a.*,q.id AS acquisition_id,q.asset_id,q.role,q.filename,q.url
      FROM source_acquisitions q JOIN assets a ON (a.owner_id,a.document_id,a.id)=(q.owner_id,q.document_id,q.asset_id)
      WHERE q.owner_id=$1 AND q.document_id=$2 AND q.job_id=$3 AND q.sha256=a.sha256 AND q.bytes=a.bytes AND q.media_type=a.media_type ORDER BY q.role LIMIT 257`, [ownerId, documentId, row.job_id])).rows;
    if (!acquisitions.length || acquisitions.length > defaultCaptureLimits.maxFiles) throw unavailable();
    const files = acquisitions.map(a => ({ id: a.acquisition_id, assetId: a.asset_id, role: a.role, filename: a.filename, url: a.url, sha256: a.sha256, bytes: Number(a.bytes), mediaType: a.media_type }));
    return { declaration: { github: { sourceManifestSha256: manifestSha256, revision, jobId: row.job_id, files } },
      files: acquisitions.map(asset => ({ path: `originals/github/${asset.role}`, asset, ceiling: asset.role === 'github-html' ? defaultCaptureLimits.maxHtmlBytes : asset.role === 'github-descriptor' ? 2 * 1024 * 1024 : ['github-repository','github-commit','github-raw'].includes(asset.role) ? 1024 * 1024 : defaultCaptureLimits.maxResourceBytes })) };
  }
  const source = (await client.query<WebCaptureRow>(`SELECT * FROM web_captures WHERE owner_id=$1 AND document_id=$2 AND source_version_id=$3 AND capture_id=$4 AND status='completed'`, [ownerId, documentId, sourceId, capture.captureId])).rows[0];
  if (!source) throw unavailable();
  const captures = [await selectCapture(source, 'capture')];
  const translated = (await client.query<{ sha256: string }>(`SELECT t.sha256 FROM web_reader_versions r JOIN web_translation_runs t
    ON (t.owner_id,t.document_id,t.id)=(r.owner_id,r.document_id,r.translation_id)
    WHERE r.owner_id=$1 AND r.document_id=$2 AND r.id=$3 AND r.source_version_id=$4 AND t.generation_kind='import'`, [ownerId, documentId, readerId, sourceId])).rows[0];
  if (translated && source.reader_version_id !== readerId) {
    const candidates = (await client.query<WebCaptureRow>(`SELECT * FROM web_captures WHERE owner_id=$1 AND document_id=$2 AND source_version_id=$3 AND reader_version_id=$4 AND status='completed'
      AND manifest->'existingTranslation' <> 'null'::jsonb AND capture_id<>$5 LIMIT 2`, [ownerId, documentId, sourceId, readerId, capture.captureId])).rows;
    if (candidates.length !== 1) throw unavailable();
    captures.push({ ...await selectCapture(candidates[0]!, 'reader-capture'), translationSha256: translated.sha256 });
  }
  return { captures };

  async function selectCapture(row: WebCaptureRow, prefix: CaptureOriginals['prefix']): Promise<CaptureOriginals> {
    if (row.manifest.files.length > defaultCaptureLimits.maxFiles) throw unavailable();
    const request = row.fetch_job_id ? null : row.admitted_request ?? { manifest: row.manifest, translationIntent: row.translation_intent, ...(row.target_document_id ? { targetDocumentId: row.target_document_id } : {}), ...row.save_hints };
    const files: CaptureOriginals['files'] = [];
    for (const file of row.manifest.files) {
      const received = (await client.query(`SELECT descriptor,received_sha256,received_bytes FROM web_capture_files WHERE owner_id=$1 AND capture_id=$2 AND id=$3`, [ownerId, row.id, file.id])).rows[0];
      if (!received || ['id','path','role','mediaType','sha256','bytes'].some(key => received.descriptor[key] !== file[key as keyof CaptureFile]) || received.received_sha256 !== file.sha256 || Number(received.received_bytes) !== file.bytes) throw unavailable();
      const asset = (await client.query<WebAssetRow>(`SELECT a.* FROM assets a WHERE a.owner_id=$1 AND a.document_id=$2 AND a.sha256=$3 AND a.bytes=$4 AND a.media_type=$5 AND (
        EXISTS(SELECT 1 FROM web_source_files f WHERE f.owner_id=a.owner_id AND f.document_id=a.document_id AND f.asset_id=a.id AND f.source_version_id=$6 AND f.id LIKE 'uploaded:%' AND f.role=$7)
        OR EXISTS(SELECT 1 FROM web_fetch_acquisitions f WHERE f.owner_id=a.owner_id AND f.document_id=a.document_id AND f.raw_asset_id=a.id AND f.ingestion_id=$8)) ORDER BY a.id LIMIT 1`, [ownerId, documentId, file.sha256, file.bytes, file.mediaType, sourceId, file.role, row.id])).rows[0];
      if (!asset) throw unavailable();
      files.push({ descriptor: file, asset });
    }
    return { prefix, manifest: row.manifest, request, requestHash: row.request_hash, files };
  }
}
