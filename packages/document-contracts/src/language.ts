import { z } from 'zod';
import type { LanguageDecision } from './reader-common.js';
import type { InlineContent } from '@pagelingo/translation-core';
import { englishCommonWords } from './language-words.js';
const commonWords = new Set(englishCommonWords);
export function naturalText(content: InlineContent[]): string {
  return content
    .map((item) =>
      item.type === 'text'
        ? item.text
        : item.type === 'format'
          ? naturalText(item.children)
          : '',
    )
    .join('');
}
export function detectLanguage(input: string): LanguageDecision {
  const text = input.replace(
    /```[\s\S]*?```|`[^`]*`|\$\$[\s\S]*?\$\$|\$[^$\n]*\$|https?:\/\/\S+|mailto:\S+/g,
    ' ',
  );
  const letters = text.match(/\p{L}/gu) ?? [];
  const han = letters.filter((c) => /\p{Script=Han}/u.test(c)).length;
  const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length;
  if (!letters.length) return { language: 'und', reason: 'no-language' };
  if (han === letters.length) return { language: 'zh', reason: 'han-only' };
  if (letters.length < 40)
    return { language: 'und', reason: 'insufficient-text' };
  if ((letters.length - han - latin) / letters.length > 0.05)
    return { language: 'und', reason: 'other-script' };
  if (han / letters.length >= 0.6)
    return { language: 'zh', reason: 'han-majority' };
  if (han / letters.length >= 0.2 && latin / letters.length >= 0.2)
    return { language: 'mixed', reason: 'mixed-script' };
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const common = words.filter((word) => commonWords.has(word));
  if (
    latin / letters.length >= 0.9 &&
    new Set(common).size >= 3 &&
    common.length / words.length >= 0.08
  )
    return { language: 'en', reason: 'english-heuristic' };
  return { language: 'und', reason: 'uncertain' };
}
export function blockLanguage(
  content: InlineContent[],
  document: LanguageDecision,
): LanguageDecision {
  const text = naturalText(content);
  const result = detectLanguage(text);
  if (
    result.reason === 'insufficient-text' &&
    document.language === 'en' &&
    (text.match(/\p{L}/gu) ?? []).every((c) => /\p{Script=Latin}/u.test(c))
  )
    return { language: 'en', reason: 'document-inherited' };
  return result;
}

/** Conservative known-language override; no registry lookup or language inference. */
export const sourceLanguageSchema = z.string().min(2).max(63).regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/)
  .refine(value => !['und', 'mul', 'zxx'].includes(value.split('-')[0].toLowerCase()), 'An explicit known source language is required');
export const webLanguageDecisionSchema = z.strictObject({
  language: z.enum(['zh', 'en', 'foreign', 'mixed', 'und']),
  sourceLanguage: sourceLanguageSchema.nullable(),
  reason: z.enum(['no-language', 'han-only', 'insufficient-text', 'other-script', 'han-majority', 'mixed-script',
    'english-heuristic', 'uncertain', 'document-inherited', 'user-specified', 'script-compatible-hint']),
}).refine(value => value.language === 'foreign'
  ? value.sourceLanguage !== null && !['zh', 'en'].includes(value.sourceLanguage.split('-')[0].toLowerCase())
  : value.language === 'zh' || value.language === 'en'
    ? value.sourceLanguage?.split('-')[0].toLowerCase() === value.language
    : value.sourceLanguage === null,
'Language and source language must agree');
export type WebLanguageDecision = z.infer<typeof webLanguageDecisionSchema>;

/** Web-only hints never change the legacy PDF detector or invoke a provider. */
export function detectWebLanguage(input: string, pageLanguage: string | null = null): WebLanguageDecision {
  const result = detectLanguage(input);
  const sourceLanguage = result.language === 'zh' || result.language === 'en' ? result.language : null;
  const legacy: WebLanguageDecision = { ...result, sourceLanguage };
  if (result.language === 'zh' || result.language === 'mixed' || result.reason === 'insufficient-text') return legacy;
  const text = input.replace(/```[\s\S]*?```|`[^`]*`|\$\$[\s\S]*?\$\$|\$[^$\n]*\$|https?:\/\/\S+|mailto:\S+/g, ' ');
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 40) return legacy;
  const hint = pageLanguage?.toLowerCase().split('-')[0];
  const ratio = (script: RegExp) => letters.filter(letter => script.test(letter)).length / letters.length;
  if (hint && ((['fr', 'de', 'es'].includes(hint) && ratio(/\p{Script=Latin}/u) >= 0.9)
    || (hint === 'ru' && ratio(/\p{Script=Cyrillic}/u) >= 0.9)
    || (hint === 'ko' && ratio(/\p{Script=Hangul}/u) >= 0.8)
    || (hint === 'ja' && ratio(/[\p{Script=Hiragana}\p{Script=Katakana}]/u) >= 0.2))) {
    return webLanguageDecisionSchema.parse({ language: 'foreign', sourceLanguage: hint, reason: 'script-compatible-hint' });
  }
  return legacy;
}
