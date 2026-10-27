import { z } from 'zod';
import { safeNonnegativeIntegerSchema, parseIdSchema, blockIdSchema } from './reader-common.js';
import { sourceLanguageSchema } from './language.js';
import { defaultCaptureLimits } from './web-capture.js';

export const webJobSelectionSchema = z.array(blockIdSchema).min(1).max(defaultCaptureLimits.maxBlocks)
  .refine(value => new Set(value).size === value.length, 'Selection block IDs must be unique');

export const webJobStatusSchema = z.enum(['queued', 'running', 'paused-config', 'partial', 'completed', 'failed', 'cancelled']);
export type WebJobStatus = z.infer<typeof webJobStatusSchema>;
export const translationIntentSchema = z.enum(['none', 'auto', 'translate']);
export type TranslationIntent = z.infer<typeof translationIntentSchema>;
export const createWebJobRequestSchema = z.strictObject({ sourceVersionId: z.uuid(), parseId: parseIdSchema, profileRevision: safeNonnegativeIntegerSchema, glossaryRevision: safeNonnegativeIntegerSchema, sourceLanguage: sourceLanguageSchema.optional(), selectionBlockIds: webJobSelectionSchema.optional() });
export type CreateWebJobRequest = z.infer<typeof createWebJobRequestSchema>;
export const webJobSchema = z.strictObject({
  id: z.uuid(), documentId: z.uuid(), kind: z.enum(['fetch-link', 'translate']), status: webJobStatusSchema,
  sourceVersionId: z.uuid().nullable(), parseId: parseIdSchema.nullable(), profileRevision: safeNonnegativeIntegerSchema.nullable(), glossaryRevision: safeNonnegativeIntegerSchema.nullable(),
  /** Immutable resolved job input: null selection means the entire source. Adapters
   * validate membership and canonicalize selection against the immutable IR. */
  sourceLanguage: sourceLanguageSchema.nullable(), selectionBlockIds: webJobSelectionSchema.nullable(),
  readerVersionId: z.uuid().nullable(), completedUnits: safeNonnegativeIntegerSchema, totalUnits: safeNonnegativeIntegerSchema,
  errorCode: z.string().min(1).nullable(), warnings: z.array(z.string().min(1)), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export type WebJob = z.infer<typeof webJobSchema>;
export const retryWebJobRequestSchema = z.strictObject({ profileRevision: safeNonnegativeIntegerSchema, glossaryRevision: safeNonnegativeIntegerSchema });
export type RetryWebJobRequest = z.infer<typeof retryWebJobRequestSchema>;
