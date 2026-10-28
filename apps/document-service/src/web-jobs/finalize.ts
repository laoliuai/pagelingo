import { assertDocumentActive, lockDocument } from '../document-lifecycle/guards.js';
import type { TranslationCheckpoint } from '@pagelingo/translation-core';
import { loadPublication, publicationConflict, publishCheckpoint, type PublicationDependencies, type PublicationGuard } from './publication.js';
import type { WebJobRow } from './repository.js';
/** Terminal authority is distinct from a running lease. No credentials or model calls are involved. */
export async function finalizeWebJob(jobId: string, deps: PublicationDependencies): Promise<void> {
  const found = (await deps.db.pool.query<WebJobRow>('SELECT * FROM web_jobs WHERE id=$1', [jobId])).rows[0];
  if (!found || found.kind !== 'translate' || !['cancelled','paused-config','partial','failed'].includes(found.status) || found.finalized_epoch === found.epoch) return;
  const guard: PublicationGuard = async client => {
    const user = (await client.query('SELECT active,auth_version FROM users WHERE id=$1 FOR UPDATE', [found.owner_id])).rows[0];
    await lockDocument(client, found.owner_id, found.document_id);
    await assertDocumentActive(client, found.owner_id, found.document_id, Number(found.document_epoch));
    const job = (await client.query<WebJobRow>('SELECT * FROM web_jobs WHERE owner_id=$1 AND id=$2 FOR UPDATE', [found.owner_id,jobId])).rows[0];
    if (!user?.active || user.auth_version !== found.auth_version || !job || job.epoch !== found.epoch || job.status !== found.status || job.input_sha256 !== found.input_sha256) throw publicationConflict();
  };
  const checkpoint = await deps.db.transaction(async client => {
    await guard(client);
    return (await client.query<{ checkpoint: TranslationCheckpoint }>('SELECT checkpoint FROM web_job_checkpoints WHERE owner_id=$1 AND job_id=$2 AND input_sha256=$3 AND epoch<=$4', [found.owner_id,jobId,found.input_sha256,found.epoch])).rows[0]?.checkpoint;
  });
  // A job cancelled before its first checkpoint has no model artifact to manufacture.
  if (!checkpoint) return;
  const context = await loadPublication(jobId, found.owner_id, deps, guard);
  await publishCheckpoint(context, checkpoint, 4, deps, guard);
}
