-- S3 is additive: the original PDF tables and current_reader FK remain intact.
ALTER TABLE documents DROP CONSTRAINT documents_kind_check;
ALTER TABLE documents ALTER COLUMN original_filename DROP NOT NULL;
ALTER TABLE documents ADD CHECK (kind IN ('pdf','article','x-post','repository','paper'));
ALTER TABLE documents ADD COLUMN source_url text;
ALTER TABLE documents ADD COLUMN current_web_reader_version_id uuid;
ALTER TABLE documents ADD COLUMN latest_web_source_version_id uuid;
ALTER TABLE documents ADD COLUMN requested_web_job_id uuid;
ALTER TABLE documents ADD CHECK (
  (kind = 'pdf' AND original_filename IS NOT NULL AND current_web_reader_version_id IS NULL
    AND latest_web_source_version_id IS NULL AND requested_web_job_id IS NULL)
  OR (kind IN ('article','x-post') AND current_reader_version_id IS NULL)
  OR (kind IN ('repository','paper') AND current_reader_version_id IS NULL
    AND current_web_reader_version_id IS NULL AND current_source_version_id IS NULL
    AND latest_web_source_version_id IS NULL AND requested_web_job_id IS NULL)
);
ALTER TABLE documents ADD CHECK (current_web_reader_version_id IS NULL OR current_source_version_id IS NOT NULL);
CREATE TABLE site_metadata (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  site_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid()
);
INSERT INTO site_metadata DEFAULT VALUES;
CREATE TRIGGER immutable_site_metadata BEFORE UPDATE ON site_metadata FOR EACH ROW EXECUTE FUNCTION reject_reader_mutation();
CREATE TRIGGER immutable_assets BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION reject_reader_mutation();
CREATE TRIGGER immutable_source_versions BEFORE UPDATE ON source_versions FOR EACH ROW EXECUTE FUNCTION reject_reader_mutation();

