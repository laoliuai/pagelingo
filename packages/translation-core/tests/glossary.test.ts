import { describe, expect, it } from 'vitest';
import * as sdk from '@pagelingo/translation-core';
import type { GlossaryEntry, GenerationRequest, TranslationDocument } from '@pagelingo/translation-core';
import { applyGlossary, restoreGlossaryText } from '../src/terminology.js';

const term = (source: string, target: string, domain: GlossaryEntry['domain'] = 'all'): GlossaryEntry =>
  ({ source, target, policy: 'translate', domain });

describe('personal glossary maintenance', () => {
  it('overwrites by normalized source and domain using the last occurrence', () => {
    expect(typeof sdk.mergeGlossaryEntries).toBe('function');
    expect(sdk.mergeGlossaryEntries([term('token', '旧译文')], [term(' Token ', '中间译文'), term('TOKEN', '词元')]))
      .toEqual([term('TOKEN', '词元')]);
  });
  it('preserves entries absent from the import and distinct domains', () => {
    expect(typeof sdk.mergeGlossaryEntries).toBe('function');
    const result = sdk.mergeGlossaryEntries([term('token', '令牌'), term('agent', '代理')], [term('token', '词元', 'machine-learning')]);
    expect(result).toEqual([term('token', '令牌'), term('agent', '代理'), term('token', '词元', 'machine-learning')]);
  });
  it('rejects invalid incoming entries before producing a partial merge', () => {
    expect(typeof sdk.mergeGlossaryEntries).toBe('function');
    expect(() => sdk.mergeGlossaryEntries([term('token', '令牌')], [term('agent', '智能体'), term('token', '')])).toThrow();
  });
  it('reads the existing pure JSON array with a BOM and validates its entries', () => {
    expect(typeof sdk.parseGlossaryFile).toBe('function');
    expect(sdk.parseGlossaryFile('\uFEFF' + JSON.stringify([term('harness engineering', 'harness 工程')]), 'json'))
      .toEqual([term('harness engineering', 'harness 工程')]);
    expect(() => sdk.parseGlossaryFile('{"apiKey":"not-a-glossary"}', 'json')).toThrow();
  });
  it('reads CSV with quoted commas, quotes, line breaks, BOM and ignored notes', () => {
    expect(typeof sdk.parseGlossaryFile).toBe('function');
    const csv = '\uFEFFsource,target,policy,domain,notes\r\n"foo, bar","甲\n乙 ""引号""",translate,all,"备注,说明"\r\n';
    expect(sdk.parseGlossaryFile(csv, 'csv')).toEqual([term('foo, bar', '甲\n乙 "引号"')]);
  });
  it('accepts two-column tab-separated text and supplies defaults', () => {
    expect(typeof sdk.parseGlossaryFile).toBe('function');
    expect(sdk.parseGlossaryFile('source\ttarget\nharness\t\nRSI\t递归自我改进\n', 'tsv'))
      .toEqual([{ source: 'harness', target: '', policy: 'keep', domain: 'all' }, term('RSI', '递归自我改进')]);
  });
  it('rejects malformed CSV, missing headers, invalid policies and an oversized unique glossary', () => {
    expect(typeof sdk.parseGlossaryFile).toBe('function');
    for (const text of ['source,target\n"unterminated,x', 'source,source\na,b', 'source,target,policy\na,b,bogus', 'source,target\na,b,c']) {
      expect(() => sdk.parseGlossaryFile(text, 'csv')).toThrow();
    }
    expect(() => sdk.mergeGlossaryEntries([], Array.from({ length: sdk.MAX_GLOSSARY_ENTRIES + 1 }, (_, i) => term(`term${i}`, '译文')))).toThrow();
  });
  it('rejects reserved marker delimiters before hard-output terms can synthesize adapter markers', () => {
    for (const target of ['⟦A999', '999⟧', '⟦A999⟧']) expect(() => sdk.mergeGlossaryEntries([], [term('term', target)])).toThrow();
  });
  it('can reimport an exported maximum-size non-ASCII glossary', () => {
    const entries = Array.from({ length: sdk.MAX_GLOSSARY_ENTRIES }, (_, i) => term(`${i}${'词'.repeat(115)}`, '译'.repeat(240)));
    expect(sdk.parseGlossaryFile(JSON.stringify(entries, null, 2), 'json')).toHaveLength(sdk.MAX_GLOSSARY_ENTRIES);
  });
  it('rejects an oversized file before parsing it', () => {
    expect(() => sdk.parseGlossaryFile(' '.repeat(sdk.MAX_GLOSSARY_FILE_BYTES + 1), 'csv')).toThrow('MiB');
  });
});

