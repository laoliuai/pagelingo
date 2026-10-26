import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseGlossaryFile, TranslationEngine } from '@pagelingo/translation-core';
import { mergedGlossaryCsv, mergeTechGlossary } from '../../scripts/merge-tech-glossary.mjs';

const term = (source, target, policy = 'translate', domain = 'machine-learning') => ({ source, target, policy, domain });
const load = name => readFileSync(new URL(`../../docs/glossaries/${name}`, import.meta.url), 'utf8');

test('curated terms retain their original scope and policy instead of gaining conflicting ML entries', () => {
  const preferred = [term('baseline', '基线', 'translate', 'all'), term('accuracy', '准确率', 'keep')];
  const external = [term('Baseline', '基准'), term('Accuracy', '准确率'), term('Kernel Method', '核方法')];
  const snapshot = JSON.stringify({ preferred, external });
  const { entries } = mergeTechGlossary(preferred, external);
  assert.deepEqual(entries.filter(entry => /baseline|accuracy/iu.test(entry.source)), preferred);
  assert.deepEqual(entries.find(entry => entry.source === 'Kernel Method'), term('Kernel Method', '核方法'));
  assert.equal(JSON.stringify({ preferred, external }), snapshot);
});

test('spelling aliases inherit curated bilingual or keep policies and fixed targets', () => {
  const preferred = [term('chain of thought', '思维链', 'first-bilingual'), term('mini-batch', '小批量')];
  const external = [term('Chain-of-Thought', '旧译法'), term('Mini Batch', '小批次'), term('Minibatch', '小批次')];
  const merged = mergeTechGlossary(preferred, external);
  assert.deepEqual(merged.entries.slice(0, 3), [
    term('Chain-of-Thought', '思维链', 'first-bilingual'), term('Mini Batch', '小批量'), term('Minibatch', '小批量'),
  ]);
});

test('unchanged English targets use keep without treating a case flag as a keep policy', () => {
  const external = parseGlossaryFile('source,target,case\nNamedModel,NamedModel,1\nSVM,支持向量机,1\n', 'csv');
  assert.deepEqual(mergeTechGlossary([], external).entries, [
    term('NamedModel', 'NamedModel', 'keep'), term('SVM', '支持向量机'),
  ]);
});

test('the maintenance CSV round-trips quoted source text and multiline targets through the real importer', () => {
  const merged = mergeTechGlossary([], [term('foo, bar', '甲\n乙 "引号"')]);
  assert.deepEqual(parseGlossaryFile(mergedGlossaryCsv(merged.records), 'csv'), merged.entries);
});

test('the shipped merged CSV and JSON agree and preserve every curated preference', () => {
  const merged = parseGlossaryFile(load('merged-tech.en-zh.json'), 'json');
  assert.ok(merged.length > 2000);
  assert.deepEqual(parseGlossaryFile(load('merged-tech.en-zh.csv'), 'csv'), merged);
  const preferred = parseGlossaryFile(load('common-tech.en-zh.json'), 'json');
  assert.deepEqual(parseGlossaryFile(load('common-tech.en-zh.csv'), 'csv'), preferred);
  for (const entry of preferred) {
    assert.deepEqual(merged.find(candidate => candidate.source === entry.source && candidate.domain === entry.domain), entry);
  }
  const manifest = JSON.parse(load('merged-tech.en-zh.manifest.json'));
  assert.equal(manifest.entries, merged.length);
  for (const format of ['json', 'csv']) {
    assert.equal(createHash('sha256').update(load(`merged-tech.en-zh.${format}`)).digest('hex'), manifest.outputSha256[format]);
  }
});

test('the full glossary preserves metrics and algorithm names while using curated longer phrases', async () => {
  const glossary = parseGlossaryFile(load('merged-tech.en-zh.json'), 'json');
  const requests = [];
  const engine = new TranslationEngine({ generate: async request => {
    requests.push(request);
    return { translations: request.data.blocks.map(block => ({ id: block.id, text: block.protectedText })) };
  } });
  const source = {
    id: 'merged-terms', blocks: [{ id: 'p', kind: 'paragraph', content: [{ type: 'text', text:
      'Accuracy and precision: mixed precision. Actor-Critic Algorithm; Actor-Critic Method; PCA. Baseline and benchmark. Action Value Function.' }] }],
  };
  const translations = [];
  for await (const batch of engine.translate(source, { targetLanguage: 'zh-CN', glossary, glossaryDomain: 'machine-learning' })) {
    translations.push(...batch.translations);
  }
  assert.equal(translations[0].text,
    'Accuracy and precision: 混合精度. Actor-Critic Algorithm; Actor-Critic Method; PCA. 基线 and 基准测试. 动作价值函数.');
  assert.ok(requests[0].data.blocks[0].glossary.length < 20, 'Only matching terms belong in model requests');
  const software = [];
  for await (const batch of engine.translate(source, { targetLanguage: 'zh-CN', glossary, glossaryDomain: 'software-engineering' })) {
    software.push(...batch.translations);
  }
  assert.doesNotMatch(software[0].text, /动作价值函数/u, 'HJFY ML-only terms must not become global fixed replacements');
  assert.ok(requests.at(-1).data.blocks[0].glossary.every(entry => entry.domain !== 'machine-learning'));
});
