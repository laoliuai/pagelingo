import { describe, expect, it } from 'vitest';
import { defaultSettings, isValidBaseUrl, settingsSchema } from '../../src/settings/schema';
import { apiHostPattern, providerOptions } from '../../src/settings/connection';
import { MAX_GLOSSARY_ENTRIES } from '@pagelingo/translation-core';

describe('local settings validation', () => {
  it('allows blank setup, HTTPS endpoints and explicit local HTTP services', () => {
    expect(settingsSchema.safeParse(defaultSettings).success).toBe(true);
    for (const url of ['https://api.example.com/v1', 'http://localhost:11434/v1', 'http://127.0.0.1:8000/v1', 'http://[::1]:8000/v1']) expect(isValidBaseUrl(url)).toBe(true);
  });
  it('rejects credentials in URLs and remote cleartext endpoints', () => {
    for (const url of ['http://api.example.com/v1', 'https://user:password@example.com', 'https://example.com?api_key=test', 'javascript:alert(1)', 'https://example.com/#key']) expect(isValidBaseUrl(url)).toBe(false);
  });
  it('requires a target for fixed translations and keeps terms domain-scoped', () => {
    const entry = { source: 'Transformer', target: '', policy: 'translate', domain: 'machine-learning' };
    expect(settingsSchema.safeParse({ ...defaultSettings, customGlossary: [entry] }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...defaultSettings, customGlossary: [{ ...entry, policy: 'keep' }] }).success).toBe(true);
  });
  it('normalizes saved duplicates with the last source-domain entry taking precedence', () => {
    const entry = { source: 'token', target: '旧译文', policy: 'translate', domain: 'all' };
    const parsed = settingsSchema.parse({ ...defaultSettings, customGlossary: [entry, { ...entry, source: ' TOKEN ', target: '词元' }] });
    expect(parsed.customGlossary).toEqual([{ ...entry, source: 'TOKEN', target: '词元' }]);
  });
  it('saves and reloads a glossary above the former limit and rejects excess entries', () => {
    const customGlossary = Array.from({ length: MAX_GLOSSARY_ENTRIES }, (_, i) => ({
      source: `term${i}`, target: '译文', policy: 'translate', domain: 'machine-learning',
    }));
    const saved = settingsSchema.parse({ ...defaultSettings, customGlossary });
    expect(settingsSchema.parse(JSON.parse(JSON.stringify(saved))).customGlossary).toHaveLength(MAX_GLOSSARY_ENTRIES);
    expect(settingsSchema.safeParse({ ...saved, customGlossary: [...customGlossary, {
      ...customGlossary[0], source: 'extra',
    }] }).success).toBe(false);
  });
  it('migrates saved M1 settings with conservative compatibility defaults', () => {
    const old = { schemaVersion: 1, baseUrl: 'https://api.example.com/v1', model: 'model', apiKey: 'key', temperature: 0.1,
      targetLanguage: 'zh-CN', displayMode: 'bilingual', customGlossary: [] };
    expect(settingsSchema.parse(old)).toMatchObject({ responseFormat: 'json-object', maxOutputTokens: 4096, thinkingMode: 'auto', maxTokensParameter: 'max_tokens', assistant: {historyLimit:50, historyMaxMiB:64, stream:true, model:'', maxInputTokens:12000} });
    expect(isValidBaseUrl('https://api.example.com/v1/chat/completions')).toBe(false);
  });
  it('requests only the configured host and limits provider-specific defaults to DeepSeek', () => {
    expect(apiHostPattern('http://localhost:4317/v1')).toBe('http://localhost/*');
    expect(apiHostPattern('https://api.example.com:8443/v1')).toBe('https://api.example.com/*');
    expect(apiHostPattern('http://[::1]:4317/v1')).toBe('http://[::1]/*');
    const settings = { ...defaultSettings, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' };
    expect(providerOptions(settings).thinking).toBe('disabled');
    expect(providerOptions({ ...settings, baseUrl: 'https://deepseek.proxy.example.com/v1' }).thinking).toBeUndefined();
    expect(providerOptions({ ...settings, thinkingMode: 'default' }).thinking).toBeUndefined();
  });
});
