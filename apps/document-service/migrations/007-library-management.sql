-- Deploy with old API/worker writers stopped; immutable source/Reader rows remain untouched.
ALTER TABLE documents ADD COLUMN origin text NOT NULL DEFAULT 'web'
  CHECK (origin IN ('upload','web','x','zhihu','wechat','github','arxiv'));
ALTER TABLE documents ADD COLUMN title_origin text NOT NULL DEFAULT 'legacy'
  CHECK (title_origin IN ('user','url','filename','source','legacy'));
ALTER TABLE documents ADD COLUMN lifecycle_epoch bigint NOT NULL DEFAULT 1 CHECK (lifecycle_epoch BETWEEN 1 AND 9007199254740991);
ALTER TABLE documents ADD COLUMN deleted_at timestamptz;
ALTER TABLE documents ADD COLUMN purge_after timestamptz;
ALTER TABLE documents ADD CHECK ((deleted_at IS NULL AND purge_after IS NULL) OR (deleted_at IS NOT NULL AND purge_after >= deleted_at));
UPDATE documents SET origin = CASE WHEN kind='pdf' THEN 'upload'
  WHEN source_url ~* '^https?://([^/@]+\.)?(x\.com|twitter\.com)([/:]|$)' THEN 'x'
  WHEN source_url ~* '^https?://([^/@]+\.)?zhihu\.com([/:]|$)' THEN 'zhihu'
  WHEN source_url ~* '^https?://([^/@]+\.)?weixin\.qq\.com([/:]|$)' THEN 'wechat'
  WHEN source_url ~* '^https?://([^/@]+\.)?github\.com([/:]|$)' THEN 'github'
  WHEN source_url ~* '^https?://([^/@]+\.)?arxiv\.org([/:]|$)' THEN 'arxiv' ELSE 'web' END;
CREATE INDEX documents_active_owner_idx ON documents(owner_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX documents_purge_after_idx ON documents(purge_after,id) WHERE deleted_at IS NOT NULL;

CREATE TABLE collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80), name_key text NOT NULL,
  UNIQUE(owner_id,id), UNIQUE(owner_id,name_key)
);
CREATE TABLE tags (LIKE collections INCLUDING ALL);
ALTER TABLE tags ADD FOREIGN KEY (owner_id) REFERENCES users(id);
CREATE TABLE document_organization (
  owner_id uuid NOT NULL, document_id uuid NOT NULL, revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  collection_id uuid, note text NOT NULL DEFAULT '' CHECK (length(note)<=10000),
  reading_status text NOT NULL DEFAULT 'unread' CHECK (reading_status IN ('unread','reading','read')),
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,document_id),
  FOREIGN KEY(owner_id,document_id) REFERENCES documents(owner_id,id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id,collection_id) REFERENCES collections(owner_id,id)
);
INSERT INTO document_organization(owner_id,document_id) SELECT owner_id,id FROM documents;
CREATE TABLE document_tags (
  owner_id uuid NOT NULL, document_id uuid NOT NULL, tag_id uuid NOT NULL,
  PRIMARY KEY(owner_id,document_id,tag_id),
  FOREIGN KEY(owner_id,document_id) REFERENCES document_organization(owner_id,document_id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id,tag_id) REFERENCES tags(owner_id,id)
);
CREATE INDEX document_tags_filter_idx ON document_tags(owner_id,tag_id,document_id);
CREATE TABLE document_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  from_document_id uuid NOT NULL, to_document_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('discovered-from','related')),
  CHECK(from_document_id<>to_document_id), UNIQUE(owner_id,from_document_id,to_document_id,kind),
  FOREIGN KEY(owner_id,from_document_id) REFERENCES documents(owner_id,id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id,to_document_id) REFERENCES documents(owner_id,id) ON DELETE CASCADE
);
CREATE INDEX document_relations_to_idx ON document_relations(owner_id,to_document_id,id);
CREATE TABLE document_search_metadata (
  owner_id uuid NOT NULL, document_id uuid NOT NULL, source_version_id uuid, parse_id text,
  source_sha256 text CHECK(source_sha256 ~ '^[a-f0-9]{64}$'), ir_sha256 text CHECK(ir_sha256 ~ '^[a-f0-9]{64}$'),
  authors text NOT NULL DEFAULT '' CHECK(length(authors)<=8000), source_url text NOT NULL DEFAULT '' CHECK(length(source_url)<=4096),
  domain text NOT NULL DEFAULT '' CHECK(length(domain)<=253), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,document_id),
  FOREIGN KEY(owner_id,document_id) REFERENCES documents(owner_id,id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id,document_id,source_version_id) REFERENCES source_versions(owner_id,document_id,id),
  CHECK((source_version_id IS NULL AND source_sha256 IS NULL AND parse_id IS NULL AND ir_sha256 IS NULL) OR (source_version_id IS NOT NULL AND source_sha256 IS NOT NULL)),
  CHECK((parse_id IS NULL)=(ir_sha256 IS NULL))
);
-- Epoch input columns are initialized from the authoritative document, never from a client.
ALTER TABLE web_jobs ADD COLUMN document_epoch bigint NOT NULL DEFAULT 1 CHECK(document_epoch BETWEEN 1 AND 9007199254740991);
ALTER TABLE bundle_imports ADD COLUMN document_epoch bigint CHECK(document_epoch BETWEEN 1 AND 9007199254740991);
ALTER TABLE web_captures ADD COLUMN document_epoch bigint CHECK(document_epoch BETWEEN 1 AND 9007199254740991);
ALTER TABLE ingestions ADD COLUMN document_epoch bigint CHECK(document_epoch BETWEEN 1 AND 9007199254740991);
UPDATE bundle_imports SET document_epoch=1 WHERE target_document_id IS NOT NULL;
UPDATE web_captures SET document_epoch=1 WHERE target_document_id IS NOT NULL;
ALTER TABLE web_jobs DROP CONSTRAINT web_jobs_owner_id_document_id_auth_version_input_sha256_key;
ALTER TABLE web_jobs ADD UNIQUE(owner_id,document_id,document_epoch,auth_version,input_sha256);
-- request_id uniqueness deliberately remains independent: accepted replays are read-only.
CREATE FUNCTION set_management_document_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.document_epoch IS DISTINCT FROM OLD.document_epoch THEN RAISE EXCEPTION 'Immutable document epoch'; END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='web_jobs' THEN target=NEW.document_id; ELSE target=NEW.target_document_id; END IF;
  IF target IS NOT NULL THEN
    SELECT lifecycle_epoch INTO STRICT NEW.document_epoch FROM documents WHERE owner_id=NEW.owner_id AND id=target;
  ELSE NEW.document_epoch=NULL; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER management_job_epoch BEFORE INSERT OR UPDATE ON web_jobs FOR EACH ROW EXECUTE FUNCTION set_management_document_epoch();
