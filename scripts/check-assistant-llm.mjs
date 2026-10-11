import assert from 'node:assert/strict';
import { AssistantEngine, PiChatProvider } from '@pagelingo/assistant-core';
import { readLlmConfiguration } from './llm-config.mjs';

// Explicit live smoke only. Default checks never read credentials or call a real model.
const intro =
  'Reinforcement learning (RL) has played a crucial role throughout the history of research on large language models (LLMs). Through RL, we created early versions of instruction following models, made important advancements in alignment and safety, and enabled LLMs to solve complex reasoning problems. Despite the many breakthroughs, however, RL remains one of the most rapidly evolving areas in AI research. Many of the most pressing problems we are trying to solve today—reasoning, knowledge work, agents, token efficiency, reliability, and more—are being addressed through RL. In this overview, we will work up to the frontier of RL research by starting from first principles. In a single overview, we will cover the fundamentals of RL, the full evolution of policy gradient algorithms currently used to train LLMs, and several recent areas of emerging research in RL.';
const cases = [
  {
    key: 'smoke:kubernetes',
    title: 'Scaling the wrong thing',
    selection: 'kubernetes',
    question: '解释一下这个东西',
    blocks: [
      { id: 'h', kind: 'heading', text: 'Scaling the wrong thing', sectionPath: [] },
      {
        id: 'p',
        kind: 'paragraph',
        text: 'We scaled the wrong part of our infrastructure using kubernetes before identifying the bottleneck.',
        sectionPath: [],
      },
    ],
    blockIds: ['p'],
    history: [],
    expectedName: /kubernetes/i,
    expectedConcept: /容器|编排/u,
    coverage: 'full',
  },
  {
    key: 'smoke:rl-selection',
    title: 'Reinforcement Learning for LLMs: The Complete Guide',
    selection: 'Reinforcement learning',
    question: '这是什么意思？',
    blocks: Array.from({ length: 100 }, (_, i) => ({
      id: `r${i}`,
      kind: 'paragraph',
      text:
        i === 5
          ? intro
          : `Chapter ${i}: This article surveys policy gradient algorithms, historical developments and training experiments. `.repeat(
              30,
            ),
      sectionPath: ['Reinforcement Learning for LLMs'],
    })),
    blockIds: ['r5'],
    history: [
      { id: 'old-q', role: 'user', text: '解释文章引言的意思', quotes: [], createdAt: 1 },
      {
        id: 'old-a',
        role: 'assistant',
        text: '你选中的这段文字（block r5）是文章正文的第一段，它是对整篇文章主题的概括性介绍。逐句解释如下：作者说明了 RL 对大模型发展的重要性，并介绍全文的路线图。',
        status: 'completed',
        createdAt: 2,
      },
    ],
    expectedName: /强化学习/u,
    expectedConcept: /奖励|回报|反馈/u,
    coverage: 'partial',
  },
];

try {
  const { baseUrl, model, apiKey } = readLlmConfiguration();
  for (const example of cases) {
    const document = {
      key: example.key,
      revision: 'v1',
      title: example.title,
      blocks: example.blocks,
      warnings: [],
    };
    let wire;
    const provider = new PiChatProvider({
      baseUrl,
      model,
      apiKey,
      temperature: 0.1,
      stream: true,
      disableThinking: new URL(baseUrl).hostname === 'api.deepseek.com',
      fetch: async (url, options) => {
        const request = JSON.parse(options.body);
        wire = request.messages.at(-1).content;
        assert.ok(wire.includes(example.selection), '最后一条用户消息缺少选区。');
        assert.ok(wire.endsWith(example.question), '最后一条用户消息缺少问题。');
        assert.ok(!wire.includes('sourceBlockIds'), '来源元数据混入了当前问题。');
        assert.ok(!wire.includes(intro), '选中的短语被扩大为整段引言。');
        return fetch(url, options);
      },
    });
    let answer = '',
      context,
      done = false,
      usage;
    const started = performance.now();
    for await (const event of new AssistantEngine(provider).run({
      document,
      question: {
        id: 'q',
        role: 'user',
        text: example.question,
        createdAt: Date.now(),
        quotes: [
          {
            id: 'selected',
            documentKey: document.key,
            revision: 'v1',
            label: document.title,
            kind: 'text',
            text: example.selection,
            blockIds: example.blockIds,
          },
        ],
      },
      history: example.history,
      mode: 'auto',
      budget: { maxInputTokens: 12000, maxOutputTokens: 2048, contextWindowTokens: 32768 },
    })) {
      if (event.type === 'delta') answer += event.text;
      if (event.type === 'context') context = event.info;
      if (event.type === 'done') {
        done = true;
        usage = event.usage;
      }
    }
    assert.equal(done, true, '模型回答未正常完成。');
    assert.equal(context.coverage, example.coverage);
    assert.match(answer, example.expectedName, '回答没有涉及所选术语。');
    assert.match(answer, example.expectedConcept, '回答没有解释术语的核心概念。');
    assert.match(answer, /\p{Script=Han}/u, '回答未使用中文。');
    assert.doesNotMatch(answer, /逐句解释如下|是对整篇文章主题的概括性介绍/u, '模型仍在解释文章引言。');
    assert.doesNotMatch(answer, /你选中的(?:这段)?(?:引言|段落)/u, '模型把背景段落误称为选区。');
    console.log(
      JSON.stringify(
        {
          case: {
            selection: example.selection,
            question: example.question,
            background: example.coverage,
            priorParagraphExplanation: example.history.length > 0,
          },
          finalUserMessage: wire,
          answer: apiKey ? answer.replaceAll(apiKey, '[REDACTED]') : answer,
          context,
          usage,
          elapsedMs: Math.round(performance.now() - started),
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : '阅读助手联调失败。');
  process.exitCode = 1;
}
