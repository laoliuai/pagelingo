ALTER TABLE assets ADD UNIQUE (owner_id, document_id, id, sha256);
CREATE TABLE parse_runs (
  id text NOT NULL CHECK (id ~ '^p_[a-f0-9]{64}$'),
  owner_id uuid NOT NULL, document_id uuid NOT NULL, source_version_id uuid NOT NULL,
  ir_asset_id uuid NOT NULL, ir_sha256 text NOT NULL,
  status text NOT NULL CHECK (status IN ('complete','partial')),
  coverage text NOT NULL CHECK (coverage IN ('full','partial')),
  warnings jsonb NOT NULL CHECK (jsonb_typeof(warnings) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, document_id, source_version_id, id),
  FOREIGN KEY (owner_id, document_id, source_version_id) REFERENCES source_versions(owner_id, document_id, id),
  FOREIGN KEY (owner_id, document_id, ir_asset_id, ir_sha256) REFERENCES assets(owner_id, document_id, id, sha256)
);
CREATE TABLE translation_runs (
  id uuid NOT NULL, owner_id uuid NOT NULL, document_id uuid NOT NULL, source_version_id uuid NOT NULL,
  parse_id text NOT NULL, translation_asset_id uuid NOT NULL, sha256 text NOT NULL,
  status text NOT NULL CHECK (status IN ('not-required','pending','partial','completed','failed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, document_id, source_version_id, parse_id, id),
  FOREIGN KEY (owner_id, document_id, source_version_id, parse_id) REFERENCES parse_runs(owner_id, document_id, source_version_id, id),
  FOREIGN KEY (owner_id, document_id, translation_asset_id, sha256) REFERENCES assets(owner_id, document_id, id, sha256)
);
CREATE TABLE reader_versions (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, document_id uuid NOT NULL, source_version_id uuid NOT NULL,
  parse_id text NOT NULL, translation_id uuid NOT NULL, package_id uuid NOT NULL,
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  archive_asset_id uuid NOT NULL, index_asset_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, package_id),
  UNIQUE (owner_id, document_id, id),
  UNIQUE (owner_id, document_id, source_version_id, id),
  UNIQUE (owner_id, document_id, source_version_id, parse_id, id),
  FOREIGN KEY (owner_id, document_id, source_version_id, parse_id, translation_id) REFERENCES translation_runs(owner_id, document_id, source_version_id, parse_id, id),
  FOREIGN KEY (owner_id, document_id, archive_asset_id) REFERENCES assets(owner_id, document_id, id),
  FOREIGN KEY (owner_id, document_id, index_asset_id) REFERENCES assets(owner_id, document_id, id)
);
ALTER TABLE documents ADD COLUMN current_reader_version_id uuid;
ALTER TABLE documents ADD CONSTRAINT documents_current_reader_fk
  FOREIGN KEY (owner_id, id, current_source_version_id, current_reader_version_id)
  REFERENCES reader_versions(owner_id, document_id, source_version_id, id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE documents ADD CHECK (current_reader_version_id IS NULL OR current_source_version_id IS NOT NULL);
CREATE TABLE reader_chunks (
  owner_id uuid NOT NULL, document_id uuid NOT NULL, reader_version_id uuid NOT NULL,
  id text NOT NULL CHECK (id ~ '^c_[0-9]{6}$'), data_asset_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reader_version_id, id),
  FOREIGN KEY (owner_id, document_id, reader_version_id) REFERENCES reader_versions(owner_id, document_id, id),
  FOREIGN KEY (owner_id, document_id, data_asset_id) REFERENCES assets(owner_id, document_id, id)
);
CREATE TABLE bundle_files (
  owner_id uuid NOT NULL, document_id uuid NOT NULL, reader_version_id uuid NOT NULL,
  path text NOT NULL, asset_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reader_version_id, path),
  FOREIGN KEY (owner_id, document_id, reader_version_id) REFERENCES reader_versions(owner_id, document_id, id),
  FOREIGN KEY (owner_id, document_id, asset_id) REFERENCES assets(owner_id, document_id, id)
);
CREATE TABLE reading_positions (
  owner_id uuid NOT NULL, document_id uuid NOT NULL, source_version_id uuid NOT NULL,
  parse_id text NOT NULL, reader_version_id uuid NOT NULL, position jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, document_id, reader_version_id),
  FOREIGN KEY (owner_id, document_id, source_version_id, parse_id, reader_version_id) REFERENCES reader_versions(owner_id, document_id, source_version_id, parse_id, id),
  CHECK ((position->>'readerVersionId' = reader_version_id::text AND position->>'sourceVersionId' = source_version_id::text AND position->>'parseId' = parse_id) IS TRUE)
);
CREATE TABLE reading_state (
  owner_id uuid NOT NULL, document_id uuid NOT NULL, revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  source_version_id uuid, parse_id text, reader_version_id uuid, position jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, document_id),
  FOREIGN KEY (owner_id, document_id) REFERENCES documents(owner_id, id),
  FOREIGN KEY (owner_id, document_id, source_version_id, parse_id, reader_version_id) REFERENCES reader_versions(owner_id, document_id, source_version_id, parse_id, id),
  CHECK ((reader_version_id IS NULL AND source_version_id IS NULL AND parse_id IS NULL AND position IS NULL) OR
    (reader_version_id IS NOT NULL AND source_version_id IS NOT NULL AND parse_id IS NOT NULL AND position IS NOT NULL AND
      (position->>'readerVersionId' = reader_version_id::text AND position->>'sourceVersionId' = source_version_id::text AND position->>'parseId' = parse_id) IS TRUE))
);
CREATE TABLE bundle_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL, request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  target_document_id uuid, status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','receiving','validating','completed','failed','cancelled')),
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch BETWEEN 0 AND 9007199254740991), heartbeat_at timestamptz NOT NULL DEFAULT now(),
  staging_key uuid, document_id uuid, reader_version_id uuid, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, idempotency_key),
  FOREIGN KEY (owner_id, target_document_id) REFERENCES documents(owner_id, id),
  FOREIGN KEY (owner_id, document_id, reader_version_id) REFERENCES reader_versions(owner_id, document_id, id),
  CHECK ((status = 'completed' AND document_id IS NOT NULL AND reader_version_id IS NOT NULL) OR
    (status <> 'completed' AND document_id IS NULL AND reader_version_id IS NULL))
);
CREATE UNIQUE INDEX bundle_imports_one_active_owner ON bundle_imports(owner_id) WHERE status IN ('created','receiving','validating');
CREATE INDEX bundle_imports_owner_created ON bundle_imports(owner_id, created_at DESC, id DESC);
CREATE FUNCTION reject_reader_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable reader data'; END; $$;
CREATE TRIGGER immutable_parse_runs BEFORE UPDATE ON parse_runs FOR EACH ROW EXECUTE FUNCTION reject_reader_mutation();
CREATE TRIGGER immutable_translation_runs BEFORE UPDATE ON translation_runs FOR EACH ROW EXECUTE FUNCTION reject_reader_mutation();
CREATE TRIGGER immutable_reader_versions BEFORE UPDATE ON reader_versions FOR EACH ROW EXECUTE FUNCTION reject_reader_mutation();
CREATE TRIGGER immutable_reader_chunks BEFORE UPDATE ON reader_chunks FOR EACH ROW EXECUTE FUNCTION reject_reader_mutation();
CREATE TRIGGER immutable_bundle_files BEFORE UPDATE ON bundle_files FOR EACH ROW EXECUTE FUNCTION reject_reader_mutation();
