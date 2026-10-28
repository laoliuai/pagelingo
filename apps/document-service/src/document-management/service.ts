import { assertDocumentWritable } from '../document-lifecycle/guards.js';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { libraryQuerySchema, patchDocumentOrganizationSchema, type PatchDocumentOrganization } from '@pagelingo/document-contracts';
import { assertActorCurrent, type Actor } from '../auth/guards.js';
import type { Database } from '../db/database.js';
import { ServiceError } from '../errors.js';
import { assertTaxonomyOwned, notFound, organization, replaceTags } from './repository.js';
import { literalPattern, nameKey, taxonomyNameSchema } from './names.js';
import { queryLibrary } from './query.js';
import { addRelation, listRelations, relationInputSchema, removeRelation, type RelationInput } from './relations.js';

export const taxonomyItemSchema = z.strictObject({ id: z.uuid(), name: z.string().min(1).max(80) });
export const taxonomyPageSchema = z.strictObject({ items: z.array(taxonomyItemSchema).max(100), nextCursor: z.uuid().nullable() });
export const taxonomyWriteSchema = z.strictObject({ name: taxonomyNameSchema });
export const cursorQuerySchema = (maximum: number, initial: number) => z.strictObject({
  cursor: z.uuid().optional(),
  limit: z.union([z.number(), z.string().regex(/^[0-9]{1,3}$/)]).transform(Number).pipe(z.number().int().min(1).max(maximum)).default(initial),
});
export const taxonomyQuerySchema = cursorQuerySchema(100, 50).extend({ q: z.string().max(80).optional() });
export type Taxonomy = 'collections' | 'tags';
const invalid = () => new ServiceError(400, 'INVALID_REQUEST', 'Invalid management request');

