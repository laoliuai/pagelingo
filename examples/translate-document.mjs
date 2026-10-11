import { readFile } from 'node:fs/promises';
import { TranslationEngine, translationDocumentSchema } from '@pagelingo/translation-core';
import { MockProvider } from '@pagelingo/translation-core/testing';

// This CLI consumes normalized document JSON; it does not parse PDF or LaTeX files.
const input = process.argv[2] ?? new URL('./academic-document.json', import.meta.url);
const document = translationDocumentSchema.parse(JSON.parse(await readFile(input, 'utf8')));
const engine = new TranslationEngine(new MockProvider());
const abort = new AbortController();
const stop = () => abort.abort();
process.once('SIGINT', stop);
try {
  for await (const batch of engine.translate(document, { targetLanguage: 'zh-CN', profile: 'academic', signal: abort.signal })) {
    console.log(JSON.stringify(batch, null, 2));
  }
} catch (error) {
  if (!abort.signal.aborted) throw error;
  process.exitCode = 130;
} finally {
  process.removeListener('SIGINT', stop);
}
