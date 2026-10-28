import type { PoolClient } from 'pg';
import { ServiceError } from '../errors.js';

/** Resolve registered Reader provenance without selecting by shared PDF bytes or writing pointers. */
export async function readerSourceRevision(
  client: PoolClient,
  ownerId: string,
  documentId: string,
  provider: 'github' | 'arxiv',
  readerVersionId: string,
  revisionId?: string,
): Promise<{ revisionId: string | null; warning?: string }> {
  const table = provider === 'arxiv' ? 'reader_versions' : 'web_reader_versions';
  const reader = (await client.query(
    `SELECT source_version_id FROM ${table} WHERE owner_id=$1 AND document_id=$2 AND id=$3`,
    [ownerId, documentId, readerVersionId],
  )).rows[0];
  if (!reader) throw new ServiceError(404, 'NOT_FOUND', 'Reader not found');
  let candidates: { id: string }[];
  let sourceOnlyFallback = false;
  if (provider === 'arxiv') {
    candidates = (await client.query<{ id: string }>(
      `SELECT arxiv_version_id AS id FROM paper_reader_bindings
       WHERE owner_id=$1 AND document_id=$2 AND reader_version_id=$3`,
      [ownerId, documentId, readerVersionId],
    )).rows;
  } else {
    candidates = (await client.query<{ id: string }>(
      `SELECT DISTINCT v.id FROM github_versions v JOIN web_jobs f
       ON(f.owner_id,f.document_id,f.source_github_revision_id)=(v.owner_id,v.document_id,v.id)
       JOIN web_captures c ON(c.owner_id,c.target_document_id,c.fetch_job_id)=(f.owner_id,f.document_id,f.id)
       LEFT JOIN web_jobs t ON(t.owner_id,t.document_id,t.id)=(c.owner_id,c.document_id,c.job_id)
       WHERE v.owner_id=$1 AND v.document_id=$2 AND v.source_version_id=$4
       AND (c.reader_version_id=$3 OR t.reader_version_id=$3)`,
      [ownerId, documentId, readerVersionId, reader.source_version_id],
    )).rows;
    if (!candidates.length) {
      sourceOnlyFallback = true;
      candidates = (await client.query<{ id: string }>(
        'SELECT id FROM github_versions WHERE owner_id=$1 AND document_id=$2 AND source_version_id=$3',
        [ownerId, documentId, reader.source_version_id],
      )).rows;
    }
  }
  if (revisionId) {
    if ((sourceOnlyFallback && candidates.length !== 1) || !candidates.some(row => row.id === revisionId.toLowerCase())) {
      throw new ServiceError(404, 'NOT_FOUND', 'Source revision does not belong to Reader');
    }
    return { revisionId: revisionId.toLowerCase() };
  }
  return candidates.length === 1
    ? { revisionId: candidates[0]!.id }
    : { revisionId: null, warning: candidates.length ? 'SOURCE_READER_REVISION_AMBIGUOUS' : 'SOURCE_READER_REVISION_UNAVAILABLE' };
}
