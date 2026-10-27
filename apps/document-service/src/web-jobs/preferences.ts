import { savePreferencesUpdateSchema, type SavePreferencesUpdate } from '@pagelingo/document-contracts';
import { readSavePreferences, savePreferences } from '../glossary/repository.js';
export { readSavePreferences } from '../glossary/repository.js';
import { assertActorCurrent, type Actor } from '../auth/guards.js';
import { assertCapturePrincipalCurrent, type CapturePrincipal } from '../devices/guards.js';
import type { Database } from '../db/database.js';
import { ServiceError } from '../errors.js';
export function createSavePreferencesService({ db }: { db: Database }) {
  return {
    async get(principal: CapturePrincipal) {
      if (principal.kind === 'device' && principal.scope !== 'preferences:read')
        throw new ServiceError(403, 'FORBIDDEN', 'Preference read scope required');
      return db.transaction(async (c) => {
        await assertCapturePrincipalCurrent(c, principal);
        return readSavePreferences(c, principal.kind === 'session' ? principal.actor.userId : principal.userId);
      });
    },
    async update(actor: Actor, input: SavePreferencesUpdate) {
      const parsed = savePreferencesUpdateSchema.safeParse(input);
      if (!parsed.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid save preferences');
      return db.transaction(async (c) => {
        await assertActorCurrent(c, actor);
        const result = await savePreferences(c, actor.userId, parsed.data.expectedRevision, parsed.data.autoTranslate);
        if (!result) throw new ServiceError(409, 'REVISION_CONFLICT', 'Save preferences have changed');
        return result;
      });
    },
  };
}
