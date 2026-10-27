import { createHash } from 'node:crypto';
import { OpenAICompatibleProvider, ProviderError, chatCompletionsUrl, type TranslationProvider } from '@pagelingo/translation-core';

export class LocalTranslationError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'LocalTranslationError'; }
}
export interface LocalProviderConfig {
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
}
/** Only this ephemeral return value contains the key. Never serialize or spread it. */
export function resolveProviderConfig(config: LocalProviderConfig) {
  try {
    if (Object.keys(config).some(key => !['baseUrl', 'model', 'apiKeyEnv'].includes(key))) throw new Error();
    const url = new URL(config.baseUrl);
    chatCompletionsUrl(config.baseUrl);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(config.model)) throw new Error();
    const keyName = config.apiKeyEnv ?? 'PAGELINGO_LLM_API_KEY';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyName)) throw new Error();
    url.pathname = url.pathname.replace(/\/+$/, '');
    return { baseUrl: url.href, model: config.model, apiKey: process.env[keyName], endpointFingerprint: createHash('sha256').update(url.href).digest('hex') };
  } catch { throw new LocalTranslationError('PROVIDER_CONFIG_INVALID'); }
}
export function createLocalProvider(config: ReturnType<typeof resolveProviderConfig>, maxOutputTokens: number): TranslationProvider {
  return new OpenAICompatibleProvider({ baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey, maxOutputTokens });
}
/** Strip arbitrary error messages/properties before SDK checkpointing observes them. */
export function safeProvider(provider: TranslationProvider): TranslationProvider {
  const sanitize = (error: unknown): never => {
    if (error instanceof ProviderError) {
      const codes = ['configuration', 'http', 'network', 'timeout', 'invalid-response', 'truncated', 'refused'];
      const code = codes.includes(error.code) ? error.code : 'network';
      const status = Number.isSafeInteger(error.status) && error.status! >= 100 && error.status! <= 599 ? error.status : undefined;
      const retryAfter = Number.isFinite(error.retryAfterMs) && error.retryAfterMs! >= 0 ? error.retryAfterMs : undefined;
      const usage = error.usage && Object.values(error.usage).every(n => Number.isSafeInteger(n) && n >= 0)
        ? { promptTokens: error.usage.promptTokens, completionTokens: error.usage.completionTokens, totalTokens: error.usage.totalTokens } : undefined;
      throw new ProviderError(code, `PROVIDER_${code.toUpperCase().replaceAll('-', '_')}`, status, retryAfter, usage);
    }
    throw new ProviderError('network', 'PROVIDER_NETWORK');
  };
  return {
    generate: async (request, signal) => { try { return await provider.generate(request, signal); } catch (error) { return sanitize(error); } },
    ...(provider.generateDetailed ? { generateDetailed: async (request: Parameters<TranslationProvider['generate']>[0], signal: AbortSignal) => {
      try { return await provider.generateDetailed!(request, signal); } catch (error) { return sanitize(error); }
    } } : {}),
  };
}
