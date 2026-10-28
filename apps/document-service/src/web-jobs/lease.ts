import { lockDocument } from '../document-lifecycle/guards.js';
import type { Database } from '../db/database.js';
import { assertJobLeaseCurrent, releaseWebJobSlot, startWebJobLease, type JobLease, type WebJobRow } from './repository.js';

/** Claim serializes an owner before touching either global slot; no old slot owner is locked. */
export async function claimWebJob(workerId: string, db: Database): Promise<JobLease | null> {
  return db.transaction(async client => {
    const owner = (await client.query<{ id: string }>(`SELECT u.id FROM users u WHERE u.active
      AND EXISTS (SELECT 1 FROM web_jobs j WHERE j.owner_id=u.id AND j.auth_version=u.auth_version AND j.status='queued'
        AND (j.next_request_at IS NULL OR j.next_request_at<=clock_timestamp())
        AND (j.kind='fetch-link' OR EXISTS (SELECT 1 FROM provider_profiles p WHERE p.owner_id=u.id AND p.revision=j.profile_revision AND p.key_id IS NOT NULL)))
      AND NOT EXISTS (SELECT 1 FROM web_jobs j WHERE j.owner_id=u.id AND j.status='running')
      ORDER BY u.id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
    if (!owner) return null;
    const job = (await client.query<{ id: string }>(`SELECT j.id FROM web_jobs j WHERE owner_id=$1 AND status='queued'
      AND (next_request_at IS NULL OR next_request_at<=clock_timestamp())
      AND auth_version=(SELECT auth_version FROM users WHERE id=$1)
      AND (kind='fetch-link' OR EXISTS (SELECT 1 FROM provider_profiles p WHERE p.owner_id=$1 AND p.revision=j.profile_revision AND p.key_id IS NOT NULL))
      ORDER BY created_at,id LIMIT 1`, [owner.id])).rows[0];
    if (!job) return null;
    for (const slotId of [1,2]) {
      const lease = await startWebJobLease(client, { ownerId: owner.id, jobId: job.id, slotId, leaseOwner: workerId });
      if (lease) return lease;
    }
    return null;
  });
}
export async function heartbeatWebJob(lease: JobLease, db: Database): Promise<void> {
  await db.transaction(async client => {
    await assertJobLeaseCurrent(client, lease);
    const until = (await client.query<{ until: Date }>("SELECT clock_timestamp()+interval '30 seconds' AS until")).rows[0]!.until;
    await client.query('UPDATE web_jobs SET lease_until=$2 WHERE id=$1', [lease.jobId, until]);
    await client.query('UPDATE web_worker_slots SET lease_until=$2 WHERE id=$1', [lease.slotId, until]);
  });
}
/** A recovery pass always starts with the affected owner, never a slot belonging to another owner. */
export async function reconcileWebJobs(db: Database): Promise<void> {
  const owners = (await db.pool.query<{ owner_id: string }>("SELECT DISTINCT owner_id FROM web_jobs WHERE status IN ('queued','running')")).rows;
  for (const { owner_id: ownerId } of owners) await db.transaction(async client => {
    const user = (await client.query<{ active: boolean; auth_version: number }>('SELECT active,auth_version FROM users WHERE id=$1 FOR UPDATE SKIP LOCKED', [ownerId])).rows[0];
    if (!user) return;
    const jobs = (await client.query<WebJobRow>("SELECT * FROM web_jobs WHERE owner_id=$1 AND status IN ('queued','running') ORDER BY created_at,id", [ownerId])).rows;
    for (const documentId of [...new Set(jobs.map(job => job.document_id))].sort()) await lockDocument(client, ownerId, documentId);
    for (const job of jobs) {
      const invalidDocument = !(await client.query('SELECT 1 FROM documents WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL AND lifecycle_epoch=$3', [ownerId,job.document_id,job.document_epoch])).rowCount;
      const invalidOwner = !user.active || user.auth_version !== job.auth_version;
      const invalidProfile = job.kind === 'translate' && !(await client.query('SELECT 1 FROM provider_profiles WHERE owner_id=$1 AND revision=$2 AND key_id IS NOT NULL', [ownerId, job.profile_revision])).rowCount;
      const expired = job.status === 'running' && (await client.query('SELECT 1 WHERE $1::timestamptz<=clock_timestamp()', [job.lease_until])).rowCount;
      if (!invalidDocument && !invalidOwner && !invalidProfile && !expired) continue;
      if (job.slot_id !== null) await client.query('SELECT id FROM web_worker_slots WHERE id=$1 FOR UPDATE', [job.slot_id]);
      await client.query('SELECT id FROM web_jobs WHERE id=$1 FOR UPDATE', [job.id]);
      if (job.slot_id !== null) await client.query(`UPDATE web_worker_slots SET owner_id=NULL,job_id=NULL,lease_owner=NULL,lease_until=NULL
        WHERE id=$1 AND epoch=$2 AND owner_id=$3 AND job_id=$4 AND lease_owner=$5`, [job.slot_id, job.slot_epoch, ownerId, job.id, job.lease_owner]);
      const status = invalidDocument ? 'cancelled' : invalidOwner || invalidProfile ? job.kind === 'translate' ? 'paused-config' : 'cancelled' : 'queued';
      await client.query(`UPDATE web_jobs SET status=$2,epoch=epoch+1,lease_owner=NULL,lease_until=NULL,slot_id=NULL,slot_epoch=NULL,
        finalized_epoch=CASE WHEN $3='DOCUMENT_RETIRED' THEN epoch+1 ELSE finalized_epoch END,error_code=$3,updated_at=clock_timestamp() WHERE id=$1`, [job.id, status, invalidDocument ? 'DOCUMENT_RETIRED' : invalidOwner ? 'UNAUTHORIZED' : invalidProfile ? 'PROFILE_CHANGED' : null]);
    }
  });
}
export async function finishWebJob(lease: JobLease, db: Database, status: 'completed' | 'partial' | 'failed', errorCode: string | null = null): Promise<void> {
  await db.transaction(async client => {
    await assertJobLeaseCurrent(client, lease);
    await releaseWebJobSlot(client, lease);
    await client.query(`UPDATE web_jobs SET status=$2,error_code=$3,lease_owner=NULL,lease_until=NULL,slot_id=NULL,slot_epoch=NULL,updated_at=clock_timestamp() WHERE id=$1`, [lease.jobId,status,errorCode]);
  });
}
