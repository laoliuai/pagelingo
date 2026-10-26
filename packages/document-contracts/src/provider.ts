import { z } from 'zod';
import {
  chatCompletionsUrl,
  responseFormatSchema,
  type BudgetOptions,
  type OpenAICompatibleOptions,
  type TokenUsage,
} from '@pagelingo/translation-core';

/** DNS and actual connection validation belong to the service transport. */
const baseUrlSchema = z.string().refine((value) => {
  if (value === '') return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !value.includes('?') && !value.includes('#') &&
      Boolean(chatCompletionsUrl(value));
  } catch {
    return false;
  }
}, 'Use an HTTPS API root without credentials, query or fragment.');

export const maxTokensParameterSchema = z.enum(['max_tokens', 'max_completion_tokens']) satisfies z.ZodType<NonNullable<OpenAICompatibleOptions['maxTokensParameter']>>;
export const thinkingModeSchema = z.enum(['auto', 'default', 'disabled']);
export const providerSettingsSchema = z.strictObject({
  baseUrl: baseUrlSchema,
  model: z.string().max(200),
  temperature: z.number().min(0).max(2),
  responseFormat: responseFormatSchema,
  maxOutputTokens: z.number().int().positive(),
  maxTokensParameter: maxTokensParameterSchema,
  thinkingMode: thinkingModeSchema,
  stream: z.boolean(),
  maxInputTokens: z.number().int().positive(),
  contextWindowTokens: z.number().int().positive(),
}) satisfies z.ZodType<
  Pick<BudgetOptions, 'maxInputTokens' | 'maxOutputTokens' | 'contextWindowTokens'> &
  Pick<Required<OpenAICompatibleOptions>,
    'baseUrl' | 'model' | 'temperature' | 'responseFormat' | 'maxTokensParameter' | 'stream'> &
  { thinkingMode: 'auto' | 'default' | 'disabled' }
>;
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;

export const providerProfileSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  ...providerSettingsSchema.shape,
  hasApiKey: z.boolean(),
});
export type ProviderProfile = z.infer<typeof providerProfileSchema>;

export const defaultProviderProfile: Readonly<ProviderProfile> = Object.freeze({
  revision: 0,
  baseUrl: '',
  model: '',
  temperature: 0.1,
  responseFormat: 'json-object',
  maxOutputTokens: 4096,
  maxTokensParameter: 'max_tokens',
  thinkingMode: 'auto',
  stream: false,
  maxInputTokens: 6000,
  contextWindowTokens: 32768,
  hasApiKey: false,
});

export const providerKeyUpdateSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('keep') }),
  z.strictObject({ action: z.literal('replace'), value: z.string().min(1).max(4096) }),
  z.strictObject({ action: z.literal('delete') }),
]);
export type ProviderKeyUpdate = z.infer<typeof providerKeyUpdateSchema>;
export const providerProfileUpdateSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  settings: providerSettingsSchema,
  key: providerKeyUpdateSchema,
});
export type ProviderProfileUpdate = z.infer<typeof providerProfileUpdateSchema>;

const tokenUsageSchema = z.strictObject({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
}) satisfies z.ZodType<TokenUsage>;
export const providerTestResultSchema = z.strictObject({
  ok: z.boolean(),
  profileRevision: z.number().int().positive(),
  usage: tokenUsageSchema.optional(),
  checkedAt: z.iso.datetime(),
});
export type ProviderTestResult = z.infer<typeof providerTestResultSchema>;
