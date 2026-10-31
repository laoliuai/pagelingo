import { runWebExportJob } from '../web-exports/runner.js';
import type { SourceTransport } from '../source-adapters/types.js';
import { CheckpointConflictError, TranslationEngine, OpenAICompatibleProvider, type TranslationProvider } from '@pagelingo/translation-core';
import type { RuntimeConfig } from '../config.js';
import type { Database } from '../db/database.js';
import type { ObjectStore } from '../storage/object-store.js';
import { createProviderJobFetch } from '../network/provider-job-fetch.js';
import { runFetchJob } from '../web-captures/fetch-runner.js';
import { createCaptureJobScheduler } from './service.js';
import { createJobProfileResolver } from './profile.js';
import { createJobStateStore } from './state-store.js';
import { createOwnerCache } from './cache.js';
import { assertJobLeaseCurrent, type JobLease } from './repository.js';
import { finishWebJob, heartbeatWebJob, reconcileWebJobs } from './lease.js';
import { loadPublication, publishCheckpoint } from './publication.js';
export interface WebJobDependencies {
  db: Database; store: ObjectStore; config: RuntimeConfig; signal: AbortSignal;
  /** Test entry only; production always uses the pinned HTTPS transport. */
  provider?: TranslationProvider; captureFetch?: typeof fetch; sourceTransport?: SourceTransport;
}
export async function runWebJob(lease: JobLease, deps: WebJobDependencies): Promise<void> {
  if ((deps.provider || deps.captureFetch || deps.sourceTransport) && deps.config.mode !== 'test') throw new Error('Test provider injection requires test mode');
  const sourceJob=lease.kind==='fetch-link' && !!(await deps.db.pool.query('SELECT 1 FROM source_requests WHERE owner_id=$1 AND job_id=$2',[lease.ownerId,lease.jobId])).rowCount;
  if (deps.config.mode === 'test' && lease.kind !== 'export-web' && (lease.kind === 'translate' ? !deps.provider : sourceJob ? !deps.sourceTransport : !deps.captureFetch)) throw new Error('Test jobs require explicit mocks');
  const controller = new AbortController();
  const signal = AbortSignal.any([deps.signal,controller.signal]);
  let checking: Promise<void> | undefined;
  let heartbeatAt = Date.now();
  const monitor = setInterval(() => {
    if (checking) return;
    checking = (async () => {
      await reconcileWebJobs(deps.db);
      if (Date.now()-heartbeatAt >= 5000) { await heartbeatWebJob(lease,deps.db); heartbeatAt=Date.now(); }
      else await deps.db.transaction(c => assertJobLeaseCurrent(c,lease));
    })().catch(() => { controller.abort(new CheckpointConflictError('Job authorization or lease changed')); }).finally(() => { checking=undefined; });
  }, 500);
  const guard = async (client: import('pg').PoolClient) => { signal.throwIfAborted(); await assertJobLeaseCurrent(client,lease); };
  try {
    if (lease.kind === 'fetch-link') {
      await runFetchJob(lease, { ...deps, signal, onPublication: createCaptureJobScheduler() }); return;
    }
    if (lease.kind === 'export-web') { await runWebExportJob(lease,{ ...deps,signal }); return; }
    const publicationDeps = { db: deps.db, store: deps.store, generationKind: deps.provider ? 'mock' as const : 'model' as const };
    let context = await loadPublication(lease.jobId, lease.ownerId, publicationDeps, guard);
    const resolveProfile = createJobProfileResolver({ db: deps.db, keyring: deps.config.keyring });
    const generate: NonNullable<TranslationProvider['generateDetailed']> = async (request, requestSignal) => {
      let profile;
      try { profile = await resolveProfile(lease); }
      catch { controller.abort(new CheckpointConflictError('Job profile changed')); signal.throwIfAborted(); throw new Error('Unreachable'); }
      requestSignal.throwIfAborted();
      if (deps.provider) return deps.provider.generateDetailed ? deps.provider.generateDetailed(request,requestSignal) : { output: await deps.provider.generate(request,requestSignal) };
      const { settings, apiKey } = profile;
      const provider = new OpenAICompatibleProvider({ ...settings, apiKey, thinking: settings.thinkingMode === 'disabled' ? 'disabled' : undefined,
        timeoutMs: 60000, firstResponseTimeoutMs: 20000, idleTimeoutMs: 20000,
        fetch: createProviderJobFetch({ timeoutMs: 60000, maxResponseBytes: 8*1024*1024 }) });
      return provider.generateDetailed(request,requestSignal);
    };
    const provider: TranslationProvider = { generateDetailed: generate, generate: async (r,s) => (await generate(r,s)).output };
    const state = createJobStateStore(lease,deps.db,context.plan.units);
    const engine = new TranslationEngine(provider, { reliability: {
      identity: { endpoint: new URL(context.settings.baseUrl).href, model: context.settings.model, generation: { ...context.settings } },
      budget: context.budget, state, cache: createOwnerCache(lease.ownerId,lease,deps.db),
      dependencies: { profileRevision: lease.profileRevision, glossaryRevision: lease.glossaryRevision },
    } });
    for await (const batch of engine.translate(context.document, { targetLanguage: 'zh', profile: context.profile, glossary: context.glossary, signal })) {
      if (!batch.completed) continue;
      const milestone = Math.min(3,Math.floor(batch.completed/batch.total*4));
      if (milestone > context.job.publication_milestone) {
        const checkpoint = await state.load();
        if (!checkpoint) throw new CheckpointConflictError('Checkpoint missing');
        await publishCheckpoint(context, checkpoint, milestone, publicationDeps, guard);
        context = { ...context, job: { ...context.job, publication_milestone: milestone } };
      }
    }
    const checkpoint = await state.load();
    if (!checkpoint) throw new CheckpointConflictError('Checkpoint missing');
    await publishCheckpoint(context, checkpoint, 4, publicationDeps, guard);
    const completed = Object.keys(checkpoint.blocks).length;
    await finishWebJob(lease,deps.db,completed === context.document.blocks.length ? 'completed' : completed ? 'partial' : 'failed');
  } catch (error) {
    await reconcileWebJobs(deps.db);
    if (!signal.aborted && !(error instanceof CheckpointConflictError)) {
      try { await finishWebJob(lease,deps.db,'failed',lease.kind === 'export-web' ? (error instanceof Error && 'code' in error && ['BUNDLE_UNSUPPORTED_SOURCE', 'EXPORT_ORIGINALS_UNAVAILABLE'].includes(String(error.code)) ? String(error.code) : error instanceof Error && 'code' in error && error.code === 'EXPORT_TIMEOUT' ? 'EXPORT_TIMEOUT' : 'EXPORT_FAILED') : 'TRANSLATION_FAILED'); }
      catch (fence) { if (!(fence instanceof CheckpointConflictError)) throw fence; }
    }
  } finally {
    clearInterval(monitor); await checking;
  }
}
