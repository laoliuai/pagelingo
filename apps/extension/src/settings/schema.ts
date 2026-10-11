import { z } from 'zod';
import {
  chatCompletionsUrl,
  glossaryEntrySchema,
  glossaryDomainSchema,
  mergeGlossaryEntries,
  responseFormatSchema,
} from '@pagelingo/translation-core';
import { displayModeSchema } from '../shared/types';

export { glossaryEntrySchema, type GlossaryEntry } from '@pagelingo/translation-core';

export function isValidBaseUrl(value: string): boolean {
  if (!value) return true;
  try {
    chatCompletionsUrl(value);
    return true;
  } catch {
    return false;
  }
}

export const settingsSchema = z.object({
  schemaVersion: z.literal(1),
  baseUrl: z
    .string()
    .trim()
    .refine(isValidBaseUrl, '请输入 HTTPS API 地址；本机服务可使用 HTTP。地址不能含密码、查询参数或片段。'),
  apiKey: z.string().trim().max(4096),
  model: z.string().trim().max(200),
  temperature: z.number().min(0).max(0.3),
  responseFormat: responseFormatSchema.default('json-object'),
  maxOutputTokens: z.number().int().min(128).max(32768).default(4096),
  maxTokensParameter: z.enum(['max_tokens', 'max_completion_tokens']).default('max_tokens'),
  thinkingMode: z.enum(['auto', 'default', 'disabled']).default('auto'),
  stream: z.boolean().default(false),
  maxInputTokens: z.number().int().min(1500).max(100000).default(6000),
  contextWindowTokens: z.number().int().min(4096).max(1000000).default(32768),
  cacheMaxMiB: z.number().int().min(1).max(256).default(64),
  targetLanguage: z.literal('zh-CN'),
  displayMode: displayModeSchema,
  customGlossary: z
    .array(glossaryEntrySchema)
    .max(2000)
    .transform((entries) => mergeGlossaryEntries([], entries)),
  glossaryDomain: glossaryDomainSchema.default('machine-learning'),
  assistant: z
    .object({
      historyLimit: z.number().int().min(1).max(500).default(50),
      historyMaxMiB: z.number().int().min(1).max(256).default(64),
      maxInputTokens: z.number().int().min(1500).max(100000).default(12000),
      maxOutputTokens: z.number().int().min(128).max(32768).default(4096),
      temperature: z.number().min(0).max(2).default(0.3),
      stream: z.boolean().default(true),
      model: z.string().trim().max(200).default(''),
      preferences: z.string().trim().max(2000).default(''),
    })
    .default({
      historyLimit: 50,
      historyMaxMiB: 64,
      maxInputTokens: 12000,
      maxOutputTokens: 4096,
      temperature: 0.3,
      stream: true,
      model: '',
      preferences: '',
    }),
});

export type UserSettings = z.infer<typeof settingsSchema>;

export const defaultSettings: UserSettings = {
  schemaVersion: 1,
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.1,
  responseFormat: 'json-object',
  maxOutputTokens: 4096,
  maxTokensParameter: 'max_tokens',
  thinkingMode: 'auto',
  stream: false,
  maxInputTokens: 6000,
  contextWindowTokens: 32768,
  cacheMaxMiB: 64,
  targetLanguage: 'zh-CN',
  displayMode: 'bilingual',
  customGlossary: [],
  glossaryDomain: 'machine-learning',
  assistant: {
    historyLimit: 50,
    historyMaxMiB: 64,
    maxInputTokens: 12000,
    maxOutputTokens: 4096,
    temperature: 0.3,
    stream: true,
    model: '',
    preferences: '',
  },
};