CREATE TABLE web_sources (
  owner_id uuid NOT NULL, document_id uuid NOT NULL, source_version_id uuid NOT NULL,
  url text NOT NULL, scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object'),
  content_fingerprint text NOT NULL CHECK (content_fingerprint ~ '^[a-f0-9]{64}$'),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, document_id, source_version_id),
  FOREIGN KEY (owner_id,document_id,source_version_id) REFERENCES source_versions(owner_id,document_id,id)
);
CREATE INDEX web_sources_fingerprint ON web_sources(owner_id,url,content_fingerprint);
CREATE FUNCTION assert_web_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM documents WHERE owner_id=NEW.owner_id AND id=NEW.document_id AND kind IN ('article','x-post') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Web source requires article or x-post document' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER web_sources_kind BEFORE INSERT ON web_sources FOR EACH ROW EXECUTE FUNCTION assert_web_document();
-- Document kind is an identity: changing it would invalidate historical artifacts.
CREATE FUNCTION reject_document_kind_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN RAISE EXCEPTION 'Immutable document kind' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER immutable_document_kind BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION reject_document_kind_change();
CREATE TABLE web_source_files (
  owner_id uuid NOT NULL, document_id uuid NOT NULL, source_version_id uuid NOT NULL,
  id text NOT NULL, path text NOT NULL, role text NOT NULL CHECK (role IN ('html','image','css','translation','preview')),
  asset_id uuid NOT NULL,
  PRIMARY KEY (owner_id,document_id,source_version_id,id),
  UNIQUE (owner_id,document_id,source_version_id,path),
  FOREIGN KEY (owner_id,document_id,source_version_id) REFERENCES web_sources(owner_id,document_id,source_version_id),
  FOREIGN KEY (owner_id,document_id,asset_id) REFERENCES assets(owner_id,document_id,id)
);
CREATE TABLE web_parse_runs (
  id text NOT NULL CHECK (id ~ '^p_[a-f0-9]{64}$'),
  owner_id uuid NOT NULL, document_id uuid NOT NULL, source_version_id uuid NOT NULL,
  ir_asset_id uuid NOT NULL, ir_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id,id),
  UNIQUE (owner_id,document_id,source_version_id,id),
  FOREIGN KEY (owner_id,document_id,source_version_id) REFERENCES web_sources(owner_id,document_id,source_version_id),
  FOREIGN KEY (owner_id,document_id,ir_asset_id,ir_sha256) REFERENCES assets(owner_id,document_id,id,sha256)
);
CREATE TABLE web_provider_revisions (
  owner_id uuid NOT NULL REFERENCES users(id), revision integer NOT NULL CHECK (revision >= 0),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (owner_id,revision)
);
CREATE TABLE glossary_revisions (
  owner_id uuid NOT NULL REFERENCES users(id), revision integer NOT NULL CHECK (revision >= 0),
  entries jsonb NOT NULL CHECK (jsonb_typeof(entries) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (owner_id,revision)
);
CREATE TABLE save_preferences (
  owner_id uuid PRIMARY KEY REFERENCES users(id), revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  auto_translate boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE web_jobs (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), document_id uuid NOT NULL,
  auth_version integer NOT NULL CHECK (auth_version >= 0),
  kind text NOT NULL CHECK (kind IN ('fetch-link','translate')),
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'), url text,
  source_version_id uuid, parse_id text, profile_revision integer, glossary_revision integer,
  source_language text, selection_block_ids text[], request_id uuid,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','paused-config','partial','completed','failed','cancelled')),
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch BETWEEN 0 AND 9007199254740991),
  lease_owner text, lease_until timestamptz, slot_id integer, slot_epoch bigint,
  next_request_at timestamptz, reader_version_id uuid,
  completed_units integer NOT NULL DEFAULT 0 CHECK (completed_units >= 0),
  total_units integer NOT NULL DEFAULT 0 CHECK (total_units >= completed_units),
  error_code text, warnings jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(warnings) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id), UNIQUE (owner_id,document_id,id),
  UNIQUE (owner_id,document_id,source_version_id,parse_id,id),
  UNIQUE (owner_id,document_id,auth_version,input_sha256),
  UNIQUE (owner_id,document_id,auth_version,request_id),
  FOREIGN KEY (owner_id,document_id) REFERENCES documents(owner_id,id),
  FOREIGN KEY (owner_id,document_id,source_version_id,parse_id) REFERENCES web_parse_runs(owner_id,document_id,source_version_id,id),
  FOREIGN KEY (owner_id,profile_revision) REFERENCES web_provider_revisions(owner_id,revision),
  FOREIGN KEY (owner_id,glossary_revision) REFERENCES glossary_revisions(owner_id,revision),
  CHECK ((kind='fetch-link' AND request_id IS NULL AND url IS NOT NULL AND source_version_id IS NULL AND parse_id IS NULL AND profile_revision IS NULL AND glossary_revision IS NULL AND source_language IS NULL AND selection_block_ids IS NULL)
    OR (kind='translate' AND url IS NULL AND source_version_id IS NOT NULL AND parse_id IS NOT NULL AND profile_revision IS NOT NULL AND glossary_revision IS NOT NULL)),
  CHECK (source_language IS NULL OR (length(source_language) BETWEEN 2 AND 63 AND source_language ~ '^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$' AND lower(split_part(source_language,'-',1)) NOT IN ('und','mul','zxx'))),
  CHECK (selection_block_ids IS NULL OR (cardinality(selection_block_ids) BETWEEN 1 AND 20000 AND array_position(selection_block_ids,NULL) IS NULL)),
  CHECK ((status='running' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL AND slot_id IS NOT NULL AND slot_epoch IS NOT NULL)
    OR (status<>'running' AND lease_owner IS NULL AND lease_until IS NULL AND slot_id IS NULL AND slot_epoch IS NULL))
);
CREATE UNIQUE INDEX web_jobs_one_running_owner ON web_jobs(owner_id) WHERE status='running';
CREATE INDEX web_jobs_queue ON web_jobs(status,next_request_at,created_at);
CREATE TRIGGER web_jobs_kind BEFORE INSERT ON web_jobs FOR EACH ROW EXECUTE FUNCTION assert_web_document();
CREATE FUNCTION protect_web_job_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.owner_id,NEW.document_id,NEW.auth_version,NEW.kind,NEW.input_sha256,NEW.url,NEW.source_version_id,NEW.parse_id,NEW.profile_revision,NEW.glossary_revision,NEW.source_language,NEW.selection_block_ids,NEW.request_id,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.document_id,OLD.auth_version,OLD.kind,OLD.input_sha256,OLD.url,OLD.source_version_id,OLD.parse_id,OLD.profile_revision,OLD.glossary_revision,OLD.source_language,OLD.selection_block_ids,OLD.request_id,OLD.created_at)
  THEN RAISE EXCEPTION 'Immutable web job input'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER immutable_web_job_input BEFORE UPDATE ON web_jobs FOR EACH ROW EXECUTE FUNCTION protect_web_job_input();
