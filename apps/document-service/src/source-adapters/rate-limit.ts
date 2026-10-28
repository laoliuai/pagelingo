import type { Database } from '../db/database.js';
import { assertJobLeaseCurrent, releaseWebJobSlot, type JobLease } from '../web-jobs/repository.js';
/** Caller must await managed HTTP cleanup before resolving/rejecting perform. Never sleeps. */
export async function withArxivRequest<T>(db: Database, lease: JobLease, perform: () => Promise<T>, retryAfter?: (result: T) => string | null): Promise<{ executed: false } | { executed: true; value: T }> {
  await db.transaction(c => assertJobLeaseCurrent(c,lease));
  const session = await db.pool.connect(); let locked = false, admitted = false; let retryDelay = 0;
  const defer = async (cooling: boolean) => db.transaction(async client => {
    await assertJobLeaseCurrent(client,lease); await releaseWebJobSlot(client,lease);
    await client.query(`UPDATE web_jobs SET status='queued',lease_owner=NULL,lease_until=NULL,slot_id=NULL,slot_epoch=NULL,
      next_request_at=${cooling ? "(SELECT next_request_at FROM external_request_limits WHERE provider='arxiv')" : "clock_timestamp()+interval '1 second'"},updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2`, [lease.ownerId,lease.jobId]);
  });
  try {
    locked = (await session.query('SELECT pg_try_advisory_lock(204716,40) AS acquired')).rows[0].acquired;
    if (!locked) { await defer(false); return { executed:false }; }
    if ((await session.query("SELECT next_request_at>clock_timestamp() AS cooling FROM external_request_limits WHERE provider='arxiv'")).rows[0].cooling) {
      await defer(true); return { executed:false };
    }
    // Conservative crash fence: a killed process cannot report its actual HTTP close time.
    // The managed transport's 120 second total bound plus cooldown is safe on session loss.
    await session.query("UPDATE external_request_limits SET next_request_at=clock_timestamp()+interval '123 seconds' WHERE provider='arxiv'");
    admitted = true;
    await db.transaction(c => assertJobLeaseCurrent(c,lease));
    const value = await perform();
    const supplied = retryAfter?.(value);
    if (supplied) {
      const seconds = /^\d+$/.test(supplied.trim()) ? Number(supplied) : NaN;
      const millis = Number.isFinite(seconds) ? seconds*1000 : Date.parse(supplied)-Date.now();
      if (Number.isFinite(millis)) retryDelay = Math.max(0,millis);
    }
    return { executed:true,value };
  } finally {
    try {
      if (admitted) await session.query("UPDATE external_request_limits SET next_request_at=clock_timestamp()+($1::double precision*interval '1 millisecond') WHERE provider='arxiv'", [Math.max(3000,retryDelay)]);
    } finally {
      try { if (locked) await session.query('SELECT pg_advisory_unlock(204716,40)'); }
      finally { session.release(true); }
    }
  }
}
