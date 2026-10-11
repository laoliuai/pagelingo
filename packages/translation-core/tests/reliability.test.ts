// @vitest-environment node
import { expect, it } from 'vitest';
import * as sdk from '@pagelingo/translation-core';
import type { TranslationDocument } from '@pagelingo/translation-core';

export function fixture(count = 1): TranslationDocument {
  return { id: 'doc', title: 'Stable title', sourceLanguage: 'en', blocks: Array.from({ length: count }, (_, i) => ({
    id: `p${i}`, kind: 'paragraph', content: [{ type: 'text', text: `Paragraph ${i} describes a reliable system.` }],
  })) };
}

const identity = { endpoint: 'https://api.example.com/v1/chat/completions', model: 'model', generation: { temperature: 0.1 } };
const budget = { maxInputTokens: 1800, maxOutputTokens: 1024, contextWindowTokens: 4000, maxBatchBlocks: 4, reserveTokens: 256 };

it('splits a long nested formatted block without changing any source or token identity', () => {
  expect(typeof sdk.planUnits).toBe('function');
  const document = fixture();
  document.blocks[0].content = [{ type: 'format', id: 'link', kind: 'link', children: [
    { type: 'text', text: 'A sentence with meaningful whitespace.\n '.repeat(160) },
    { type: 'format', id: 'bold', kind: 'strong', children: [
      { type: 'protected', id: 'code', kind: 'code', source: 'someCode(42)' },
      { type: 'text', text: ' More sentences. '.repeat(120) },
    ] },
  ] }];
  const input = sdk.encodeBlock(document.blocks[0]);
  const plan = sdk.planUnits(document, 'zh-CN', 'technical', budget);
  expect(plan.failures).toEqual([]);
  expect(plan.units.length).toBeGreaterThan(2);
  for (const unit of plan.units) {
    expect(sdk.validateStructure(unit.input, unit.input.protectedText)).toEqual([]);
    expect(sdk.requestFits(sdk.buildTranslationRequest(plan.document, [unit.input], 'zh-CN', 'technical'), budget)).toBe(true);
  }
  const joined = plan.units.map((u) => sdk.stripContinuation(u.input, u.input.protectedText)).join('');
  expect(joined).toBe(input.protectedText);
  expect(sdk.decodeTranslation(input, joined)).toEqual(document.blocks[0].content);
});

it('rejects an indivisible protected object locally and uses both input and output budgets', () => {
  expect(typeof sdk.planUnits).toBe('function');
  const doc = fixture(2);
  doc.blocks[0].content = [{ type: 'protected', id: 'huge', kind: 'code', source: 'x'.repeat(10000) }];
  const plan = sdk.planUnits(doc, 'zh-CN', 'technical', budget);
  expect(plan.failures.map((f) => f.id)).toEqual(['p0']);
  expect(plan.units.some((u) => u.blockIndex === 1)).toBe(true);
  expect(sdk.requestFits(sdk.buildTranslationRequest(plan.document, [sdk.encodeBlock(fixture().blocks[0])], 'zh-CN', 'technical'), { ...budget, contextWindowTokens: 1024 })).toBe(false);
});

it('cache keys ignore random IDs and credentials but include effective semantic dependencies', async () => {
  expect(typeof sdk.cacheKey).toBe('function');
  const doc = fixture(); const input = sdk.encodeBlock(doc.blocks[0]);
  const params = { input, document: doc, targetLanguage: 'zh-CN', profile: 'technical' as const, identity };
  const key = await sdk.cacheKey(params);
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(await sdk.cacheKey({ ...params, input: { ...input, id: 'new-random' }, document: { ...doc, id: 'random-document' } })).toBe(key);
  for (const change of [
    { targetLanguage: 'de' }, { profile: 'academic' as const },
    { identity: { ...identity, model: 'other' } },
    { identity: { ...identity, generation: { temperature: 0.2 } } },
    { document: { ...doc, title: 'Different meaning' } },
    { input: { ...input, sourceText: input.sourceText + ' ', protectedText: input.protectedText + ' ' } },
    { dependencies: { terminology: ['a', 'b'] } },
  ]) expect(await sdk.cacheKey({ ...params, ...change })).not.toBe(key);
});

it('fingerprints all content while retaining semantic query parameters and hash routes', async () => {
  expect(typeof sdk.documentFingerprint).toBe('function');
  const doc = fixture(100);
  const before = await sdk.documentFingerprint(doc);
  doc.id = 'different-session'; doc.blocks[99].id = 'different-block';
  expect(await sdk.documentFingerprint(doc)).toBe(before);
  doc.blocks[99].content = [{ type: 'text', text: 'Only the last paragraph changed.' }];
  expect(await sdk.documentFingerprint(doc)).not.toBe(before);
  expect(sdk.normalizeDocumentUrl('https://example.com/doc?chapter=2&utm_source=x#heading')).toBe('https://example.com/doc?chapter=2');
  expect(sdk.normalizeDocumentUrl('https://example.com/doc?chapter=2#/next')).toContain('#/next');
});

it('limits shared endpoint concurrency, removes cancelled queued work and releases failed slots', async () => {
  expect(typeof sdk.ConcurrencyScheduler).toBe('function');
  const queue = new sdk.ConcurrencyScheduler(2);
  let active = 0; let peak = 0; const release: Array<() => void> = [];
  const task = () => queue.run('endpoint', async () => {
    active++; peak = Math.max(peak, active);
    await new Promise<void>((resolve) => release.push(resolve)); active--;
  });
  const first = task(); const second = task();
  const cancelled = new AbortController();
  const third = queue.run('endpoint', async () => { throw new Error('should not run'); }, cancelled.signal);
  cancelled.abort(); await expect(third).rejects.toThrow();
  const fourth = task();
  await new Promise((r) => setTimeout(r, 0)); expect(release).toHaveLength(2);
  release.shift()!(); await first;
  await new Promise((r) => setTimeout(r, 0)); expect(peak).toBe(2);
  release.forEach((r) => r()); await Promise.all([second, fourth]);
  await expect(queue.run('endpoint', async () => { throw new Error('failure'); })).rejects.toThrow('failure');
  expect(await queue.run('endpoint', async () => 42)).toBe(42);
});