CREATE TABLE web_worker_slots (
  id integer PRIMARY KEY CHECK (id IN (1,2)), epoch bigint NOT NULL DEFAULT 0 CHECK (epoch BETWEEN 0 AND 9007199254740991),
  owner_id uuid, job_id uuid, lease_owner text, lease_until timestamptz,
  FOREIGN KEY (owner_id,job_id) REFERENCES web_jobs(owner_id,id),
  CHECK ((owner_id IS NULL AND job_id IS NULL AND lease_owner IS NULL AND lease_until IS NULL)
    OR (owner_id IS NOT NULL AND job_id IS NOT NULL AND lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
INSERT INTO web_worker_slots(id) VALUES (1),(2);
ALTER TABLE web_jobs ADD FOREIGN KEY (slot_id) REFERENCES web_worker_slots(id);
CREATE TABLE web_job_checkpoints (
  owner_id uuid NOT NULL, job_id uuid NOT NULL, epoch bigint NOT NULL,
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'), checkpoint jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (owner_id,job_id),
  FOREIGN KEY (owner_id,job_id) REFERENCES web_jobs(owner_id,id)
);
CREATE TABLE web_owner_cache (
  owner_id uuid NOT NULL REFERENCES users(id), cache_key text NOT NULL,
  entry jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (owner_id,cache_key)
);
CREATE TABLE web_translation_runs (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, document_id uuid NOT NULL, source_version_id uuid NOT NULL,
  parse_id text NOT NULL, job_id uuid, generation_kind text NOT NULL DEFAULT 'model' CHECK (generation_kind IN ('model','import')), translation_asset_id uuid NOT NULL, sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,document_id,source_version_id,parse_id,id),
  FOREIGN KEY (owner_id,document_id,source_version_id,parse_id,job_id) REFERENCES web_jobs(owner_id,document_id,source_version_id,parse_id,id),
  FOREIGN KEY (owner_id,document_id,translation_asset_id,sha256) REFERENCES assets(owner_id,document_id,id,sha256)
);
CREATE TABLE web_reader_versions (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, document_id uuid NOT NULL, source_version_id uuid NOT NULL,
  parse_id text NOT NULL, translation_id uuid, index_asset_id uuid NOT NULL,
  translation_status text NOT NULL CHECK (translation_status IN ('not-required','pending','partial','completed','failed','cancelled')),
  warnings jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(warnings) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,document_id,id), UNIQUE (owner_id,document_id,source_version_id,id),
  UNIQUE (owner_id,document_id,source_version_id,parse_id,id),
  FOREIGN KEY (owner_id,document_id,source_version_id,parse_id) REFERENCES web_parse_runs(owner_id,document_id,source_version_id,id),
  FOREIGN KEY (owner_id,document_id,source_version_id,parse_id,translation_id) REFERENCES web_translation_runs(owner_id,document_id,source_version_id,parse_id,id),
  FOREIGN KEY (owner_id,document_id,index_asset_id) REFERENCES assets(owner_id,document_id,id),
  CHECK (translation_id IS NOT NULL OR translation_status IN ('not-required','pending'))
);
CREATE TABLE web_reader_chunks (
  owner_id uuid NOT NULL, document_id uuid NOT NULL, reader_version_id uuid NOT NULL,
  id text NOT NULL CHECK (id ~ '^c_[0-9]{6}$'), data_asset_id uuid NOT NULL,
  PRIMARY KEY (reader_version_id,id),
  FOREIGN KEY (owner_id,document_id,reader_version_id) REFERENCES web_reader_versions(owner_id,document_id,id),
  FOREIGN KEY (owner_id,document_id,data_asset_id) REFERENCES assets(owner_id,document_id,id)
);
CREATE TABLE web_reader_assets (
  owner_id uuid NOT NULL, document_id uuid NOT NULL, reader_version_id uuid NOT NULL,
  local_id text NOT NULL, asset_id uuid NOT NULL,
  PRIMARY KEY (reader_version_id,local_id),
  FOREIGN KEY (owner_id,document_id,reader_version_id) REFERENCES web_reader_versions(owner_id,document_id,id),
  FOREIGN KEY (owner_id,document_id,asset_id) REFERENCES assets(owner_id,document_id,id)
);
ALTER TABLE documents ADD FOREIGN KEY (owner_id,id,latest_web_source_version_id) REFERENCES web_sources(owner_id,document_id,source_version_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE documents ADD FOREIGN KEY (owner_id,id,current_source_version_id,current_web_reader_version_id) REFERENCES web_reader_versions(owner_id,document_id,source_version_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE documents ADD FOREIGN KEY (owner_id,id,requested_web_job_id) REFERENCES web_jobs(owner_id,document_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE web_jobs ADD FOREIGN KEY (owner_id,document_id,source_version_id,parse_id,reader_version_id) REFERENCES web_reader_versions(owner_id,document_id,source_version_id,parse_id,id);
CREATE TABLE web_reading_positions (
  owner_id uuid NOT NULL, document_id uuid NOT NULL, source_version_id uuid NOT NULL,
  parse_id text NOT NULL, reader_version_id uuid NOT NULL, position jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (owner_id,document_id,reader_version_id),
  FOREIGN KEY (owner_id,document_id,source_version_id,parse_id,reader_version_id) REFERENCES web_reader_versions(owner_id,document_id,source_version_id,parse_id,id),
  CHECK ((position->>'readerVersionId'=reader_version_id::text AND position->>'sourceVersionId'=source_version_id::text AND position->>'parseId'=parse_id) IS TRUE)
);
CREATE TABLE web_reading_state (
  owner_id uuid NOT NULL, document_id uuid NOT NULL, revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  reader_version_id uuid, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (owner_id,document_id),
  FOREIGN KEY (owner_id,document_id) REFERENCES documents(owner_id,id),
  FOREIGN KEY (owner_id,document_id,reader_version_id) REFERENCES web_reading_positions(owner_id,document_id,reader_version_id)
);
CREATE TABLE device_pairings (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), auth_version integer NOT NULL CHECK (auth_version >= 0),
  session_id uuid NOT NULL, code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id)
);
CREATE TABLE devices (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), auth_version integer NOT NULL CHECK (auth_version >= 0),
  pairing_session_id uuid NOT NULL, token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  name text NOT NULL, extension_id text NOT NULL, extension_version text NOT NULL,
  scopes text[] NOT NULL CHECK (scopes <@ ARRAY['captures:write','captures:read','links:write','preferences:read']::text[]),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, revoked_at timestamptz,
  UNIQUE (owner_id,id)
);
CREATE INDEX devices_pairing_session ON devices(owner_id,pairing_session_id);
CREATE TABLE web_captures (
  id uuid PRIMARY KEY, capture_id uuid NOT NULL, owner_id uuid NOT NULL REFERENCES users(id), auth_version integer NOT NULL CHECK (auth_version >= 0),
  device_id uuid, session_id uuid, fetch_job_id uuid, idempotency_key text NOT NULL, request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='object'), target_document_id uuid,
  translation_intent text NOT NULL CHECK (translation_intent IN ('none','auto','translate')),
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','receiving','validating','completed','failed','cancelled')),
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch BETWEEN 0 AND 9007199254740991), staging_key uuid NOT NULL,
  document_id uuid, source_version_id uuid, reader_version_id uuid, job_id uuid,
  save_status text CHECK (save_status IN ('original-saved','partial-resources')), error_code text,
  warnings jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(warnings)='array'),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id), UNIQUE (owner_id,capture_id), UNIQUE (owner_id,idempotency_key),
  FOREIGN KEY (owner_id,device_id) REFERENCES devices(owner_id,id),
  FOREIGN KEY (owner_id,target_document_id) REFERENCES documents(owner_id,id),
  FOREIGN KEY (owner_id,document_id,source_version_id,reader_version_id) REFERENCES web_reader_versions(owner_id,document_id,source_version_id,id),
  FOREIGN KEY (owner_id,document_id,job_id) REFERENCES web_jobs(owner_id,document_id,id),
  CHECK (idempotency_key=capture_id::text),
  CHECK (num_nonnulls(device_id,session_id,fetch_job_id)=1),
  CHECK (fetch_job_id IS NULL OR (target_document_id IS NOT NULL AND id<>fetch_job_id AND capture_id<>fetch_job_id AND id<>capture_id)),
  UNIQUE (owner_id,fetch_job_id),
  UNIQUE (owner_id,target_document_id,auth_version,fetch_job_id,id),
  CHECK ((status='completed' AND document_id IS NOT NULL AND source_version_id IS NOT NULL AND reader_version_id IS NOT NULL AND save_status IS NOT NULL)
    OR (status<>'completed' AND document_id IS NULL AND source_version_id IS NULL AND reader_version_id IS NULL AND job_id IS NULL AND save_status IS NULL))
);
CREATE TABLE web_capture_files (
  owner_id uuid NOT NULL, capture_id uuid NOT NULL, id text NOT NULL, descriptor jsonb NOT NULL,
  staging_key uuid, upload_token uuid, upload_until timestamptz,
  received_sha256 text CHECK (received_sha256 ~ '^[a-f0-9]{64}$'), received_bytes bigint CHECK (received_bytes >= 0), received_at timestamptz,
  PRIMARY KEY (owner_id,capture_id,id),
  FOREIGN KEY (owner_id,capture_id) REFERENCES web_captures(owner_id,id),
  CHECK ((received_sha256 IS NULL AND received_bytes IS NULL AND received_at IS NULL)
    OR ((received_sha256=descriptor->>'sha256' AND received_bytes=(descriptor->>'bytes')::bigint AND received_at IS NOT NULL) IS TRUE)),
  CHECK ((descriptor->>'id'=id) IS TRUE)
);
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['web_sources','web_source_files','web_parse_runs','web_provider_revisions','glossary_revisions','web_translation_runs','web_reader_versions','web_reader_chunks','web_reader_assets'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_%I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION reject_reader_mutation()',table_name,table_name);
  END LOOP;
END; $$;
CREATE FUNCTION protect_web_capture_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.owner_id,NEW.capture_id,NEW.auth_version,NEW.device_id,NEW.session_id,NEW.fetch_job_id,NEW.idempotency_key,NEW.request_hash,NEW.manifest,NEW.target_document_id,NEW.translation_intent,NEW.staging_key,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.capture_id,OLD.auth_version,OLD.device_id,OLD.session_id,OLD.fetch_job_id,OLD.idempotency_key,OLD.request_hash,OLD.manifest,OLD.target_document_id,OLD.translation_intent,OLD.staging_key,OLD.created_at)
  THEN RAISE EXCEPTION 'Immutable capture input'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER immutable_web_capture_input BEFORE UPDATE ON web_captures FOR EACH ROW EXECUTE FUNCTION protect_web_capture_input();
