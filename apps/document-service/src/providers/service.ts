import { defaultProviderProfile, providerProfileSchema, providerProfileUpdateSchema } from '@pagelingo/document-contracts';
import type { ProviderProfile, ProviderProfileUpdate } from '@pagelingo/document-contracts';
import type { PoolClient } from 'pg';
import { assertActorCurrent } from '../auth/guards.js';
import type { Actor } from '../auth/guards.js';
import type { RuntimeConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { ServiceError } from '../errors.js';
import { findProviderProfile, saveProviderProfile, storedSecret } from './repository.js';
import type { ProviderProfileRow } from './repository.js';
import { openApiKey, sealApiKey } from './secrets.js';

function publicProfile(row: ProviderProfileRow | undefined): ProviderProfile {
  // Explicit whitelist, then revalidate the public DTO. Never spread database rows.
  return providerProfileSchema.parse(row ? {
    revision: row.revision, baseUrl: row.base_url, model: row.model, temperature: row.temperature,
    responseFormat: row.response_format, maxOutputTokens: row.max_output_tokens,
    maxTokensParameter: row.max_tokens_parameter, thinkingMode: row.thinking_mode, stream: row.stream,
    maxInputTokens: row.max_input_tokens, contextWindowTokens: row.context_window_tokens,
    hasApiKey: row.key_id !== null,
  } : defaultProviderProfile);
}

export function createProvidersService({ db, keyring }: { db: Database; keyring: RuntimeConfig['keyring'] }) {
  async function authorized<T>(actor: Actor, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return db.transaction(async client => {
      // User -> session -> profile. Never acquire the account-management global lock.
      await assertActorCurrent(client, actor);
      return fn(client);
    });
  }
  return {
    async get(actor: Actor): Promise<ProviderProfile> {
      return authorized(actor, async client => publicProfile(await findProviderProfile(client, actor.userId)));
    },
    async update(actor: Actor, input: ProviderProfileUpdate): Promise<ProviderProfile> {
      const parsed = providerProfileUpdateSchema.safeParse(input);
      if (!parsed.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid request body');
      return authorized(actor, async client => {
        const row = await findProviderProfile(client, actor.userId);
        const revision = row?.revision ?? 0;
        if (parsed.data.expectedRevision !== revision) throw new ServiceError(409, 'REVISION_CONFLICT', 'Provider profile has changed');
        const { settings, key } = parsed.data;
        const secret = key.action === 'replace' ? sealApiKey(key.value, actor.userId, keyring)
          : key.action === 'delete' ? undefined : storedSecret(row);
        return publicProfile(await saveProviderProfile(client, actor.userId, revision + 1, settings, secret));
      });
    },
    /** Internal call boundary only. Do not serialize, persist or log the returned key. */
    async getForCall(actor: Actor): Promise<{ profile: ProviderProfile; apiKey: string | undefined }> {
      return authorized(actor, async client => {
        const row = await findProviderProfile(client, actor.userId);
        const profile = publicProfile(row);
        try {
          const secret = storedSecret(row);
          return { profile, apiKey: secret ? openApiKey(secret, actor.userId, keyring) : undefined };
        } catch {
          throw new ServiceError(500, 'PROVIDER_SECRET_UNAVAILABLE', 'Provider key is unavailable');
        }
      });
    },
  };
}
