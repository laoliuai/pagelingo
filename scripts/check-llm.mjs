import assert from 'node:assert/strict';
import { OpenAICompatibleProvider, TranslationEngine } from '@pagelingo/translation-core';
import { readLlmConfiguration } from './llm-config.mjs';

// Local integration only. This file is not imported by the extension or Vite.
try {
  const { baseUrl, model, apiKey, responseFormat } = readLlmConfiguration();
  const usage = [];
  const provider = new OpenAICompatibleProvider({
    baseUrl, model, apiKey,
    temperature: 0.1, responseFormat, maxOutputTokens: 1024,
    thinking: new URL(baseUrl).hostname === 'api.deepseek.com' ? 'disabled' : undefined,
    onUsage: (entry) => usage.push(entry),
  });
  const input = {
    id: 'live-smoke', title: 'Technical translation smoke test', sourceLanguage: 'en',
    blocks: [
      { id: 'p1', kind: 'paragraph', sectionPath: ['Implementation'], content: [
        { type: 'text', text: 'Use ' },
        { type: 'protected', id: 'code', kind: 'code', source: 'AbortController' },
        { type: 'text', text: ' to cancel a pending request. The equation ' },
        { type: 'protected', id: 'eq', kind: 'math', source: String.raw`E = mc^2` },
        { type: 'text', text: ' must remain unchanged.' },
      ] },
      { id: 'p2', kind: 'paragraph', sectionPath: ['Evaluation'], content: [
        { type: 'text', text: 'The experiment did not show a significant improvement. Latency decreased by 15%, from 200 ms to 170 ms.' },
      ] },
      { id: 'p3', kind: 'paragraph', content: [
        { type: 'text', text: 'Read the ' },
        { type: 'format', id: 'link', kind: 'link', children: [{ type: 'text', text: 'API documentation' }] },
        { type: 'text', text: ' before changing the configuration.' },
      ] },
    ],
  };
  const started = performance.now();
  const output = [];
  for await (const batch of new TranslationEngine(provider).translate(input, { targetLanguage: 'zh-CN', profile: 'technical' })) output.push(...batch.translations);
  assert.equal(output.length, input.blocks.length);
  assert.deepEqual(output[0].content.filter((inline) => inline.type === 'protected'), input.blocks[0].content.filter((inline) => inline.type === 'protected'));
  assert.equal(output[2].content.find((inline) => inline.type === 'format')?.kind, 'link');
  for (const translation of output) assert.match(translation.text, /\p{Script=Han}/u);
  const plainText = (items) => items.map((inline) => inline.type === 'format' ? plainText(inline.children) : inline.type === 'protected' ? inline.source : inline.text).join('');
  console.log(JSON.stringify({ model, completed: output.length, elapsedMs: Math.round(performance.now() - started), usage,
    translations: output.map((entry) => ({ id: entry.id, text: plainText(entry.content) })),
    validation: 'JSON、块 ID、槽位数量及嵌套、原始代码和公式还原均通过；语义质量仍需人工评测。',
  }, null, 2));
} catch (error) {
  // ProviderError messages deliberately exclude upstream payloads and credentials.
  console.error(error instanceof Error ? error.message : '联调失败。');
  process.exitCode = 1;
}
