import type { PoolClient } from 'pg';
import { webDocumentSummarySchema, type DocumentSummary } from '@pagelingo/document-contracts';
import { findWebDocument, findWebReaderVersion, findWebSource } from '../web-readers/repository.js';
import { findDocument, summary } from './repository.js';
import { ServiceError } from '../errors.js';
import { assertDocumentActive } from '../document-management/repository.js';
export async function libraryDocument(client: PoolClient, ownerId: string, id: string): Promise<DocumentSummary> {
  await assertDocumentActive(client,ownerId,id);
  const kind = (await client.query<{ kind: string }>('SELECT kind FROM documents WHERE owner_id=$1 AND id=$2', [ownerId, id])).rows[0]?.kind;
  if (!kind) throw new ServiceError(404, 'NOT_FOUND', 'Document not found');
  if (kind === 'pdf') return summary(await findDocument(client, ownerId, id));
  const document = (await findWebDocument(client, ownerId, id))!;
  const reader = await findWebReaderVersion(client, ownerId, id);
  const source = reader ? await findWebSource(client, ownerId, id, reader.source_version_id) : undefined;
  const configured = reader?.translation_status === 'pending'
    ? (await client.query<{ configured: boolean }>("SELECT EXISTS (SELECT 1 FROM provider_profiles WHERE owner_id=$1 AND key_id IS NOT NULL AND base_url<>'' AND model<>'') AS configured", [ownerId])).rows[0]!.configured
    : true;
  return webDocumentSummarySchema.parse({ id, kind, title: document.title, originalFilename: null, createdAt: document.created_at.toISOString(), url: document.source_url,
    source: source ? { documentId: id, sourceVersionId: source.source_version_id, manifestAssetId: source.asset_id, sha256: source.sha256, bytes: Number(source.bytes), snapshotSha256: source.snapshot_sha256 } : null,
    saveStatus: source ? source.metadata.saveStatus ?? 'original-saved' : 'link-only',
    processingStatus: reader ? (!configured ? 'awaiting-config' : 'reader-ready') : 'link-only',
    reader: reader ? { versionId: reader.id, translationStatus: reader.translation_status, warnings: reader.warnings } : null });
}
export async function libraryList(client: PoolClient, ownerId: string, query: { q?: string; page: number; pageSize: number }) {
  const pattern = `%${(query.q ?? '').replace(/[\\%_]/g, value => `\\${value}`)}%`;
  const total = (await client.query<{ total: number }>("SELECT count(*)::int AS total FROM documents WHERE owner_id=$1 AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM document_source_aliases a WHERE a.owner_id=documents.owner_id AND a.document_id=documents.id AND a.resolution='alias') AND title ILIKE $2 ESCAPE '\\'", [ownerId, pattern])).rows[0]!.total;
  const rows = (await client.query<{ id: string }>("SELECT id FROM documents WHERE owner_id=$1 AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM document_source_aliases a WHERE a.owner_id=documents.owner_id AND a.document_id=documents.id AND a.resolution='alias') AND title ILIKE $2 ESCAPE '\\' ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4", [ownerId, pattern, query.pageSize, (query.page - 1) * query.pageSize])).rows;
  const items: DocumentSummary[] = []; for (const row of rows) items.push(await libraryDocument(client, ownerId, row.id));
  return { items, total, page: query.page, pageSize: query.pageSize };
}
