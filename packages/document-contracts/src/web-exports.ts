import { z } from 'zod';
import { safeNonnegativeIntegerSchema } from './reader-common.js';
export const createWebExportRequestSchema = z.strictObject({ readerVersionId: z.uuid() });
export type CreateWebExportRequest = z.infer<typeof createWebExportRequestSchema>;
export const webExportSchema = z.strictObject({
  id: z.uuid(), packageId: z.uuid(), documentId: z.uuid(), readerVersionId: z.uuid(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'expired']),
  bytes: safeNonnegativeIntegerSchema.nullable(), sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  expiresAt: z.iso.datetime().nullable(), errorCode: z.string().nullable(),
});
export type WebExport = z.infer<typeof webExportSchema>;
