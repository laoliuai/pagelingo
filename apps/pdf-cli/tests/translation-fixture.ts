import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GenerationRequest, TranslationProvider } from '@pagelingo/translation-core';
import type { ReaderIR } from '@pagelingo/document-contracts';
import { processPdf } from '../src/index.js';
import { fixture, english } from './fixtures/legacy-preview/create.js';
export { english };
export const providerConfig = { baseUrl: 'http://localhost:11434/v1', model: 'fixture-model' };
export function echo(request: GenerationRequest) {
  return { translations: request.data.blocks.map(block => ({ id: block.id, text: block.protectedText })) };
}
export const echoProvider: TranslationProvider = { generate: async request => echo(request) };
export async function readyRun(body = `<h1>Introduction</h1><p>${english}</p><p>中文引语</p>`) {
  const f = await fixture(`<article class="docvortex-document">${body}</article>`);
  await processPdf({ ...f, p0RunDir: f.run, previewDir: f.preview }, { inspectPdf: async () => f.inspection });
  const ir = JSON.parse(await readFile(join(f.runDir, 'source-ir.json'), 'utf8')) as ReaderIR;
  return { ...f, ir };
}
