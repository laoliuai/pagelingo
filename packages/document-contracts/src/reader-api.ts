import { z } from 'zod';
import { readerContractCeilings } from './reader-limits.js';
import { translationBlockSchema } from '@pagelingo/translation-core';
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
  index: readerIndexSchema, assetMap: z.record(z.string().min(1), z.uuid()),
  translationStatus: readerTranslationStatusSchema, parseCoverage: parseCoverageSchema, warnings: z.array(z.string().min(1)),
  progress: readingProgressSchema.nullable(), restoreHint: z.literal('version-updated-source-page').nullable(),
}));
export type ReaderDescriptor = z.infer<typeof readerDescriptorSchema>;

export const bundleImportStatusSchema = z.enum(['uploading', 'validating', 'publishing', 'completed', 'failed', 'cancelled']);
export type BundleImportStatus = z.infer<typeof bundleImportStatusSchema>;
export const createBundleImportRequestSchema = z.strictObject({ documentId: z.uuid().nullable() });
export type CreateBundleImportRequest = z.infer<typeof createBundleImportRequestSchema>;
export const bundleImportSchema = z.strictObject({
  id: z.uuid(), documentId: z.uuid().nullable(), status: bundleImportStatusSchema,
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  readerVersionId: z.uuid().nullable(), error: z.strictObject({ code: z.string().min(1), message: z.string().min(1) }).nullable(),
});
export type BundleImport = z.infer<typeof bundleImportSchema>;
export const bundleImportLimitsSchema = bundleLimitsSchema;
