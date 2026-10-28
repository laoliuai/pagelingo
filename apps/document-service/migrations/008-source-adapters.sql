-- Stop old writers before migration; source identities never change document kind or job identity.
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='documents'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%kind%' AND pg_get_constraintdef(oid) LIKE '%current_reader_version_id%'
  LOOP EXECUTE format('ALTER TABLE documents DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE documents ADD CHECK (
  (kind='pdf' AND original_filename IS NOT NULL AND current_web_reader_version_id IS NULL AND latest_web_source_version_id IS NULL AND requested_web_job_id IS NULL)
  OR (kind IN ('article','x-post','repository') AND current_reader_version_id IS NULL)
  OR (kind='paper' AND current_web_reader_version_id IS NULL AND latest_web_source_version_id IS NULL)
);
CREATE OR REPLACE FUNCTION assert_web_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='web_jobs' THEN
    PERFORM 1 FROM documents WHERE owner_id=NEW.owner_id AND id=NEW.document_id
      AND (kind IN ('article','x-post','repository') OR (kind='paper' AND NEW.kind='fetch-link')) FOR SHARE;
  ELSE
    PERFORM 1 FROM documents WHERE owner_id=NEW.owner_id AND id=NEW.document_id AND kind IN ('article','x-post','repository') FOR SHARE;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source/job document kind mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TABLE document_source_identities (
  owner_id uuid NOT NULL, document_id uuid NOT NULL, provider text NOT NULL CHECK(provider IN ('github','arxiv')), provider_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,provider,provider_id), UNIQUE(owner_id,document_id),
  FOREIGN KEY(owner_id,document_id) REFERENCES documents(owner_id,id),
  CHECK((provider='github' AND provider_id ~ '^[1-9][0-9]*$') OR (provider='arxiv' AND length(provider_id) BETWEEN 8 AND 100))
);
CREATE TABLE document_source_aliases (
  owner_id uuid NOT NULL, document_id uuid NOT NULL, canonical_document_id uuid NOT NULL, resolution text NOT NULL CHECK(resolution IN ('alias','conflict')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,document_id), CHECK(document_id<>canonical_document_id),
  FOREIGN KEY(owner_id,document_id) REFERENCES documents(owner_id,id), FOREIGN KEY(owner_id,canonical_document_id) REFERENCES documents(owner_id,id)
);
CREATE FUNCTION assert_source_alias() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF EXISTS(SELECT 1 FROM document_source_aliases WHERE owner_id=NEW.owner_id AND document_id=NEW.canonical_document_id)
    OR EXISTS(SELECT 1 FROM document_source_identities WHERE owner_id=NEW.owner_id AND document_id=NEW.document_id)
    OR EXISTS(SELECT 1 FROM document_source_aliases WHERE owner_id=NEW.owner_id AND canonical_document_id=NEW.document_id)
    OR NOT EXISTS(SELECT 1 FROM document_source_identities WHERE owner_id=NEW.owner_id AND document_id=NEW.canonical_document_id)
  THEN RAISE EXCEPTION 'Invalid source alias graph' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_alias_graph BEFORE INSERT ON document_source_aliases FOR EACH ROW EXECUTE FUNCTION assert_source_alias();
