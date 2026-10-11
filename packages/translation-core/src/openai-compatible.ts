import { z } from 'zod';
import { abortable } from './abort.js';
import type { GenerationRequest, TranslationProvider } from './provider.js';

export const responseFormatSchema = z.enum(['json-object', 'json-schema', 'text']);
export type ResponseFormat = z.infer<typeof responseFormatSchema>;

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface OpenAICompatibleOptions {
  /** API root, for example https://api.example.com/v1. No implicit /v1 is added. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  responseFormat?: ResponseFormat;
  maxOutputTokens?: number;
  maxTokensParameter?: 'max_tokens' | 'max_completion_tokens';
  /** Provider-specific capability; omitted unless explicitly configured. */
  thinking?: 'disabled';
  timeoutMs?: number;
  stream?: boolean;
  firstResponseTimeoutMs?: number;
  idleTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  onUsage?: (usage: TokenUsage) => void;
}

export type ProviderErrorCode = 'configuration' | 'http' | 'network' | 'timeout' | 'invalid-response' | 'truncated' | 'refused';

/** Messages contain no upstream response body, credentials or source text. */
export class ProviderError extends Error {
  readonly name = 'ProviderError';
  constructor(readonly code: ProviderErrorCode, message: string, readonly status?: number, readonly retryAfterMs?: number, readonly usage?: TokenUsage) {
    super(message);
  }
}

export function chatCompletionsUrl(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl.trim()); }
  catch { throw new ProviderError('configuration', '请输入有效的 API Base URL。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
    throw new ProviderError('configuration', 'API 地址必须使用 HTTPS（本机可用 HTTP），且不能含凭据、查询参数或片段。');
  }
  const root = url.pathname.replace(/\/+$/, '');
  if (root.endsWith('/chat/completions')) throw new ProviderError('configuration', 'Base URL 应填写 API 根地址，不包含 /chat/completions。');
  url.pathname = `${root}/chat/completions`;
  return url.href;
}

const envelopeSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    message: z.object({ content: z.string().nullable().optional(), refusal: z.string().nullable().optional() }),
  })).min(1),
  usage: z.unknown().optional(),
});
const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});