const document: TranslationDocument = {
  id: 'doc', title: 'Harness Engineering', blocks: [
    { id: 'title', kind: 'heading', content: [{ type: 'text', text: 'Harness engineering for RSI' }] },
    { id: 'body', kind: 'paragraph', content: [
      { type: 'text', text: 'The harness uses tokens, not tokenization. ' },
      { type: 'format', id: 'em', kind: 'emphasis', children: [{ type: 'text', text: 'harness' }] },
      { type: 'protected', id: 'code', kind: 'code', source: 'harness(token)' },
    ] },
  ],
};
const glossary: GlossaryEntry[] = [
  { source: 'harness', target: '', policy: 'keep', domain: 'machine-learning' },
  term('harness engineering', 'harness 工程', 'machine-learning'),
  { source: 'RSI', target: '递归自我改进', policy: 'first-bilingual', domain: 'all' },
  term('tokens', '词元', 'machine-learning'),
];
const echo = (request: GenerationRequest) => ({ translations: request.data.blocks.map(b => ({ id: b.id, text: '译文：' + b.protectedText })) });
const collect = async (engine: sdk.TranslationEngine, options: sdk.TranslationOptions) => {
  const batches = []; for await (const batch of engine.translate(document, options)) batches.push(batch);
  return batches.flatMap(b => b.translations);
};

