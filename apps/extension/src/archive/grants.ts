import { z } from 'zod';
import { captureUrlSchema } from '@pagelingo/document-contracts';

export const captureIdentitySchema = z.strictObject({
  contentSessionId: z.uuid(), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), url: captureUrlSchema,
});
export type CaptureIdentity = z.infer<typeof captureIdentitySchema>;
/** Only the trusted background issues these, bound to Chrome's tab/document identity. */
export const captureGrantSchema = captureIdentitySchema.extend({
  grantId: z.uuid(), captureId: z.uuid(), tabId: z.number().int().nonnegative(),
  frameId: z.literal(0), documentId: z.string().min(1).max(200),
});
export type CaptureGrant = z.infer<typeof captureGrantSchema>;
export const captureContentCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('capture:identity') }),
  z.strictObject({ type: z.literal('capture:collect'), grant: captureGrantSchema }),
]);

export const RESOURCE_FRAME_BYTES = 256 * 1024;
export const captureResourceFrameSchema = z.strictObject({
  type: z.literal('capture:resource-frame'), grant: captureGrantSchema, resourceId: z.string().min(1).max(240),
  offset: z.number().int().nonnegative().max(16 * 1024 * 1024), total: z.number().int().positive().max(16 * 1024 * 1024),
  mediaType: z.enum(['image/png','image/jpeg','image/webp','image/gif']), data: z.string().min(4).max(RESOURCE_FRAME_BYTES),
});
export const captureAcquisitionCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('capture:begin'), grant: captureGrantSchema }),
  z.strictObject({ type: z.literal('capture:resource'), grant: captureGrantSchema, resourceId: z.string().min(1).max(240) }),
  z.strictObject({ type: z.literal('capture:check-resource'), grant: captureGrantSchema, resourceId: z.string().min(1).max(240) }),
]);
export function sameCaptureGrant(a: CaptureGrant, b: CaptureGrant): boolean {
  return a.grantId === b.grantId && a.captureId === b.captureId && a.tabId === b.tabId && a.frameId === b.frameId && a.documentId === b.documentId && a.contentSessionId === b.contentSessionId && a.revision === b.revision && a.url === b.url;
}