export function createDocumentManagementService({ db }: { db: Database }) {
  async function transaction<T>(actor: Actor, fn: (client: PoolClient) => Promise<T>, snapshot = false): Promise<T> {
    return db.transaction(async client => {
      if (snapshot) await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await assertActorCurrent(client, actor);
      return fn(client);
    });
  }
  return {
    getOrganization(actor: Actor, id: string) { return transaction(actor, client => organization(client, actor.userId, id)); },
    patchOrganization(actor: Actor, id: string, input: PatchDocumentOrganization) {
      const parsed = patchDocumentOrganizationSchema.safeParse(input);
      if (!parsed.success) throw invalid();
      const value = parsed.data;
      return transaction(actor, async client => {
        await assertDocumentWritable(client, actor.userId, id);
        await client.query('SELECT id FROM documents WHERE owner_id=$1 AND id=$2 FOR UPDATE', [actor.userId, id]);
        if (value.collectionId) await assertTaxonomyOwned(client, actor.userId, 'collections', [value.collectionId]);
        if (value.tagIds) await assertTaxonomyOwned(client, actor.userId, 'tags', value.tagIds);
        const updates = ['revision=revision+1', 'updated_at=clock_timestamp()'];
        const values: unknown[] = [actor.userId, id, value.expectedRevision];
        for (const [field, column] of [['collectionId', 'collection_id'], ['note', 'note'], ['readingStatus', 'reading_status']] as const) {
          if (value[field] !== undefined) { values.push(value[field]); updates.push(`${column}=$${values.length}`); }
        }
        const changed = await client.query(`UPDATE document_organization SET ${updates.join(',')}
          WHERE owner_id=$1 AND document_id=$2 AND revision=$3 AND revision<9007199254740991 RETURNING document_id`, values);
        if (!changed.rowCount) throw new ServiceError(409, 'METADATA_CONFLICT', 'Organization metadata changed; read the current value before retrying');
        if (value.title !== undefined) await client.query("UPDATE documents SET title=$3,title_origin='user',updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2", [actor.userId, id, value.title]);
        if (value.tagIds) await replaceTags(client, actor.userId, id, value.tagIds);
        return organization(client, actor.userId, id);
      });
    },
    library(actor: Actor, input: unknown) {
      const parsed = libraryQuerySchema.safeParse(input);
      if (!parsed.success) throw invalid();
      return transaction(actor, client => queryLibrary(client, actor.userId, parsed.data), true);
    },
    taxonomyList(actor: Actor, type: Taxonomy, input: unknown) {
      const parsed = taxonomyQuerySchema.safeParse(input);
      if (!parsed.success) throw invalid();
      const query = parsed.data;
      return transaction(actor, async client => {
        if (query.cursor) await assertTaxonomyOwned(client, actor.userId, type, [query.cursor]);
        const rows = (await client.query<{ id: string; name: string }>(`SELECT id,name FROM ${type}
          WHERE owner_id=$1 AND ($2::uuid IS NULL OR id>$2) AND name ILIKE $3 ESCAPE '\\' ORDER BY id LIMIT $4`,
        [actor.userId, query.cursor ?? null, literalPattern(query.q ?? ''), query.limit + 1])).rows;
        const items = rows.slice(0, query.limit);
        return taxonomyPageSchema.parse({ items, nextCursor: rows.length > query.limit ? items.at(-1)!.id : null });
      });
    },
    taxonomyGet(actor: Actor, type: Taxonomy, id: string) {
      return transaction(actor, async client => {
        const row = (await client.query(`SELECT id,name FROM ${type} WHERE owner_id=$1 AND id=$2`, [actor.userId, id])).rows[0];
        if (!row) throw notFound();
        return taxonomyItemSchema.parse(row);
      });
    },
    taxonomySave(actor: Actor, type: Taxonomy, input: unknown, id?: string) {
      const parsed = taxonomyWriteSchema.safeParse(input);
      if (!parsed.success) throw invalid();
      return transaction(actor, async client => {
        if (id) await assertTaxonomyOwned(client, actor.userId, type, [id]);
        const name = parsed.data.name;
        try {
          const row = (await client.query(id
            ? `UPDATE ${type} SET name=$3,name_key=$4 WHERE owner_id=$1 AND id=$2 RETURNING id,name`
            : `INSERT INTO ${type}(owner_id,name,name_key) VALUES($1,$2,$3) RETURNING id,name`,
          id ? [actor.userId, id, name, nameKey(name)] : [actor.userId, name, nameKey(name)])).rows[0];
          return taxonomyItemSchema.parse(row);
        } catch (error) {
          if ((error as { code?: string }).code === '23505') throw new ServiceError(409, 'NAME_CONFLICT', 'A taxonomy item with this name already exists');
          throw error;
        }
      });
    },
    taxonomyDelete(actor: Actor, type: Taxonomy, id: string) {
      return transaction(actor, async client => {
        await assertTaxonomyOwned(client, actor.userId, type, [id]);
        if (type === 'collections') {
          await client.query('UPDATE document_organization SET collection_id=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE owner_id=$1 AND collection_id=$2', [actor.userId, id]);
        } else {
          await client.query(`UPDATE document_organization o SET revision=revision+1,updated_at=clock_timestamp() WHERE o.owner_id=$1
            AND EXISTS(SELECT 1 FROM document_tags t WHERE (t.owner_id,t.document_id)=(o.owner_id,o.document_id) AND t.tag_id=$2)`, [actor.userId, id]);
          await client.query('DELETE FROM document_tags WHERE owner_id=$1 AND tag_id=$2', [actor.userId, id]);
        }
        await client.query(`DELETE FROM ${type} WHERE owner_id=$1 AND id=$2`, [actor.userId, id]);
      });
    },
    relationWrite(actor: Actor, input: RelationInput, remove = false) {
      const parsed = relationInputSchema.safeParse(input);
      if (!parsed.success) throw invalid();
      return transaction(actor, async client => {
        await (remove ? removeRelation : addRelation)(client, actor.userId, parsed.data);
        return { status: 'ok' as const };
      });
    },
    relations(actor: Actor, id: string, input: unknown) {
      const parsed = cursorQuerySchema(50, 20).safeParse(input);
      if (!parsed.success) throw invalid();
      return transaction(actor, client => listRelations(client, actor.userId, id, parsed.data));
    },
  };
}
