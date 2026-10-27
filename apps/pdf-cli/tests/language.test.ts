import { expect, test } from 'vitest';
import { detectLanguage } from '../src/index.js';
import { english } from './fixtures/legacy-preview/create.js';
test.each([
  ['这是中文。', 'zh', 'han-only'],
  ['123 + =', 'und', 'no-language'],
  ['Introduction', 'und', 'insufficient-text'],
  [english, 'en', 'english-heuristic'],
  [
    '这是中文解释'.repeat(8) + ' model learning test '.repeat(6),
    'mixed',
    'mixed-script',
  ],
  ['これは日本語です'.repeat(10), 'und', 'other-script'],
  [
    '```js\nconst result = the + and + for;\n``` https://example.com/the/and/for',
    'und',
    'no-language',
  ],
  ['abcdefghijklmno '.repeat(10), 'und', 'uncertain'],
])('decides natural language for %s', (text, language, reason) =>
  expect(detectLanguage(text)).toEqual({ language, reason }),
);
