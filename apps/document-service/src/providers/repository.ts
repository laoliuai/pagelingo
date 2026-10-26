import type { ProviderProfile, ProviderSettings } from '@pagelingo/document-contracts';
import type { PoolClient } from 'pg';
import type { SealedSecret } from './secrets.js';

export interface ProviderProfileRow {
  owner_id: string;
  revision: number;
  base_url: string;
  model: string;
  temperature: number;
  response_format: ProviderProfile['responseFormat'];
  max_output_tokens: number;
  max_tokens_parameter: ProviderProfile['maxTokensParameter'];
  thinking_mode: ProviderProfile['thinkingMode'];
  stream: boolean;
  max_input_tokens: number;
  context_window_tokens: number;
  key_id: string | null;
  key_nonce: Buffer | null;
  key_ciphertext: Buffer | null;
  key_tag: Buffer | null;
}

/** Call only after locking and revalidating this owner with assertActorCurrent. */
export async function findProviderProfile(client: PoolClient, ownerId: string): Promise<ProviderProfileRow | undefined> {
  return (await client.query<ProviderProfileRow>('SELECT * FROM provider_profiles WHERE owner_id = $1', [ownerId])).rows[0];
}

export function storedSecret(row: ProviderProfileRow | undefined): SealedSecret | undefined {
  if (!row || row.key_id === null) return undefined;
  if (row.key_nonce === null || row.key_ciphertext === null || row.key_tag === null) throw new Error('Invalid provider secret');
  return { keyId: row.key_id, nonce: row.key_nonce, ciphertext: row.key_ciphertext, tag: row.key_tag };
}

/** The owner's user lock serializes both the absent-row insert and subsequent updates. */
export async function saveProviderProfile(
  client: PoolClient, ownerId: string, revision: number, settings: ProviderSettings, secret: SealedSecret | undefined,
): Promise<ProviderProfileRow> {
  return (await client.query<ProviderProfileRow>(`INSERT INTO provider_profiles (
    owner_id, revision, base_url, model, temperature, response_format, max_output_tokens,
    max_tokens_parameter, thinking_mode, stream, max_input_tokens, context_window_tokens,
    key_id, key_nonce, key_ciphertext, key_tag
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
  ON CONFLICT (owner_id) DO UPDATE SET revision = EXCLUDED.revision, base_url = EXCLUDED.base_url,
    model = EXCLUDED.model, temperature = EXCLUDED.temperature, response_format = EXCLUDED.response_format,
    max_output_tokens = EXCLUDED.max_output_tokens, max_tokens_parameter = EXCLUDED.max_tokens_parameter,
    thinking_mode = EXCLUDED.thinking_mode, stream = EXCLUDED.stream, max_input_tokens = EXCLUDED.max_input_tokens,
    context_window_tokens = EXCLUDED.context_window_tokens, key_id = EXCLUDED.key_id, key_nonce = EXCLUDED.key_nonce,
    key_ciphertext = EXCLUDED.key_ciphertext, key_tag = EXCLUDED.key_tag, updated_at = now()
  RETURNING *`, [
    ownerId, revision, settings.baseUrl, settings.model, settings.temperature, settings.responseFormat,
    settings.maxOutputTokens, settings.maxTokensParameter, settings.thinkingMode, settings.stream,
    settings.maxInputTokens, settings.contextWindowTokens, secret?.keyId ?? null, secret?.nonce ?? null,
    secret?.ciphertext ?? null, secret?.tag ?? null,
  ])).rows[0]!;
}
