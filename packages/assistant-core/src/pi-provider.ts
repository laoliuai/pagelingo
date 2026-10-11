import { Agent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model, Message, TextContent } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { ChatProvider, ChatRequest, ChatUsage, ProviderEvent } from './types.js';

class SafeProviderError extends Error {}

export interface PiProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  stream?: boolean;
  maxTokensParameter?: 'max_tokens' | 'max_completion_tokens';
  disableThinking?: boolean;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}
export function assistantEndpoint(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new SafeProviderError('请使用 HTTPS API 地址，或本机 HTTP 服务。');
  url.pathname = url.pathname.replace(/\/$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return url.href;
}
class Queue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private ended = false;
  private wake?: () => void;
  push(value: T) {
    this.items.push(value);
    this.wake?.();
  }
  end() {
    this.ended = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (!this.ended || this.items.length) {
      if (this.items.length) yield this.items.shift()!;
      else
        await new Promise<void>((r) => {
          this.wake = r;
        });
    }
  }
}
const zeroUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const number = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    void operation()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', cancel));
  });
}

/** Pi owns run state and events. This adapter keeps the self-hosted Chat Completions wire protocol explicit. */
export class PiChatProvider implements ChatProvider {
  private endpoint: string;
  constructor(private options: PiProviderOptions) {
    this.endpoint = assistantEndpoint(options.baseUrl);
    if (!options.model.trim()) throw new SafeProviderError('请配置阅读助手使用的模型。');
  }
  async *stream(request: ChatRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    signal.throwIfAborted();
    if (!request.messages.length || request.messages.at(-1)?.role !== 'user')
      throw new SafeProviderError('当前请求需要以用户问题结束。');
    const model: Model<'openai-completions'> = {
      id: this.options.model,
      name: this.options.model,
      provider: 'pagelingo',
      api: 'openai-completions',
      baseUrl: this.endpoint,
      reasoning: false,
      input: ['text'],
      contextWindow: 1_000_000,
      maxTokens: request.maxOutputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const base = (): AssistantMessage => ({
      role: 'assistant',
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [],
      usage: zeroUsage(),
      stopReason: 'stop',
      timestamp: Date.now(),
    });
    const messages: Message[] = request.messages.map((m) =>
      m.role === 'assistant'
        ? { ...base(), content: [{ type: 'text', text: m.content }] }
        : { role: m.role, content: m.content, timestamp: Date.now() },
    );
    const queue = new Queue<ProviderEvent>();
    let error: Error | undefined;
    let usage: ChatUsage | undefined;
    const agent = new Agent({
      initialState: { model, messages: messages.slice(0, -1), tools: [], thinkingLevel: 'off' },
      streamFn: (_model, _context, options) => {
        const stream = createAssistantMessageEventStream();
        const message = base();
        const text: TextContent = { type: 'text', text: '' };
        message.content = [text];
        const abort = new AbortController();
        const cancel = () => abort.abort();
        options?.signal?.addEventListener('abort', cancel, { once: true });
        if (options?.signal?.aborted) abort.abort();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const total = setTimeout(
          () => abort.abort(new SafeProviderError('回答超过总时限，请重试。')),
          this.options.timeoutMs ?? 120_000,
        );
        const idle = () => {
          clearTimeout(timer);
          timer = setTimeout(
            () => abort.abort(new SafeProviderError('模型响应超时，请重试。')),
            this.options.idleTimeoutMs ?? 25_000,
          );
        };
        idle();
        const append = (delta: string) => {
          text.text += delta;
          if (text.text.length > 200_000) throw new SafeProviderError('回答超过允许长度。');
          stream.push({ type: 'text_delta', contentIndex: 0, delta, partial: message });
        };
        void (async () => {
          stream.push({ type: 'start', partial: message });
          stream.push({ type: 'text_start', contentIndex: 0, partial: message });
          try {
            const body = {
              model: model.id,
              messages: request.messages,
              temperature: this.options.temperature ?? 0.3,
              [this.options.maxTokensParameter ?? 'max_tokens']: request.maxOutputTokens,
              stream: this.options.stream ?? true,
              ...(this.options.disableThinking ? { thinking: { type: 'disabled' } } : {}),
              ...((this.options.stream ?? true) ? { stream_options: { include_usage: true } } : {}),
            };
            const response = await abortable(
              () =>
                (this.options.fetch ?? globalThis.fetch)(this.endpoint, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
                  },
                  body: JSON.stringify(body),
                  signal: abort.signal,
                  redirect: 'error',
                  credentials: 'omit',
                }),
              abort.signal,
            );
            idle();
            if (!response.ok)
              throw new SafeProviderError(`模型服务返回 HTTP ${response.status}，请检查配置后重试。`);
            if (!response.body) throw new SafeProviderError('模型服务返回了空响应。');
            let finish: string | undefined;
            let done = false;
            let bytes = 0;
            const consume = (value: unknown, streaming: boolean) => {
              if (!value || typeof value !== 'object') throw new SafeProviderError('模型响应格式不正确。');
              const data = value as {
                choices?: {
                  index?: number;
                  delta?: { content?: unknown; refusal?: unknown; tool_calls?: unknown };
                  message?: { content?: unknown; refusal?: unknown; tool_calls?: unknown };
                  finish_reason?: string;
                }[];
                usage?: Record<string, unknown>;
                error?: unknown;
              };
              if (data.error) throw new SafeProviderError('模型服务返回错误，请稍后重试。');
              if (data.usage) {
                usage = {
                  input: number(data.usage.prompt_tokens),
                  output: number(data.usage.completion_tokens),
                  total: number(data.usage.total_tokens),
                };
                message.usage = {
                  ...zeroUsage(),
                  input: usage.input,
                  output: usage.output,
                  totalTokens: usage.total,
                };
              }
              const choice = data.choices?.find((c) => c.index === 0) ?? data.choices?.[0];
              if (!choice) {
                if (!data.usage) throw new SafeProviderError('模型响应缺少回答。');
                return;
              }
              const part = streaming ? choice.delta : choice.message;
              if (part?.refusal) throw new SafeProviderError('模型未能回答这个问题，请调整问题后重试。');
              if (part?.tool_calls) throw new SafeProviderError('当前阅读助手未启用工具调用。');
              if (typeof part?.content === 'string') append(part.content);
              else if (part?.content !== undefined && part?.content !== null)
                throw new SafeProviderError('模型返回了不支持的回答格式。');
              if (choice.finish_reason) finish = choice.finish_reason;
            };
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            try {
              while (true) {
                const chunk = await abortable(() => reader.read(), abort.signal);
                if (chunk.done) break;
                idle();
                bytes += chunk.value.byteLength;
                if (bytes > 2 * 1024 * 1024) throw new SafeProviderError('模型响应超过允许大小。');
                buffer += decoder.decode(chunk.value, { stream: true });
                if (!(this.options.stream ?? true)) continue;
                buffer = buffer.replace(/\r\n/g, '\n');
                let boundary: number;
                while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                  const frame = buffer.slice(0, boundary);
                  buffer = buffer.slice(boundary + 2);
                  const data = frame
                    .split('\n')
                    .filter((l) => l.startsWith('data:'))
                    .map((l) => l.slice(5).trimStart())
                    .join('\n');
                  if (!data) continue;
                  if (data === '[DONE]') {
                    done = true;
                    break;
                  }
                  try {
                    consume(JSON.parse(data), true);
                  } catch (e) {
                    if (e instanceof SyntaxError) throw new SafeProviderError('模型流式响应格式不正确。');
                    throw e;
                  }
                }
                if (done) break;
              }
              if (!(this.options.stream ?? true)) {
                buffer += decoder.decode();
                try {
                  consume(JSON.parse(buffer), false);
                } catch (e) {
                  if (e instanceof SyntaxError) throw new SafeProviderError('模型响应格式不正确。');
                  throw e;
                }
                done = true;
              } else if (!done && !finish) throw new SafeProviderError('模型流式回答意外中断，请重试。');
            } finally {
              void reader.cancel().catch(() => {});
              reader.releaseLock();
            }
            if (finish === 'length')
              throw new SafeProviderError('回答达到输出 Token 上限，已保留部分内容；可提高上限后重试。');
            if (finish && !['stop', 'length'].includes(finish))
              throw new SafeProviderError('模型回答未正常完成，请重试。');
            if (!text.text.trim()) throw new SafeProviderError('模型没有返回可显示的回答。');
            stream.push({ type: 'text_end', contentIndex: 0, content: text.text, partial: message });
            stream.push({ type: 'done', reason: 'stop', message });
          } catch (e) {
            const reason = abort.signal.aborted ? abort.signal.reason : undefined;
            const safe =
              reason instanceof SafeProviderError
                ? reason.message
                : e instanceof SafeProviderError
                  ? e.message
                  : '模型请求失败，请检查连接或重试。';
            message.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
            message.errorMessage = safe;
            stream.push({ type: 'error', reason: message.stopReason, error: message });
          } finally {
            clearTimeout(timer);
            clearTimeout(total);
            options?.signal?.removeEventListener('abort', cancel);
            stream.end();
          }
        })();
        return stream;
      },
    });
    agent.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta')
        queue.push({ type: 'delta', text: event.assistantMessageEvent.delta });
      if (
        event.type === 'message_end' &&
        event.message.role === 'assistant' &&
        ['error', 'aborted'].includes(event.message.stopReason)
      )
        error = new SafeProviderError(event.message.errorMessage ?? '回答未完成。');
    });
    const cancel = () => agent.abort();
    signal.addEventListener('abort', cancel, { once: true });
    const run = agent
      .prompt(messages.at(-1)!)
      .then(() => {
        if (!error && !signal.aborted) queue.push({ type: 'done', usage });
      })
      .catch(() => {
        error = new SafeProviderError('对话运行失败，请重试。');
      })
      .finally(() => queue.end());
    try {
      for await (const event of queue) {
        signal.throwIfAborted();
        yield event;
      }
      await run;
      signal.throwIfAborted();
      if (error) throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
      agent.abort();
      await run;
    }
  }
}
