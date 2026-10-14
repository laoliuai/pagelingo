import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('packed SDK installs outside the workspace, typechecks and runs in plain Node', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'pagelingo-sdk-package-'));
  const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 45_000, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], path.resolve('packages/translation-core')));
    assert.ok(packed.files.some((file) => file.path === 'dist/index.d.ts'));
    assert.ok(packed.files.some((file) => file.path === 'dist/testing.js'));
    assert.ok(!packed.files.some((file) => /^(src|tests|node_modules)\//.test(file.path)));
    const consumer = path.join(temporary, 'consumer');
    mkdirSync(consumer);
    writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'sdk-consumer', private: true, type: 'module' }));
    // npm ci/install populates the dependency cache first; this check itself makes no network requests.
    run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', path.join(temporary, packed.filename)], consumer);
    writeFileSync(path.join(consumer, 'consumer.mts'), `
import { OpenAICompatibleProvider, TranslationEngine, ConcurrencyScheduler, parseGlossaryFile, mergeGlossaryEntries, encodeBlock, decodeTranslation, type TranslationDocument, type CacheEntry } from '@pagelingo/translation-core';
import { MockProvider } from '@pagelingo/translation-core/testing';
if (typeof document !== 'undefined' || typeof window !== 'undefined') throw new Error('Unexpected DOM');
const input: TranslationDocument = {
  id: 'node-consumer',
  blocks: [{ id: 'p1', kind: 'paragraph', content: [
    { type: 'text', text: 'Read ' },
    { type: 'protected', id: 'ref', kind: 'citation', source: '[1]' },
  ] }],
};
let completed = 0;
for await (const result of new TranslationEngine(new MockProvider(0)).translate(input, { targetLanguage: 'zh-CN' })) {
  completed = result.completed;
  if (!result.translations[0].text.startsWith('【布局预览】')) throw new Error('Missing mock label');
  if (JSON.stringify(result.translations[0].content[1]) !== JSON.stringify(input.blocks[0].content[1])) throw new Error('Citation changed');
}
if (completed !== 1) throw new Error('Missing translation result');
const prompt: TranslationDocument = { id: 'prompt', blocks: [{ id: 'instruction', kind: 'paragraph', content: [
  { type: 'format', id: 'color', kind: 'style', children: [
    { type: 'format', id: 'underline', kind: 'underline', children: [{ type: 'text', text: 'Solve' }] },
  ] },
  { type: 'protected', id: 'variable', kind: 'literal', source: '{∗problem∗}' },
  { type: 'protected', id: 'answer', kind: 'literal', source: '____' },
] }] };
const encodedPrompt = encodeBlock(prompt.blocks[0]);
const decodedPrompt = decodeTranslation(encodedPrompt, encodedPrompt.protectedText.replace('Solve', '解答'));
if (JSON.stringify(decodedPrompt) !== JSON.stringify([
  { type: 'format', id: 'color', kind: 'style', children: [
    { type: 'format', id: 'underline', kind: 'underline', children: [{ type: 'text', text: '解答' }] },
  ] }, ...prompt.blocks[0].content.slice(1),
])) throw new Error('Portable prompt / style restoration failed');
const glossary = mergeGlossaryEntries([], parseGlossaryFile('source,target,policy,domain\\nharness engineering,harness 工程,translate,machine-learning', 'csv'));
const technical: TranslationDocument = { id: 'terms', blocks: [{ id: 'title', kind: 'heading', content: [{ type: 'text', text: 'Harness engineering' }] }] };
for await (const result of new TranslationEngine(new MockProvider(0)).translate(technical, { targetLanguage: 'zh-CN', glossary, glossaryDomain: 'machine-learning' })) {
  if (result.translations[0].text !== '【布局预览】harness 工程') throw new Error('Portable glossary application failed');
}
let requests = 0;
const provider = new OpenAICompatibleProvider({
  baseUrl: 'https://api.example.com/v1', model: 'test-model',
  fetch: async (_url, init) => {
    requests++;
    if (init?.redirect !== 'error') throw new Error('Unsafe redirect policy');
    const data = JSON.parse(JSON.parse(init!.body as string).messages[1].content);
    return Response.json({ choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify({ translations: data.blocks.map((b: { id: string }) => ({ id: b.id, text: '参阅 ⟦A0⟧' })) }),
    } }] });
  },
});
for await (const result of new TranslationEngine(provider).translate(input, { targetLanguage: 'zh-CN' })) {
  if (!result.translations[0].text.startsWith('参阅')) throw new Error('Missing provider output');
  if (JSON.stringify(result.translations[0].content[1]) !== JSON.stringify(input.blocks[0].content[1])) throw new Error('Provider changed citation');
}
if (requests !== 1) throw new Error('Unexpected provider request count');
const entries = new Map<string, CacheEntry>();
const reliable = new TranslationEngine(provider, { reliability: {
  identity: { endpoint: 'https://api.example.com/v1/chat/completions', model: 'test-model', generation: {} },
  budget: { maxInputTokens: 6000, maxOutputTokens: 4096, contextWindowTokens: 32768 },
  scheduler: new ConcurrencyScheduler(2),
  cache: { get: async (key) => entries.get(key), delete: async (key) => { entries.delete(key); },
    putMany: async (values) => { values.forEach((v) => entries.set(v.key, v)); } },
} });
for await (const result of reliable.translate(input, { targetLanguage: 'zh-CN' })) {
  if (result.completed !== 1 || result.failures?.length) throw new Error('Reliable engine failed');
}
const beforeCache = requests;
for await (const result of reliable.translate(input, { targetLanguage: 'zh-CN' })) {
  if (result.metrics?.cacheHits !== 1) throw new Error('Portable cache failed');
}
if (requests !== beforeCache) throw new Error('Cache made another request');
console.log('sdk-package-ok');
`);
    writeFileSync(path.join(consumer, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, types: [], lib: ['ES2022', 'DOM'] },
      include: ['consumer.mts'],
    }));
    run(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'), '-p', path.join(consumer, 'tsconfig.json')], consumer);
    assert.equal(run(process.execPath, ['consumer.mjs'], consumer).trim(), 'sdk-package-ok');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
