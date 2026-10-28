import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ServiceError } from '../errors.js';
import { validatePdf } from '../documents/pdf-validation.js';
import { lockObjectPublication } from '../documents/repository.js';
import { projectSelectedMetadata } from '../document-management/metadata-projection.js';
import type { JobLease } from '../web-jobs/repository.js';
import { assertSourcePublication } from './identity.js';
import type { ArxivMetadata } from './arxiv-atom.js';
import type { SourceAcquisition } from './repository.js';
import type { SourceFetchDependencies } from './types.js';
function conflict(): never { throw new ServiceError(409, 'SOURCE_VERSION_CONFLICT', 'Fixed paper version changed'); }
/** Immutable metadata and attempt result; selected readable materials change only after PDF validation. */
export async function publishArxivMetadata(client: PoolClient, lease: JobLease, value: ArxivMetadata, atom: SourceAcquisition): Promise<string> {
  await assertSourcePublication(client, lease);
  const identity = (await client.query("SELECT provider_id FROM document_source_identities WHERE owner_id=$1 AND document_id=$2 AND provider='arxiv'", [lease.ownerId, lease.documentId])).rows[0];
  if (identity?.provider_id !== value.baseId) conflict();
  const existing = (await client.query('SELECT * FROM arxiv_versions WHERE owner_id=$1 AND document_id=$2 AND base_id=$3 AND version=$4', [lease.ownerId, lease.documentId, value.baseId, value.version])).rows[0];
  let id = existing?.id as string | undefined;
  if (existing) {
    if (existing.title !== value.title || JSON.stringify(existing.authors) !== JSON.stringify(value.authors) || existing.summary !== value.summary || existing.published_at.toISOString() !== value.publishedAt || existing.updated_at.toISOString() !== value.updatedAt) conflict();
  } else {
    id = randomUUID();
    const inserted = await client.query(`INSERT INTO arxiv_versions(id,owner_id,document_id,job_id,base_id,version,title,authors,summary,published_at,updated_at,captured_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,a.created_at FROM source_acquisitions a WHERE a.owner_id=$2 AND a.document_id=$3 AND a.job_id=$4 AND a.id=$12 AND a.role='arxiv-atom'`,
    [id, lease.ownerId, lease.documentId, lease.jobId, value.baseId, value.version, value.title, JSON.stringify(value.authors), value.summary, value.publishedAt, value.updatedAt, atom.id]);
    if (!inserted.rowCount) throw new Error('Missing registered Atom');
  }
  await client.query('UPDATE web_jobs SET source_arxiv_revision_id=$3 WHERE owner_id=$1 AND id=$2', [lease.ownerId, lease.jobId, id]);
  if ((await client.query('UPDATE documents SET current_arxiv_revision_id=$3 WHERE owner_id=$1 AND id=$2 AND current_source_version_id IS NULL RETURNING id', [lease.ownerId, lease.documentId, id])).rowCount) await projectSelectedMetadata(client, lease.ownerId, lease.documentId);
  return id!;
}
/** The caller has streamed and hash-checked the actual immutable PDF outside SQL. */
export async function publishArxivPdf(lease: JobLease, deps: SourceFetchDependencies, revisionId: string, pdf: SourceAcquisition): Promise<void> {
  const retained = await deps.db.transaction(async client => {
    await assertSourcePublication(client, lease);
    return (await client.query(`SELECT s.id,a.object_key,a.sha256,a.bytes FROM arxiv_versions v
      JOIN source_versions s ON(s.owner_id,s.document_id,s.id)=(v.owner_id,v.document_id,v.source_version_id)
      JOIN assets a ON(a.owner_id,a.document_id,a.id)=(s.owner_id,s.document_id,s.asset_id)
      WHERE v.owner_id=$1 AND v.document_id=$2 AND v.pdf_sha256=$4 AND v.pdf_bytes=$5
      ORDER BY (v.id=$3) DESC,v.captured_at,v.id LIMIT 1`, [lease.ownerId, lease.documentId, revisionId, pdf.sha256, pdf.bytes])).rows[0];
  });
  if (retained) {
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of validatePdf(deps.store.read(retained.object_key), deps.config.maxPdfBytes)) { deps.signal.throwIfAborted(); bytes += chunk.byteLength; hash.update(chunk); }
    if (bytes !== Number(retained.bytes) || hash.digest('hex') !== retained.sha256) throw new ServiceError(400, 'SOURCE_HASH_MISMATCH', 'Stored original changed');
  }
  await deps.db.transaction(async client => {
    await assertSourcePublication(client, lease); deps.signal.throwIfAborted();
    const row = (await client.query('SELECT * FROM arxiv_versions WHERE owner_id=$1 AND document_id=$2 AND id=$3', [lease.ownerId, lease.documentId, revisionId])).rows[0];
    if (!row || !(await client.query("SELECT 1 FROM source_acquisitions WHERE owner_id=$1 AND document_id=$2 AND job_id=$3 AND asset_id=$4 AND role='arxiv-pdf' AND sha256=$5 AND bytes=$6", [lease.ownerId, lease.documentId, lease.jobId, pdf.assetId, pdf.sha256, pdf.bytes])).rowCount) throw new Error('Missing paper acquisition');
    if (row.pdf_asset_id && (row.pdf_sha256 !== pdf.sha256 || Number(row.pdf_bytes) !== pdf.bytes)) conflict();
    await lockObjectPublication(client);
    if ((await deps.store.stat(pdf.objectKey)).bytes !== pdf.bytes) throw new Error('Stored PDF size mismatch');
    if (retained && (await deps.store.stat(retained.object_key)).bytes !== Number(retained.bytes)) throw new Error('Stored original size mismatch');
    let sourceId: string | undefined = row.source_version_id;
    if (!sourceId) {
      // Reuse is scoped to this paper and actual registered PDF identity.
      sourceId = retained?.id;
      if (!sourceId) {
        sourceId = randomUUID();
        await client.query('INSERT INTO source_versions(id,owner_id,document_id,asset_id,sha256,bytes) VALUES($1,$2,$3,$4,$5,$6)', [sourceId, lease.ownerId, lease.documentId, pdf.assetId, pdf.sha256, pdf.bytes]);
      }
      await client.query('UPDATE arxiv_versions SET pdf_asset_id=$4,pdf_sha256=$5,pdf_bytes=$6,source_version_id=$7 WHERE owner_id=$1 AND document_id=$2 AND id=$3', [lease.ownerId, lease.documentId, revisionId, pdf.assetId, pdf.sha256, pdf.bytes, sourceId]);
    }
    // Explicit same-byte associations, not a guess from the document's shared source pointer.
    await client.query(`INSERT INTO paper_reader_bindings(owner_id,document_id,arxiv_version_id,source_version_id,reader_version_id)
      SELECT DISTINCT b.owner_id,b.document_id,$3::uuid,b.source_version_id,b.reader_version_id FROM paper_reader_bindings b
      JOIN arxiv_versions v ON(v.owner_id,v.document_id,v.id,v.source_version_id)=(b.owner_id,b.document_id,b.arxiv_version_id,b.source_version_id)
      WHERE b.owner_id=$1 AND b.document_id=$2 AND b.source_version_id=$4 AND v.pdf_sha256=$5 AND v.pdf_bytes=$6 ON CONFLICT DO NOTHING`, [lease.ownerId, lease.documentId, revisionId, sourceId, pdf.sha256, pdf.bytes]);
    const reader = (await client.query(`SELECT r.id FROM paper_reader_bindings b JOIN reader_versions r ON(r.owner_id,r.document_id,r.id)=(b.owner_id,b.document_id,b.reader_version_id)
      JOIN translation_runs t ON(t.owner_id,t.id)=(r.owner_id,r.translation_id) JOIN parse_runs p ON(p.owner_id,p.id)=(r.owner_id,r.parse_id)
      WHERE b.owner_id=$1 AND b.document_id=$2 AND b.arxiv_version_id=$3 ORDER BY CASE WHEN t.status IN ('completed','not-required') THEN 2 WHEN t.status='partial' THEN 1 ELSE 0 END DESC,(p.coverage='full') DESC,r.created_at DESC,r.id DESC LIMIT 1`, [lease.ownerId, lease.documentId, revisionId])).rows[0];
    await client.query('UPDATE documents SET current_source_version_id=$3,current_reader_version_id=$4,current_arxiv_revision_id=$5,original_filename=$6,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2', [lease.ownerId, lease.documentId, sourceId, reader?.id ?? null, revisionId, pdf.filename]);
    await projectSelectedMetadata(client, lease.ownerId, lease.documentId);
  });
}