describe('glossary application shared by page and document adapters', () => {
  it('applies longest phrases consistently to the heading and body while preserving code and formatting', async () => {
    const engine = new sdk.TranslationEngine({ generate: async request => echo(request) });
    const result = await collect(engine, { targetLanguage: 'zh-CN', glossary, glossaryDomain: 'machine-learning' });
    expect(result[0].text).toBe('译文：harness 工程 for 递归自我改进（RSI）');
    expect(result[1].text).toBe('译文：The harness uses 词元, not tokenization. ⟦S0⟧harness⟦E0⟧⟦A1⟧');
    expect(result[1].content.at(-1)).toEqual({ type: 'protected', id: 'code', kind: 'code', source: 'harness(token)' });
  });
  it('restricts domain-specific terms and gives the selected domain priority over all-domain terms', async () => {
    const engine = new sdk.TranslationEngine({ generate: async request => echo(request) });
    const entries = [term('harness', '通用含义'), term('harness', '领域含义', 'machine-learning')];
    expect((await collect(engine, { targetLanguage: 'zh-CN', glossary: entries, glossaryDomain: 'machine-learning' }))[1].text)
      .toContain('The 领域含义 uses tokens');
    expect((await collect(engine, { targetLanguage: 'zh-CN', glossary: entries, glossaryDomain: 'physics' }))[1].text)
      .toContain('The 通用含义 uses tokens');
  });
  it('does not match words inside longer identifiers or protected code', async () => {
    const engine = new sdk.TranslationEngine({ generate: async request => echo(request) });
    const result = await collect(engine, { targetLanguage: 'zh-CN', glossary: [term('token', '令牌')], glossaryDomain: 'all' });
    expect(result[1].text).toContain('tokens, not tokenization');
    expect(result[1].content.at(-1)).toMatchObject({ source: 'harness(token)' });
  });
  it('rejects a missing terminology marker instead of accepting an unconstrained translation', async () => {
    const engine = new sdk.TranslationEngine({ generate: async request => ({ translations: request.data.blocks.map(b => ({ id: b.id, text: '错误译文' })) }) });
    const stream = engine.translate({ ...document, blocks: [document.blocks[0]] }, { targetLanguage: 'zh-CN', glossary, glossaryDomain: 'machine-learning' });
    await expect(stream.next()).rejects.toThrow();
  });
  it('restores terms from the local snapshot even when a provider mutates its request', async () => {
    const engine = new sdk.TranslationEngine({ generate: async request => {
      const result = echo(request);
      for (const b of request.data.blocks) for (const s of b.slots) if (s.kind === 'atom' && s.inline.type === 'text') s.inline.text = 'provider tampering';
      return result;
    } });
    const result = await collect(engine, { targetLanguage: 'zh-CN', glossary, glossaryDomain: 'machine-learning' });
    expect(result[0].text).toContain('harness 工程');
    expect(result[0].text).not.toContain('provider tampering');
  });
  it('respects word boundaries even when formatting splits a longer word', async () => {
    const engine = new sdk.TranslationEngine({ generate: async request => echo(request) });
    const source: TranslationDocument = { id: 'boundary', blocks: [{ id: 'p', kind: 'paragraph', content: [
      { type: 'text', text: 'micro' }, { type: 'format', id: 'part', kind: 'emphasis', children: [{ type: 'text', text: 'token' }] },
      { type: 'text', text: 'ization and ' }, { type: 'format', id: 'whole', kind: 'emphasis', children: [{ type: 'text', text: 'token' }] },
    ] }] };
    const batch = await engine.translate(source, { targetLanguage: 'zh-CN', glossary: [term('token', '词元')] }).next();
    expect(batch.value?.translations[0].text).toBe('译文：micro⟦S0⟧token⟦E0⟧ization and ⟦S1⟧词元⟦E1⟧');
  });
  it('tries a shorter whole-word term when the longer phrase only matches a word prefix', async () => {
    const source: TranslationDocument = { id: 'shorter', blocks: [{ id: 'p', kind: 'paragraph', content: [{ type: 'text', text: 'The neural networks work.' }] }] };
    const engine = new sdk.TranslationEngine({ generate: async request => echo(request) });
    const batch = await engine.translate(source, { targetLanguage: 'zh-CN', glossary: [term('neural network', '神经网络'), term('neural', '神经')] }).next();
    expect(batch.value?.translations[0].text).toBe('译文：The 神经 networks work.');
  });
  it.each([['μ', 'µ'], ['σ', 'ς'], ['k', 'K']])('handles Unicode case folding for %s and %s without losing the matched entry', async (key, text) => {
    const source: TranslationDocument = { id: 'unicode', blocks: [{ id: 'p', kind: 'paragraph', content: [{ type: 'text', text }] }] };
    const engine = new sdk.TranslationEngine({ generate: async request => echo(request) });
    const batch = await engine.translate(source, { targetLanguage: 'zh-CN', glossary: [term(key, '符号')] }).next();
    expect(batch.value?.translations[0].text).toBe('译文：符号');
  });
  it('splits a glossary-dense paragraph without repeating the full block glossary in each unit', async () => {
    const entries = Array.from({ length: 100 }, (_, i) => term(`term${i}`, '对应的中文技术术语翻译'));
    const source: TranslationDocument = { id: 'long', blocks: [{ id: 'p', kind: 'paragraph', content: [{ type: 'text', text:
      Array.from({ length: 100 }, (_, i) => `term${i} is a supported technical concept. `).join('') }] }] };
    const engine = new sdk.TranslationEngine({ generate: async request => echo(request) }, { reliability: {
      identity: { endpoint: 'https://api.example.com/v1/chat/completions', model: 'fixture', generation: {} },
      budget: { maxInputTokens: 6000, maxOutputTokens: 4096, contextWindowTokens: 32768 }, backoffMs: 0,
    } });
    const result: sdk.TranslationBatchResult[] = [];
    for await (const batch of engine.translate(source, { targetLanguage: 'zh-CN', glossary: entries })) result.push(batch);
    expect(result.at(-1)?.completed).toBe(1);
    expect(result.flatMap(batch => batch.failures ?? [])).toEqual([]);
    expect(result.flatMap(batch => batch.translations).at(-1)?.text.match(/对应的中文技术术语翻译/g)).toHaveLength(100);
  });
  it('retains a soft preference on both sides of a phrase split by the request budget', async () => {
    const source: TranslationDocument = { id: 'soft', blocks: [{ id: 'p', kind: 'paragraph', content: [{ type: 'text', text:
      'prefix '.repeat(81) + 'neural network' + ' suffix'.repeat(100) }] }] };
    const requested: GenerationRequest['data']['blocks'] = [];
    const engine = new sdk.TranslationEngine({ generate: async request => { requested.push(...request.data.blocks); return echo(request); } }, { reliability: {
      identity: { endpoint: 'https://api.example.com/v1/chat/completions', model: 'fixture', generation: {} },
      budget: { maxInputTokens: 1800, maxOutputTokens: 1000, contextWindowTokens: 16000 }, backoffMs: 0,
    } });
    for await (const _batch of engine.translate(source, { targetLanguage: 'zh-CN', glossary: [
      { source: 'neural network', target: '上下文说明', policy: 'prefer-source', domain: 'all' },
    ] })) { /* Inspect the real model-facing requests. */ }
    const affected = requested.filter(input => /neural|network/.test(input.protectedText));
    expect(affected.length).toBeGreaterThan(0);
    expect(affected.every(input => input.glossary?.some(entry => entry.source === 'neural network'))).toBe(true);
    expect(requested.filter(input => !/neural|network/.test(input.protectedText)).every(input => !input.glossary?.length)).toBe(true);
  });
});

