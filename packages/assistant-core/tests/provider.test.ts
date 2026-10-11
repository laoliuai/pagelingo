import { expect, it, vi } from 'vitest';
import { PiChatProvider, assistantEndpoint, type ChatRequest } from '../src/index.js';
const request: ChatRequest = {
  messages: [
    { role: 'system', content: 'Reading assistant' },
    { role: 'user', content: 'Explain np.reshape' },
  ],
  maxOutputTokens: 512,
};
const frame = (v: unknown) => `data: ${JSON.stringify(v)}\r\n\r\n`;
const options = { baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'unit-secret', model: 'test' };
it('uses the real Pi lifecycle for streaming text, Unicode boundaries and reported usage', async () => {
  let body: Record<string, unknown> | undefined;
  const fetcher: typeof fetch = async (_url, init) => {
    body = JSON.parse(init!.body as string);
    const bytes = new TextEncoder().encode(
      frame({ choices: [{ index: 0, delta: { content: '中文 `np.reshape`' } }] }) +
        frame({ choices: [{ index: 0, delta: { content: ' 解释' }, finish_reason: 'stop' }] }) +
        frame({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }) +
        'data: [DONE]\r\n\r\n',
    );
    return new Response(
      new ReadableStream({
        start(c) {
          for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3));
          c.close();
        },
      }),
    );
  };
  const events = [];
  for await (const e of new PiChatProvider({
    ...options,
    fetch: fetcher,
    maxTokensParameter: 'max_completion_tokens',
    disableThinking: true,
  }).stream(request, new AbortController().signal))
    events.push(e);
  expect(
    events
      .filter((e) => e.type === 'delta')
      .map((e) => e.text)
      .join(''),
  ).toBe('中文 `np.reshape` 解释');
  expect(events.at(-1)).toEqual({ type: 'done', usage: { input: 50, output: 10, total: 60 } });
  expect(body).toMatchObject({ model: 'test', max_completion_tokens: 512, thinking: { type: 'disabled' } });
  expect(body).not.toHaveProperty('tools');
  expect(body).not.toHaveProperty('response_format');
});
it('supports non-streaming compatible endpoints', async () => {
  const events = [];
  const fetcher: typeof fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }] }));
  for await (const e of new PiChatProvider({ ...options, fetch: fetcher, stream: false }).stream(
    request,
    new AbortController().signal,
  ))
    events.push(e);
  expect(events[0]).toEqual({ type: 'delta', text: 'answer' });
  expect(events.at(-1)?.type).toBe('done');
});
it.each([
  [new Response('unit-secret private details', { status: 401 }), 'HTTP 401'],
  [new Response('data: {bad json}\n\n'), '格式'],
  [new Response(frame({ choices: [{ delta: { content: 'partial' } }] })), '中断'],
  [new Response(frame({ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] })), '上限'],
])('rejects failed or incomplete responses with safe errors', async (response, reason) => {
  const fetcher: typeof fetch = async () => response.clone();
  const consume = async () => {
    for await (const _e of new PiChatProvider({ ...options, fetch: fetcher }).stream(
      request,
      new AbortController().signal,
    )) {
      /* drain */
    }
  };
  await expect(consume()).rejects.toThrow(reason);
  await expect(consume()).rejects.not.toThrow('unit-secret');
});
it('aborts the actual request promptly when stopped', async () => {
  let aborted = false;
  const abort = new AbortController();
  const fetcher: typeof fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init!.signal!.addEventListener(
        'abort',
        () => {
          aborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  const pending = (async () => {
    for await (const _e of new PiChatProvider({ ...options, fetch: fetcher }).stream(request, abort.signal)) {
      /* drain */
    }
  })();
  await new Promise((r) => setTimeout(r, 10));
  abort.abort();
  await expect(pending).rejects.toThrow();
  expect(aborted).toBe(true);
});
it('times out a stalled request without disclosing provider data', async () => {
  const fetcher: typeof fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('unit-secret')), { once: true });
    });
  const consume = async () => {
    for await (const _e of new PiChatProvider({ ...options, fetch: fetcher, idleTimeoutMs: 15 }).stream(
      request,
      new AbortController().signal,
    )) {
      /* drain */
    }
  };
  await expect(consume()).rejects.toThrow('超时');
});
it('rejects insecure remote endpoints and credentials embedded in URLs', () => {
  expect(assistantEndpoint('https://api.example/v1/')).toBe('https://api.example/v1/chat/completions');
  expect(() => assistantEndpoint('http://api.example/v1')).toThrow();
  expect(() => assistantEndpoint('https://key:secret@api.example/v1')).toThrow();
});
it('does not silently retry billable chat calls', async () => {
  const fetcher = vi.fn(async () => new Response('unavailable', { status: 503 }));
  await expect(
    (async () => {
      for await (const _e of new PiChatProvider({ ...options, fetch: fetcher }).stream(
        request,
        new AbortController().signal,
      )) {
        /* drain */
      }
    })(),
  ).rejects.toThrow('503');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('sanitizes arbitrary transport errors even when they resemble internal messages', async () => {
  const fetcher: typeof fetch = async () => {
    throw new Error('模型 unit-secret private transport details');
  };
  await expect(async () => {
    for await (const _ of new PiChatProvider({ ...options, fetch: fetcher }).stream(
      request,
      new AbortController().signal,
    )) {
      /* drain */
    }
  }).rejects.toThrow('模型请求失败');
});
it('rejects a request without a final user message before making a request', async () => {
  const fetcher = vi.fn();
  await expect(async () => {
    for await (const _ of new PiChatProvider({ ...options, fetch: fetcher }).stream(
      { messages: [], maxOutputTokens: 512 },
      new AbortController().signal,
    )) {
      /* drain */
    }
  }).rejects.toThrow('用户问题');
  expect(fetcher).not.toHaveBeenCalled();
});
