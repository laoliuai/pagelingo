import { z } from 'zod';
import { readerContractCeilings } from './reader-limits.js';
import { translationBlockSchema } from '@pagelingo/translation-core';
import { pdfPageMetadataSchema } from './reader-source.js';
import { sourceIdentitySchema } from './documents.js';
import { blockIdSchema, languageDecisionSchema, nodeIdSchema, parseCoverageSchema, parseIdSchema, safeNonnegativeIntegerSchema, sha256Schema, withJsonDepthLimit } from './reader-common.js';
import { readerAssetSchema, readerBlockSchema, readerNodeSchema } from './reader.js';
import { generationKindSchema, readerTranslationStatusSchema } from './reader-translation.js';
import { readingProgressSchema } from './progress.js';
import { bundleLimitsSchema } from './bundle.js';

export const readerChunkIdSchema = z.string().regex(/^c_(?!000000)[0-9]{6}$/);
const pageIndices = z.array(safeNonnegativeIntegerSchema);
export const readerChunkBlockSchema = z.strictObject({
  source: readerBlockSchema,
  /** Recovered via SDK decodeTranslation, using source bindings. Never an uploaded format tree. */
  translation: translationBlockSchema.nullable(),
  sourceOnlyReason: z.enum(['language-not-required', 'manual-choice', 'pending', 'failed', 'cancelled']).nullable(),
});
export type ReaderChunkBlock = z.infer<typeof readerChunkBlockSchema>;
export const readerChunkSchema = withJsonDepthLimit(z.strictObject({
  id: readerChunkIdSchema, parseId: parseIdSchema, sourceSha256: sha256Schema,
  blockIds: z.array(blockIdSchema), blocks: z.array(readerChunkBlockSchema), nodes: z.array(readerNodeSchema),
  roots: z.array(nodeIdSchema), assets: z.array(readerAssetSchema),
}));
export type ReaderChunk = z.infer<typeof readerChunkSchema>;
export const readerIndexSchema = withJsonDepthLimit(z.strictObject({
  parseId: parseIdSchema, sourceSha256: sha256Schema,
  chunks: z.array(z.strictObject({ id: readerChunkIdSchema, blockIds: z.array(blockIdSchema), pageIndices, bytes: safeNonnegativeIntegerSchema })),
  toc: z.array(z.strictObject({ nodeId: nodeIdSchema, parentId: nodeIdSchema.nullable(), blockId: blockIdSchema, title: z.string(), depth: z.number().int().min(1).max(readerContractCeilings.maxDepth) })),
  blockLocations: z.record(blockIdSchema, z.strictObject({ chunkId: readerChunkIdSchema, pageIndices })),
  language: languageDecisionSchema, translationStatus: readerTranslationStatusSchema, generationKind: generationKindSchema,
  parseCoverage: parseCoverageSchema, assetIds: z.array(z.string().min(1)), warnings: z.array(z.string().min(1)),
}));
export type ReaderIndex = z.infer<typeof readerIndexSchema>;
export const readerDescriptorSchema = withJsonDepthLimit(z.strictObject({
  documentId: z.uuid(), versionId: z.uuid(), source: sourceIdentitySchema, parseId: parseIdSchema,
  index: readerIndexSchema,
  pages: z.array(pdfPageMetadataSchema).min(1).refine(pages => pages.every((page, index) => page.pageIndex === index), 'Pages must cover ordered physical indices'),
  assetMap: z.record(z.string().min(1), z.uuid()),
  translationStatus: readerTranslationStatusSchema, parseCoverage: parseCoverageSchema, warnings: z.array(z.string().min(1)),
  progress: readingProgressSchema.nullable(), restoreHint: z.literal('version-updated-source-page').nullable(),
}));
export type ReaderDescriptor = z.infer<typeof readerDescriptorSchema>;

export const bundleImportStatusSchema = z.enum(['created', 'receiving', 'validating', 'completed', 'failed', 'cancelled']);
export type BundleImportStatus = z.infer<typeof bundleImportStatusSchema>;
export const createBundleImportRequestSchema = z.strictObject({ targetDocumentId: z.uuid().optional() });
export type CreateBundleImportRequest = z.infer<typeof createBundleImportRequestSchema>;
export const bundleImportSchema = z.strictObject({
  id: z.uuid(), status: bundleImportStatusSchema, epoch: safeNonnegativeIntegerSchema,
  documentId: z.uuid().optional(), readerVersionId: z.uuid().optional(), errorCode: z.string().min(1).optional(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export type BundleImport = z.infer<typeof bundleImportSchema>;
export const bundleImportLimitsSchema = bundleLimitsSchema;

export const readerVersionSummarySchema = z.strictObject({
  id: z.uuid(), createdAt: z.iso.datetime(), sourceVersionId: z.uuid(), parseId: parseIdSchema,
  translationStatus: readerTranslationStatusSchema, parseCoverage: parseCoverageSchema, warnings: z.array(z.string().min(1)),
});
export type ReaderVersionSummary = z.infer<typeof readerVersionSummarySchema>;
export const readerVersionListSchema = z.strictObject({
  items: z.array(readerVersionSummarySchema), total: safeNonnegativeIntegerSchema,
  page: z.number().int().positive(), pageSize: z.number().int().min(1).max(100),
});
export type ReaderVersionList = z.infer<typeof readerVersionListSchema>;
const paginationNumberSchema = z.union([z.number(), z.string().regex(/^[0-9]+$/)]).pipe(z.coerce.number());
export const readerVersionListQuerySchema = z.strictObject({
  page: paginationNumberSchema.pipe(z.number().int().positive()).default(1),
  pageSize: paginationNumberSchema.pipe(z.number().int().min(1).max(100)).default(20),
});
export type ReaderVersionListQuery = z.infer<typeof readerVersionListQuerySchema>;
