import { providerSettingsSchema, glossaryRevisionSchema, type ProviderSettings } from '@pagelingo/document-contracts';
import type { GlossaryEntry } from '@pagelingo/translation-core';
import type { Database } from '../db/database.js';
import type { RuntimeConfig } from '../config.js';
import { ServiceError } from '../errors.js';
import { findProviderProfile, storedSecret } from '../providers/repository.js';
import { openApiKey } from '../providers/secrets.js';
import { assertJobLeaseCurrent, type JobLease } from './repository.js';
export const profileChanged = () =>
  new ServiceError(409, 'PROFILE_CHANGED', 'Configuration has changed; explicitly start a new run');
export interface ResolvedJobProfile {
  settings: ProviderSettings;
  apiKey: string;
  profileRevision: number;
  glossaryRevision: number;
  glossary: GlossaryEntry[];
}
/** Worker-only boundary: temporary key, never a session or a public DTO. Re-resolve before each call. */
export function createJobProfileResolver({ db, keyring }: { db: Database; keyring: RuntimeConfig['keyring'] }) {
  return async function resolveJobProfile(lease: JobLease): Promise<ResolvedJobProfile> {
    if (lease.kind !== 'translate') throw new ServiceError(400, 'INVALID_REQUEST', 'Translation lease required');
    return db.transaction(async (client) => {
      const user = (await client.query('SELECT active,auth_version FROM users WHERE id=$1 FOR UPDATE', [lease.ownerId]))
        .rows[0];
      if (!user?.active || user.auth_version !== lease.authVersion)
        throw new ServiceError(401, 'UNAUTHORIZED', 'Job owner is no longer current');
      const current = await findProviderProfile(client, lease.ownerId);
      if (!current || current.revision !== lease.profileRevision || !current.key_id) throw profileChanged();
      await assertJobLeaseCurrent(client, lease);
      const snapshot = (
        await client.query('SELECT settings FROM web_provider_revisions WHERE owner_id=$1 AND revision=$2', [
          lease.ownerId,
          lease.profileRevision,
        ])
      ).rows[0];
      const glossary = (
        await client.query('SELECT revision,entries FROM glossary_revisions WHERE owner_id=$1 AND revision=$2', [
          lease.ownerId,
          lease.glossaryRevision,
        ])
      ).rows[0];
      if (!snapshot || !glossary) throw profileChanged();
      const settings = providerSettingsSchema.parse(snapshot.settings);
      const entries = glossaryRevisionSchema.parse(glossary).entries;
      try {
        return {
          settings,
          apiKey: openApiKey(storedSecret(current)!, lease.ownerId, keyring),
          profileRevision: lease.profileRevision,
          glossaryRevision: lease.glossaryRevision,
          glossary: entries,
        };
      } catch {
        throw new ServiceError(500, 'PROVIDER_SECRET_UNAVAILABLE', 'Provider key is unavailable');
      }
    });
  };
}
