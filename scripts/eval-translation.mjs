// Translation quality check with a real model. It costs money and sends the samples to your provider,
// so it only runs when asked. Structural tests elsewhere use mocks and cannot judge meaning.
// Usage: npm run eval:translation -- [--glossary <file>] [--profile technical|academic] [--mock] [--output <new-directory>]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { OpenAICompatibleProvider, TranslationEngine, PROMPT_VERSION } from '@pagelingo/translation-core';
import { readLlmConfiguration } from './llm-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  glossary: { type: 'string' }, profile: { type: 'string', default: 'technical' }, mock: { type: 'boolean', default: false },
  output: { type: 'string' }, cases: { type: 'string', default: join(root, 'evals/translation/cases.json') },
} });
const cases = JSON.parse(await readFile(values.cases, 'utf8'));
const glossary = values.glossary ? JSON.parse(await readFile(values.glossary, 'utf8')) : [];
const entries = Array.isArray(glossary) ? glossary : glossary.entries;
const usage = { promptTokens: 0, completionTokens: 0, requests: 0 };

function createProvider() {
  if (values.mock) {
    return { generate: async request => ({ translations: request.data.blocks.map(block => ({ id: block.id, text: block.protectedText })) }) };
  }
  const { baseUrl, model, apiKey, responseFormat } = readLlmConfiguration();
  return new OpenAICompatibleProvider({
    baseUrl, model, apiKey, temperature: 0.1, responseFormat, maxOutputTokens: 2048,
    thinking: new URL(baseUrl).hostname === 'api.deepseek.com' ? 'disabled' : undefined,
    timeoutMs: 120_000, firstResponseTimeoutMs: 60_000, idleTimeoutMs: 60_000,
    onUsage: entry => { usage.promptTokens += entry.promptTokens; usage.completionTokens += entry.completionTokens; usage.requests += 1; },
  });
}
const render = content => content.map(item => item.type === 'text' ? item.text : item.type === 'protected' ? item.source : render(item.children)).join('');
const cjk = text => (text.match(/\p{Script=Han}/gu) ?? []).length;

/** Mechanical signals only. They catch dropped numbers and flipped meaning; a person still reads the table. */
function grade(sample, output) {
  const problems = [];
  for (const number of sample.numbers ?? []) if (!new RegExp(`(^|[^\\d.])${number}([^\\d]|$)`).test(output)) problems.push(`缺少数字 ${number}`);
  for (const pattern of sample.mustMatch ?? []) if (!new RegExp(pattern).test(output)) problems.push(`未匹配 /${pattern}/`);
  for (const pattern of sample.mustNotMatch ?? []) if (new RegExp(pattern).test(output)) problems.push(`不应匹配 /${pattern}/`);
  for (const text of sample.mustContain ?? []) if (!output.includes(text)) problems.push(`缺少保护内容 ${text}`);
  for (const text of sample.mustNotExact ?? []) if (output.trim() === text) problems.push(`输出被样本中的指令改写为 ${text}`);
  if (cjk(output) < 2) problems.push('几乎没有中文');
  return problems;
}

const engine = new TranslationEngine(createProvider(), { batchSize: 1 });
const results = [];
for (const sample of cases) {
  const content = sample.content ?? [{ type: 'text', text: sample.text }];
  const document = { id: `eval-${sample.id}`, title: 'Translation evaluation', sourceLanguage: 'en', blocks: [{ id: sample.id, kind: sample.kind ?? 'paragraph', content }] };
  let output = '', error;
  try {
    for await (const batch of engine.translate(document, { targetLanguage: 'zh-CN', profile: values.profile, glossary: entries })) {
      output += batch.translations.map(item => render(item.content)).join('');
    }
  } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  const problems = error ? [`请求失败：${error}`] : grade(sample, output);
  results.push({ id: sample.id, category: sample.category, source: render(content), output, problems });
  console.log(`${problems.length ? '✗' : '✓'} ${sample.category} ${sample.id}${problems.length ? `  ${problems.join('；')}` : ''}`);
}
const passed = results.filter(result => !result.problems.length).length;
const summary = { promptVersion: PROMPT_VERSION, profile: values.profile, glossaryEntries: entries.length, mock: values.mock, cases: results.length, passed, usage };
console.log(JSON.stringify(summary));
if (values.output) {
  const output = resolve(values.output);
  await mkdir(output);
  await writeFile(join(output, 'results.json'), `${JSON.stringify({ summary, results }, null, 2)}\n`);
  const escape = text => text.replaceAll('|', '\\|').replaceAll('\n', ' ');
  await writeFile(join(output, 'report.md'), [
    '# 翻译评测', '', `${passed}/${results.length} 通过机械检查（提示词版本 ${PROMPT_VERSION}，${values.profile}，术语 ${entries.length} 条）。机械检查只能发现明显错误，下表需要人工通读。`, '',
    '| 类别 | 原文 | 译文 | 问题 |', '| --- | --- | --- | --- |',
    ...results.map(result => `| ${result.category} | ${escape(result.source)} | ${escape(result.output)} | ${escape(result.problems.join('；'))} |`), '',
  ].join('\n'));
}
if (!values.mock && passed < results.length) process.exitCode = 1;
