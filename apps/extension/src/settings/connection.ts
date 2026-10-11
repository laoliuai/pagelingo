import { OpenAICompatibleProvider, chatCompletionsUrl, type OpenAICompatibleOptions, type ProviderIdentity } from '@pagelingo/translation-core';
import type { UserSettings } from './schema';

/** Match patterns omit the port: Chrome grants an origin's scheme + host. */
export function apiHostPattern(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.hostname}/*`;
}

export function requireConnection(settings: UserSettings): void {
  if (!settings.baseUrl || !settings.model) throw new Error('请先在设置页填写并保存 Base URL 和 Model，再授权 API 服务。');
}

export function providerOptions(settings: UserSettings): OpenAICompatibleOptions {
  requireConnection(settings);
  const disableThinking = settings.thinkingMode === 'disabled' ||
    (settings.thinkingMode === 'auto' && new URL(settings.baseUrl).hostname === 'api.deepseek.com');
  return {
    baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model,
    temperature: settings.temperature, responseFormat: settings.responseFormat,
    maxOutputTokens: settings.maxOutputTokens, maxTokensParameter: settings.maxTokensParameter,
    thinking: disableThinking ? 'disabled' : undefined,
    stream: settings.stream, timeoutMs: 120_000, firstResponseTimeoutMs: 25_000, idleTimeoutMs: 25_000,
  };
}

export function providerIdentity(settings: UserSettings): ProviderIdentity {
  const { baseUrl, apiKey: _key, fetch: _fetch, onUsage: _usage, timeoutMs: _timeout, firstResponseTimeoutMs: _first, idleTimeoutMs: _idle, model, ...generation } = providerOptions(settings);
  return { endpoint: chatCompletionsUrl(baseUrl), model, generation };
}

export async function requireApiPermission(settings: UserSettings): Promise<void> {
  requireConnection(settings);
  if (!await chrome.permissions.contains({ origins: [apiHostPattern(settings.baseUrl)] })) {
    throw new Error('尚未授权 API 服务，请在设置页点击“授权并测试连接”。');
  }
}

export function createProvider(settings: UserSettings): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(providerOptions(settings));
}