CREATE FUNCTION protect_capture_file_descriptor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.owner_id,NEW.capture_id,NEW.id,NEW.descriptor) IS DISTINCT FROM (OLD.owner_id,OLD.capture_id,OLD.id,OLD.descriptor)
  THEN RAISE EXCEPTION 'Immutable capture file descriptor'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER immutable_capture_file_descriptor BEFORE UPDATE ON web_capture_files FOR EACH ROW EXECUTE FUNCTION protect_capture_file_descriptor();
ALTER TABLE documents ADD CHECK (kind NOT IN ('article','x-post') OR
  ((current_source_version_id IS NULL) = (current_web_reader_version_id IS NULL)));
CREATE FUNCTION assert_source_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM documents WHERE owner_id=NEW.owner_id AND id=NEW.document_id AND kind IN ('pdf','article','x-post') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Link-only documents cannot have source artifacts' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER source_versions_kind BEFORE INSERT ON source_versions FOR EACH ROW EXECUTE FUNCTION assert_source_document();
CREATE FUNCTION assert_pdf_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM documents WHERE owner_id=NEW.owner_id AND id=NEW.document_id AND kind='pdf' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PDF parses require PDF documents' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER parse_runs_kind BEFORE INSERT ON parse_runs FOR EACH ROW EXECUTE FUNCTION assert_pdf_document();
CREATE FUNCTION valid_web_selection(ids text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT count(*)=count(DISTINCT id) AND bool_and(id ~ '^b_[a-f0-9]{32}$') FROM unnest(ids) AS id;
$$;
ALTER TABLE web_jobs ADD CHECK (selection_block_ids IS NULL OR valid_web_selection(selection_block_ids));
-- The full source/parse FK intentionally skips fetch jobs; their result still needs owner/document fencing.
ALTER TABLE web_jobs ADD FOREIGN KEY (owner_id,document_id,reader_version_id) REFERENCES web_reader_versions(owner_id,document_id,id);
-- A capture's associated translation job must translate the saved Reader's exact identity.
-- Those job/Reader columns are immutable; existing FKs retain both referenced rows.
CREATE FUNCTION assert_capture_job_reader_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM web_jobs j
    JOIN web_reader_versions r ON (r.owner_id,r.document_id,r.id) =
      (NEW.owner_id,NEW.document_id,NEW.reader_version_id)
    WHERE (j.owner_id,j.document_id,j.id) = (NEW.owner_id,NEW.document_id,NEW.job_id)
      AND j.kind = 'translate'
      AND (j.source_version_id,j.parse_id) IS DISTINCT FROM (r.source_version_id,r.parse_id)
  ) THEN
    RAISE EXCEPTION 'Capture translation job must match Reader source and parse'
      USING ERRCODE='23503', CONSTRAINT='web_capture_job_reader_identity';
  END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER web_capture_job_reader_identity
  AFTER INSERT OR UPDATE ON web_captures
  FOR EACH ROW WHEN (NEW.job_id IS NOT NULL)
  EXECUTE FUNCTION assert_capture_job_reader_identity();

