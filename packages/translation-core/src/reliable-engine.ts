import { z } from 'zod';
import { abortable } from './abort.js';
import { planUnits, requestFits, stripContinuation } from './budget.js';
import { cacheKey, contentHash, makeCacheEntry, type CacheEntry } from './cache.js';
import { CheckpointConflictError, type ReliabilityOptions, type TranslationCheckpoint } from './checkpoint.js';
import type { TranslationDocument } from './document.js';
import { ProviderError, type TokenUsage } from './openai-compatible.js';
import { decodeTranslation } from './protection.js';
import { buildTranslationRequest, type TranslationProvider } from './provider.js';
import type { TranslationBatchResult, TranslationOptions, TranslationMetrics } from './types.js';
import { validateStructure } from './validator.js';
import { restoreGlossaryText } from './terminology.js';

export function emptyMetrics(): TranslationMetrics {
  return { requests: 0, retries: 0, cacheHits: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    usageRequests: 0, startedAt: Date.now(), elapsedMs: 0 };
}
const itemSchema = z.strictObject({ id: z.string(), text: z.string().min(1) });
const partialSchema = z.strictObject({ translations: z.array(z.unknown()) });
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted();
  const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, Math.min(ms, 2_147_483_647));
  const cancel = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', cancel, { once: true });
});

