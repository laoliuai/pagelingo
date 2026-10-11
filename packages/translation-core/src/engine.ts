import { z } from 'zod';
import { abortable } from './abort.js';
import { translationDocumentSchema, type TranslationDocument } from './document.js';
import { encodeBlock, decodeTranslation } from './protection.js';
import { buildTranslationRequest, type TranslationProvider } from './provider.js';
import { translationProfileSchema, type TranslationOptions, type TranslationBatchResult } from './types.js';
import { validateBatch } from './validator.js';
import type { ReliabilityOptions } from './checkpoint.js';
import { translateReliably } from './reliable-engine.js';
import { glossaryEntrySchema, glossaryDomainSchema, mergeGlossaryEntries } from './glossary.js';
import { applyGlossary, restoreGlossaryText } from './terminology.js';

const optionsSchema = z.object({
  targetLanguage: z.string().trim().min(1),
  profile: translationProfileSchema.default('technical'),
  glossary: z.array(glossaryEntrySchema).default([]).transform(entries => mergeGlossaryEntries([], entries)),
  glossaryDomain: glossaryDomainSchema.default('machine-learning'),
});

export class TranslationEngine {
  private readonly batchSize: number;

  constructor(private readonly provider: TranslationProvider, private readonly options: { batchSize?: number; reliability?: ReliabilityOptions } = {}) {
    this.batchSize = options.batchSize ?? 8;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1) throw new Error('batchSize 必须为正整数。');
  }

  /** Pull-based batches: every yielded result has passed schema and structure validation. */
  async *translate(value: TranslationDocument, options: TranslationOptions): AsyncGenerator<TranslationBatchResult> {
    const signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const { targetLanguage, profile, glossary, glossaryDomain } = optionsSchema.parse(options);
    const { blocks, ...document } = translationDocumentSchema.parse(value);
    if (this.options.reliability) {
      yield* translateReliably(this.provider, { ...document, blocks }, { targetLanguage, profile, signal, glossary, glossaryDomain }, this.options.reliability);
      return;
    }
    const inputs = blocks.map(block => applyGlossary(encodeBlock(block), glossary, glossaryDomain));
    if (inputs.some((input) => !input.protectedText.trim())) throw new Error('输入文本块为空。');

    for (let index = 0; index < inputs.length; index += this.batchSize) {
      signal.throwIfAborted();
      const batch = inputs.slice(index, index + this.batchSize);
      const request = buildTranslationRequest(document, batch, targetLanguage, profile);
      const response = await abortable(() => this.provider.generate(request, signal), signal);
      signal.throwIfAborted();
      const output = validateBatch(batch, response);
      const byId = new Map(output.translations.map((translation) => [translation.id, translation.text]));
      yield {
        documentId: document.id,
        translations: batch.map((input) => {
          const text = byId.get(input.id)!;
          return { id: input.id, text: restoreGlossaryText(input, text), content: decodeTranslation(input, text) };
        }),
        completed: index + batch.length,
        total: inputs.length,
      };
    }
  }
}
