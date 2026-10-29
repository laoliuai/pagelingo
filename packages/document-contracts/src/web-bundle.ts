import { z } from 'zod';
import { githubSourceRevisionSchema } from './source-details.js';
import { captureUrlSchema, defaultCaptureLimits, webLocalIdSchema } from './web-capture.js';
import { bundleFileSchema } from './bundle.js';
import { readerContractCeilings } from './reader-limits.js';
import { parseIdSchema, sha256Schema, withJsonDepthLimit } from './reader-common.js';
import { readerTranslationStatusSchema } from './reader-translation.js';
import { webGenerationKindSchema } from './web-translation.js';
const originalCaptureSchema = z.strictObject({ manifestSha256: sha256Schema, requestSha256: sha256Schema, admissionKind: z.enum(['upload', 'fetch']) });
/** Shape only. Actual source, SDK proof and executable closure require validateWebBundle.
 * Title is an export-time header snapshot, including legal legacy titles. */
export const webDocumentBundleManifestShapeSchema = z.strictObject({
  schemaVersion: z.literal('pagelingo-web-document-bundle/1'),
  packageId: z.uuid(), createdAt: z.iso.datetime(), title: z.string().min(1),
  source: z.strictObject({
    manifestPath: z.literal('source/manifest.json'), manifestSha256: sha256Schema,
    snapshotSha256: sha256Schema, contentFingerprint: sha256Schema,
  }),
  originals: z.union([
    z.strictObject({ capture: originalCaptureSchema, readerCapture: originalCaptureSchema.extend({
      translationSha256: sha256Schema,
      sharedFiles: z.array(z.strictObject({ id: webLocalIdSchema, sourceFileId: webLocalIdSchema })).max(defaultCaptureLimits.maxFiles),
    }).optional() }),
    z.strictObject({ github: z.strictObject({
      sourceManifestSha256: sha256Schema, revision: githubSourceRevisionSchema, jobId: z.uuid(),
      files: z.array(z.strictObject({
        id: z.uuid(), assetId: z.uuid(), role: z.string().regex(/^[a-z][a-z0-9-]{0,99}$/),
        url: captureUrlSchema, filename: z.string().min(1).max(255),
        sha256: sha256Schema, bytes: z.number().int().nonnegative().max(defaultCaptureLimits.maxResourceBytes),
        mediaType: z.string().min(1),
      })).min(1).max(defaultCaptureLimits.maxFiles),
    }) }),
  ]).optional(),
  parse: z.strictObject({ id: parseIdSchema, readerIrSha256: sha256Schema }),
  translation: z.strictObject({ path: z.literal('translation.json'), sha256: sha256Schema,
    status: readerTranslationStatusSchema, generationKind: webGenerationKindSchema }).nullable(),
  renderer: z.strictObject({ version: z.string().min(1), codeSha256: sha256Schema }),
  files: z.array(bundleFileSchema).max(readerContractCeilings.maxFiles - 1),
});
export const webDocumentBundleManifestSchema = withJsonDepthLimit(webDocumentBundleManifestShapeSchema);
export type WebDocumentBundleManifest = z.infer<typeof webDocumentBundleManifestSchema>;
