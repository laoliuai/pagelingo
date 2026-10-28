import { assertJobLeaseCurrent, type JobLease } from '../web-jobs/repository.js';
import { finishWebJob } from '../web-jobs/lease.js';
import { runGithubFetchJob } from './github.js';
import type { SourceFetchDependencies } from './types.js';
export async function runSourceFetchJob(lease: JobLease, deps: SourceFetchDependencies): Promise<void> {
  if (lease.kind !== 'fetch-link') throw new Error('Source fetch requires fetch-link lease');
  if (deps.sourceTransport && deps.config.mode !== 'test') throw new Error('Source transport injection requires test mode');
  deps.signal.throwIfAborted();
  const request = await deps.db.transaction(async client => { await assertJobLeaseCurrent(client, lease); return (await client.query('SELECT reference FROM source_requests WHERE owner_id=$1 AND job_id=$2', [lease.ownerId, lease.jobId])).rows[0]; });
  if (request?.reference.provider === 'github') return runGithubFetchJob(lease, deps);
  // Task 9 owns actual arXiv acquisition and PDF publication.
  await finishWebJob(lease, deps.db, 'failed', 'UNSUPPORTED_SOURCE');
}
