import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { readConfig } from '../config.js';
import { openDatabase } from '../db/database.js';
import { verifyDatabaseSchema } from '../db/migrate.js';
import { createLocalObjectStore } from '../storage/local-object-store.js';
import { claimWebJob, reconcileWebJobs } from '../web-jobs/lease.js';
import { runWebJob, type WebJobDependencies } from '../web-jobs/translation-runner.js';
import { finalizeWebJob } from '../web-jobs/finalize.js';

/** One independent process can fill both durable slots; the database owns concurrency. */
export async function runWorker(deps: WebJobDependencies, workerId = randomUUID()): Promise<void> {
  if ((deps.provider || deps.captureFetch) && deps.config.mode !== 'test') throw new Error('Test provider injection requires test mode');
  if (deps.config.mode === 'test' && (!deps.provider || !deps.captureFetch)) throw new Error('Test workers require explicit mocks');
  await verifyDatabaseSchema(deps.db);
  const active = new Set<Promise<void>>();
  const finalizerFailures = new Map<string, { id: string; epoch: string; attempt: number; until: number }>();
  try {
    while (!deps.signal.aborted) {
      await reconcileWebJobs(deps.db);
      const cooling = [...finalizerFailures.values()].filter(failure => failure.until > Date.now());
      const terminal = (await deps.db.pool.query<{ id: string; epoch: string }>(`SELECT j.id,j.epoch FROM web_jobs j JOIN users u ON u.id=j.owner_id
        WHERE j.kind='translate' AND j.status IN ('cancelled','paused-config','partial','failed') AND u.active AND u.auth_version=j.auth_version
        AND j.finalized_epoch IS DISTINCT FROM j.epoch AND EXISTS (SELECT 1 FROM web_job_checkpoints c WHERE c.owner_id=j.owner_id AND c.job_id=j.id)
        AND NOT EXISTS (SELECT 1 FROM unnest($1::uuid[],$2::bigint[]) AS cooling(id,epoch) WHERE cooling.id=j.id AND cooling.epoch=j.epoch)
        ORDER BY j.updated_at LIMIT 10`, [cooling.map(failure => failure.id),cooling.map(failure => failure.epoch)])).rows;
      for (const job of terminal) {
        const key = `${job.id}:${job.epoch}`;
        try {
          await finalizeWebJob(job.id, { db: deps.db, store: deps.store, generationKind: deps.provider ? 'mock' : 'model' });
          finalizerFailures.delete(key);
        } catch {
          // Storage/replay retry only: never alter the SDK's durable endpoint cooldown.
          const attempt = Math.min(7,(finalizerFailures.get(key)?.attempt ?? 0)+1);
          if (!finalizerFailures.has(key) && finalizerFailures.size >= 1024) finalizerFailures.delete(finalizerFailures.keys().next().value!);
          finalizerFailures.set(key,{ id: job.id, epoch: job.epoch, attempt, until: Date.now()+Math.min(60000,1000*2**(attempt-1)) });
        }
      }
      while (active.size < 2 && !deps.signal.aborted) {
        const lease = await claimWebJob(workerId,deps.db);
        if (!lease) break;
        const work = runWebJob(lease,deps).finally(() => { active.delete(work); });
        active.add(work);
        // Attach immediately; lifecycle observes failures without unhandled rejections.
        void work.catch(() => {});
      }
      await sleep(200,undefined,{ signal: deps.signal }).catch(() => {});
    }
  } finally { await Promise.allSettled(active); }
}
async function main() {
  const config = readConfig(process.env);
  const db = openDatabase(config.databaseUrl);
  const controller = new AbortController();
  for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, () => controller.abort());
  try { await runWorker({ db, config, store: createLocalObjectStore(config.dataDir), signal: controller.signal }); }
  finally { await db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(() => {
  console.error('Document worker stopped; check runtime configuration and database availability.'); process.exitCode=1;
});
