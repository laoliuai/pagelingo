import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import * as contracts from '../src/index.js';

test('generated dictionary preserves the same ordered words to the frozen PDF fixture', () => {
  expect(contracts.englishCommonWords).toEqual(JSON.parse(readFileSync(new URL('../fixtures/reader-v1/english-common-words.json', import.meta.url), 'utf8')));
});
test.each([
  ['这是中文。', 'en', 'zh', 'zh'],
  ['これは日本語です'.repeat(10), 'ja', 'foreign', 'ja'],
  ['Bonjour le monde et les amis voici une longue histoire de notre temps '.repeat(3), 'fr', 'foreign', 'fr'],
  ['Это длинный русский текст для проверки определения языка '.repeat(3), 'ru', 'foreign', 'ru'],
  ['한국어 문장을 충분히 길게 반복하여 언어 감지를 확인합니다 '.repeat(3), 'ko', 'foreign', 'ko'],
  ['Hello', 'fr', 'und', null],
  ['これは日本語です'.repeat(10), 'fr', 'und', null],
  ['abcdefghijklmno '.repeat(10), null, 'und', null],
  ['这是中文解释'.repeat(8) + ' model learning test '.repeat(6), 'en', 'mixed', null],
])('uses deterministic script-compatible hints for %s', (text, hint, language, sourceLanguage) => {
  expect(contracts.detectWebLanguage(text, hint)).toMatchObject({ language, sourceLanguage });
});
test('inherits English only for short Latin text and omits protected data from natural text', () => {
  const content = [{ type: 'format' as const, id: 'em', kind: 'emphasis' as const, children: [{ type: 'text' as const, text: 'Introduction' }] }, { type: 'protected' as const, id: 'code', kind: 'code' as const, source: '这是代码' }];
  expect(contracts.naturalText(content)).toBe('Introduction');
  expect(contracts.blockLanguage(content, { language: 'en', reason: 'english-heuristic' })).toEqual({ language: 'en', reason: 'document-inherited' });
  expect(contracts.blockLanguage(content, { language: 'und', reason: 'uncertain' })).toEqual({ language: 'und', reason: 'insufficient-text' });
});
test.each(['de', 'es'])('recognizes %s only from a compatible explicit Web hint', hint => {
  expect(contracts.detectWebLanguage('abcdefghij '.repeat(8), hint)).toEqual({ language: 'foreign', sourceLanguage: hint, reason: 'script-compatible-hint' });
  expect(contracts.detectWebLanguage('abcdefghij '.repeat(8), 'ru').language).toBe('und');
});
test('supports explicit manual foreign languages without expanding automatic detection', () => {
  expect(contracts.webLanguageDecisionSchema.safeParse({ language: 'foreign', sourceLanguage: 'pt-BR', reason: 'user-specified' }).success).toBe(true);
  expect(contracts.detectWebLanguage('abcdefghij '.repeat(8), 'pt-BR').language).toBe('und');
  for (const sourceLanguage of ['zh', 'ZH-Hans', 'en-US', 'EN', 'und', 'UND-Latn', 'mul', 'zxx', 'not a language', 'a'.repeat(64)]) {
    expect(contracts.webLanguageDecisionSchema.safeParse({ language: 'foreign', sourceLanguage, reason: 'user-specified' }).success).toBe(false);
  }
});
test('keeps portable known-language patterns aligned with case and region exclusions', async () => {
  const { z } = await import('zod');
  const { Ajv2020 } = await import('ajv/dist/2020.js');
  const validate = new Ajv2020({ strict: true }).compile(z.toJSONSchema(contracts.sourceLanguageSchema));
  for (const language of ['en', 'zh-Hans', 'pt-BR', 'un', 'unda', 'mulan', 'zxxx']) {
    expect(contracts.sourceLanguageSchema.safeParse(language).success, language).toBe(true);
    expect(validate(language), language).toBe(true);
  }
  for (const language of ['und', 'UND-Latn', 'mul', 'MuL-CA', 'zxx', 'ZXX-US']) {
    expect(contracts.sourceLanguageSchema.safeParse(language).success, language).toBe(false);
    expect(validate(language), language).toBe(false);
  }
});
