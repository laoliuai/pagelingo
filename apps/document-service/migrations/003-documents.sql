CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'pdf' CHECK (kind = 'pdf'),
  title text NOT NULL,
  original_filename text NOT NULL,
  current_source_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, id)
);
CREATE INDEX documents_owner_created_idx ON documents(owner_id, created_at DESC, id DESC);
CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  document_id uuid NOT NULL,
  object_key text NOT NULL UNIQUE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  bytes bigint NOT NULL CHECK (bytes >= 0),
  media_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, document_id, id),
  UNIQUE (owner_id, document_id, id, sha256, bytes),
  FOREIGN KEY (owner_id, document_id) REFERENCES documents(owner_id, id) ON DELETE CASCADE
);
CREATE TABLE source_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  document_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  bytes bigint NOT NULL CHECK (bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, document_id, id),
  FOREIGN KEY (owner_id, document_id) REFERENCES documents(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, document_id, asset_id, sha256, bytes) REFERENCES assets(owner_id, document_id, id, sha256, bytes)
);
ALTER TABLE documents ADD CONSTRAINT documents_current_source_fk
  FOREIGN KEY (owner_id, id, current_source_version_id) REFERENCES source_versions(owner_id, document_id, id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE ingestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  document_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete', 'failed')),
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, idempotency_key),
  FOREIGN KEY (owner_id, document_id) REFERENCES documents(owner_id, id),
  CHECK (status <> 'complete' OR document_id IS NOT NULL)
);
