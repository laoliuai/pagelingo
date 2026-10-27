import type { PoolClient } from 'pg';
import { glossaryEntriesSchema, type GlossaryRevision, type SavePreferences } from '@pagelingo/document-contracts';

export async function readSavePreferences(client: PoolClient, ownerId: string): Promise<SavePreferences> {
  const row = (await client.query<{ revision: number; auto_translate: boolean }>('SELECT revision,auto_translate FROM save_preferences WHERE owner_id=$1', [ownerId])).rows[0];
  return row ? { revision: row.revision, autoTranslate: row.auto_translate } : { revision: 0, autoTranslate: false };
}
/** Owner locks serialize first creation and CAS updates. Authentication stays in the caller. */
export async function savePreferences(client: PoolClient, ownerId: string, expectedRevision: number, autoTranslate: boolean): Promise<SavePreferences | null> {
  await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [ownerId]);
  await client.query('INSERT INTO save_preferences (owner_id) VALUES ($1) ON CONFLICT DO NOTHING', [ownerId]);
  const row = (await client.query<{ revision: number; auto_translate: boolean }>(`UPDATE save_preferences SET revision=revision+1,auto_translate=$3,updated_at=clock_timestamp()
    WHERE owner_id=$1 AND revision=$2 RETURNING revision,auto_translate`, [ownerId,expectedRevision,autoTranslate])).rows[0];
  return row ? { revision: row.revision, autoTranslate: row.auto_translate } : null;
}
export async function readGlossaryRevision(client: PoolClient, ownerId: string, revision?: number): Promise<GlossaryRevision | undefined> {
  const row = (await client.query<GlossaryRevision>(`SELECT revision,entries FROM glossary_revisions
    WHERE owner_id=$1 AND ($2::integer IS NULL OR revision=$2) ORDER BY revision DESC LIMIT 1`, [ownerId,revision ?? null])).rows[0];
  return row ?? (revision === undefined || revision === 0 ? { revision: 0, entries: [] } : undefined);
}
export async function saveGlossaryRevision(client: PoolClient, ownerId: string, expectedRevision: number, entries: GlossaryRevision['entries']): Promise<GlossaryRevision | null> {
  const validated = glossaryEntriesSchema.parse(entries);
  await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [ownerId]);
  await client.query("INSERT INTO glossary_revisions (owner_id,revision,entries) VALUES ($1,0,'[]') ON CONFLICT DO NOTHING", [ownerId]);
  const current = (await readGlossaryRevision(client,ownerId))!;
  if (current.revision !== expectedRevision) return null;
  const result = { revision: expectedRevision + 1, entries: validated };
  await client.query('INSERT INTO glossary_revisions (owner_id,revision,entries) VALUES ($1,$2,$3)', [ownerId,result.revision,JSON.stringify(validated)]);
  return result;
}
/** Materializes the initial immutable revision so a first job can reference revision zero. */
export async function ensureGlossaryRevision(client: PoolClient, ownerId: string): Promise<GlossaryRevision> {
  await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [ownerId]);
  await client.query("INSERT INTO glossary_revisions (owner_id,revision,entries) VALUES ($1,0,'[]') ON CONFLICT DO NOTHING", [ownerId]);
  return (await readGlossaryRevision(client,ownerId))!;
}
