// @vitest-environment node
import { expect, it, vi } from 'vitest';
import * as sdk from '@pagelingo/translation-core';
import type { CacheEntry, GenerationRequest, TranslationDocument } from '@pagelingo/translation-core';

const doc = (count = 4): TranslationDocument => ({ id: 'doc', title: 'Doc', sourceLanguage: 'en', blocks: Array.from({ length: count }, (_, i) => ({
  id: `p${i}`, kind: 'paragraph', content: [{ type: 'text', text: `The system ${i} is reliable.` }, { type: 'protected', id: 'c', kind: 'code', source: 'run()' }],
})) });
const echo = (r: GenerationRequest) => ({ translations: r.data.blocks.map((b) => ({ id: b.id, text: b.protectedText.replace('The system', '系统') })) });
const policy = { identity: { endpoint: 'https://api.example.com/v1/chat/completions', model: 'test', generation: {} },
  budget: { maxInputTokens: 6000, maxOutputTokens: 4096, contextWindowTokens: 16000, maxBatchBlocks: 4 }, backoffMs: 0 };
function memoryCache() {
  const entries = new Map<string, CacheEntry>();
  return { entries, get: async (key: string) => entries.get(key), putMany: async (values: CacheEntry[]) => { values.forEach((v) => entries.set(v.key, v)); }, delete: async (key: string) => { entries.delete(key); } };
}
async function collect(engine: sdk.TranslationEngine, document = doc()) {
  const batches: sdk.TranslationBatchResult[] = [];
  for await (const b of engine.translate(document, { targetLanguage: 'zh-CN' })) batches.push(b);
  return batches;
}

it('gives the first uncached block priority, caches validated results and rebinds new block IDs', async () => {
  const cache = memoryCache(); const generate = vi.fn(async (r: GenerationRequest) => echo(r));
  const result = await collect(new sdk.TranslationEngine({ generate }, { reliability: { ...policy, cache } }));
  expect(generate.mock.calls[0][0].data.blocks).toHaveLength(1);
  expect(result.at(-1)?.completed).toBe(4);
  const changed = doc(); changed.id = 'next-session'; changed.blocks.forEach((b, i) => b.id = `new-${i}`);
  generate.mockClear();
  const cached = await collect(new sdk.TranslationEngine({ generate }, { reliability: { ...policy, cache } }), changed);
  expect(generate).not.toHaveBeenCalled();
  expect(cached.flatMap((b) => b.translations.map((t) => t.id))).toEqual(['new-0', 'new-1', 'new-2', 'new-3']);
  expect(cached.at(-1)?.metrics?.cacheHits).toBe(4);
});

it('keeps independently valid results and retries only the invalid block, for at most three attempts', async () => {
  const counts = new Map<string, number>();
  const generate = vi.fn(async (r: GenerationRequest) => {
    r.data.blocks.forEach((b) => counts.set(b.id, (counts.get(b.id) ?? 0) + 1));
    return { translations: echo(r).translations.map((b) => b.id === 'u2:0' ? { ...b, text: 'missing marker' } : b) };
  });
  const result = await collect(new sdk.TranslationEngine({ generate }, { reliability: policy }));
  expect(counts.get('u2:0')).toBe(3);
  expect(counts.get('u1:0')).toBe(1); expect(counts.get('u3:0')).toBe(1);
  expect(result.at(-1)?.completed).toBe(3);
  expect(result.flatMap((b) => b.failures ?? []).map((b) => b.id)).toEqual(['p2']);
});

it('shares transport and validation retries and stops immediately on authentication failure', async () => {
  let calls = 0;
  const generate = vi.fn(async () => {
    calls++; if (calls === 1) throw new sdk.ProviderError('network', 'network');
    return { translations: [{ id: 'u0:0', text: 'invalid' }] };
  });
  const result = await collect(new sdk.TranslationEngine({ generate }, { reliability: policy }), doc(1));
  expect(generate).toHaveBeenCalledTimes(3); expect(result.at(-1)?.failures).toHaveLength(1);
  const auth = vi.fn(async () => { throw new sdk.ProviderError('http', '鉴权失败', 401); });
  const denied = await collect(new sdk.TranslationEngine({ generate: auth }, { reliability: policy }));
  expect(auth).toHaveBeenCalledTimes(1); expect(denied.at(-1)?.failures).toHaveLength(4);
});

