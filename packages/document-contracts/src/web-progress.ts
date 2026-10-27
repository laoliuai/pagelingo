import { z } from 'zod';
import { blockIdSchema, parseIdSchema, safeNonnegativeIntegerSchema } from './reader-common.js';
export const webReadingPositionSchema = z.strictObject({
  readerVersionId: z.uuid(), sourceVersionId: z.uuid(), parseId: parseIdSchema, blockId: blockIdSchema.nullable(),
  blockOffset: z.number().min(0).max(1), view: z.enum(['content', 'snapshot']), contentMode: z.enum(['source', 'translation', 'bilingual']),
});
export type WebReadingPosition = z.infer<typeof webReadingPositionSchema>;
export const webReadingProgressSchema = z.strictObject({ position: webReadingPositionSchema, revision: safeNonnegativeIntegerSchema, updatedAt: z.iso.datetime() });
export type WebReadingProgress = z.infer<typeof webReadingProgressSchema>;
export const webReadingProgressUpdateSchema = z.strictObject({ position: webReadingPositionSchema, expectedRevision: safeNonnegativeIntegerSchema });
export type WebReadingProgressUpdate = z.infer<typeof webReadingProgressUpdateSchema>;
export const resolvedWebPositionSchema = z.strictObject({ position: webReadingPositionSchema, chunkId: z.string().min(1).nullable(), previewId: z.string().min(1).nullable(), anchorId: z.string().min(1).nullable(), restoreHint: z.literal('version-updated-source-start').nullable() });
export type ResolvedWebPosition = z.infer<typeof resolvedWebPositionSchema>;
