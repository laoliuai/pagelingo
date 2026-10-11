import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('packed assistant SDK installs outside the workspace, typechecks and runs Pi in plain Node', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'pagelingo-assistant-package-'));
  const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], path.resolve('packages/assistant-core')));
    assert.ok(packed.files.some(file => file.path === 'dist/index.d.ts'));
    assert.ok(packed.files.some(file => file.path === 'README.md'));
    assert.ok(!packed.files.some(file => /^(src|tests|node_modules)\//.test(file.path)));
    const consumer = path.join(temporary, 'consumer'); mkdirSync(consumer);
    writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'assistant-consumer', private: true, type: 'module' }));
    run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', path.join(temporary, packed.filename)], consumer);
    writeFileSync(path.join(consumer, 'consumer.mts'), `
import { AssistantEngine, PiChatProvider, type ReadingDocument, type ConversationStore } from '@pagelingo/assistant-core';
if (typeof document !== 'undefined' || typeof window !== 'undefined') throw new Error('Unexpected DOM');
const article: ReadingDocument = {
  key: 'latex:node-consumer', revision: 'v1', title: 'Technical article', warnings: [],
  blocks: [{ id: 'code', kind: 'code', text: '    np.reshape(x, (2, 3))\\n', sectionPath: [] }],
};
let requests = 0;
const provider = new PiChatProvider({ baseUrl: 'https://api.example.com/v1', apiKey: 'test-key', model: 'test-model', stream: false,
  fetch: async (url, options) => {
    requests++;
    if (url !== 'https://api.example.com/v1/chat/completions' || options?.redirect !== 'error') throw new Error('Wrong transport');
    const request = JSON.parse(options!.body as string);
    const input = JSON.parse(request.messages.at(-2).content);
    if (request.messages.at(-1).content !== '解释这个函数') throw new Error('Question is not the final user message');
    if (input.document.blocks[0].text !== article.blocks[0].text || input.document.key !== article.key) throw new Error('Document corrupted');
    return Response.json({ choices: [{ message: { content: '数组重新调整形状。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  },
});
let answer = ''; let coverage = ''; let complete = false;
for await (const event of new AssistantEngine(provider).run({ document: article,
  question: { id: 'q1', role: 'user', text: '解释这个函数', quotes: [], createdAt: 1 }, history: [], mode: 'auto',
  budget: { maxInputTokens: 3000, maxOutputTokens: 500, contextWindowTokens: 4096 },
})) {
  if (event.type === 'delta') answer += event.text;
  if (event.type === 'context') coverage = event.info.coverage;
  if (event.type === 'done') complete = event.usage?.total === 15;
}
if (answer !== '数组重新调整形状。' || coverage !== 'full' || !complete || requests !== 1) throw new Error('Portable Pi execution failed');
console.log('assistant-package-ok');
`);
    writeFileSync(path.join(consumer, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, types: [], lib: ['ES2022', 'DOM'] },
      include: ['consumer.mts'],
    }));
    run(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'), '-p', path.join(consumer, 'tsconfig.json')], consumer);
    assert.equal(run(process.execPath, ['consumer.mjs'], consumer).trim(), 'assistant-package-ok');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
