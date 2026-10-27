import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { readerIrSchema, type ReaderIR } from '@pagelingo/document-contracts';
import { serializeBundleJson } from '@pagelingo/document-bundle';
import { toTranslationDocument, validateReaderTranslation } from '@pagelingo/document-renderer';
import { TranslationEngine, CheckpointConflictError, contentHash, mergeGlossaryEntries, glossaryDomainSchema, translationProfileSchema, planUnits } from '@pagelingo/translation-core';
import type { LocalRun } from './local-run.js';
import type { LocalTranslationJob, LocalTranslationResult, TranslateRunOptions, TranslationDependencies } from './translation-types.js';
import { atomicWrite, FileCheckpointStore, privateDirectory, readJson } from './file-checkpoints.js';
import { FileTranslationCache } from './file-cache.js';
import { acquireRunLock, type RunLock } from './run-lock.js';
import { createLocalProvider, resolveProviderConfig, safeProvider, LocalTranslationError } from './safe-config.js';
import { translationSnapshot } from './translation-snapshot.js';
export type { LocalTranslationJob, LocalTranslationResult, TranslateRunOptions, TranslationDependencies } from './translation-types.js';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
async function sourceRun(runDir: string): Promise<{ ir: ReaderIR; readerIrSha256: string }> {
  const run = await readJson(join(runDir, 'config.json')) as LocalRun;
  if (run.schemaVersion !== 'pagelingo-local-run/1' || !['complete', 'partial'].includes(run.status) || run.stage !== 'ready') throw new LocalTranslationError('TRANSLATION_RUN_NOT_READY');
  const irPath = join(runDir, 'source-ir.json');
  if ((await stat(irPath)).size > 32 * 1024 * 1024) throw new LocalTranslationError('TRANSLATION_IR_TOO_LARGE');
  const bytes = await readFile(irPath); const readerIrSha256 = hash(bytes);
  const ir = readerIrSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (readerIrSha256 !== run.readerIrSha256 || ir.parse.id !== run.parseId || ir.source.sha256 !== run.sourceSha256) throw new LocalTranslationError('TRANSLATION_SOURCE_CHANGED');
  const digest = createHash('sha256');
  for await (const part of createReadStream(join(runDir, 'source.pdf'))) digest.update(part);
  if (digest.digest('hex') !== ir.source.sha256) throw new LocalTranslationError('TRANSLATION_SOURCE_CHANGED');
  return { ir, readerIrSha256 };
}
async function currentJob(runDir: string): Promise<string | undefined> {
  try {
    const pointer = await readJson(join(runDir, 'translation/current.json')) as { jobId: string };
    if (!uuid.test(pointer.jobId)) throw new Error();
    return pointer.jobId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new LocalTranslationError('TRANSLATION_STATE_UNREADABLE');
  }
}
function jobPaths(jobId: string) {
  const directory = `translation/jobs/${jobId}`;
  return { directory, jobPath: `${directory}/job.json`, checkpointPath: `${directory}/checkpoint.json`, latestPath: `${directory}/latest.json` };
}
/** Reads the last fully durable immutable snapshot, never the mutable SDK checkpoint. */
export async function loadTranslationRun(runDir: string): Promise<LocalTranslationResult> {
  try {
    const { ir, readerIrSha256 } = await sourceRun(runDir);
    const jobId = await currentJob(runDir);
    if (!jobId) throw new LocalTranslationError('TRANSLATION_JOB_MISSING');
    const paths = jobPaths(jobId);
    const job = await readJson(join(runDir, paths.jobPath)) as LocalTranslationJob;
    const latest = await readJson(join(runDir, paths.latestPath)) as { snapshotId: string; sha256: string };
    if (!uuid.test(latest.snapshotId) || job.jobId !== jobId || job.readerIrSha256 !== readerIrSha256) throw new Error();
    const snapshotPath = `${paths.directory}/snapshots/${latest.snapshotId}.json`;
    const bytes = await readFile(join(runDir, snapshotPath));
    if (hash(bytes) !== latest.sha256) throw new Error();
    const snapshot = JSON.parse(bytes.toString('utf8')) as LocalTranslationResult['snapshot'];
    if (snapshot.jobId !== jobId || snapshot.id !== latest.snapshotId || snapshot.readerIrSha256 !== readerIrSha256) throw new Error();
    validateReaderTranslation(ir, snapshot);
    return { job, snapshot, jobPath: paths.jobPath, checkpointPath: paths.checkpointPath, snapshotPath, snapshotSha256: latest.sha256,
      warnings: snapshot.blocks.some(block => block.status === 'source-only' && block.reason === 'manual-choice') ? ['MANUAL_SELECTION_REQUIRED'] : [] };
  } catch (error) {
    if (error instanceof LocalTranslationError) throw error;
    throw new LocalTranslationError('TRANSLATION_STATE_UNREADABLE');
  }
}

