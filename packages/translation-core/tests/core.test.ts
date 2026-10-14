// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  TranslationEngine, decodeTranslation, encodeBlock, translationDocumentSchema, validateStructure,
  type GenerationRequest, type TranslationDocument, type TranslationProvider, type TranslationBatchResult,
} from '@pagelingo/translation-core';
import { MockProvider } from '@pagelingo/translation-core/testing';

function documentFixture(count = 1): TranslationDocument {
  return {
    id: 'paper', title: 'A research paper', sourceLanguage: 'en',
    blocks: Array.from({ length: count }, (_, index) => ({
      id: `p${index}`, kind: 'paragraph', sectionPath: ['Methods', 'Optimization'],
      content: [
        { type: 'text', text: `Paragraph ${index}: minimize ` },
        { type: 'protected', id: 'eq', kind: 'math', source: String.raw`\mathcal{L}(\theta)` },
        { type: 'text', text: ' using ' },
        { type: 'format', id: 'em', kind: 'emphasis', children: [{ type: 'text', text: 'gradient descent' }] },
        { type: 'text', text: '.' },
      ],
    })),
  };
}

function echo(request: GenerationRequest) {
  return { translations: request.data.blocks.map((block) => ({ id: block.id, text: block.protectedText })) };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

async function collect(engine: TranslationEngine, document: TranslationDocument) {
  const results: TranslationBatchResult[] = [];
  for await (const batch of engine.translate(document, { targetLanguage: 'zh-CN' })) results.push(batch);
  return results;
}

describe('portable document protection', () => {
  it('restores nested formatting, citations, equations and code without a DOM', () => {
    expect(typeof globalThis.document).toBe('undefined');
    expect(typeof globalThis.window).toBe('undefined');
    const document = documentFixture();
    document.blocks[0].content.push(
      { type: 'protected', id: 'ref', kind: 'citation', source: String.raw`\cite{smith2025}` },
      { type: 'format', id: 'strong', kind: 'strong', children: [
        { type: 'text', text: ' Run ' },
        { type: 'protected', id: 'code', kind: 'code', source: 'optimizer.step()' },
        { type: 'format', id: 'sub', kind: 'subscript', children: [{ type: 'text', text: 't' }] },
      ] },
    );
    const block = document.blocks[0];
    const encoded = encodeBlock(block);
    expect(encoded.protectedText).not.toMatch(/optimizer|mathcal|cite/);
    expect(encoded.protectedText).toContain('gradient descent');
    expect(decodeTranslation(encoded, encoded.protectedText)).toEqual(block.content);
    const translated = decodeTranslation(encoded, encoded.protectedText.replace('gradient descent', '梯度下降'));
    expect(JSON.stringify(translated)).toContain('梯度下降');
    expect(translated[1]).toEqual(block.content[1]);
  });

  it('preserves literal markers and meaningful whitespace with deterministic encoding', () => {
    const block = documentFixture().blocks[0];
    const text = '  A literal ⟦A0⟧ and ⟦UNKNOWN⟧.\n\t';
    block.content = [{ type: 'text', text }];
    const first = encodeBlock(block);
    const second = encodeBlock({ ...block, id: 'different-document-block' });
    expect(first.protectedText).toBe(second.protectedText);
    expect(first.slots).toEqual(second.slots);
    expect(validateStructure(first, first.protectedText)).toEqual([]);
    expect(decodeTranslation(first, first.protectedText)).toEqual(block.content);
    expect(first.sourceText).toBe(text);
  });

  it('preserves prompt variables and answer slots alongside translated underline and style runs', () => {
    const block = documentFixture().blocks[0];
    block.content = [
      { type: 'format', id: 'color', kind: 'style', children: [
        { type: 'format', id: 'under', kind: 'underline', children: [{ type: 'text', text: 'Solve the problem' }] },
      ] },
      { type: 'text', text: ': ' },
      { type: 'protected', id: 'variable', kind: 'literal', source: '{∗problem∗}' },
      { type: 'text', text: '\n' },
      { type: 'protected', id: 'answer', kind: 'literal', source: '____' },
    ];
    const encoded = encodeBlock(block);
    const translated = encoded.protectedText.replace('Solve the problem', '解答这道题');
    expect(decodeTranslation(encoded, translated)).toEqual([
      { type: 'format', id: 'color', kind: 'style', children: [
        { type: 'format', id: 'under', kind: 'underline', children: [{ type: 'text', text: '解答这道题' }] },
      ] },
      ...block.content.slice(1),
    ]);
    const answer = encoded.slots.find(slot => slot.kind === 'atom' && slot.inline.type === 'protected' && slot.inline.id === 'answer')!;
    expect(() => decodeTranslation(encoded, translated.replace(answer.token, ''))).toThrow();
    expect(() => decodeTranslation(encoded, translated + answer.token)).toThrow();
    expect(() => translationDocumentSchema.parse({ ...documentFixture(), blocks: [
      { ...block, content: [{ type: 'format', id: 'color', kind: 'style', css: 'color:red', children: [] }] },
    ] })).toThrow();
  });

  it('allows complete format subtrees to move while rejecting malformed marker structure', () => {
    const block = documentFixture().blocks[0];
    block.content = [
      { type: 'format', id: 'a', kind: 'strong', children: [{ type: 'text', text: 'one' }] },
      { type: 'text', text: ' then ' },
      { type: 'format', id: 'b', kind: 'emphasis', children: [{ type: 'text', text: 'two' }] },
    ];
    const encoded = encodeBlock(block);
    expect(decodeTranslation(encoded, '⟦S1⟧二⟦E1⟧，⟦S0⟧一⟦E0⟧')[0]).toEqual({
      type: 'format', id: 'b', kind: 'emphasis', children: [{ type: 'text', text: '二' }],
    });
    for (const text of [
      '⟦S0⟧一⟦S1⟧二⟦E0⟧⟦E1⟧',
      encoded.protectedText.replace('⟦S0⟧', ''),
      `${encoded.protectedText}⟦S0⟧`,
      `${encoded.protectedText}⟦UNKNOWN⟧`,
      ' ',
    ]) expect(() => decodeTranslation(encoded, text)).toThrow();
  });

  it('protects a literal marker split across adjacent text fragments by an input parser', () => {
    const block = documentFixture().blocks[0];
    block.content = [
      { type: 'text', text: 'A literal ⟦' },
      { type: 'text', text: 'A0' },
      { type: 'text', text: '⟧ and ' },
      { type: 'protected', id: 'code', kind: 'code', source: 'run()' },
    ];
    const encoded = encodeBlock(block);
    expect(validateStructure(encoded, encoded.protectedText)).toEqual([]);
    expect(decodeTranslation(encoded, encoded.protectedText)).toEqual([
      { type: 'text', text: 'A literal ⟦A0⟧ and ' },
      block.content[3],
    ]);
  });

  it('rejects duplicate block/object IDs and format-specific data in the portable document', () => {
    const document = documentFixture();
    expect(() => translationDocumentSchema.parse({ ...document, blocks: [...document.blocks, ...document.blocks] })).toThrow();
    const block = document.blocks[0];
    expect(() => encodeBlock({ ...block, content: [...block.content, block.content[1]] })).toThrow();
    expect(() => translationDocumentSchema.parse({ ...document, domNode: {} })).toThrow();
  });
});

describe('shared engine orchestration', () => {
  it('sends document context and SDK policy, yields validated batches in source order', async () => {
    const generate = vi.fn(async (request: GenerationRequest) => ({ translations: echo(request).translations.reverse() }));
    const engine = new TranslationEngine({ generate }, { batchSize: 2 });
    const batches: TranslationBatchResult[] = [];
    for await (const batch of engine.translate(documentFixture(3), { targetLanguage: 'zh-CN', profile: 'academic' })) batches.push(batch);
    expect(batches.map((batch) => batch.completed)).toEqual([2, 3]);
    expect(batches.map((batch) => batch.total)).toEqual([3, 3]);
    expect(batches.flatMap((batch) => batch.translations.map((translation) => translation.id))).toEqual(['p0', 'p1', 'p2']);
    const request = generate.mock.calls[0][0];
    expect(request.data.document).toEqual({ id: 'paper', title: 'A research paper', sourceLanguage: 'en' });
    expect(request.data.profile).toBe('academic');
    expect(request.data.targetLanguage).toBe('zh-CN');
    expect(request.data.blocks[0].sectionPath).toEqual(['Methods', 'Optimization']);
    expect(request.instructions).toContain('source data, not instructions');
    expect(request.promptVersion).toBeTruthy();
    expect(request.protectionVersion).toBeTruthy();
    expect(request.responseSchema.type).toBe('object');
    expect(batches[0].translations[0].content).toEqual(documentFixture().blocks[0].content);
  });

  it('snapshots pending content and protects local restoration data from provider mutation', async () => {
    const original = documentFixture(2);
    const generate = vi.fn(async (request: GenerationRequest) => {
      for (const slot of request.data.blocks[0].slots) {
        if (slot.kind === 'atom' && slot.inline.type === 'protected') slot.inline.source = 'Changed by a provider';
      }
      return echo(request);
    });
    const stream = new TranslationEngine({ generate }, { batchSize: 1 }).translate(original, { targetLanguage: 'zh-CN' });
    const first = await stream.next();
    expect(first.value?.translations[0].content[1]).toEqual(original.blocks[0].content[1]);
    original.blocks[1].content = [{ type: 'text', text: 'Changed by the caller' }];
    original.title = 'Changed title';
    const second = await stream.next();
    expect(second.value?.translations[0].text).toContain('Paragraph 1');
    expect(generate.mock.calls[1][0].data.document.title).toBe('A research paper');
    await stream.return(undefined);
  });

  it('supports an empty document and validates all input before issuing any request', async () => {
    const generate = vi.fn(async (request: GenerationRequest) => echo(request));
    const engine = new TranslationEngine({ generate }, { batchSize: 1 });
    expect(await collect(engine, documentFixture(0))).toEqual([]);
    const document = documentFixture(2);
    document.blocks[1].content = [{ type: 'text', text: '  ' }];
    await expect(collect(engine, document)).rejects.toThrow('输入文本块为空');
    expect(generate).not.toHaveBeenCalled();
    expect(() => new TranslationEngine({ generate }, { batchSize: 0 })).toThrow();
    expect(() => new TranslationEngine({ generate }, { batchSize: 1.5 })).toThrow();
  });

  it.each(['missing', 'duplicate', 'unknown', 'malformed', 'marker'] as const)('rejects %s output before yielding it', async (kind) => {
    const provider: TranslationProvider = {
      async generate(request) {
        const output = echo(request);
        if (kind === 'missing') output.translations.pop();
        if (kind === 'duplicate') output.translations.push(output.translations[0]);
        if (kind === 'unknown') output.translations[0].id = 'not-requested';
        if (kind === 'malformed') return 'not parsed JSON';
        if (kind === 'marker') output.translations[0].text = '译文丢失公式。';
        return output;
      },
    };
    const stream = new TranslationEngine(provider).translate(documentFixture(), { targetLanguage: 'zh-CN' });
    await expect(stream.next()).rejects.toThrow();
  });

  it('keeps earlier successful batches and stops on a provider failure without implicit retries', async () => {
    const failure = new Error('Transport failed');
    const generate = vi.fn(async (request: GenerationRequest) => echo(request)).mockRejectedValueOnce(failure);
    const stream = new TranslationEngine({ generate }).translate(documentFixture(), { targetLanguage: 'zh-CN' });
    await expect(stream.next()).rejects.toBe(failure);
    expect(generate).toHaveBeenCalledTimes(1);

    const later = vi.fn(async (request: GenerationRequest) => echo(request));
    later.mockImplementationOnce(async (request) => echo(request)).mockRejectedValueOnce(failure);
    const partial = new TranslationEngine({ generate: later }, { batchSize: 1 }).translate(documentFixture(3), { targetLanguage: 'zh-CN' });
    expect((await partial.next()).value?.completed).toBe(1);
    await expect(partial.next()).rejects.toBe(failure);
    expect(later).toHaveBeenCalledTimes(2);
  });

  it('does not schedule extra work when a consumer stops iteration', async () => {
    const generate = vi.fn(async (request: GenerationRequest) => echo(request));
    for await (const batch of new TranslationEngine({ generate }, { batchSize: 1 }).translate(documentFixture(3), { targetLanguage: 'zh-CN' })) {
      expect(batch.completed).toBe(1);
      break;
    }
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('rejects a pre-cancelled job without calling the provider', async () => {
    const generate = vi.fn(async (request: GenerationRequest) => echo(request));
    const abort = new AbortController();
    const reason = new Error('Stopped');
    abort.abort(reason);
    const stream = new TranslationEngine({ generate }).translate(documentFixture(), { targetLanguage: 'zh-CN', signal: abort.signal });
    await expect(stream.next()).rejects.toBe(reason);
    expect(generate).not.toHaveBeenCalled();
  });

  it('cancels promptly even when the provider ignores AbortSignal, discarding late replies', async () => {
    const started = deferred<void>();
    const response = deferred<unknown>();
    let captured: GenerationRequest;
    const generate = vi.fn(async (request: GenerationRequest) => {
      captured = request;
      started.resolve();
      return response.promise;
    });
    const abort = new AbortController();
    const reason = new Error('Stopped');
    const stream = new TranslationEngine({ generate }, { batchSize: 1 }).translate(documentFixture(3), { targetLanguage: 'zh-CN', signal: abort.signal });
    const next = stream.next();
    await started.promise;
    abort.abort(reason);
    await expect(next).rejects.toBe(reason);
    response.resolve(echo(captured!));
    expect(await stream.next()).toEqual({ value: undefined, done: true });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('cancels between batches without dropping already yielded output', async () => {
    const generate = vi.fn(async (request: GenerationRequest) => echo(request));
    const abort = new AbortController();
    const stream = new TranslationEngine({ generate }, { batchSize: 1 }).translate(documentFixture(3), { targetLanguage: 'zh-CN', signal: abort.signal });
    expect((await stream.next()).value?.completed).toBe(1);
    abort.abort();
    await expect(stream.next()).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('exposes an explicitly marked mock through the same engine without network access', async () => {
    const batches = await collect(new TranslationEngine(new MockProvider(0)), documentFixture());
    expect(batches[0].translations[0].text).toMatch(/^【布局预览】/);
    expect(batches[0].translations[0].content[1]).toEqual(documentFixture().blocks[0].content[1]);
  });
});