function httpError(status: number, retryAfter?: string | null): ProviderError {
  const detail = status === 401 || status === 403 ? '鉴权失败，请检查 API Key 和服务权限。'
    : status === 402 ? '服务余额不足，请检查账户余额。'
    : status === 404 ? '接口或模型不存在，请检查 Base URL 和 Model。'
    : status === 429 ? '请求受到限流，请稍后重试。'
    : status === 400 || status === 422 ? '服务不接受当前请求，请检查模型、JSON 输出方式和参数。'
    : status >= 500 ? '模型服务暂时不可用，请稍后重试。'
    : '模型请求失败，请检查服务配置。';
  const seconds = retryAfter && /^\d+(\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : Date.parse(retryAfter ?? '') - Date.now();
  return new ProviderError('http', `LLM API（HTTP ${status}）：${detail}`, status, Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined);
}

/** Browser/Node transport. SDK validation remains authoritative in every output mode. */
export class OpenAICompatibleProvider implements TranslationProvider {
  private readonly endpoint: string;
  private readonly transport: typeof globalThis.fetch;
  private readonly options: OpenAICompatibleOptions;

  constructor(options: OpenAICompatibleOptions) {
    this.endpoint = chatCompletionsUrl(options.baseUrl);
    if (typeof options.model !== 'string' || !options.model.trim()) throw new ProviderError('configuration', '请填写模型 ID。');
    if (options.temperature !== undefined && (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)) {
      throw new ProviderError('configuration', 'Temperature 必须在 0–2 之间。');
    }
    const maxOutputTokens = options.maxOutputTokens ?? 4096;
    const timeoutMs = options.timeoutMs ?? 25_000;
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new ProviderError('configuration', '输出 Token 上限和超时必须为正整数。');
    }
    const format = responseFormatSchema.safeParse(options.responseFormat ?? 'json-object');
    if (!format.success) throw new ProviderError('configuration', '请选择支持的 JSON 输出方式。');
    if (options.maxTokensParameter !== undefined && !['max_tokens', 'max_completion_tokens'].includes(options.maxTokensParameter)) {
      throw new ProviderError('configuration', '请选择支持的输出 Token 参数。');
    }
    if (options.thinking !== undefined && options.thinking !== 'disabled') throw new ProviderError('configuration', 'thinking 参数仅支持显式关闭。');
    if (options.apiKey !== undefined && typeof options.apiKey !== 'string') throw new ProviderError('configuration', 'API Key 必须为字符串。');
    this.options = { ...options, model: options.model.trim(), apiKey: options.apiKey?.trim(), maxOutputTokens, timeoutMs,
      responseFormat: format.data };
    for (const duration of [options.firstResponseTimeoutMs, options.idleTimeoutMs]) {
      if (duration !== undefined && (!Number.isSafeInteger(duration) || duration < 1)) throw new ProviderError('configuration', '响应时限必须为正整数。');
    }
    this.transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async generate(request: GenerationRequest, signal: AbortSignal): Promise<unknown> {
    return (await this.generateDetailed(request, signal)).output;
  }

  async generateDetailed(request: GenerationRequest, signal: AbortSignal): Promise<{ output: unknown; usage?: TokenUsage }> {
    signal.throwIfAborted();
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new ProviderError('timeout', '模型请求超时，请稍后重试或减小每批文本量。')), this.options.timeoutMs);
    let readTimer = setTimeout(() => controller.abort(new ProviderError('timeout', '模型首响应超时，请检查服务或减小每批文本量。')), this.options.firstResponseTimeoutMs ?? this.options.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const body: Record<string, unknown> = {
        model: this.options.model, stream: this.options.stream ?? false,
        messages: [
          { role: 'system', content: `${request.instructions}\nOutput JSON schema: ${JSON.stringify(request.responseSchema)}\nExample JSON output (use actual input IDs and translated text): {"translations":[{"id":"block-id","text":"译文"}]}` },
          { role: 'user', content: JSON.stringify(request.data) },
        ],
        [this.options.maxTokensParameter ?? 'max_tokens']: this.options.maxOutputTokens,
      };
      if (this.options.stream) body.stream_options = { include_usage: true };
      if (this.options.temperature !== undefined) body.temperature = this.options.temperature;
      if (this.options.thinking) body.thinking = { type: this.options.thinking };
      if (this.options.responseFormat === 'json-object') body.response_format = { type: 'json_object' };
      if (this.options.responseFormat === 'json-schema') {
        body.response_format = { type: 'json_schema', json_schema: { name: 'translation', strict: true, schema: request.responseSchema } };
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.options.apiKey) headers.Authorization = `Bearer ${this.options.apiKey}`;
      const response = await abortable(() => this.transport(this.endpoint, {
        method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
        redirect: 'error', credentials: 'omit', cache: 'no-store',
      }), controller.signal);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw httpError(response.status, response.headers.get('Retry-After'));
      }
      let json: unknown;
      try {
        if (!response.body) throw new Error('empty body');
        reader = response.body.getReader();
        const decoder = new TextDecoder(); let text = ''; let bytes = 0;
        const stream = this.options.stream ? new SseParser() : undefined;
        while (true) {
          const chunk = await abortable(() => reader!.read(), controller.signal);
          if (chunk.done) {
            const tail = decoder.decode();
            if (stream) stream.append(tail); else text += tail;
            break;
          }
          bytes += chunk.value.byteLength;
          if (bytes > 2_000_000) throw new Error('response too large');
          if (chunk.value.byteLength) {
            clearTimeout(readTimer);
            readTimer = setTimeout(() => controller.abort(new ProviderError('timeout', '模型响应读取超时，请稍后重试。')), this.options.idleTimeoutMs ?? this.options.timeoutMs);
          }
          const decoded = decoder.decode(chunk.value, { stream: true });
          if (stream) {
            stream.append(decoded);
            // DONE terminates the protocol even when a proxy keeps HTTP open.
            if (stream.done) break;
          } else text += decoded;
        }
        json = stream ? stream.result() : JSON.parse(text);
      }
      catch (error) {
        if (controller.signal.aborted) throw error;
        throw new ProviderError('invalid-response', '模型服务返回了无法解析的 JSON 响应。');
      }
      const parsed = envelopeSchema.safeParse(json);
      if (!parsed.success) throw new ProviderError('invalid-response', '模型服务响应不符合 Chat Completions 格式。');
      const choice = parsed.data.choices[0];
      const parsedUsage = usageSchema.safeParse(parsed.data.usage);
      const usage = parsedUsage.success ? { promptTokens: parsedUsage.data.prompt_tokens, completionTokens: parsedUsage.data.completion_tokens, totalTokens: parsedUsage.data.total_tokens } : undefined;
      if (usage) this.options.onUsage?.(usage);
      if (choice.finish_reason === 'length') throw new ProviderError('truncated', '译文达到输出 Token 上限，请增大上限或减小每批文本量。', undefined, undefined, usage);
      if (choice.message.refusal || (choice.finish_reason && choice.finish_reason !== 'stop')) {
        throw new ProviderError('refused', '模型未完成翻译，请检查内容或稍后重试。');
      }
      const content = choice.message.content?.trim();
      if (!content) throw new ProviderError('invalid-response', '模型返回了空译文，请稍后重试。');
      let output: unknown;
      try {
        // Some text-only compatible services wrap their entire JSON answer in a fence.
        const text = this.options.responseFormat === 'text' ? content.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1') : content;
        output = JSON.parse(text);
      } catch { throw new ProviderError('invalid-response', '模型译文不是有效 JSON，请调整 JSON 输出方式。'); }
      controller.signal.throwIfAborted();
      return { output, usage };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('network', '无法连接模型服务，请检查网络、地址和跨域权限。');
    } finally {
      clearTimeout(timer);
      clearTimeout(readTimer);
      if (reader) { void reader.cancel().catch(() => {}); }
      signal.removeEventListener('abort', onAbort);
    }
  }
}

