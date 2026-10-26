CREATE TABLE provider_profiles (
  owner_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  base_url text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  temperature double precision NOT NULL DEFAULT 0.1,
  response_format text NOT NULL DEFAULT 'json-object' CHECK (response_format IN ('json-object', 'json-schema', 'text')),
  max_output_tokens integer NOT NULL DEFAULT 4096 CHECK (max_output_tokens > 0),
  max_tokens_parameter text NOT NULL DEFAULT 'max_tokens' CHECK (max_tokens_parameter IN ('max_tokens', 'max_completion_tokens')),
  thinking_mode text NOT NULL DEFAULT 'auto' CHECK (thinking_mode IN ('auto', 'default', 'disabled')),
  stream boolean NOT NULL DEFAULT false,
  max_input_tokens integer NOT NULL DEFAULT 6000 CHECK (max_input_tokens > 0),
  context_window_tokens integer NOT NULL DEFAULT 32768 CHECK (context_window_tokens > 0),
  key_id text,
  key_nonce bytea,
  key_ciphertext bytea,
  key_tag bytea,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((key_id IS NULL AND key_nonce IS NULL AND key_ciphertext IS NULL AND key_tag IS NULL)
    OR (key_id IS NOT NULL AND key_nonce IS NOT NULL AND key_ciphertext IS NOT NULL AND key_tag IS NOT NULL
      AND octet_length(key_nonce) = 12 AND octet_length(key_tag) = 16))
);
