import { readFileSync, writeFileSync } from 'node:fs';
const words = JSON.parse(readFileSync(new URL('../fixtures/reader-v1/english-common-words.json', import.meta.url), 'utf8'));
writeFileSync(new URL('../src/language-words.ts', import.meta.url), `// Generated from fixtures/reader-v1/english-common-words.json; keep the fixture frozen.\nexport const englishCommonWords: readonly string[] = ${JSON.stringify(words, null, 2)};\n`);