export async function* translateReliably(provider: TranslationProvider, document: TranslationDocument,
  options: TranslationOptions, policy: ReliabilityOptions): AsyncGenerator<TranslationBatchResult> {
  const signal = options.signal!; const profile = options.profile ?? 'technical';
  const maxAttempts = 1 + (policy.maxRetries ?? 2);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error('重试上限为 0–2 次。');
  if (policy.backoffMs !== undefined && (!Number.isFinite(policy.backoffMs) || policy.backoffMs < 0)) throw new Error('退避时间不能为负。');
  const plan = planUnits(document, options.targetLanguage, profile, policy.budget, options);
  const keyOptions = { document: plan.document, targetLanguage: options.targetLanguage, profile, identity: policy.identity, dependencies: policy.dependencies };
  const fullKeys = await Promise.all(plan.inputs.map((input) => cacheKey({ ...keyOptions, input })));
  const unitKeys = await Promise.all(plan.units.map((u) => cacheKey({ ...keyOptions, input: u.input })));
  const fingerprint = await contentHash({ fullKeys, unitKeys, budget: policy.budget });
  let saved: TranslationCheckpoint | undefined;
  let storageWarning: string | undefined;
  const warn = () => { storageWarning = '本地存储不可用，当前译文仍可显示；恢复和缓存可能受限。'; };
  try { saved = await policy.state?.load(); } catch (error) { if (error instanceof CheckpointConflictError) throw error; warn(); }
  if (saved?.version !== 1 || saved.fingerprint !== fingerprint) saved = undefined;
  const state: TranslationCheckpoint = { version: 1, fingerprint, blocks: {}, metrics: saved?.metrics ?? emptyMetrics(),
    nextRequestAt: Number.isFinite(saved?.nextRequestAt) ? saved!.nextRequestAt : undefined,
    units: plan.units.map((unit, index) => {
      const old = saved?.units.find((u) => u.id === unit.id && u.key === unitKeys[index]);
      const attempt = old && Number.isSafeInteger(old.attempt) && old.attempt >= 0 ? Math.min(old.attempt, maxAttempts) : 0;
      const valid = old?.text && !validateStructure(unit.input, old.text).length;
      return { id: unit.id, key: unitKeys[index], attempt, status: valid ? 'completed' : attempt >= maxAttempts ? 'failed' : 'pending',
        text: valid ? old.text : undefined, source: old?.source, retryAt: old?.retryAt,
        error: valid ? undefined : old?.error ?? (attempt >= maxAttempts ? '已达到最大尝试次数，原文保留。' : undefined) };
    }) };
  if (state.nextRequestAt) policy.scheduler?.deferUntil(policy.identity.endpoint, state.nextRequestAt);
  const failures = new Map(plan.failures.map((f) => [f.id, f.error]));
  const delivered = new Set<string>(); const deliveredFailures = new Set<string>();
  let writes: CacheEntry[] = [];
  const persist = async () => {
    signal.throwIfAborted();
    state.metrics.elapsedMs = Date.now() - state.metrics.startedAt;
    if (storageWarning) state.metrics.storageWarning = storageWarning;
    const entries = writes; writes = [];
    try {
      if (policy.state) await policy.state.save(structuredClone(state), entries);
      else if (entries.length) await policy.cache?.putMany(entries);
    } catch (error) {
      if (error instanceof CheckpointConflictError) throw error;
      warn(); state.metrics.storageWarning = storageWarning;
    }
    signal.throwIfAborted();
  };
  const read = async (key: string, input: typeof plan.inputs[number]) => {
    try {
      const entry = await policy.cache?.get(key);
      signal.throwIfAborted();
      if (!entry) return undefined;
      if (entry.schemaVersion === 1 && entry.key === key && typeof entry.text === 'string' && !validateStructure(input, entry.text).length) return entry.text;
      await policy.cache?.delete(key);
    } catch { signal.throwIfAborted(); warn(); }
    return undefined;
  };
  for (let i = 0; i < plan.inputs.length; i++) {
    const recovered = saved?.blocks[String(i)];
    if (recovered?.text && !validateStructure(plan.inputs[i], recovered.text).length) {
      state.blocks[String(i)] = { text: recovered.text, source: 'recovered' }; failures.delete(plan.inputs[i].id); continue;
    }
    const text = await read(fullKeys[i], plan.inputs[i]);
    if (text !== undefined) { state.blocks[String(i)] = { text, source: 'cache' }; state.metrics.cacheHits++; failures.delete(plan.inputs[i].id); }
  }
  for (let i = 0; i < plan.units.length; i++) {
    if (state.blocks[String(plan.units[i].blockIndex)] || state.units[i].status === 'completed') continue;
    const text = await read(unitKeys[i], plan.units[i].input);
    if (text !== undefined) Object.assign(state.units[i], { status: 'completed', text, source: 'cache', error: undefined });
  }
  const assemble = () => {
    for (let i = 0; i < plan.inputs.length; i++) {
      if (state.blocks[String(i)] || failures.has(plan.inputs[i].id)) continue;
      const indices = plan.units.map((u, n) => u.blockIndex === i ? n : -1).filter((n) => n >= 0);
      const bad = indices.find((n) => state.units[n].status === 'failed');
      if (bad !== undefined) { failures.set(plan.inputs[i].id, state.units[bad].error ?? '此段翻译失败，原文保留。'); continue; }
      if (!indices.length || !indices.every((n) => state.units[n].status === 'completed')) continue;
      try {
        const text = indices.map((n) => stripContinuation(plan.units[n].input, state.units[n].text!)).join('');
        if (validateStructure(plan.inputs[i], text).length) throw new Error('structure');
        const source = indices.every((n) => state.units[n].source === 'cache') ? 'cache' : 'network';
        if (source === 'cache') state.metrics.cacheHits++;
        state.blocks[String(i)] = { text, source }; writes.push(makeCacheEntry(fullKeys[i], text));
      } catch { failures.set(plan.inputs[i].id, '分片合并校验失败，原文保留。'); }
    }
  };
  const take = (): TranslationBatchResult => {
    const translations = plan.inputs.flatMap((input, index) => {
      const result = state.blocks[String(index)];
      if (!result || delivered.has(input.id)) return [];
      delivered.add(input.id);
      return [{ id: input.id, text: restoreGlossaryText(input, result.text), content: decodeTranslation(input, result.text) }];
    });
    const freshFailures = [...failures].filter(([id]) => !deliveredFailures.has(id)).map(([id, error]) => { deliveredFailures.add(id); return { id, error }; });
    if (translations.length && state.metrics.firstResultMs === undefined) state.metrics.firstResultMs = Date.now() - state.metrics.startedAt;
    return { documentId: document.id, translations, completed: Object.keys(state.blocks).length, total: plan.inputs.length,
      failures: freshFailures, metrics: { ...state.metrics, elapsedMs: Date.now() - state.metrics.startedAt } };
  };
  const addUsage = (usage?: TokenUsage) => {
    if (!usage) return;
    state.metrics.promptTokens += usage.promptTokens; state.metrics.completionTokens += usage.completionTokens;
    state.metrics.totalTokens += usage.totalTokens; state.metrics.usageRequests++;
  };
  assemble(); await persist();
  if (Object.keys(state.blocks).length || failures.size) yield take();
  let batchLimit = policy.budget.maxBatchBlocks ?? 4;
  while (true) {
    signal.throwIfAborted();
    const pending = state.units.map((s, i) => ({ s, i })).filter(({ s, i }) => s.status === 'pending' && !state.blocks[String(plan.units[i].blockIndex)] && !failures.has(plan.inputs[plan.units[i].blockIndex].id));
    if (!pending.length) break;
    const now = Date.now();
    if (state.nextRequestAt && state.nextRequestAt > now) { await sleep(state.nextRequestAt - now, signal); continue; }
    const ready = pending.filter(({ s }) => !s.retryAt || s.retryAt <= now);
    if (!ready.length) { await sleep(Math.max(1, Math.min(...pending.map(({ s }) => s.retryAt!)) - now), signal); continue; }
    const selected: number[] = [];
    const limit = state.metrics.requests === 0 ? 1 : batchLimit;
    for (const { i } of ready) {
      if (selected.length >= limit) break;
      const proposed = [...selected, i];
      if (!requestFits(buildTranslationRequest(plan.document, proposed.map((n) => plan.units[n].input), options.targetLanguage, profile), policy.budget)) break;
      selected.push(i);
    }
    if (!selected.length) throw new Error('请求无法满足 Token 预算。');
    const request = buildTranslationRequest(plan.document, selected.map((n) => plan.units[n].input), options.targetLanguage, profile);
    let output: unknown; let failure: unknown;
    const execute = async () => {
      signal.throwIfAborted();
      selected.forEach((n) => { const unit = state.units[n]; if (unit.attempt) state.metrics.retries++; unit.attempt++; unit.status = 'inflight'; });
      state.metrics.requests++; await persist();
      try {
        if (provider.generateDetailed) { const result = await abortable(() => provider.generateDetailed!(request, signal), signal); addUsage(result.usage); output = result.output; }
        else output = await abortable(() => provider.generate(request, signal), signal);
      } catch (error) {
        signal.throwIfAborted(); failure = error;
        if (error instanceof ProviderError) {
          addUsage(error.usage);
          if (error.status === 429) {
            const delay = (policy.backoffMs ?? 500) * 2 ** (Math.max(...selected.map((n) => state.units[n].attempt)) - 1);
            state.nextRequestAt = Math.max(state.nextRequestAt ?? 0, Date.now() + Math.max(delay, error.retryAfterMs ?? 0) + Math.random() * delay * 0.2);
            // Set the shared cooldown before this operation releases its slot.
            policy.scheduler?.deferUntil(policy.identity.endpoint, state.nextRequestAt);
          }
        }
      }
    };
    if (policy.scheduler) await policy.scheduler.run(policy.identity.endpoint, execute, signal); else await execute();
    signal.throwIfAborted();
    const partial = partialSchema.safeParse(output);
    const parsed = partial.success ? partial.data.translations.map((t) => itemSchema.safeParse(t)).filter((t) => t.success).map((t) => t.data!) : [];
    const counts = new Map<string, number>();
    if (partial.success) for (const value of partial.data.translations) {
      const id = value && typeof value === 'object' ? (value as { id?: unknown }).id : undefined;
      if (typeof id === 'string') counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const fatal = failure instanceof ProviderError && (failure.code === 'configuration' || (failure.code === 'http' && ![408, 429].includes(failure.status ?? 0) && (failure.status ?? 0) < 500));
    const truncated = failure instanceof ProviderError && failure.code === 'truncated';
    if (truncated && selected.length > 1) batchLimit = Math.max(1, Math.floor(selected.length / 2));
    for (const n of selected) {
      const unit = state.units[n]; const input = plan.units[n].input;
      const result = parsed.find((t) => t.id === input.id && counts.get(t.id) === 1);
      if (!failure && result && !validateStructure(input, result.text).length) {
        Object.assign(unit, { status: 'completed', text: result.text, error: undefined, retryAt: undefined, source: 'network' });
        writes.push(makeCacheEntry(unit.key, result.text));
      } else {
        unit.error = failure instanceof ProviderError ? failure.message : '翻译结构校验未通过，原文保留。';
        const permanent = fatal || (truncated && selected.length === 1) || (failure instanceof ProviderError && failure.code === 'refused');
        unit.status = permanent || unit.attempt >= maxAttempts ? 'failed' : 'pending';
        const delay = (policy.backoffMs ?? 500) * 2 ** (unit.attempt - 1);
        unit.retryAt = Date.now() + Math.max(delay, failure instanceof ProviderError ? failure.retryAfterMs ?? 0 : 0) + Math.random() * delay * 0.2;
      }
    }
    if (fatal) state.units.forEach((unit) => { if (unit.status !== 'completed') { unit.status = 'failed'; unit.error = (failure as Error).message; } });
    assemble(); await persist();
    const batch = take();
    if (batch.translations.length || batch.failures?.length) yield batch;
  }
}