CREATE TRIGGER management_import_epoch BEFORE INSERT OR UPDATE ON bundle_imports FOR EACH ROW EXECUTE FUNCTION set_management_document_epoch();
CREATE TRIGGER management_capture_epoch BEFORE INSERT OR UPDATE ON web_captures FOR EACH ROW EXECUTE FUNCTION set_management_document_epoch();
ALTER TABLE web_captures ADD COLUMN save_hints jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(save_hints)='object');
CREATE FUNCTION protect_capture_save_hints() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.save_hints IS DISTINCT FROM OLD.save_hints THEN RAISE EXCEPTION 'Immutable capture save hints'; END IF; RETURN NEW;
END; $$;
CREATE TRIGGER immutable_capture_save_hints BEFORE UPDATE ON web_captures FOR EACH ROW EXECUTE FUNCTION protect_capture_save_hints();

-- Non-content infrastructure used by lifecycle workers in subsequent tasks.
CREATE TABLE retired_document_identities (
  owner_id uuid NOT NULL REFERENCES users(id), identity_kind text NOT NULL CHECK(identity_kind IN ('url','source-sha256')),
  identity_digest text NOT NULL CHECK(identity_digest ~ '^[a-f0-9]{64}$'), retired_at timestamptz NOT NULL,
  document_id uuid NOT NULL, PRIMARY KEY(owner_id,identity_kind,identity_digest,retired_at)
);
CREATE TABLE document_tombstones (
  owner_id uuid NOT NULL REFERENCES users(id), document_id uuid NOT NULL, lifecycle_epoch bigint NOT NULL CHECK(lifecycle_epoch BETWEEN 1 AND 9007199254740991),
  purged_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,document_id)
);
CREATE TABLE retired_operations (
  owner_id uuid NOT NULL REFERENCES users(id), operation_kind text NOT NULL, key_digest text NOT NULL CHECK(key_digest ~ '^[a-f0-9]{64}$'),
  document_id uuid NOT NULL, accepted_at timestamptz NOT NULL, retired_at timestamptz NOT NULL,
  PRIMARY KEY(owner_id,operation_kind,key_digest)
);
CREATE TABLE document_purges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id), document_id uuid NOT NULL,
  lifecycle_epoch bigint NOT NULL CHECK(lifecycle_epoch BETWEEN 1 AND 9007199254740991),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed')),
  cursor text, attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner uuid, lease_until timestamptz, error_code text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE(owner_id,document_id), UNIQUE(owner_id,id)
);
CREATE INDEX document_purge_claim_idx ON document_purges(next_attempt_at,id) WHERE status<>'completed';
CREATE TABLE object_deletion_queue (
  owner_id uuid NOT NULL, task_id uuid NOT NULL, object_key text NOT NULL,
  PRIMARY KEY(owner_id,task_id,object_key), FOREIGN KEY(owner_id,task_id) REFERENCES document_purges(owner_id,id) ON DELETE CASCADE
);
CREATE TABLE web_cache_document_refs (
  owner_id uuid NOT NULL, document_id uuid NOT NULL, document_epoch bigint NOT NULL CHECK(document_epoch BETWEEN 1 AND 9007199254740991), cache_key text NOT NULL,
  PRIMARY KEY(owner_id,document_id,document_epoch,cache_key),
  FOREIGN KEY(owner_id,document_id) REFERENCES documents(owner_id,id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id,cache_key) REFERENCES web_owner_cache(owner_id,cache_key) ON DELETE CASCADE
);
CREATE TABLE document_cache_cleanup_state (
  owner_id uuid PRIMARY KEY REFERENCES users(id), legacy_cache_cleared_at timestamptz
);
