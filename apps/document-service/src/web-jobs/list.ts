import { assertDocumentActive } from '../document-lifecycle/guards.js';
import type { PoolClient } from 'pg';
import { webJobListSchema, type WebJobListQuery } from '@pagelingo/document-contracts';
import { ServiceError } from '../errors.js';
import { findWebSource, findWebParse } from '../web-readers/repository.js';
import type { WebJobRow } from './repository.js';
import { publicWebJob } from './service.js';
/** Pure discovery: timestamps stay in PostgreSQL so keysets retain microseconds. */
export async function listWebJobs(client: PoolClient, ownerId: string, documentId: string, query: WebJobListQuery) {
  await assertDocumentActive(client, ownerId, documentId);
  const document = (await client.query('SELECT kind FROM documents WHERE owner_id=$1 AND id=$2', [ownerId, documentId])).rows[0];
  if (!document || document.kind === 'pdf') throw new ServiceError(404, 'NOT_FOUND', 'Web document not found');
  if (query.sourceVersionId && !(await findWebSource(client, ownerId, documentId, query.sourceVersionId))) throw new ServiceError(404, 'NOT_FOUND', 'Source not found');
  if (query.parseId && !(await findWebParse(client, ownerId, documentId, query.sourceVersionId!, query.parseId))) throw new ServiceError(404, 'NOT_FOUND', 'Parse not found');
  const filters = "kind<>'export-web' AND owner_id=$1 AND document_id=$2 AND ($3::uuid IS NULL OR source_version_id=$3) AND ($4::text IS NULL OR parse_id=$4)";
  const params = [ownerId, documentId, query.sourceVersionId ?? null, query.parseId ?? null, query.cursor ?? null];
  if (query.cursor && !(await client.query(`SELECT id FROM web_jobs WHERE ${filters} AND id=$5`, params)).rowCount) throw new ServiceError(400, 'INVALID_REQUEST', 'Cursor does not belong to this query');
  const rows = (await client.query<WebJobRow>(`SELECT * FROM web_jobs WHERE ${filters} AND ($5::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM web_jobs WHERE id=$5)) ORDER BY created_at DESC,id DESC LIMIT $6`, [...params, query.limit + 1])).rows;
  return webJobListSchema.parse({ items: rows.slice(0, query.limit).map(publicWebJob), nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null });
}