class SseParser {
  private pending = '';
  private content = '';
  private refusal = '';
  private finish?: string;
  private usage: unknown;
  done = false;

  append(text: string): void {
    this.pending += text;
    while (!this.done) {
      const separator = /\r?\n\r?\n/.exec(this.pending);
      if (!separator) break;
      const frame = this.pending.slice(0, separator.index);
      this.pending = this.pending.slice(separator.index + separator[0].length);
      this.frame(frame);
    }
  }

  private frame(frame: string): void {
    const data = frame.replace(/\r\n/g, '\n').split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data === '[DONE]') { this.done = true; return; }
    const envelope = JSON.parse(data) as { choices?: Array<{ index?: number; delta?: { content?: unknown; refusal?: unknown }; finish_reason?: string | null }>; usage?: unknown; error?: unknown };
    if (envelope.error) throw new Error('stream error');
    if (envelope.usage !== undefined) this.usage = envelope.usage;
    const choice = envelope.choices?.find((item) => item.index === undefined || item.index === 0);
    if (typeof choice?.delta?.content === 'string') this.content += choice.delta.content;
    if (typeof choice?.delta?.refusal === 'string') this.refusal += choice.delta.refusal;
    if (choice?.finish_reason) this.finish = choice.finish_reason;
  }

  result(): unknown {
    if (!this.done && this.pending) this.frame(this.pending);
    if (!this.done && !this.finish) throw new Error('incomplete stream');
    return { choices: [{ finish_reason: this.finish, message: { content: this.content, refusal: this.refusal } }], usage: this.usage };
  }
}
