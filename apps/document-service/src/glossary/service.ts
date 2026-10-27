import { glossaryUpdateSchema, type GlossaryUpdate } from '@pagelingo/document-contracts';
import { mergeGlossaryEntries } from '@pagelingo/translation-core';
import { readGlossaryRevision, saveGlossaryRevision } from './repository.js';
import { assertActorCurrent, type Actor } from '../auth/guards.js';
import type { Database } from '../db/database.js';
import { ServiceError } from '../errors.js';
export function createGlossaryService({ db }: { db: Database }) {
  return {
    async get(actor: Actor) {
      return db.transaction(async (c) => {
        await assertActorCurrent(c, actor);
        return (await readGlossaryRevision(c, actor.userId))!;
      });
    },
    async update(actor: Actor, input: GlossaryUpdate) {
      const parsed = glossaryUpdateSchema.safeParse(input);
      if (!parsed.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid glossary');
      const entries = mergeGlossaryEntries([], parsed.data.entries);
      return db.transaction(async (c) => {
        await assertActorCurrent(c, actor);
        const result = await saveGlossaryRevision(c, actor.userId, parsed.data.expectedRevision, entries);
        if (!result) throw new ServiceError(409, 'REVISION_CONFLICT', 'Glossary has changed');
        return result;
      });
    },
  };
}
