import { readFileSync } from 'node:fs';
import type { LanguageDecision } from '@pagelingo/document-contracts';
import type { InlineContent } from '@pagelingo/translation-core';
const commonWords = new Set<string>(
  JSON.parse(
    readFileSync(
      new URL(
        '../../../packages/document-contracts/fixtures/reader-v1/english-common-words.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ),
);
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
