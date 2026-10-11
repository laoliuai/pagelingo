import { describe, expect, it } from 'vitest';
import {
  AssistantEngine,
  buildContext,
  historyEvictions,
  webDocumentKey,
  type AssistantInput,
  type ChatProvider,
} from '../src/index.js';

const input = (): AssistantInput => ({
  document: {
    key: 'paper:1',
    revision: 'v1',
    title: 'Technical reading',
    blocks: [
      { id: 'h', kind: 'heading', text: 'NumPy', sectionPath: ['NumPy'] },
      { id: 'p', kind: 'paragraph', text: 'This function reshapes the array.', sectionPath: ['NumPy'] },
      {
        id: 'c',
        kind: 'code',
        text: 'result = np.reshape(x, (2, 3))\n    print(result)',
        sectionPath: ['NumPy'],
      },
    ],
    warnings: [],
  },
  question: { id: 'q', role: 'user', text: '解释一下这个函数', quotes: [], createdAt: 1 },
  history: [],
  mode: 'auto',
  budget: { maxInputTokens: 3000, maxOutputTokens: 500, contextWindowTokens: 4096 },
});
describe('document identity and retention', () => {
  it('removes tracking and section anchors while retaining semantic queries and hash routes', () => {
    expect(webDocumentKey('https://site.test/post?id=2&utm_source=x#section')).toBe(
      'web:https://site.test/post?id=2',
    );
    expect(webDocumentKey('https://site.test/post?id=3')).not.toBe(
      webDocumentKey('https://site.test/post?id=2'),
    );
    expect(webDocumentKey('https://site.test/#/article/2')).not.toBe(
      webDocumentKey('https://site.test/#/article/3'),
    );
    expect(() => webDocumentKey('https://user:secret@site.test/')).toThrow();
  });
  it('evicts by oldest use, enforcing both limits and retaining protected sessions', () => {
    const rows = [
      { key: 'a', updatedAt: 1, bytes: 10 },
      { key: 'b', updatedAt: 2, bytes: 10 },
      { key: 'c', updatedAt: 3, bytes: 80 },
    ];
    expect(historyEvictions(rows, { count: 2, bytes: 90 })).toEqual(['a']);
    expect(historyEvictions(rows, { count: 1, bytes: 20 }, new Set(['a']))).toEqual(['b', 'c']);
  });
});
describe('context selection', () => {
  it('keeps a short phrase distinct from its containing paragraph and an earlier paragraph explanation', () => {
    const x = input();
    const paragraph =
      'Reinforcement learning (RL) has played a crucial role throughout the history of large language models. ' +
      'This introduction describes the full evolution of policy gradient methods. '.repeat(12);
    x.document.blocks = Array.from({ length: 100 }, (_, i) => ({
      id: `r${i}`,
      kind: 'paragraph',
      text: i === 5 ? paragraph : 'Background on policy gradients and training experiments. '.repeat(30),
      sectionPath: ['Reinforcement Learning for LLMs'],
    }));
    x.question.text = '这是什么意思？';
    x.question.quotes = [
      {
        id: 'term',
        documentKey: x.document.key,
        revision: 'v1',
        label: x.document.title,
        text: 'Reinforcement learning',
        kind: 'text',
        blockIds: ['r5'],
      },
    ];
    x.history = [
      { id: 'old-q', role: 'user', text: '解释文章开头的段落', quotes: [], createdAt: 0 },
      {
        id: 'old-a',
        role: 'assistant',
        text: '这段引言介绍了文章的路线图。',
        status: 'completed',
        createdAt: 0,
      },
    ];
    const { request, info } = buildContext(x);
    const last = request.messages.at(-1)!;
    const background = JSON.parse(request.messages.at(-2)!.content);
    expect(info.coverage).toBe('partial');
    expect(last.role).toBe('user');
    expect(last.content).toContain('\nReinforcement learning\n');
    expect(last.content.endsWith('这是什么意思？')).toBe(true);
    expect(last.content).not.toContain('crucial role');
    expect(last.content).not.toContain('r5');
    expect(last.content).not.toContain('路线图');
    expect(background.document.blocks.find((b: { id: string }) => b.id === 'r5').text).toBe(paragraph);
    expect(background.selectionSources[0].sourceBlockIds).toEqual(['r5']);
    expect(background.selectionSources[0]).not.toHaveProperty('text');
  });
  it('keeps multiple verbatim references including Markdown fences and original code whitespace', () => {
    const x = input();
    const selected = '    ```python\n    print("\\t")\n    ```\n';
    x.question.quotes = [selected, 'Reinforcement learning'].map((text, i) => ({
      id: `selection-${i}`,
      documentKey: x.document.key,
      revision: 'v1',
      label: 'Source chapter',
      text,
      kind: i === 0 ? 'code' : 'text',
      blockIds: ['p'],
    }));
    const { request } = buildContext(x);
    const content = request.messages.at(-1)!.content;
    expect(content).toContain(selected);
    expect(content).toContain('\n````\n' + selected + '\n````');
    expect(content.indexOf(selected)).toBeLessThan(content.indexOf('Reinforcement learning'));
    expect(content).not.toContain('Source chapter');
    expect(content.endsWith(x.question.text)).toBe(true);
  });
  it.each(['auto', 'full', 'selection'] as const)(
    'identifies the selected passage as the target of a vague question in %s mode',
    (mode) => {
      const x = input();
      x.mode = mode;
      x.document.title = 'Scaling the wrong thing';
      x.document.blocks = [
        { id: 'h', kind: 'heading', text: x.document.title, sectionPath: [x.document.title] },
        {
          id: 'p',
          kind: 'paragraph',
          text: 'We used kubernetes to scale the infrastructure.',
          sectionPath: [x.document.title],
        },
      ];
      x.question.text = '解释一下这个东西';
      x.question.quotes = [
        {
          id: 'selected-term',
          documentKey: x.document.key,
          revision: x.document.revision,
          label: x.document.title,
          kind: 'text',
          text: 'kubernetes',
          blockIds: ['p'],
        },
      ];
      const { request } = buildContext(x);
      const data = JSON.parse(request.messages.at(-2)!.content);
      const prompt = request.messages.at(-1)!.content;
      expect(prompt).toContain('\n```\nkubernetes\n```');
      expect(prompt.endsWith('解释一下这个东西')).toBe(true);
      expect(data.document.title).toBe('Scaling the wrong thing');
      expect(data.referenceOnly).toBe(true);
      expect(data.selectionSources[0].sourceBlockIds).toEqual(['p']);
      expect(prompt).not.toContain(x.document.title);
      expect(prompt).not.toContain(x.document.blocks[1].text);
      expect(prompt).not.toContain('blockIds');
      expect(data.document.blocks).toHaveLength(mode === 'selection' ? 0 : 2);
    },
  );
  it('provides a complete small document and preserves code whitespace', () => {
    const context = buildContext(input());
    expect(context.info.coverage).toBe('full');
    const data = JSON.parse(context.request.messages.at(-2)!.content);
    expect(data.document.blocks[2].text).toBe(input().document.blocks[2].text);
    expect(context.request.messages.at(-1)!.content).toBe('解释一下这个函数');
  });
  it('keeps explicit references intact and chooses neighboring blocks in a large document', () => {
    const x = input();
    x.document.blocks = Array.from({ length: 100 }, (_, i) => ({
      id: `b${i}`,
      kind: 'paragraph',
      text: 'unrelated text '.repeat(30),
      sectionPath: ['Section'],
    }));
    x.question.quotes = [
      {
        id: 'quote',
        documentKey: x.document.key,
        revision: 'v1',
        label: 'Code',
        kind: 'code',
        text: 'np.reshape(x, (2, 3))',
        blockIds: ['b70'],
      },
    ];
    const context = buildContext(x);
    const data = JSON.parse(context.request.messages.at(-2)!.content);
    expect(context.info.coverage).toBe('partial');
    expect(data.document.blocks.some((b: { id: string }) => b.id === 'b70')).toBe(true);
    expect(context.request.messages.at(-1)!.content).toContain(x.question.quotes[0].text);
    expect(context.info.inputTokens).toBeLessThanOrEqual(x.budget.maxInputTokens);
  });
  it('rejects oversized full context or explicit quotes instead of silently clipping them', () => {
    const x = input();
    x.document.blocks[1].text = 'word '.repeat(3000);
    x.mode = 'full';
    expect(() => buildContext(x)).toThrow(/全文/);
    x.mode = 'selection';
    x.question.quotes = [
      {
        id: 'q1',
        documentKey: x.document.key,
        revision: 'v1',
        label: 'Reference',
        kind: 'text',
        text: 'word '.repeat(3000),
        blockIds: [],
      },
    ];
    expect(() => buildContext(x)).toThrow(/引用|问题/);
  });
  it('rejects cross-document references and duplicate block IDs', () => {
    const x = input();
    x.question.quotes = [
      {
        id: 'q1',
        documentKey: 'another',
        revision: 'v1',
        label: 'Reference',
        kind: 'text',
        text: 'selected',
        blockIds: [],
      },
    ];
    expect(() => buildContext(x)).toThrow(/文章/);
    x.question.quotes = [];
    x.document.blocks.push(x.document.blocks[0]);
    expect(() => buildContext(x)).toThrow();
  });
  it('does not send interrupted answers as established history', () => {
    const x = input();
    x.history = [
      {
        id: 'old',
        role: 'assistant',
        text: 'incorrect unfinished answer',
        status: 'interrupted',
        createdAt: 0,
      },
    ];
    expect(JSON.stringify(buildContext(x).request)).not.toContain('incorrect unfinished answer');
  });
  it('finds Latin function names embedded in Chinese questions on a long article', () => {
    const x = input();
    x.question.text = '解释np.reshape的用法';
    x.document.blocks = Array.from({ length: 100 }, (_, i) => ({
      id: `b${i}`,
      kind: 'paragraph',
      text:
        i === 90 ? 'np.reshape changes the array shape. '.repeat(30) : 'Unrelated introduction. '.repeat(30),
      sectionPath: [],
    }));
    const context = buildContext(x);
    const data = JSON.parse(context.request.messages.at(-2)!.content);
    expect(context.info.coverage).toBe('partial');
    expect(data.document.blocks.some((b: { id: string }) => b.id === 'b90')).toBe(true);
  });
  it('reduces a large outline before discarding mandatory questions and references', () => {
    const x = input();
    x.mode = 'selection';
    x.budget.maxInputTokens = 1500;
    x.document.blocks = Array.from({ length: 100 }, (_, i) => ({
      id: `h${i}`,
      kind: 'heading',
      text: 'A very long section title '.repeat(12),
      sectionPath: [],
    }));
    x.question.quotes = [
      {
        id: 'ref',
        documentKey: x.document.key,
        revision: 'v1',
        label: 'Reference',
        kind: 'text',
        text: 'explicit reference',
        blockIds: [],
      },
    ];
    const context = buildContext(x);
    const data = JSON.parse(context.request.messages.at(-2)!.content);
    expect(context.request.messages.at(-1)!.content).toContain('explicit reference');
    expect(context.info.inputTokens).toBeLessThanOrEqual(1500);
    expect(data.document.outline.length).toBeLessThan(30);
  });
});
it('streams an answer through the provider without mutating caller data', async () => {
  const provider: ChatProvider = {
    async *stream() {
      yield { type: 'delta', text: '中文' };
      yield { type: 'done', usage: { input: 20, output: 2, total: 22 } };
    },
  };
  const x = input();
  const before = JSON.stringify(x);
  const events = [];
  for await (const event of new AssistantEngine(provider).run(x)) events.push(event);
  expect(events.map((e) => e.type)).toEqual(['context', 'delta', 'done']);
  expect(JSON.stringify(x)).toBe(before);
});
it('summarizes older history while retaining original records and the latest complete turns', async () => {
  const x = input();
  x.budget.maxInputTokens = 4000;
  x.budget.contextWindowTokens = 8192;
  x.history = Array.from({ length: 12 }, (_, i) =>
    i % 2 === 0
      ? { id: `m${i}`, role: 'user' as const, text: 'Earlier question '.repeat(50), quotes: [], createdAt: i }
      : {
          id: `m${i}`,
          role: 'assistant' as const,
          text: 'Earlier answer '.repeat(50),
          status: 'completed' as const,
          createdAt: i,
        },
  );
  const snapshot = JSON.stringify(x);
  const requests: unknown[] = [];
  const provider: ChatProvider = {
    async *stream(r) {
      requests.push(r);
      yield { type: 'delta', text: r.messages[0].content.startsWith('Summarize') ? '记忆摘要' : '当前回答' };
      yield { type: 'done' };
    },
  };
  const events = [];
  for await (const e of new AssistantEngine(provider).run(x)) events.push(e);
  const summary = events.find((e) => e.type === 'summary');
  expect(summary?.type === 'summary' && summary.summary.throughId).toBe('m7');
  expect(events.at(-1)?.type).toBe('done');
  expect(requests.length).toBeGreaterThan(1);
  expect(JSON.stringify(x)).toBe(snapshot);
});
it('does not spend summary requests when mandatory references already exceed the budget', async () => {
  const x = input();
  x.history = Array.from({ length: 12 }, (_, i) =>
    i % 2 === 0
      ? { id: `m${i}`, role: 'user' as const, text: 'Earlier question '.repeat(40), quotes: [], createdAt: i }
      : {
          id: `m${i}`,
          role: 'assistant' as const,
          text: 'Earlier answer '.repeat(40),
          status: 'completed' as const,
          createdAt: i,
        },
  );
  x.question.quotes = [
    {
      id: 'oversized',
      documentKey: x.document.key,
      revision: 'v1',
      label: 'Reference',
      kind: 'text',
      text: 'explicit quote '.repeat(1000),
      blockIds: [],
    },
  ];
  let calls = 0;
  const provider: ChatProvider = {
    async *stream() {
      calls++;
      yield { type: 'done' };
    },
  };
  await expect(async () => {
    for await (const _ of new AssistantEngine(provider).run(x)) {
      /* Collect to completion. */
    }
  }).rejects.toThrow(/预算/);
  expect(calls).toBe(0);
});
it('uses only a summary whose boundary exists, retaining recent turns and excluding unfinished answers', () => {
  const x = input();
  x.history = [
    { id: 'u1', role: 'user', text: 'Old question', quotes: [], createdAt: 1 },
    { id: 'a1', role: 'assistant', text: 'Old answer', status: 'completed', createdAt: 2 },
    { id: 'u2', role: 'user', text: 'Recent question', quotes: [], createdAt: 3 },
    { id: 'a2', role: 'assistant', text: 'Recent answer', status: 'completed', createdAt: 4 },
  ];
  x.summary = { throughId: 'a1', text: 'Earlier memory' };
  const serialized = JSON.stringify(buildContext(x).request);
  expect(serialized).toContain('Earlier memory');
  expect(serialized).toContain('Recent answer');
  expect(serialized).not.toContain('Old answer');
  x.summary = { throughId: 'missing', text: 'Invalid memory' };
  const fallback = JSON.stringify(buildContext(x).request);
  expect(fallback).toContain('Old answer');
  expect(fallback).not.toContain('Invalid memory');
});
it('omits unfinished answers and invalid old memory from summary requests', async () => {
  const x = input();
  x.budget.maxInputTokens = 4000;
  x.budget.contextWindowTokens = 8192;
  x.history = [
    { id: 'failed-u', role: 'user', text: 'Unfinished question', quotes: [], createdAt: 0 },
    { id: 'failed-a', role: 'assistant', text: 'UNFINISHED_ERROR_TEXT', status: 'error', createdAt: 0 },
    ...Array.from({ length: 12 }, (_, i) =>
      i % 2 === 0
        ? {
            id: `m${i}`,
            role: 'user' as const,
            text: 'Earlier question '.repeat(50),
            quotes: [],
            createdAt: i,
          }
        : {
            id: `m${i}`,
            role: 'assistant' as const,
            text: 'Earlier answer '.repeat(50),
            status: 'completed' as const,
            createdAt: i,
          },
    ),
  ];
  x.summary = { throughId: 'missing', text: 'INVALID_OLD_MEMORY' };
  const requests: string[] = [];
  const provider: ChatProvider = {
    async *stream(r) {
      requests.push(JSON.stringify(r));
      yield { type: 'delta', text: 'memory and answer' };
      yield { type: 'done' };
    },
  };
  for await (const _ of new AssistantEngine(provider).run(x)) {
    /* drain */
  }
  expect(requests.length).toBeGreaterThan(1);
  expect(requests.join('')).not.toContain('UNFINISHED_ERROR_TEXT');
  expect(requests.join('')).not.toContain('INVALID_OLD_MEMORY');
});
