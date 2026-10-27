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
