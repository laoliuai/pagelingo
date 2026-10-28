import type { PoolClient } from 'pg';
import { libraryPageSchema, type LibraryQuery } from '@pagelingo/document-contracts';
import { libraryDocument } from '../documents/library.js';
import { assertTaxonomyOwned, organization } from './repository.js';
import { literalPattern } from './names.js';

/** Caller uses a short repeatable-read transaction, including summary/header hydration. */
export async function queryLibrary(client: PoolClient, ownerId: string, query: LibraryQuery) {
  if (query.collectionId && query.collectionId !== 'none') await assertTaxonomyOwned(client, ownerId, 'collections', [query.collectionId]);
  await assertTaxonomyOwned(client, ownerId, 'tags', query.tagIds ?? []);
  const values: unknown[] = [ownerId]; const predicates = ['d.owner_id=$1', 'd.deleted_at IS NULL'];
  const parameter = (value: unknown) => { values.push(value); return `$${values.length}`; };
  if (query.kind) predicates.push(`d.kind=${parameter(query.kind)}`);
  if (query.origin) predicates.push(`d.origin=${parameter(query.origin)}`);
  if (query.readingStatus) predicates.push(`o.reading_status=${parameter(query.readingStatus)}`);
  if (query.collectionId === 'none') predicates.push('o.collection_id IS NULL');
  else if (query.collectionId) predicates.push(`o.collection_id=${parameter(query.collectionId)}::uuid`);
  if (query.tagIds?.length) predicates.push(`NOT EXISTS(SELECT 1 FROM unnest(${parameter(query.tagIds)}::uuid[]) requested(id) WHERE NOT EXISTS(SELECT 1 FROM document_tags t WHERE t.owner_id=d.owner_id AND t.document_id=d.id AND t.tag_id=requested.id))`);
  if (query.q) {
    const p = parameter(literalPattern(query.q));
    predicates.push(`(d.title ILIKE ${p} ESCAPE '\\' OR o.note ILIKE ${p} ESCAPE '\\' OR COALESCE(d.source_url,'') ILIKE ${p} ESCAPE '\\'
      OR COALESCE(m.authors,'') ILIKE ${p} ESCAPE '\\' OR COALESCE(m.source_url,'') ILIKE ${p} ESCAPE '\\' OR COALESCE(m.domain,'') ILIKE ${p} ESCAPE '\\'
      OR EXISTS(SELECT 1 FROM collections c WHERE (c.owner_id,c.id)=(o.owner_id,o.collection_id) AND c.name ILIKE ${p} ESCAPE '\\')
      OR EXISTS(SELECT 1 FROM document_tags dt JOIN tags t ON (t.owner_id,t.id)=(dt.owner_id,dt.tag_id) WHERE dt.owner_id=d.owner_id AND dt.document_id=d.id AND t.name ILIKE ${p} ESCAPE '\\'))`);
  }
  // Stale projections never participate, even if a future publication omitted its refresh.
  const from = `FROM documents d JOIN document_organization o ON(o.owner_id,o.document_id)=(d.owner_id,d.id)
    LEFT JOIN document_search_metadata m ON(m.owner_id,m.document_id)=(d.owner_id,d.id)
      AND m.source_version_id IS NOT DISTINCT FROM d.current_source_version_id
      AND m.parse_id IS NOT DISTINCT FROM COALESCE((SELECT parse_id FROM reader_versions r WHERE (r.owner_id,r.document_id,r.id)=(d.owner_id,d.id,d.current_reader_version_id)),(SELECT parse_id FROM web_reader_versions r WHERE (r.owner_id,r.document_id,r.id)=(d.owner_id,d.id,d.current_web_reader_version_id)))
    WHERE ${predicates.join(' AND ')}`;
  const total = (await client.query<{total:number}>(`SELECT count(*)::int AS total ${from}`, values)).rows[0]!.total;
  const limit = parameter(query.pageSize), offset = parameter((query.page-1)*query.pageSize);
  const rows = (await client.query<{id:string;origin:string}>(`SELECT d.id,d.origin ${from} ORDER BY d.created_at DESC,d.id DESC LIMIT ${limit} OFFSET ${offset}`, values)).rows;
  const items = [];
  for (const row of rows) items.push({ document: await libraryDocument(client,ownerId,row.id), organization: await organization(client,ownerId,row.id), origin: row.origin });
  return libraryPageSchema.parse({ items, total, page:query.page, pageSize:query.pageSize });
}
