import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { readerIrShapeSchema } from '../dist/reader.js';
import { readerTranslationShapeSchema } from '../dist/reader-translation.js';
import { documentBundleManifestShapeSchema } from '../dist/bundle.js';

import * as contracts from '../dist/index.js';

for (const [name, schema] of [
  ['reader-ir', readerIrShapeSchema],
  ['reader-translation', readerTranslationShapeSchema],
  ['document-bundle', documentBundleManifestShapeSchema],
  ['web-document-bundle', contracts.webDocumentBundleManifestShapeSchema],
  ['web-capture', contracts.webCaptureManifestShapeSchema],
  ['web-capture-translation-candidate', contracts.webCaptureTranslationCandidateShapeSchema],
  ['web-reader-ir', contracts.webReaderIrShapeSchema],
  ['web-reader-translation', contracts.webTranslationShapeSchema],
  ['web-imported-translation', contracts.webImportedTranslationShapeSchema],
  ['web-reader-index', contracts.webReaderIndexShapeSchema],
  ['web-reader-chunk', contracts.webReaderChunkShapeSchema],
  ['web-reader-descriptor', contracts.webReaderDescriptorShapeSchema],
  ['web-reading-position', contracts.webReadingPositionSchema],
  ['web-reading-progress', contracts.webReadingProgressSchema],
  ['web-api', contracts.createWebCaptureRequestShapeSchema],
  ['document-summary', contracts.documentSummarySchema],
  ['document-organization', contracts.documentOrganizationSchema],
  ['patch-document-organization', contracts.patchDocumentOrganizationSchema],
  ['library-query', contracts.libraryQueryShapeSchema],
  ['library-page', contracts.libraryPageSchema],
  ['document-link-request', contracts.createDocumentLinkRequestSchema],
  ['bundle-import-request', contracts.createBundleImportRequestSchema],
  ['source-details', contracts.sourceDetailsSchema],
  ['source-refresh-request', contracts.sourceRefreshRequestSchema],
  ['source-reference', contracts.sourceReferenceSchema],
  ['source-versions', contracts.sourceVersionsSchema],
  ['devices', contracts.deviceDtoSchema],
  ['web-exports', contracts.webExportSchema],
  ['web-export-request', contracts.createWebExportRequestSchema],
  ['web-jobs', contracts.webJobSchema],
  ['web-job-list', contracts.webJobListSchema],
  ['web-job-list-query', contracts.webJobListQuerySchema],
  ['web-job-request', contracts.createWebJobRequestSchema],
  ['save-preferences', contracts.savePreferencesSchema],
  ['glossary', contracts.glossaryRevisionSchema],
  ['web-language', contracts.webLanguageDecisionSchema],
]) {
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-2020-12', ...(name === 'library-query' ? { io: 'input' } : {}) });
  jsonSchema.$id = `https://pagelingo.dev/schemas/${name}/1`;
  jsonSchema.$comment = 'Shape validation only. Reader graph, translation references, SDK replay, resource closure and actual byte hashes require their dedicated validators.';
  writeFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), `${JSON.stringify(jsonSchema, null, 2)}\n`);
}
