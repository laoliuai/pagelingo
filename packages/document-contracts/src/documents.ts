import { captureUrlSchema } from './web-capture.js';
import { webSourceIdentitySchema } from './web-reader.js';
import { z } from 'zod';
import { parseCoverageSchema } from './reader-common.js';
import { readerTranslationStatusSchema } from './reader-translation.js';

export const webSaveStatusSchema = z.enum(['link-only', 'original-saved', 'partial-resources']);
export type WebSaveStatus = z.infer<typeof webSaveStatusSchema>;

export const sourceIdentitySchema = z.strictObject({
  documentId: z.uuid(),
  sourceVersionId: z.uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  assetId: z.uuid(),
  bytes: z.number().int().positive(),
});
export type SourceIdentity = z.infer<typeof sourceIdentitySchema>;

const pdfDocumentSummaryShape = {
  id: z.uuid(),
  kind: z.literal('pdf'),
  title: z.string().min(1),
  originalFilename: z.string().min(1),
  createdAt: z.iso.datetime(),
  source: sourceIdentitySchema,
  saveStatus: z.literal('original-saved'),
  processingStatus: z.enum(['awaiting-local-processing', 'reader-ready']),
  reader: z.strictObject({ versionId: z.uuid(), translationStatus: readerTranslationStatusSchema, parseCoverage: parseCoverageSchema, warnings: z.array(z.string().min(1)) }).nullable(),
};
const pdfReadinessJsonSchema = { anyOf: [
  { properties: { processingStatus: { const: 'reader-ready' }, reader: { type: 'object' } } },
  { properties: { processingStatus: { const: 'awaiting-local-processing' }, reader: { type: 'null' } } },
] };
const readerReadiness = (value: { processingStatus: string; reader: unknown }) => (value.processingStatus === 'reader-ready') === (value.reader !== null);
export const pdfDocumentSummarySchema = z.strictObject(pdfDocumentSummaryShape).refine(readerReadiness, {
  message: 'Reader readiness must match the reader version', path: ['reader'],
}).meta(pdfReadinessJsonSchema);
export type PdfDocumentSummary = z.infer<typeof pdfDocumentSummarySchema>;
export const paperPdfDocumentSummarySchema = z.strictObject({ ...pdfDocumentSummaryShape, kind: z.literal('paper'), url: captureUrlSchema }).refine(readerReadiness, {
  message: 'Reader readiness must match the reader version', path: ['reader'],
}).meta(pdfReadinessJsonSchema);
export type PaperPdfDocumentSummary = z.infer<typeof paperPdfDocumentSummarySchema>;
export const webDocumentSummarySchema = z.strictObject({
  id: z.uuid(), kind: z.enum(['article', 'x-post', 'repository', 'paper']), title: z.string().min(1),
  originalFilename: z.null(), createdAt: z.iso.datetime(), url: captureUrlSchema,
  source: webSourceIdentitySchema.nullable(), saveStatus: webSaveStatusSchema,
  processingStatus: z.enum(['link-only', 'fetch-queued', 'fetching', 'fetch-failed', 'awaiting-config', 'reader-ready']),
  reader: z.strictObject({ versionId: z.uuid(), translationStatus: readerTranslationStatusSchema, warnings: z.array(z.string().min(1)) }).nullable(),
}).refine(value => (value.source === null) === (value.saveStatus === 'link-only'), 'Web source and save status must agree')
  .refine(value => value.reader === null || value.source !== null, 'Web reader requires an archived source')
  .refine(value => value.kind !== 'paper' || (value.source === null && value.reader === null), 'Paper Web entries are links only').meta({ anyOf: [
    { properties: { source: { type: 'null' }, saveStatus: { const: 'link-only' }, reader: { type: 'null' } } },
    { properties: { source: { type: 'object' }, saveStatus: { enum: ['original-saved', 'partial-resources'] }, kind: { enum: ['article', 'x-post', 'repository'] } } },
  ] });
export type WebDocumentSummary = z.infer<typeof webDocumentSummarySchema>;
export const documentSummarySchema = z.union([pdfDocumentSummarySchema, webDocumentSummarySchema, paperPdfDocumentSummarySchema]);
export type DocumentSummary = z.infer<typeof documentSummarySchema>;

/** Dispatch validated summaries by their stored PDF source capability, never URL suffix. */
export function isPdfReadableDocument(value: DocumentSummary): value is PdfDocumentSummary | PaperPdfDocumentSummary {
  return value.kind === 'pdf' || (value.kind === 'paper' && value.source !== null && 'assetId' in value.source);
}

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
