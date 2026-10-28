import { z } from 'zod';
import { bundleFileSchema } from './bundle.js';
import { readerContractCeilings } from './reader-limits.js';
import { parseIdSchema, sha256Schema, withJsonDepthLimit } from './reader-common.js';
import { readerTranslationStatusSchema } from './reader-translation.js';
import { webGenerationKindSchema } from './web-translation.js';
/** Shape only. Actual source, SDK proof and executable closure require validateWebBundle.
 * Title is an export-time header snapshot, including legal legacy titles. */
export const webDocumentBundleManifestShapeSchema = z.strictObject({
  schemaVersion: z.literal('pagelingo-web-document-bundle/1'),
  packageId: z.uuid(), createdAt: z.iso.datetime(), title: z.string().min(1),
  source: z.strictObject({
    manifestPath: z.literal('source/manifest.json'), manifestSha256: sha256Schema,
    snapshotSha256: sha256Schema, contentFingerprint: sha256Schema,
  }),
  parse: z.strictObject({ id: parseIdSchema, readerIrSha256: sha256Schema }),
  translation: z.strictObject({ path: z.literal('translation.json'), sha256: sha256Schema,
    status: readerTranslationStatusSchema, generationKind: webGenerationKindSchema }).nullable(),
  renderer: z.strictObject({ version: z.string().min(1), codeSha256: sha256Schema }),
  files: z.array(bundleFileSchema).max(readerContractCeilings.maxFiles - 1),
});
export const webDocumentBundleManifestSchema = withJsonDepthLimit(webDocumentBundleManifestShapeSchema);
export type WebDocumentBundleManifest = z.infer<typeof webDocumentBundleManifestSchema>;
