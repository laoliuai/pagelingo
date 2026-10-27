import { z } from 'zod';
import { blockIdSchema, parseIdSchema, safeNonnegativeIntegerSchema } from './reader-common.js';

export const readingPositionSchema = z.strictObject({
  readerVersionId: z.uuid(), sourceVersionId: z.uuid(), parseId: parseIdSchema, blockId: blockIdSchema.nullable(),
  blockOffset: z.number().min(0).max(1), pdfPageIndex: safeNonnegativeIntegerSchema,
  view: z.enum(['split', 'source', 'content']), contentMode: z.enum(['source', 'translation']),
});
export type ReadingPosition = z.infer<typeof readingPositionSchema>;
export const readingProgressSchema = z.strictObject({
  position: readingPositionSchema, revision: safeNonnegativeIntegerSchema, updatedAt: z.iso.datetime(),
});
export type ReadingProgress = z.infer<typeof readingProgressSchema>;
export const readingProgressUpdateSchema = z.strictObject({ position: readingPositionSchema, expectedRevision: safeNonnegativeIntegerSchema });
export type ReadingProgressUpdate = z.infer<typeof readingProgressUpdateSchema>;
