import { z } from 'zod';
import { captureUrlSchema, webCaptureManifestSchema, webCaptureManifestShapeSchema, webLocalIdSchema } from './web-capture.js';
import { safeNonnegativeIntegerSchema, parseIdSchema } from './reader-common.js';
import { readerTranslationStatusSchema } from './reader-translation.js';
import { translationIntentSchema } from './web-jobs.js';
export const captureStatusSchema = z.enum(['created', 'receiving', 'validating', 'completed', 'failed', 'cancelled']);
export type CaptureStatus = z.infer<typeof captureStatusSchema>;
export { webSaveStatusSchema, type WebSaveStatus } from './documents.js';
import { documentSaveHintsShape } from './library-management.js';
/** Idempotency-Key is a required transport header equal to manifest.captureId. */
export const createWebCaptureRequestShapeSchema = z.strictObject({ ...documentSaveHintsShape, manifest: webCaptureManifestShapeSchema, targetDocumentId: z.uuid().optional(), translationIntent: translationIntentSchema });
export const createWebCaptureRequestSchema = createWebCaptureRequestShapeSchema.extend({ manifest: webCaptureManifestSchema });
export type CreateWebCaptureRequest = z.infer<typeof createWebCaptureRequestSchema>;
export const webCaptureResultSchema = z.strictObject({
  id: z.uuid(), captureId: z.uuid(), status: captureStatusSchema,
  receivedFileIds: z.array(webLocalIdSchema), missingFileIds: z.array(webLocalIdSchema),
  documentId: z.uuid().nullable(), sourceVersionId: z.uuid().nullable(), readerVersionId: z.uuid().nullable(), jobId: z.uuid().nullable(),
  saveStatus: z.enum(['original-saved', 'partial-resources']).nullable(), errorCode: z.string().min(1).nullable(), warnings: z.array(z.string().min(1)),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).refine(value => value.status !== 'completed' || (value.documentId !== null && value.sourceVersionId !== null && value.readerVersionId !== null && value.saveStatus !== null && value.missingFileIds.length === 0), 'Completed capture requires published identities and no missing uploads');
export type WebCaptureResult = z.infer<typeof webCaptureResultSchema>;
export const createDocumentLinkRequestSchema = z.strictObject({ ...documentSaveHintsShape, url: captureUrlSchema, title: z.string().min(1).max(2000).optional(), kind: z.enum(['article', 'x-post', 'repository', 'paper']).optional(), translationIntent: translationIntentSchema });
export type CreateDocumentLinkRequest = z.infer<typeof createDocumentLinkRequestSchema>;
export const documentLinkResultSchema = z.strictObject({ documentId: z.uuid(), jobId: z.uuid().nullable() });
export type DocumentLinkResult = z.infer<typeof documentLinkResultSchema>;
export const webReaderVersionSummarySchema = z.strictObject({ id: z.uuid(), createdAt: z.iso.datetime(), sourceVersionId: z.uuid(), parseId: parseIdSchema, translationStatus: readerTranslationStatusSchema, warnings: z.array(z.string().min(1)) });
export type WebReaderVersionSummary = z.infer<typeof webReaderVersionSummarySchema>;
export const webReaderVersionListSchema = z.strictObject({ items: z.array(webReaderVersionSummarySchema), total: safeNonnegativeIntegerSchema, page: z.number().int().positive(), pageSize: z.number().int().min(1).max(100) });
export type WebReaderVersionList = z.infer<typeof webReaderVersionListSchema>;