ALTER TABLE web_translation_runs ADD CHECK ((generation_kind='import' AND job_id IS NULL) OR (generation_kind='model' AND job_id IS NOT NULL));

ALTER TABLE web_translation_runs ADD FOREIGN KEY (owner_id,document_id,source_version_id,parse_id) REFERENCES web_parse_runs(owner_id,document_id,source_version_id,id);

-- Stable transport retry ledger; callers cannot overwrite a lost acknowledgement.
ALTER TABLE web_jobs ADD UNIQUE (owner_id,document_id,auth_version,id);
CREATE TABLE web_link_requests (
  owner_id uuid NOT NULL REFERENCES users(id), idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'), request jsonb NOT NULL,
  document_id uuid NOT NULL, job_id uuid, auth_version integer NOT NULL, reason text,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (owner_id,idempotency_key),
  FOREIGN KEY (owner_id,document_id) REFERENCES documents(owner_id,id),
  FOREIGN KEY (owner_id,document_id,auth_version,job_id) REFERENCES web_jobs(owner_id,document_id,auth_version,id)
);
CREATE TRIGGER immutable_web_link_request BEFORE UPDATE ON web_link_requests FOR EACH ROW EXECUTE FUNCTION reject_reader_mutation();

-- Job-origin captures require the actual immutable lease identity, not a synthetic session.
ALTER TABLE web_captures ADD FOREIGN KEY (owner_id,target_document_id,auth_version,fetch_job_id)
  REFERENCES web_jobs(owner_id,document_id,auth_version,id);