CREATE TABLE source_requests (
  owner_id uuid NOT NULL, document_id uuid NOT NULL, auth_version integer NOT NULL, idempotency_key uuid NOT NULL, job_id uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), reference jsonb NOT NULL CHECK(jsonb_typeof(reference)='object'),
  translation_intent text NOT NULL CHECK(translation_intent IN ('auto','none')), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,document_id,auth_version,idempotency_key), UNIQUE(owner_id,document_id,auth_version,job_id), UNIQUE(owner_id,job_id),
  FOREIGN KEY(owner_id,document_id,auth_version,job_id) REFERENCES web_jobs(owner_id,document_id,auth_version,id)
);
CREATE TABLE source_acquisitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL, document_id uuid NOT NULL, auth_version integer NOT NULL, job_id uuid NOT NULL,
  role text NOT NULL CHECK(length(role) BETWEEN 1 AND 100), asset_id uuid NOT NULL, sha256 text NOT NULL, bytes bigint NOT NULL,
  media_type text NOT NULL, filename text NOT NULL CHECK(length(filename) BETWEEN 1 AND 255), url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(owner_id,job_id,role), UNIQUE(owner_id,document_id,id),
  FOREIGN KEY(owner_id,document_id,auth_version,job_id) REFERENCES source_requests(owner_id,document_id,auth_version,job_id),
  FOREIGN KEY(owner_id,document_id,asset_id,sha256,bytes) REFERENCES assets(owner_id,document_id,id,sha256,bytes)
);
CREATE TABLE external_request_limits (
  provider text PRIMARY KEY CHECK(provider='arxiv'), next_request_at timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO external_request_limits(provider) VALUES('arxiv');
CREATE TABLE github_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL, document_id uuid NOT NULL, job_id uuid NOT NULL,
  repository_id text NOT NULL CHECK(repository_id ~ '^[1-9][0-9]*$'), repository_owner text NOT NULL, repository_name text NOT NULL,
  description text, original_url text NOT NULL, canonical_url text NOT NULL, commit_sha text CHECK(commit_sha ~ '^[a-f0-9]{40}$'),
  readme_path text, blob_sha text CHECK(blob_sha ~ '^[a-f0-9]{40}$'), raw_asset_id uuid, html_asset_id uuid, source_version_id uuid,
  content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'), captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(owner_id,document_id,id), UNIQUE(owner_id,document_id,content_digest),
  FOREIGN KEY(owner_id,document_id,job_id) REFERENCES web_jobs(owner_id,document_id,id),
  FOREIGN KEY(owner_id,document_id,raw_asset_id) REFERENCES assets(owner_id,document_id,id),
  FOREIGN KEY(owner_id,document_id,html_asset_id) REFERENCES assets(owner_id,document_id,id),
  FOREIGN KEY(owner_id,document_id,source_version_id) REFERENCES web_sources(owner_id,document_id,source_version_id),
  CHECK((raw_asset_id IS NULL AND readme_path IS NULL AND blob_sha IS NULL AND html_asset_id IS NULL) OR (raw_asset_id IS NOT NULL AND readme_path IS NOT NULL AND blob_sha IS NOT NULL))
);
CREATE TABLE arxiv_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL, document_id uuid NOT NULL, job_id uuid NOT NULL,
  base_id text NOT NULL, version integer NOT NULL CHECK(version>0), title text NOT NULL, authors jsonb NOT NULL CHECK(jsonb_typeof(authors)='array'), summary text NOT NULL,
  published_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  pdf_asset_id uuid, pdf_sha256 text, pdf_bytes bigint, source_version_id uuid,
  UNIQUE(owner_id,document_id,id), UNIQUE(owner_id,document_id,base_id,version), UNIQUE(owner_id,document_id,id,source_version_id),
  FOREIGN KEY(owner_id,document_id,job_id) REFERENCES web_jobs(owner_id,document_id,id),
  FOREIGN KEY(owner_id,document_id,pdf_asset_id,pdf_sha256,pdf_bytes) REFERENCES assets(owner_id,document_id,id,sha256,bytes),
  FOREIGN KEY(owner_id,document_id,source_version_id) REFERENCES source_versions(owner_id,document_id,id),
  CHECK((pdf_asset_id IS NULL AND pdf_sha256 IS NULL AND pdf_bytes IS NULL AND source_version_id IS NULL) OR
    (pdf_asset_id IS NOT NULL AND pdf_sha256 IS NOT NULL AND pdf_bytes IS NOT NULL AND source_version_id IS NOT NULL))
);
CREATE FUNCTION protect_arxiv_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (to_jsonb(NEW)-ARRAY['pdf_asset_id','pdf_sha256','pdf_bytes','source_version_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['pdf_asset_id','pdf_sha256','pdf_bytes','source_version_id'])
    OR (OLD.pdf_asset_id IS NOT NULL AND NEW IS DISTINCT FROM OLD)
  THEN RAISE EXCEPTION 'Immutable arxiv version: SOURCE_VERSION_CONFLICT'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_arxiv_version BEFORE UPDATE ON arxiv_versions FOR EACH ROW EXECUTE FUNCTION protect_arxiv_version();
CREATE TABLE paper_reader_bindings (
  owner_id uuid NOT NULL, document_id uuid NOT NULL, arxiv_version_id uuid NOT NULL, source_version_id uuid NOT NULL, reader_version_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,document_id,arxiv_version_id,reader_version_id),
  FOREIGN KEY(owner_id,document_id,arxiv_version_id,source_version_id) REFERENCES arxiv_versions(owner_id,document_id,id,source_version_id),
  FOREIGN KEY(owner_id,document_id,source_version_id,reader_version_id) REFERENCES reader_versions(owner_id,document_id,source_version_id,id)
);
ALTER TABLE documents ADD COLUMN current_github_revision_id uuid;
ALTER TABLE documents ADD COLUMN current_arxiv_revision_id uuid;
ALTER TABLE documents ADD FOREIGN KEY(owner_id,id,current_github_revision_id) REFERENCES github_versions(owner_id,document_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE documents ADD FOREIGN KEY(owner_id,id,current_arxiv_revision_id) REFERENCES arxiv_versions(owner_id,document_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE documents ADD CHECK((current_github_revision_id IS NULL OR kind='repository') AND (current_arxiv_revision_id IS NULL OR kind='paper'));
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['document_source_identities','document_source_aliases','source_requests','source_acquisitions','github_versions','paper_reader_bindings'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_%I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION reject_reader_mutation()',name,name);
  END LOOP;
END $$;
ALTER TABLE retired_document_identities DROP CONSTRAINT retired_document_identities_identity_kind_check;
ALTER TABLE retired_document_identities ADD CHECK(identity_kind IN ('url','source-sha256','source-provider'));
-- Receipt grouping contains UUIDs only and outlives minimum alias content cleanup.
ALTER TABLE document_purges ADD COLUMN group_document_id uuid;
ALTER TABLE documents ADD COLUMN source_trash_parent_id uuid;
-- Every revision material is acquired on this document; PDF source bytes must match its revision.
ALTER TABLE source_acquisitions ADD UNIQUE(owner_id,document_id,asset_id);
ALTER TABLE github_versions ADD FOREIGN KEY(owner_id,document_id,raw_asset_id) REFERENCES source_acquisitions(owner_id,document_id,asset_id);
ALTER TABLE github_versions ADD FOREIGN KEY(owner_id,document_id,html_asset_id) REFERENCES source_acquisitions(owner_id,document_id,asset_id);
ALTER TABLE arxiv_versions ADD FOREIGN KEY(owner_id,document_id,pdf_asset_id) REFERENCES source_acquisitions(owner_id,document_id,asset_id);
ALTER TABLE source_versions ADD UNIQUE(owner_id,document_id,id,sha256,bytes);
ALTER TABLE source_requests ADD COLUMN original_url text NOT NULL;
CREATE FUNCTION assert_source_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM web_jobs j JOIN documents d ON(d.owner_id,d.id)=(j.owner_id,j.document_id)
    WHERE (j.owner_id,j.document_id,j.auth_version,j.id)=(NEW.owner_id,NEW.document_id,NEW.auth_version,NEW.job_id)
    AND j.kind='fetch-link' AND j.url=NEW.reference->>'url'
    AND ((d.kind='repository' AND NEW.reference->>'provider'='github') OR (d.kind='paper' AND NEW.reference->>'provider'='arxiv')))
  THEN RAISE EXCEPTION 'Invalid source request job identity' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_request_identity BEFORE INSERT ON source_requests FOR EACH ROW EXECUTE FUNCTION assert_source_request();

CREATE OR REPLACE FUNCTION assert_source_document() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  PERFORM 1 FROM documents WHERE owner_id=NEW.owner_id AND id=NEW.document_id AND kind IN ('pdf','article','x-post','repository','paper') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source document kind mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
ALTER TABLE arxiv_versions ADD FOREIGN KEY(owner_id,document_id,source_version_id,pdf_sha256,pdf_bytes) REFERENCES source_versions(owner_id,document_id,id,sha256,bytes);
-- A reused immutable revision still has an explicit result for each requesting job.
ALTER TABLE web_jobs ADD COLUMN source_github_revision_id uuid;
ALTER TABLE web_jobs ADD COLUMN source_arxiv_revision_id uuid;
ALTER TABLE web_jobs ADD FOREIGN KEY(owner_id,document_id,source_github_revision_id) REFERENCES github_versions(owner_id,document_id,id);
ALTER TABLE web_jobs ADD FOREIGN KEY(owner_id,document_id,source_arxiv_revision_id) REFERENCES arxiv_versions(owner_id,document_id,id);
ALTER TABLE web_jobs ADD CHECK((source_github_revision_id IS NULL AND source_arxiv_revision_id IS NULL) OR
  (kind='fetch-link' AND (source_github_revision_id IS NULL OR source_arxiv_revision_id IS NULL)));

-- Paper PDF capability retains the original PDF graph and adds explicit version associations.
CREATE OR REPLACE FUNCTION assert_pdf_document() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  PERFORM 1 FROM documents d JOIN source_versions s ON(s.owner_id,s.document_id)=(d.owner_id,d.id)
    JOIN assets a ON(a.owner_id,a.document_id,a.id)=(s.owner_id,s.document_id,s.asset_id)
    WHERE d.owner_id=NEW.owner_id AND d.id=NEW.document_id AND d.kind IN ('pdf','paper')
      AND s.id=NEW.source_version_id AND a.media_type='application/pdf' FOR SHARE OF d;
  IF NOT FOUND THEN RAISE EXCEPTION 'PDF document/source kind mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
ALTER TABLE paper_reader_bindings ADD UNIQUE(owner_id,document_id,arxiv_version_id,source_version_id,reader_version_id);
ALTER TABLE documents ADD FOREIGN KEY(owner_id,id,current_arxiv_revision_id,current_source_version_id)
  REFERENCES arxiv_versions(owner_id,document_id,id,source_version_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE documents ADD FOREIGN KEY(owner_id,id,current_arxiv_revision_id,current_source_version_id,current_reader_version_id)
  REFERENCES paper_reader_bindings(owner_id,document_id,arxiv_version_id,source_version_id,reader_version_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE documents ADD CHECK(kind<>'paper' OR current_source_version_id IS NULL OR (current_arxiv_revision_id IS NOT NULL AND original_filename IS NOT NULL));
ALTER TABLE bundle_imports ADD COLUMN target_source_version_id uuid;
ALTER TABLE bundle_imports ADD COLUMN target_arxiv_version_id uuid;
ALTER TABLE bundle_imports ADD CHECK(target_source_version_id IS NULL OR target_document_id IS NOT NULL);
ALTER TABLE bundle_imports ADD CHECK(target_arxiv_version_id IS NULL OR target_source_version_id IS NOT NULL);
ALTER TABLE bundle_imports ADD FOREIGN KEY(owner_id,target_document_id,target_source_version_id) REFERENCES source_versions(owner_id,document_id,id);
ALTER TABLE bundle_imports ADD FOREIGN KEY(owner_id,target_document_id,target_arxiv_version_id,target_source_version_id) REFERENCES arxiv_versions(owner_id,document_id,id,source_version_id);
CREATE OR REPLACE FUNCTION protect_bundle_admitted_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (NEW.admitted_request,NEW.target_source_version_id,NEW.target_arxiv_version_id) IS DISTINCT FROM (OLD.admitted_request,OLD.target_source_version_id,OLD.target_arxiv_version_id)
    THEN RAISE EXCEPTION 'Immutable bundle admission'; END IF;
  RETURN NEW;
END $$;
