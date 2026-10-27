import { z } from 'zod';
import { readerContractCeilings } from './reader-limits.js';
export { readerContractCeilings } from './reader-limits.js';
import { bundlePathSchema, parseIdSchema, safeNonnegativeIntegerSchema, safePositiveIntegerSchema, sha256Schema, withJsonDepthLimit } from './reader-common.js';
import { readerPdfSourceSchema } from './reader-source.js';
import { generationKindSchema, readerTranslationStatusSchema } from './reader-translation.js';
export { bundlePathSchema } from './reader-common.js';

export const bundleLimitsSchema = z.strictObject({
  maxArchiveBytes: safePositiveIntegerSchema, maxPdfBytes: safePositiveIntegerSchema, maxExpandedBytes: safePositiveIntegerSchema,
  maxFiles: safePositiveIntegerSchema.max(readerContractCeilings.maxFiles), maxManifestBytes: safePositiveIntegerSchema, maxIrBytes: safePositiveIntegerSchema,
  maxTranslationBytes: safePositiveIntegerSchema, maxProvenanceFileBytes: safePositiveIntegerSchema, maxOtherFileBytes: safePositiveIntegerSchema,
  maxPathBytes: safePositiveIntegerSchema.max(readerContractCeilings.maxPathBytes), maxNodes: safePositiveIntegerSchema.max(readerContractCeilings.maxNodes), maxBlocks: safePositiveIntegerSchema.max(readerContractCeilings.maxBlocks),
  maxDepth: safePositiveIntegerSchema.max(readerContractCeilings.maxDepth), maxJsonDepth: safePositiveIntegerSchema.max(readerContractCeilings.maxJsonDepth), maxTextBytes: safePositiveIntegerSchema.max(readerContractCeilings.maxTextBytes),
  maxCodeBytes: safePositiveIntegerSchema.max(readerContractCeilings.maxCodeBytes), maxLatexBytes: safePositiveIntegerSchema.max(readerContractCeilings.maxLatexBytes), maxImagePixels: safePositiveIntegerSchema.max(readerContractCeilings.maxImagePixels),
  maxImageDimension: safePositiveIntegerSchema.max(readerContractCeilings.maxImageDimension),
});
export type BundleLimits = z.infer<typeof bundleLimitsSchema>;
export const defaultBundleLimits: Readonly<BundleLimits> = Object.freeze({
  maxArchiveBytes: 268435456, maxPdfBytes: 268435456, maxExpandedBytes: 1073741824,
  ...readerContractCeilings, maxManifestBytes: 2097152, maxIrBytes: 33554432, maxTranslationBytes: 33554432,
  maxProvenanceFileBytes: 134217728, maxOtherFileBytes: 67108864,
});
/** Structural fields reject above-ceiling overrides; operational byte budgets may grow.
 * maxPdfBytes has one source of configuration: PAGELINGO_MAX_PDF_BYTES. */
export const bundleLimitsOverrideSchema = bundleLimitsSchema.omit({ maxPdfBytes: true }).partial();
export type BundleLimitsOverride = z.infer<typeof bundleLimitsOverrideSchema>;
export const bundleFileSchema = z.strictObject({
  path: bundlePathSchema, bytes: safeNonnegativeIntegerSchema, sha256: sha256Schema, mediaType: z.string().min(1),
  role: z.enum(['source', 'reader-ir', 'translation', 'render', 'asset', 'provenance', 'license']),
});
export type BundleFile = z.infer<typeof bundleFileSchema>;
/** File membership, required paths, aliases, identity joins and actual byte hashes belong
 * to the bundle validator. This schema validates the manifest's shape only. */
export const documentBundleManifestShapeSchema = z.strictObject({
  schemaVersion: z.literal('pagelingo-document-bundle/1'), packageId: z.uuid(), createdAt: z.iso.datetime(),
  title: z.string().min(1), originalFilename: z.string().min(1), source: readerPdfSourceSchema,
  parse: z.strictObject({ id: parseIdSchema, inputManifestSha256: sha256Schema, projectorVersion: z.string().min(1), configSha256: sha256Schema }),
  readerIrSha256: sha256Schema,
  translation: z.strictObject({ id: z.uuid(), sha256: sha256Schema, status: readerTranslationStatusSchema, generationKind: generationKindSchema }),
  renderer: z.strictObject({ version: z.string().min(1), codeSha256: sha256Schema }),
  files: z.array(bundleFileSchema).max(readerContractCeilings.maxFiles - 1),
});
export const documentBundleManifestSchema = withJsonDepthLimit(documentBundleManifestShapeSchema);
export type DocumentBundleManifest = z.infer<typeof documentBundleManifestSchema>;