describe('spacing around restored glossary terms', () => {
  const restored = (source: string, entries: GlossaryEntry[], translated: (token: string[]) => string) => {
    const input = applyGlossary(sdk.encodeBlock({ id: 'b', kind: 'paragraph', content: [{ type: 'text', text: source }] }), entries, 'all');
    const tokens = input.terminologyTokens ?? [];
    const text = translated(tokens);
    return { input, text, decoded: sdk.decodeTranslation(input, text), restored: restoreGlossaryText(input, text) };
  };
  const zh = [term('encoder', '编码器'), term('decoder', '解码器')];
  it('closes gaps the model leaves around Chinese terms', () => {
    const { decoded, restored: text } = restored('encoder and decoder', zh, ([a, b]) => `在 ${a} 和 ${b} 之间`);
    expect(decoded).toEqual([{ type: 'text', text: '在编码器和解码器之间' }]);
    expect(text).toBe('在编码器和解码器之间');
  });
  it('closes the gap between two adjacent Chinese terms', () => {
    const { decoded } = restored('encoder decoder', zh, ([a, b]) => `${a} ${b}`);
    expect(decoded).toEqual([{ type: 'text', text: '编码器解码器' }]);
  });
  it('keeps normal spacing beside Latin words and terms kept in English', () => {
    expect(restored('encoder', zh, ([a]) => `the ${a} works`).decoded).toEqual([{ type: 'text', text: 'the 编码器 works' }]);
    const kept: GlossaryEntry[] = [{ source: 'accuracy', target: 'accuracy', policy: 'keep', domain: 'all' }];
    expect(restored('accuracy', kept, ([a]) => `提高 ${a} 指标`).decoded).toEqual([{ type: 'text', text: '提高 accuracy 指标' }]);
  });
  it('leaves spacing beside code and formulas alone', () => {
    const input = applyGlossary(sdk.encodeBlock({ id: 'b', kind: 'paragraph', content: [{ type: 'text', text: 'encoder ' }, { type: 'protected', id: 'c', kind: 'code', source: 'run()' }] }), zh, 'all');
    const code = input.slots.find(slot => slot.kind === 'atom' && slot.inline.type === 'protected')!.token;
    const content = sdk.decodeTranslation(input, `调用 ${code} 的 ${input.terminologyTokens![0]}`);
    expect(content[0]).toEqual({ type: 'text', text: '调用 ' });
    expect(content[2]).toEqual({ type: 'text', text: ' 的编码器' });
  });
});