it('shrinks a truncated multi-block batch instead of repeating it unchanged', async () => {
  const sizes: number[] = [];
  const generate = async (r: GenerationRequest) => {
    sizes.push(r.data.blocks.length);
    if (r.data.blocks.length > 1) throw new sdk.ProviderError('truncated', 'length');
    return echo(r);
  };
  const result = await collect(new sdk.TranslationEngine({ generate }, { reliability: policy }), doc(3));
  expect(sizes).toEqual([1, 2, 1, 1]); expect(result.at(-1)?.completed).toBe(3);
});

it('revalidates corrupt cached text before reuse and tolerates cache write failure', async () => {
  const cache = memoryCache(); const generate = vi.fn(async (r: GenerationRequest) => echo(r));
  await collect(new sdk.TranslationEngine({ generate }, { reliability: { ...policy, cache } }), doc(1));
  cache.entries.forEach((e) => e.text = 'invalid'); generate.mockClear();
  cache.putMany = async () => { throw new Error('quota'); };
  const result = await collect(new sdk.TranslationEngine({ generate }, { reliability: { ...policy, cache } }), doc(1));
  expect(generate).toHaveBeenCalledTimes(1); expect(result.at(-1)?.completed).toBe(1);
  expect(result.at(-1)?.metrics?.storageWarning).toBeTruthy();
});

it('checkpoints completed work before yielding and replays it without spending new attempts', async () => {
  expect(typeof sdk.contentHash).toBe('function');
  let checkpoint: sdk.TranslationCheckpoint | undefined;
  const state = { load: async () => checkpoint, save: async (s: sdk.TranslationCheckpoint) => { checkpoint = structuredClone(s); } };
  const generate = vi.fn(async (r: GenerationRequest) => echo(r));
  const stream = new sdk.TranslationEngine({ generate }, { reliability: { ...policy, state } }).translate(doc(), { targetLanguage: 'zh-CN' });
  const first = await stream.next(); expect(first.value?.completed).toBe(1);
  expect(checkpoint?.units[0].status).toBe('completed');
  await stream.return(undefined); generate.mockClear();
  const resumed = await collect(new sdk.TranslationEngine({ generate }, { reliability: { ...policy, state } }));
  expect(resumed[0].translations[0].id).toBe('p0');
  expect(generate.mock.calls.flatMap(([r]) => r.data.blocks.map((b) => b.id))).not.toContain('u0:0');
  expect(resumed.at(-1)?.completed).toBe(4);
});

it('counts an interrupted inflight request against the same three-attempt limit on recovery', async () => {
  let checkpoint: sdk.TranslationCheckpoint | undefined;
  const state = { load: async () => checkpoint, save: async (s: sdk.TranslationCheckpoint) => { checkpoint = structuredClone(s); } };
  const abort = new AbortController();
  const generate = vi.fn(async () => { abort.abort(); return new Promise<unknown>(() => {}); });
  await expect(new sdk.TranslationEngine({ generate }, { reliability: { ...policy, state } }).translate(doc(1), { targetLanguage: 'zh-CN', signal: abort.signal }).next()).rejects.toThrow();
  expect(checkpoint?.units[0].attempt).toBe(1);
  const invalid = vi.fn(async () => ({ translations: [] }));
  await collect(new sdk.TranslationEngine({ generate: invalid }, { reliability: { ...policy, state } }), doc(1));
  expect(invalid).toHaveBeenCalledTimes(2);
});

