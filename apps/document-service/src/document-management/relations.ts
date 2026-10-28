import { assertDocumentWritable } from '../document-lifecycle/guards.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ServiceError } from '../errors.js';
import { assertDocumentActive, notFound } from './repository.js';
export const relationInputSchema = z.strictObject({ fromDocumentId: z.uuid(), toDocumentId: z.uuid(), kind: z.enum(['discovered-from','related']) }).refine(v => v.fromDocumentId.toLowerCase() !== v.toDocumentId.toLowerCase(), 'Self relation is not allowed');
export type RelationInput = z.infer<typeof relationInputSchema>;
export const relationSchema = z.strictObject({ id: z.uuid(), fromDocumentId: z.uuid(), toDocumentId: z.uuid(), kind: z.enum(['discovered-from','related']) });
export const relationPageSchema = z.strictObject({ items: z.array(relationSchema).max(50), nextCursor: z.uuid().nullable() });
export async function addRelation(client: PoolClient, ownerId: string, input: RelationInput): Promise<void> {
  const parsed = relationInputSchema.safeParse(input); if (!parsed.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid relation');
  for (const id of [input.fromDocumentId,input.toDocumentId].sort()) await assertDocumentWritable(client, ownerId, id);
  await client.query('INSERT INTO document_relations(owner_id,from_document_id,to_document_id,kind) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,from_document_id,to_document_id,kind) DO NOTHING', [ownerId,input.fromDocumentId,input.toDocumentId,input.kind]);
}
export async function removeRelation(client: PoolClient, ownerId: string, input: RelationInput): Promise<void> {
  for (const id of [input.fromDocumentId,input.toDocumentId].sort()) await assertDocumentWritable(client, ownerId, id);
  await client.query('DELETE FROM document_relations WHERE owner_id=$1 AND from_document_id=$2 AND to_document_id=$3 AND kind=$4', [ownerId,input.fromDocumentId,input.toDocumentId,input.kind]);
}
export async function listRelations(client: PoolClient, ownerId: string, documentId: string, query: {cursor?:string;limit:number}) {
  await assertDocumentActive(client, ownerId, documentId);
  if (query.cursor && !(await client.query('SELECT 1 FROM document_relations WHERE owner_id=$1 AND id=$2 AND (from_document_id=$3 OR to_document_id=$3)', [ownerId,query.cursor,documentId])).rowCount) throw notFound();
  const rows = (await client.query(`SELECT r.* FROM document_relations r
    JOIN documents a ON (a.owner_id,a.id)=(r.owner_id,r.from_document_id) JOIN documents b ON (b.owner_id,b.id)=(r.owner_id,r.to_document_id)
    WHERE r.owner_id=$1 AND (r.from_document_id=$2 OR r.to_document_id=$2) AND a.deleted_at IS NULL AND b.deleted_at IS NULL
    AND ($3::uuid IS NULL OR r.id>$3) ORDER BY r.id LIMIT $4`, [ownerId,documentId,query.cursor ?? null,query.limit+1])).rows;
  const items = rows.slice(0,query.limit).map(r => ({id:r.id,fromDocumentId:r.from_document_id,toDocumentId:r.to_document_id,kind:r.kind}));
  return relationPageSchema.parse({ items, nextCursor: rows.length>query.limit ? items.at(-1)!.id : null });
}
