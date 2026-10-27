import { captureUrlSchema } from './web-capture.js';
import { webSourceIdentitySchema } from './web-reader.js';
import { webSaveStatusSchema } from './web-api.js';
import { z } from 'zod';
import { parseCoverageSchema } from './reader-common.js';
import { readerTranslationStatusSchema } from './reader-translation.js';

export const sourceIdentitySchema = z.strictObject({
  documentId: z.uuid(),
  sourceVersionId: z.uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  assetId: z.uuid(),
  bytes: z.number().int().positive(),
});
export type SourceIdentity = z.infer<typeof sourceIdentitySchema>;

export const pdfDocumentSummarySchema = z.strictObject({
  id: z.uuid(),
  kind: z.literal('pdf'),
  title: z.string().min(1),
  originalFilename: z.string().min(1),
  createdAt: z.iso.datetime(),
  source: sourceIdentitySchema,
  saveStatus: z.literal('original-saved'),
  processingStatus: z.enum(['awaiting-local-processing', 'reader-ready']),
  reader: z.strictObject({ versionId: z.uuid(), translationStatus: readerTranslationStatusSchema, parseCoverage: parseCoverageSchema, warnings: z.array(z.string().min(1)) }).nullable(),
}).refine(value => (value.processingStatus === 'reader-ready') === (value.reader !== null), {
  message: 'Reader readiness must match the reader version', path: ['reader'],
});
export type PdfDocumentSummary = z.infer<typeof pdfDocumentSummarySchema>;
export const webDocumentSummarySchema = z.strictObject({
  id: z.uuid(), kind: z.enum(['article', 'x-post', 'repository', 'paper']), title: z.string().min(1),
  originalFilename: z.null(), createdAt: z.iso.datetime(), url: captureUrlSchema,
  source: webSourceIdentitySchema.nullable(), saveStatus: webSaveStatusSchema,
  processingStatus: z.enum(['link-only', 'fetch-queued', 'fetching', 'fetch-failed', 'awaiting-config', 'reader-ready']),
  reader: z.strictObject({ versionId: z.uuid(), translationStatus: readerTranslationStatusSchema, warnings: z.array(z.string().min(1)) }).nullable(),
}).refine(value => (value.source === null) === (value.saveStatus === 'link-only'), 'Web source and save status must agree')
  .refine(value => value.reader === null || value.source !== null, 'Web reader requires an archived source')
  .refine(value => !['repository', 'paper'].includes(value.kind) || (value.source === null && value.reader === null), 'Repository and paper entries are links only');
export type WebDocumentSummary = z.infer<typeof webDocumentSummarySchema>;
export const documentSummarySchema = z.union([pdfDocumentSummarySchema, webDocumentSummarySchema]);
export type DocumentSummary = z.infer<typeof documentSummarySchema>;

export const documentListSchema = z.strictObject({
  items: z.array(documentSummarySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(100),
});
export type DocumentList = z.infer<typeof documentListSchema>;

const queryNumberSchema = z.union([z.number(), z.string().regex(/^[0-9]+$/)]).pipe(z.coerce.number());

export const documentListQuerySchema = z.strictObject({
  page: queryNumberSchema.pipe(z.number().int().positive()).default(1),
  pageSize: queryNumberSchema.pipe(z.number().int().min(1).max(100)).default(20),
  q: z.string().max(200).optional(),
});
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;