CREATE FUNCTION assert_fetch_capture_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.fetch_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM web_jobs WHERE (owner_id,document_id,auth_version,id,kind,url)=
      (NEW.owner_id,NEW.target_document_id,NEW.auth_version,NEW.fetch_job_id,'fetch-link',NEW.manifest->'source'->>'url')
  ) THEN RAISE EXCEPTION 'Fetch capture origin mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER web_capture_fetch_origin BEFORE INSERT ON web_captures FOR EACH ROW EXECUTE FUNCTION assert_fetch_capture_origin();
CREATE TABLE web_fetch_acquisitions (
  owner_id uuid NOT NULL, document_id uuid NOT NULL, auth_version integer NOT NULL, job_id uuid NOT NULL,
  ingestion_id uuid NOT NULL, raw_asset_id uuid NOT NULL, raw_sha256 text NOT NULL, raw_bytes bigint NOT NULL,
  final_url text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id,job_id), UNIQUE (owner_id,ingestion_id),
  FOREIGN KEY (owner_id,document_id,auth_version,job_id,ingestion_id) REFERENCES web_captures(owner_id,target_document_id,auth_version,fetch_job_id,id),
  FOREIGN KEY (owner_id,document_id,raw_asset_id,raw_sha256,raw_bytes) REFERENCES assets(owner_id,document_id,id,sha256,bytes)
);
CREATE TRIGGER immutable_web_fetch_acquisition BEFORE UPDATE ON web_fetch_acquisitions FOR EACH ROW EXECUTE FUNCTION reject_reader_mutation();

-- Durable bounded publication and terminal finalizer idempotence (S3 worker).
ALTER TABLE web_jobs ADD COLUMN publication_milestone integer NOT NULL DEFAULT -1 CHECK (publication_milestone BETWEEN -1 AND 4);
ALTER TABLE web_jobs ADD COLUMN finalized_epoch bigint CHECK (finalized_epoch BETWEEN 0 AND 9007199254740991 AND finalized_epoch<=epoch);
