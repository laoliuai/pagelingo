import type { Database } from '../db/database.js';
/** Invalidate stale attempt references before unlinking. Never lock a user after the GC lock. */
export async function expireWebCaptureStaging(db: Database): Promise<void> {
  const owners = (await db.pool.query<{ owner_id: string }>(`SELECT DISTINCT owner_id FROM web_captures
    WHERE fetch_job_id IS NULL AND status IN ('created','receiving','validating','failed') AND updated_at<clock_timestamp()-interval '24 hours'`)).rows;
  for (const { owner_id } of owners) await db.transaction(async client => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner_id]);
    const rows = (await client.query<{ id: string }>(`SELECT id FROM web_captures WHERE owner_id=$1 AND fetch_job_id IS NULL
      AND status IN ('created','receiving','validating','failed') AND updated_at<clock_timestamp()-interval '24 hours' FOR UPDATE`, [owner_id])).rows;
    for (const row of rows) {
      await client.query(`UPDATE web_capture_files SET staging_key=NULL,upload_token=NULL,upload_until=NULL,received_at=NULL,received_bytes=NULL,received_sha256=NULL WHERE owner_id=$1 AND capture_id=$2`, [owner_id, row.id]);
      await client.query("UPDATE web_captures SET status='failed',epoch=epoch+1,error_code='CAPTURE_STAGING_EXPIRED',updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2", [owner_id, row.id]);
    }
  });
}