export async function translateRun(options: TranslateRunOptions, deps: TranslationDependencies = {}): Promise<LocalTranslationResult> {
  let lock: RunLock | undefined;
  try {
    const { ir, readerIrSha256 } = await sourceRun(options.runDir);
    if (!['auto', 'all', 'none'].includes(options.selection) || options.newJob && options.resume) throw new LocalTranslationError('TRANSLATION_OPTIONS_INVALID');
    const budgetKeys = ['maxInputTokens', 'maxOutputTokens', 'contextWindowTokens', 'maxBatchBlocks', 'reserveTokens'];
    if (options.budget && Object.keys(options.budget).some(key => !budgetKeys.includes(key))) throw new LocalTranslationError('TRANSLATION_OPTIONS_INVALID');
    const resolved = resolveProviderConfig(options.provider);
    const generationKind = deps.provider ? deps.generationKind ?? 'mock' : 'model';
    if (!['mock', 'model'].includes(generationKind)) throw new LocalTranslationError('TRANSLATION_OPTIONS_INVALID');
    const selectionBlockIds = ir.blocks.filter(block => block.type === 'text' && (options.selection === 'all' || options.selection === 'auto' && block.language.language === 'en')).map(block => block.id);
    const document = toTranslationDocument(ir, selectionBlockIds, options.sourceLanguage);
    const config = {
      schemaVersion: 'pagelingo-local-translation-job/1' as const, readerIrSha256, sourceSha256: ir.source.sha256, parseId: ir.parse.id,
      selection: options.selection, selectionBlockIds, sourceLanguage: document.sourceLanguage ?? null,
      targetLanguage: options.targetLanguage ?? 'zh-CN', profile: translationProfileSchema.parse(options.profile ?? 'academic'),
      budget: { maxInputTokens: 8192, maxOutputTokens: 8192, contextWindowTokens: 32768, maxBatchBlocks: 4, reserveTokens: 512, ...options.budget },
      glossary: mergeGlossaryEntries([], options.glossary ?? []), glossaryDomain: glossaryDomainSchema.parse(options.glossaryDomain ?? 'machine-learning'),
      maxRetries: options.maxRetries ?? 2, backoffMs: options.backoffMs ?? 500,
      provider: { model: resolved.model, endpointFingerprint: resolved.endpointFingerprint }, generationKind,
    };
    if (!Number.isSafeInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > 2 || !Number.isFinite(config.backoffMs) || config.backoffMs < 0 || !config.targetLanguage.trim()) throw new LocalTranslationError('TRANSLATION_OPTIONS_INVALID');
    // Replay the public SDK planner before creating any job, including zero-selection jobs.
    try { planUnits(document, config.targetLanguage, config.profile, config.budget, config); }
    catch { throw new LocalTranslationError('TRANSLATION_OPTIONS_INVALID'); }
    const configSha256 = await contentHash(config);
    lock = await acquireRunLock(options.runDir);
    const previousId = await currentJob(options.runDir);
    let job: LocalTranslationJob;
    if (previousId && !options.newJob) {
      job = await readJson(join(options.runDir, jobPaths(previousId).jobPath)) as LocalTranslationJob;
      const { jobId: _id, configSha256: storedHash, ...storedConfig } = job;
      if (await contentHash(storedConfig) !== storedHash) throw new LocalTranslationError('TRANSLATION_STATE_UNREADABLE');
      if (job.configSha256 !== configSha256) throw new LocalTranslationError('TRANSLATION_CONFIG_CHANGED');
      if (!options.resume) throw new LocalTranslationError('TRANSLATION_JOB_EXISTS');
      if (job.jobId !== previousId) throw new LocalTranslationError('TRANSLATION_STATE_UNREADABLE');
    } else {
      job = { ...config, jobId: randomUUID(), configSha256 };
    }
    const paths = jobPaths(job.jobId);
    await privateDirectory(join(options.runDir, paths.directory, 'snapshots'));
    const cache = new FileTranslationCache(join(options.runDir, 'translation/cache'), lock);
    const store = new FileCheckpointStore(join(options.runDir, paths.checkpointPath), lock, cache, deps.checkpointWrite);
    const saveSnapshot = async (cancelled = false): Promise<LocalTranslationResult> => {
      await lock!.assertCurrent();
      const checkpoint = await store.load();
      const snapshot = await translationSnapshot(ir, job, checkpoint, cancelled);
      const snapshotPath = `${paths.directory}/snapshots/${snapshot.id}.json`;
      const bytes = serializeBundleJson(snapshot);
      await lock!.assertCurrent();
      await atomicWrite(join(options.runDir, snapshotPath), bytes, true, () => lock!.assertCurrent());
      await lock!.assertCurrent();
      await atomicWrite(join(options.runDir, paths.latestPath), serializeBundleJson({ snapshotId: snapshot.id, sha256: hash(bytes) }), false, () => lock!.assertCurrent());
      return { job, snapshot, jobPath: paths.jobPath, checkpointPath: paths.checkpointPath, snapshotPath, snapshotSha256: hash(bytes),
        warnings: snapshot.blocks.some(block => block.status === 'source-only' && block.reason === 'manual-choice') ? ['MANUAL_SELECTION_REQUIRED'] : [] };
    };
    if (job.jobId !== previousId) {
      await lock.assertCurrent();
      await atomicWrite(join(options.runDir, paths.jobPath), serializeBundleJson(job), true, () => lock!.assertCurrent());
      await saveSnapshot();
      await atomicWrite(join(options.runDir, 'translation/current.json'), serializeBundleJson({ jobId: job.jobId }), false, () => lock!.assertCurrent());
    }
    const signal = deps.signal ?? new AbortController().signal;
    if (!selectionBlockIds.length) return await saveSnapshot();
    const provider = safeProvider(deps.provider ?? createLocalProvider(resolved, config.budget.maxOutputTokens));
    const engine = new TranslationEngine(provider, { reliability: { identity: { endpoint: resolved.baseUrl, model: resolved.model, generation: { kind: generationKind } },
      budget: job.budget, cache, state: store, maxRetries: job.maxRetries, backoffMs: job.backoffMs } });
    try {
      for await (const _batch of engine.translate(document, { targetLanguage: job.targetLanguage, profile: job.profile, glossary: job.glossary, glossaryDomain: job.glossaryDomain, signal })) await saveSnapshot();
    } catch (error) {
      if (error instanceof CheckpointConflictError) throw error;
      if (!signal.aborted) throw new LocalTranslationError('TRANSLATION_SDK_FAILED');
    }
    return await saveSnapshot(signal.aborted);
  } catch (error) {
    if (error instanceof LocalTranslationError || error instanceof CheckpointConflictError) throw error;
    throw new LocalTranslationError('TRANSLATION_DISK_WRITE_FAILED');
  } finally { await lock?.release(); }
}
