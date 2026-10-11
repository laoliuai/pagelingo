// @vitest-environment node
import { expect, it, vi } from 'vitest';
import * as sdk from '@pagelingo/translation-core';
const request = sdk.buildTranslationRequest({ id: 'doc' }, [sdk.encodeBlock({ id: 'p', kind: 'paragraph', content: [{ type: 'text', text: 'Hello.' }] })], 'zh-CN', 'technical');
const options = { baseUrl: 'https://api.example.com/v1', model: 'model', stream: true, timeoutMs: 1000, firstResponseTimeoutMs: 20, idleTimeoutMs: 20 };
it('reads SSE across arbitrary UTF-8 chunks, ignores reasoning, and captures final usage', async () => {
  const text = 'data: '+JSON.stringify({ choices: [{ delta: { reasoning_content: 'secret reasoning' } }] })+'\r\n\r\n' +
    'data: '+JSON.stringify({ choices: [{ delta: { content: '{"translations":[{"id":"p","text":"你好。"}]}' }, finish_reason: 'stop' }] })+'\n\n' +
    'data: '+JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })+'\n\n'+'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(text); const transport = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const provider = new sdk.OpenAICompatibleProvider({ ...options, fetch: transport });
  expect(typeof provider.generateDetailed).toBe('function');
  const result = await provider.generateDetailed(request, new AbortController().signal);
  expect(result.output).toEqual({ translations: [{ id: 'p', text: '你好。' }] });
  expect(result.usage?.totalTokens).toBe(20);
  expect(JSON.parse(transport.mock.calls[0][1]!.body as string).stream).toBe(true);
});
it.each(['first', 'idle', 'total'] as const)('enforces the %s deadline and cancels the underlying stream', async (mode) => {
  vi.useFakeTimers();
  try {
    let cancelled = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const api = new sdk.OpenAICompatibleProvider({ ...options, timeoutMs: mode === 'total' ? 50 : 1000,
      fetch: async () => mode === 'first' ? new Promise<Response>(() => {}) : new Response(new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode(': heartbeat\n\n')); }, cancel() { cancelled = true; } })) });
    const pending = api.generate(request, new AbortController().signal); const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    if (mode === 'total') for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(15); if (!cancelled) controller!.enqueue(new TextEncoder().encode(': heartbeat\n\n')); }
    else await vi.advanceTimersByTimeAsync(25);
    await assertion;
    if (mode !== 'first') expect(cancelled).toBe(true);
  } finally { vi.useRealTimers(); }
});
it('exposes Retry-After without exposing private response contents', async () => {
  const api = new sdk.OpenAICompatibleProvider({ ...options, fetch: async () => new Response('secret', { status: 429, headers: { 'Retry-After': '3' } }) });
  await expect(api.generate(request, new AbortController().signal)).rejects.toMatchObject({ retryAfterMs: 3000 });
});

it('finishes at the SSE DONE event and cancels a server that leaves its stream open', async () => {
  let cancelled = false;
  const payload = 'data: '+JSON.stringify({ choices: [{ delta: { content: '{"translations":[{"id":"p","text":"你好。"}]}' }, finish_reason: 'stop' }] })+'\n\n' +
    'data: '+JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })+'\n\n'+'data: [DONE]\n\n';
  const provider = new sdk.OpenAICompatibleProvider({ ...options, fetch: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(payload)); }, cancel() { cancelled = true; } })) });
  const result = await provider.generateDetailed(request, new AbortController().signal);
  expect(result.output).toEqual({ translations: [{ id: 'p', text: '你好。' }] });
  expect(result.usage?.totalTokens).toBe(20); expect(cancelled).toBe(true);
});
