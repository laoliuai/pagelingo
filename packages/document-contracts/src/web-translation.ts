import { z } from 'zod';
import { readerTranslationShapeSchema } from './reader-translation.js';
import { blockIdSchema, parseIdSchema, sha256Schema, withJsonDepthLimit } from './reader-common.js';
import { captureTranslationCandidateBlockSchema, defaultCaptureLimits } from './web-capture.js';
import { sourceLanguageSchema } from './language.js';
/** Model runs retain the original Web shape and all model provenance requirements. */
export const webModelTranslationShapeSchema = readerTranslationShapeSchema.extend({ schemaVersion: z.literal('web-reader-translation/1') });
export const webModelTranslationSchema = withJsonDepthLimit(webModelTranslationShapeSchema);
export type WebModelTranslation = z.infer<typeof webModelTranslationSchema>;
export const webGenerationKindSchema = z.enum(['model', 'mock', 'none', 'import']);
/** Whole-block import evidence; source IDs are rebound only after exact source structure comparison. */
export const webImportedTranslationShapeSchema = z.strictObject({
  schemaVersion: z.literal('web-imported-translation/1'), id: z.uuid(), generationKind: z.literal('import'),
  sourceSha256: sha256Schema, parseId: parseIdSchema, readerIrSha256: sha256Schema,
  sourceSnapshotSha256: sha256Schema, sourceContentFingerprint: sha256Schema,
  sdkVersion: z.string().min(1).max(100), promptVersion: z.string().min(1).max(100), protectionVersion: z.string().min(1).max(100),
  sourceLanguage: sourceLanguageSchema.nullable(), targetLanguage: sourceLanguageSchema,
  blocks: z.array(captureTranslationCandidateBlockSchema.extend({ blockId: blockIdSchema })).min(1).max(defaultCaptureLimits.maxBlocks),
  status: z.enum(['partial', 'completed']),
});
export const webImportedTranslationSchema = withJsonDepthLimit(webImportedTranslationShapeSchema);
export type WebImportedTranslation = z.infer<typeof webImportedTranslationSchema>;
export const webTranslationShapeSchema = z.union([webModelTranslationShapeSchema, webImportedTranslationShapeSchema]);
export const webTranslationSchema = withJsonDepthLimit(webTranslationShapeSchema);
export type WebTranslation = z.infer<typeof webTranslationSchema>;
