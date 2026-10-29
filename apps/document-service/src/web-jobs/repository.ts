import { assertDocumentActive, lockDocument } from '../document-lifecycle/guards.js';
import type { PoolClient } from 'pg';
import { providerSettingsSchema, sourceLanguageSchema, webJobSelectionSchema, type ProviderSettings, type WebJobStatus } from '@pagelingo/document-contracts';
import { CheckpointConflictError, type CacheEntry, type TranslationCheckpoint } from '@pagelingo/translation-core';

interface JobIdentity { jobId: string; ownerId: string; authVersion: number; epoch: number; leaseOwner: string; leaseUntil: Date; slotId: number; slotEpoch: number; documentId: string; documentEpoch: number }
export type JobLease = JobIdentity & (
  { kind: 'fetch-link'; url: string } |
  { kind: 'export-web'; sourceVersionId: string; parseId: string; exportId: string } |
  { kind: 'translate'; sourceVersionId: string; parseId: string; profileRevision: number; glossaryRevision: number }
);
export type WebJobInput = { id: string; ownerId: string; authVersion: number; documentId: string; inputSha256: string } & (
  { kind: 'fetch-link'; url: string } |
  { kind: 'translate'; sourceVersionId: string; parseId: string; profileRevision: number; glossaryRevision: number; sourceLanguage: string | null; selectionBlockIds: string[] | null; requestId?: string }
);
export interface WebJobRow {
  id: string; owner_id: string; document_id: string; document_epoch: string; auth_version: number; kind: 'fetch-link' | 'translate' | 'export-web';
  input_sha256: string; url: string | null; source_version_id: string | null; parse_id: string | null;
  request_id: string | null;
  profile_revision: number | null; glossary_revision: number | null; source_language: string | null; selection_block_ids: string[] | null;
  status: WebJobStatus; epoch: string; lease_owner: string | null; lease_until: Date | null; slot_id: number | null; slot_epoch: string | null;
  publication_milestone: number; finalized_epoch: string | null;
  next_request_at: Date | null; reader_version_id: string | null; completed_units: number; total_units: number;
  error_code: string | null; warnings: string[]; created_at: Date; updated_at: Date;
}
interface SlotRow { id: number; epoch: string; owner_id: string | null; job_id: string | null; lease_owner: string | null; lease_until: Date | null }
const conflict = () => new CheckpointConflictError('Web job lease is no longer current');
export async function insertProviderRevision(client: PoolClient, ownerId: string, revision: number, settings: ProviderSettings): Promise<void> {
  const validated = providerSettingsSchema.parse(settings);
  await client.query(`INSERT INTO web_provider_revisions (owner_id,revision,settings) VALUES ($1,$2,$3)
    ON CONFLICT (owner_id,revision) DO NOTHING`, [ownerId,revision,JSON.stringify(validated)]);
  const stored = (await client.query<{ same: boolean }>('SELECT settings=$3::jsonb AS same FROM web_provider_revisions WHERE owner_id=$1 AND revision=$2', [ownerId,revision,JSON.stringify(validated)])).rows[0];
  if (!stored?.same) throw new Error('Immutable provider revision mismatch');
}
export async function insertWebJob(client: PoolClient, input: WebJobInput): Promise<WebJobRow> {
  await lockDocument(client, input.ownerId, input.documentId);
  await assertDocumentActive(client, input.ownerId, input.documentId);
  const t = input.kind === 'translate' ? input : null;
  if (t?.sourceLanguage !== null && t?.sourceLanguage !== undefined) sourceLanguageSchema.parse(t.sourceLanguage);
  if (t?.selectionBlockIds !== null && t?.selectionBlockIds !== undefined) webJobSelectionSchema.parse(t.selectionBlockIds);
  return (await client.query<WebJobRow>(`INSERT INTO web_jobs
    (id,owner_id,document_id,auth_version,kind,input_sha256,url,source_version_id,parse_id,profile_revision,glossary_revision,source_language,selection_block_ids,request_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
  [input.id,input.ownerId,input.documentId,input.authVersion,input.kind,input.inputSha256,input.kind === 'fetch-link' ? input.url : null,t?.sourceVersionId ?? null,t?.parseId ?? null,t?.profileRevision ?? null,t?.glossaryRevision ?? null,t?.sourceLanguage ?? null,t?.selectionBlockIds ?? null,t?.requestId ?? null])).rows[0]!;
}
export async function findWebJob(client: PoolClient, ownerId: string, jobId: string): Promise<WebJobRow | undefined> {
  return (await client.query<WebJobRow>('SELECT * FROM web_jobs WHERE owner_id=$1 AND id=$2', [ownerId,jobId])).rows[0];
}
/** Must run in a transaction. Lock order is user -> document -> slot -> job.
 * No lock is taken on the old owner when reusing an expired global slot. */
export async function startWebJobLease(client: PoolClient, input: { ownerId: string; jobId: string; slotId: number; leaseOwner: string }): Promise<JobLease | null> {
  const user = (await client.query<{ active: boolean; auth_version: number }>('SELECT active,auth_version FROM users WHERE id=$1 FOR UPDATE', [input.ownerId])).rows[0];
  if (!user?.active) return null;
  const candidate = await findWebJob(client, input.ownerId, input.jobId);
  if (!candidate) return null;
  await lockDocument(client, input.ownerId, candidate.document_id);
  try { await assertDocumentActive(client, input.ownerId, candidate.document_id, Number(candidate.document_epoch)); } catch { return null; }
  const slot = (await client.query<SlotRow>('SELECT * FROM web_worker_slots WHERE id=$1 FOR UPDATE SKIP LOCKED', [input.slotId])).rows[0];
  if (!slot) return null;
  const job = (await client.query<WebJobRow>('SELECT * FROM web_jobs WHERE owner_id=$1 AND id=$2 FOR UPDATE SKIP LOCKED', [input.ownerId,input.jobId])).rows[0];
  if (!job || job.auth_version !== user.auth_version || job.status !== 'queued') return null;
  const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  if ((slot.lease_until && slot.lease_until > now) || (job.next_request_at && job.next_request_at > now)) return null;
  if ((await client.query("SELECT 1 FROM web_jobs WHERE owner_id=$1 AND status='running'", [input.ownerId])).rowCount) return null;
  if (job.kind === 'translate' && !(await client.query('SELECT 1 FROM provider_profiles WHERE owner_id=$1 AND revision=$2', [input.ownerId,job.profile_revision])).rowCount) return null;
  const until = new Date(now.getTime() + 30_000);
  const epoch = Number(slot.epoch) + 1;
  await client.query('UPDATE web_worker_slots SET epoch=$2,owner_id=$3,job_id=$4,lease_owner=$5,lease_until=$6 WHERE id=$1', [input.slotId,epoch,input.ownerId,input.jobId,input.leaseOwner,until]);
  const updated = (await client.query<WebJobRow>(`UPDATE web_jobs SET status='running',epoch=epoch+1,lease_owner=$3,lease_until=$4,slot_id=$5,slot_epoch=$6,updated_at=clock_timestamp()
    WHERE owner_id=$1 AND id=$2 RETURNING *`, [input.ownerId,input.jobId,input.leaseOwner,until,input.slotId,epoch])).rows[0]!;
  const identity: JobIdentity = { jobId: updated.id, ownerId: updated.owner_id, authVersion: updated.auth_version, epoch: Number(updated.epoch), leaseOwner: input.leaseOwner, leaseUntil: until, slotId: input.slotId, slotEpoch: epoch, documentId: updated.document_id, documentEpoch: Number(updated.document_epoch) };
  if (updated.kind === 'export-web') {
    const exported = (await client.query<{ id: string }>('SELECT id FROM web_exports WHERE owner_id=$1 AND job_id=$2 AND source_version_id=$3 AND parse_id=$4', [updated.owner_id, updated.id, updated.source_version_id, updated.parse_id])).rows[0];
    if (!exported) throw conflict();
    return { ...identity, kind: 'export-web', sourceVersionId: updated.source_version_id!, parseId: updated.parse_id!, exportId: exported.id };
  }
  return updated.kind === 'fetch-link' ? { ...identity, kind: 'fetch-link', url: updated.url! } : {
    ...identity, kind: 'translate', sourceVersionId: updated.source_version_id!, parseId: updated.parse_id!, profileRevision: updated.profile_revision!, glossaryRevision: updated.glossary_revision!,
  };
}
/** Transaction required. Retains the authorization row locks until commit; an unlocked check is unsafe.
 * The persisted expiry is authoritative (heartbeats may extend leaseUntil after dispatch). */
export async function assertJobLeaseCurrent(client: PoolClient, lease: JobLease): Promise<void> {
  const user = (await client.query<{ active: boolean; auth_version: number }>('SELECT active,auth_version FROM users WHERE id=$1 FOR UPDATE', [lease.ownerId])).rows[0];
  if (!user?.active || user.auth_version !== lease.authVersion) throw conflict();
  await lockDocument(client, lease.ownerId, lease.documentId);
  try { await assertDocumentActive(client, lease.ownerId, lease.documentId, lease.documentEpoch); } catch { throw conflict(); }
  const slot = (await client.query<SlotRow>('SELECT * FROM web_worker_slots WHERE id=$1 FOR UPDATE', [lease.slotId])).rows[0];
  const job = (await client.query<WebJobRow>('SELECT * FROM web_jobs WHERE owner_id=$1 AND id=$2 FOR UPDATE', [lease.ownerId,lease.jobId])).rows[0];
  const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  if (!slot || !job || slot.owner_id !== lease.ownerId || slot.job_id !== lease.jobId || Number(slot.epoch) !== lease.slotEpoch || slot.lease_owner !== lease.leaseOwner || !slot.lease_until || slot.lease_until <= now ||
    job.status !== 'running' || job.auth_version !== lease.authVersion || Number(job.epoch) !== lease.epoch || job.lease_owner !== lease.leaseOwner || !job.lease_until || job.lease_until <= now || job.slot_id !== lease.slotId || Number(job.slot_epoch) !== lease.slotEpoch || job.document_id !== lease.documentId || job.kind !== lease.kind || Number(job.document_epoch) !== lease.documentEpoch) throw conflict();
  if (lease.kind === 'fetch-link') { if (job.url !== lease.url) throw conflict(); }
  else if (lease.kind === 'export-web') {
    if (job.source_version_id !== lease.sourceVersionId || job.parse_id !== lease.parseId || !(await client.query('SELECT 1 FROM web_exports WHERE owner_id=$1 AND id=$2 AND job_id=$3 AND document_epoch=$4', [lease.ownerId, lease.exportId, lease.jobId, lease.documentEpoch])).rowCount) throw conflict();
  } else {
    if (job.source_version_id !== lease.sourceVersionId || job.parse_id !== lease.parseId || job.profile_revision !== lease.profileRevision || job.glossary_revision !== lease.glossaryRevision) throw conflict();
    if (!(await client.query('SELECT 1 FROM provider_profiles WHERE owner_id=$1 AND revision=$2', [lease.ownerId,lease.profileRevision])).rowCount) throw conflict();
  }
}
/** Conditional release deliberately cannot erase a slot already reassigned to another owner. */
export async function releaseWebJobSlot(client: PoolClient, lease: JobLease): Promise<boolean> {
  await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [lease.ownerId]);
  return (await client.query(`UPDATE web_worker_slots SET owner_id=NULL,job_id=NULL,lease_owner=NULL,lease_until=NULL
    WHERE id=$1 AND epoch=$2 AND owner_id=$3 AND job_id=$4 AND lease_owner=$5`, [lease.slotId,lease.slotEpoch,lease.ownerId,lease.jobId,lease.leaseOwner])).rowCount === 1;
}
export async function loadJobCheckpoint(client: PoolClient, lease: JobLease): Promise<TranslationCheckpoint | undefined> {
  await assertJobLeaseCurrent(client,lease);
  return (await client.query<{ checkpoint: TranslationCheckpoint }>(`SELECT c.checkpoint FROM web_job_checkpoints c JOIN web_jobs j ON (j.owner_id,j.id,j.input_sha256)=(c.owner_id,c.job_id,c.input_sha256)
    WHERE c.owner_id=$1 AND c.job_id=$2`, [lease.ownerId,lease.jobId])).rows[0]?.checkpoint;
}
export async function saveJobCheckpoint(client: PoolClient, lease: JobLease, checkpoint: TranslationCheckpoint, cacheWrites: CacheEntry[]): Promise<void> {
  await assertJobLeaseCurrent(client,lease);
  await client.query(`INSERT INTO web_job_checkpoints (owner_id,job_id,epoch,input_sha256,checkpoint)
    SELECT owner_id,id,epoch,input_sha256,$3 FROM web_jobs WHERE owner_id=$1 AND id=$2
    ON CONFLICT (owner_id,job_id) DO UPDATE SET epoch=EXCLUDED.epoch,input_sha256=EXCLUDED.input_sha256,checkpoint=EXCLUDED.checkpoint,updated_at=clock_timestamp()`, [lease.ownerId,lease.jobId,JSON.stringify(checkpoint)]);
  await putOwnerCache(client,lease.ownerId,cacheWrites);
  await recordCacheReferences(client, lease, cacheWrites.map(entry => entry.key));
  await client.query('UPDATE web_jobs SET next_request_at=$3,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2', [lease.ownerId,lease.jobId,checkpoint.nextRequestAt === undefined ? null : new Date(checkpoint.nextRequestAt)]);
}
/** Cache adapters must hold/revalidate the owning identity; job writes use saveJobCheckpoint. */
export async function readOwnerCache(client: PoolClient, ownerId: string, key: string): Promise<CacheEntry | undefined> {
  return (await client.query<{ entry: CacheEntry }>('SELECT entry FROM web_owner_cache WHERE owner_id=$1 AND cache_key=$2', [ownerId,key])).rows[0]?.entry;
}
export async function putOwnerCache(client: PoolClient, ownerId: string, entries: readonly CacheEntry[]): Promise<void> {
  for (const entry of entries) await client.query(`INSERT INTO web_owner_cache (owner_id,cache_key,entry) VALUES ($1,$2,$3)
    ON CONFLICT (owner_id,cache_key) DO UPDATE SET entry=EXCLUDED.entry,updated_at=clock_timestamp()`, [ownerId,entry.key,JSON.stringify(entry)]);
}
export async function deleteOwnerCache(client: PoolClient, ownerId: string, key: string): Promise<void> {
  await client.query('DELETE FROM web_owner_cache WHERE owner_id=$1 AND cache_key=$2', [ownerId,key]);
}
export async function findWebJobByInput(client: PoolClient, ownerId: string, documentId: string, authVersion: number, inputSha256: string): Promise<WebJobRow | undefined> {
  return (await client.query<WebJobRow>('SELECT * FROM web_jobs WHERE owner_id=$1 AND document_id=$2 AND auth_version=$3 AND input_sha256=$4 AND document_epoch=(SELECT lifecycle_epoch FROM documents WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL)', [ownerId,documentId,authVersion,inputSha256])).rows[0];
}
export async function findWebJobByRequest(client: PoolClient, ownerId: string, documentId: string, authVersion: number, requestId: string): Promise<WebJobRow | undefined> {
  return (await client.query<WebJobRow>('SELECT * FROM web_jobs WHERE owner_id=$1 AND document_id=$2 AND auth_version=$3 AND request_id=$4', [ownerId,documentId,authVersion,requestId])).rows[0];
}

/** Called under a current lease; hashes remain owned by the SDK. */
export async function recordCacheReferences(client: PoolClient, lease: JobLease, keys: readonly string[]): Promise<void> {
  await client.query(`INSERT INTO web_cache_document_refs(owner_id,document_id,document_epoch,cache_key)
    SELECT owner_id,$2,$3,cache_key FROM web_owner_cache WHERE owner_id=$1 AND cache_key=ANY($4::text[]) ON CONFLICT DO NOTHING`, [lease.ownerId,lease.documentId,lease.documentEpoch,keys]);
}
