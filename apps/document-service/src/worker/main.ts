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
import { FinalizerSchedule, readFinalizerCandidates } from './finalizer-schedule.js';

/** One independent process can fill both durable slots; the database owns concurrency. */
export async function runWorker(deps: WebJobDependencies, workerId = randomUUID()): Promise<void> {
  if ((deps.provider || deps.captureFetch) && deps.config.mode !== 'test') throw new Error('Test provider injection requires test mode');
  if (deps.config.mode === 'test' && (!deps.provider || !deps.captureFetch)) throw new Error('Test workers require explicit mocks');
  await verifyDatabaseSchema(deps.db);
  const active = new Set<Promise<void>>();
  const finalizers = new FinalizerSchedule();
  try {
    while (!deps.signal.aborted) {
      await reconcileWebJobs(deps.db);
      const terminal = await finalizers.next((after,cooling) => readFinalizerCandidates(deps.db,after,cooling));
      for (const job of terminal) {
        try {
          await finalizeWebJob(job.id, { db: deps.db, store: deps.store, generationKind: deps.provider ? 'mock' : 'model' });
          finalizers.succeeded(job);
        } catch {
          finalizers.failed(job);
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
