-- Stop old writers before migration. Export jobs never require provider revisions.
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='web_jobs'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%kind%' AND pg_get_constraintdef(oid) NOT LIKE '%source_github_revision_id%'
  LOOP EXECUTE format('ALTER TABLE web_jobs DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE web_jobs ADD CHECK(kind IN ('fetch-link','translate','export-web'));
ALTER TABLE web_jobs ADD CHECK (
  (kind='fetch-link' AND request_id IS NULL AND url IS NOT NULL AND source_version_id IS NULL AND parse_id IS NULL AND profile_revision IS NULL AND glossary_revision IS NULL AND source_language IS NULL AND selection_block_ids IS NULL)
  OR (kind='translate' AND url IS NULL AND source_version_id IS NOT NULL AND parse_id IS NOT NULL AND profile_revision IS NOT NULL AND glossary_revision IS NOT NULL)
  OR (kind='export-web' AND url IS NULL AND source_version_id IS NOT NULL AND parse_id IS NOT NULL AND profile_revision IS NULL AND glossary_revision IS NULL AND request_id IS NULL AND source_language IS NULL AND selection_block_ids IS NULL)
);
CREATE TABLE web_exports (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, document_id uuid NOT NULL, auth_version integer NOT NULL,
  document_epoch bigint NOT NULL, idempotency_key uuid NOT NULL, job_id uuid NOT NULL,
  reader_version_id uuid NOT NULL, source_version_id uuid NOT NULL, parse_id text NOT NULL,
  package_id uuid NOT NULL UNIQUE, title text NOT NULL, renderer_version text NOT NULL, renderer_sha256 text NOT NULL,
  asset_id uuid, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(owner_id,id), UNIQUE(owner_id,document_id,auth_version,idempotency_key), UNIQUE(owner_id,job_id),
  FOREIGN KEY(owner_id,document_id) REFERENCES documents(owner_id,id),
  FOREIGN KEY(owner_id,document_id,job_id) REFERENCES web_jobs(owner_id,document_id,id),
  FOREIGN KEY(owner_id,document_id,reader_version_id) REFERENCES web_reader_versions(owner_id,document_id,id),
  FOREIGN KEY(owner_id,document_id,source_version_id,parse_id) REFERENCES web_parse_runs(owner_id,document_id,source_version_id,id),
  FOREIGN KEY(owner_id,document_id,asset_id) REFERENCES assets(owner_id,document_id,id),
  CHECK((asset_id IS NULL) OR expires_at IS NOT NULL)
);
CREATE FUNCTION protect_web_export_input() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (NEW.id,NEW.owner_id,NEW.document_id,NEW.auth_version,NEW.document_epoch,NEW.idempotency_key,NEW.job_id,NEW.reader_version_id,NEW.source_version_id,NEW.parse_id,NEW.package_id,NEW.title,NEW.renderer_version,NEW.renderer_sha256,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.document_id,OLD.auth_version,OLD.document_epoch,OLD.idempotency_key,OLD.job_id,OLD.reader_version_id,OLD.source_version_id,OLD.parse_id,OLD.package_id,OLD.title,OLD.renderer_version,OLD.renderer_sha256,OLD.created_at)
  THEN RAISE EXCEPTION 'Immutable Web export input'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_web_export_input BEFORE UPDATE ON web_exports FOR EACH ROW EXECUTE FUNCTION protect_web_export_input();
CREATE INDEX web_export_expiry ON web_exports(expires_at,id) WHERE asset_id IS NOT NULL;
-- Transient registered work is independent of permanent document purge receipts.
CREATE TABLE registered_object_work (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), document_id uuid NOT NULL,
  job_id uuid NOT NULL, job_epoch bigint NOT NULL, writer_owner text NOT NULL,
  slot_id integer NOT NULL, slot_epoch bigint NOT NULL, writer_until timestamptz NOT NULL,
  writer_stopped boolean NOT NULL DEFAULT false,
  lease_owner uuid, lease_until timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0, error_code text, UNIQUE(owner_id,id)
);
ALTER TABLE object_deletion_queue DROP CONSTRAINT object_deletion_queue_pkey;
ALTER TABLE object_deletion_queue ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE object_deletion_queue ADD COLUMN work_id uuid;
ALTER TABLE object_deletion_queue ADD COLUMN available_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE object_deletion_queue ADD FOREIGN KEY(owner_id,work_id) REFERENCES registered_object_work(owner_id,id);
ALTER TABLE object_deletion_queue ADD CHECK(num_nonnulls(task_id,work_id)=1);
CREATE UNIQUE INDEX object_queue_purge_key ON object_deletion_queue(owner_id,task_id,storage_kind,object_key) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX object_queue_work_key ON object_deletion_queue(owner_id,work_id,storage_kind,object_key) WHERE work_id IS NOT NULL;
ALTER TABLE object_deletion_queue DROP CONSTRAINT object_deletion_queue_storage_kind_check;
ALTER TABLE object_deletion_queue ADD CHECK(storage_kind IN ('objects','bundle-staging','web-staging','export-staging'));
ALTER TABLE document_maintenance_cursor ADD COLUMN last_export_expiry_at timestamptz;
ALTER TABLE document_maintenance_cursor ADD COLUMN last_export_id uuid;
ALTER TABLE document_maintenance_cursor ADD COLUMN last_work_due_at timestamptz;
ALTER TABLE document_maintenance_cursor ADD COLUMN last_work_id uuid;
CREATE INDEX registered_object_work_due ON registered_object_work(next_attempt_at,id);

-- Existing in-progress purges have no exports yet; preserve their phase after prepending the new FK step.
UPDATE document_purges SET cursor=(cursor::integer+1)::text WHERE status<>'completed' AND cursor IS NOT NULL;
ALTER TABLE web_exports ADD FOREIGN KEY(owner_id,document_id,source_version_id,parse_id,reader_version_id)
  REFERENCES web_reader_versions(owner_id,document_id,source_version_id,parse_id,id);
CREATE FUNCTION protect_registered_writer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (NEW.id,NEW.owner_id,NEW.document_id,NEW.job_id,NEW.job_epoch,NEW.writer_owner,NEW.slot_id,NEW.slot_epoch)
    IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.document_id,OLD.job_id,OLD.job_epoch,OLD.writer_owner,OLD.slot_id,OLD.slot_epoch)
    OR (OLD.writer_stopped AND NOT NEW.writer_stopped)
  THEN RAISE EXCEPTION 'Immutable registered writer'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_registered_writer BEFORE UPDATE ON registered_object_work FOR EACH ROW EXECUTE FUNCTION protect_registered_writer();