it('respects Retry-After and cancellation during backoff without another request', async () => {
  vi.useFakeTimers();
  try {
    const abort = new AbortController();
    let started!: () => void;
    const firstCall = new Promise<void>((resolve) => { started = resolve; });
    const generate = vi.fn(async () => { started(); throw new sdk.ProviderError('http', 'rate limited', 429, 4000); });
    const iterator = new sdk.TranslationEngine({ generate }, { reliability: { ...policy, backoffMs: 10 } }).translate(doc(1), { targetLanguage: 'zh-CN', signal: abort.signal });
    const pending = iterator.next(); const assertion = expect(pending).rejects.toThrow();
    await firstCall;
    await vi.advanceTimersByTimeAsync(1000); expect(generate).toHaveBeenCalledTimes(1);
    abort.abort(); await assertion; expect(generate).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

it('does not accept a valid item when another item duplicates its ID with invalid fields', async () => {
  const generate = vi.fn(async (r: GenerationRequest) => ({ translations: [...echo(r).translations, { id: r.data.blocks[0].id, text: null }] }));
  const result = await collect(new sdk.TranslationEngine({ generate }, { reliability: policy }), doc(1));
  expect(result.at(-1)?.completed).toBe(0);
  expect(result.at(-1)?.failures).toHaveLength(1); expect(generate).toHaveBeenCalledTimes(3);
});

it('assembles long split output once with original format and atom IDs, and caches the whole block', async () => {
  const source = doc(1); source.blocks[0].content = [{ type: 'format', id: 'outer', kind: 'link', children: [
    { type: 'text', text: 'Repeated sentence. '.repeat(180) }, { type: 'protected', id: 'math', kind: 'math', source: '\\alpha = 42' },
  ] }];
  const cache = memoryCache();
  const generate = vi.fn(async (r: GenerationRequest) => ({ translations: r.data.blocks.map((b) => ({ id: b.id, text: b.protectedText })) }));
  const reliability = { ...policy, budget: { ...policy.budget, maxInputTokens: 1900 }, cache };
  const result = await collect(new sdk.TranslationEngine({ generate }, { reliability }), source);
  expect(generate.mock.calls.length).toBeGreaterThan(1);
  expect(result.flatMap((b) => b.translations)).toHaveLength(1);
  expect(result.at(-1)?.translations[0].content).toEqual(source.blocks[0].content);
  generate.mockClear();
  expect((await collect(new sdk.TranslationEngine({ generate }, { reliability }), source)).at(-1)?.completed).toBe(1);
  expect(generate).not.toHaveBeenCalled();
});

it('waits Retry-After before sending fresh blocks and shares the endpoint cooldown with a second document', async () => {
  vi.useFakeTimers();
  try {
    const scheduler = new sdk.ConcurrencyScheduler(2);
    let started!: () => void; const first = new Promise<void>((resolve) => { started = resolve; });
    let calls = 0;
    const generate = vi.fn(async (r: GenerationRequest) => { if (++calls === 1) { started(); throw new sdk.ProviderError('http', '429', 429, 3000); } return echo(r); });
    const initial = collect(new sdk.TranslationEngine({ generate }, { reliability: { ...policy, scheduler } }), doc(3));
    await first; await vi.advanceTimersByTimeAsync(1);
    let ready!: () => void; const secondReady = new Promise<void>((resolve) => { ready = resolve; });
    const other = collect(new sdk.TranslationEngine({ generate }, { reliability: { ...policy, scheduler,
      state: { load: async () => undefined, save: async (s) => { if (s.units[0].attempt === 0) ready(); } },
    } }), doc(1));
    await secondReady;
    await vi.advanceTimersByTimeAsync(1000);
    expect(generate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2500);
    expect((await initial).at(-1)?.completed).toBe(3); expect((await other).at(-1)?.completed).toBe(1);
  } finally { vi.useRealTimers(); }
});

it('retains an endpoint cooldown deadline in the checkpoint before recovery', async () => {
  const abort = new AbortController(); let snapshot: sdk.TranslationCheckpoint | undefined;
  const generate = vi.fn(async () => { throw new sdk.ProviderError('http', '429', 429, 60000); });
  const state = { load: async () => undefined, save: async (s: sdk.TranslationCheckpoint) => {
    snapshot = structuredClone(s); if (s.units[0].status === 'pending' && s.units[0].attempt === 1) abort.abort();
  } };
  const pending = new sdk.TranslationEngine({ generate }, { reliability: { ...policy, state } }).translate(doc(2), { targetLanguage: 'zh-CN', signal: abort.signal }).next();
  await expect(pending).rejects.toThrow();
  expect(snapshot?.nextRequestAt).toBeGreaterThan(Date.now() + 59000); expect(generate).toHaveBeenCalledTimes(1);
});
