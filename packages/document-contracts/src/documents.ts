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

export const documentSummarySchema = z.strictObject({
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
