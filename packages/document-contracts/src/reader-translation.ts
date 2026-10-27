import { z } from 'zod';
import { readerContractCeilings } from './reader-limits.js';
import { glossaryEntrySchema, glossaryDomainSchema, translationProfileSchema } from '@pagelingo/translation-core';
import { blockIdSchema, parseIdSchema, safeNonnegativeIntegerSchema, safePositiveIntegerSchema, sha256Schema, withJsonDepthLimit } from './reader-common.js';
export { validateReaderTranslationReferences } from './reader-translation-references.js';

export const readerTranslationStatusSchema = z.enum(['not-required', 'pending', 'partial', 'completed', 'failed', 'cancelled']);
export type ReaderTranslationStatus = z.infer<typeof readerTranslationStatusSchema>;
export const generationKindSchema = z.enum(['model', 'mock', 'none']);
export type GenerationKind = z.infer<typeof generationKindSchema>;
export const readerTranslationBlockSchema = z.discriminatedUnion('status', [
  z.strictObject({ blockId: blockIdSchema, status: z.literal('translated'), rawText: z.string().min(1) }),
  z.strictObject({ blockId: blockIdSchema, status: z.literal('source-only'),
    reason: z.enum(['language-not-required', 'manual-choice', 'pending', 'failed', 'cancelled']) }),
]);
export type ReaderTranslationBlock = z.infer<typeof readerTranslationBlockSchema>;
const unitIdentity = { id: z.string().regex(/^u[0-9]+:[0-9]+$/), blockId: blockIdSchema, part: safeNonnegativeIntegerSchema };
export const readerTranslationUnitSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...unitIdentity, status: z.literal('completed'), rawText: z.string().min(1) }),
  z.strictObject({ ...unitIdentity, status: z.literal('covered-by-block') }),
  z.strictObject({ ...unitIdentity, status: z.enum(['pending', 'failed', 'cancelled']), error: z.string().optional() }),
]);
export type ReaderTranslationUnit = z.infer<typeof readerTranslationUnitSchema>;
export const readerTranslationShapeSchema = z.strictObject({
  schemaVersion: z.literal('reader-translation/1'), id: z.uuid(), jobId: z.uuid(),
  sourceSha256: sha256Schema, parseId: parseIdSchema, readerIrSha256: sha256Schema,
  sdkVersion: z.string().min(1), promptVersion: z.string().min(1), protectionVersion: z.string().min(1),
  sourceLanguage: z.string().min(1).nullable(), targetLanguage: z.string().min(1), profile: translationProfileSchema,
  budget: z.strictObject({ maxInputTokens: safePositiveIntegerSchema, maxOutputTokens: safePositiveIntegerSchema,
    contextWindowTokens: safePositiveIntegerSchema, maxBatchBlocks: safePositiveIntegerSchema.optional(), reserveTokens: safePositiveIntegerSchema.optional() }),
  glossary: z.array(glossaryEntrySchema.strict()).max(5000), glossaryDomain: glossaryDomainSchema, glossarySha256: sha256Schema,
  selectionBlockIds: z.array(blockIdSchema).max(readerContractCeilings.maxBlocks),
  provider: z.strictObject({ model: z.string().min(1).nullable(), endpointFingerprint: sha256Schema.nullable() }),
  generationKind: generationKindSchema,
  metrics: z.strictObject({ requests: safeNonnegativeIntegerSchema, retries: safeNonnegativeIntegerSchema, cacheHits: safeNonnegativeIntegerSchema,
    promptTokens: safeNonnegativeIntegerSchema, completionTokens: safeNonnegativeIntegerSchema, totalTokens: safeNonnegativeIntegerSchema,
    usageRequests: safeNonnegativeIntegerSchema, startedAt: z.number().nonnegative(), elapsedMs: z.number().nonnegative(), firstResultMs: z.number().nonnegative().optional() }),
  blocks: z.array(readerTranslationBlockSchema).max(readerContractCeilings.maxBlocks), units: z.array(readerTranslationUnitSchema), status: readerTranslationStatusSchema,
});
export const readerTranslationSchema = withJsonDepthLimit(readerTranslationShapeSchema);
export type ReaderTranslation = z.infer<typeof readerTranslationSchema>;
