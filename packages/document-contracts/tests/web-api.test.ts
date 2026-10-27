import { expect, test } from 'vitest';
import * as contracts from '../src/index.js';
import { manifest, uuid } from './web-fixtures.js';

test('accepts explicit capture intent and rejects caller ownership or provider secrets', () => {
  const request = { manifest, translationIntent: 'none' };
  expect(contracts.createWebCaptureRequestSchema.parse(request)).toEqual(request);
  for (const patch of [{ ownerId: uuid }, { apiKey: 'secret' }, { translationIntent: 'silent' }]) {
    expect(contracts.createWebCaptureRequestSchema.safeParse({ ...request, ...patch }).success).toBe(false);
  }
});
test('limits device scopes and keeps preference and glossary revisions explicit', () => {
  expect(contracts.deviceScopeSchema.safeParse('preferences:read').success).toBe(true);
  expect(contracts.deviceScopeSchema.safeParse('provider:read').success).toBe(false);
  expect(contracts.savePreferencesSchema.parse({ revision: 0, autoTranslate: false })).toEqual(contracts.defaultSavePreferences);
  expect(contracts.savePreferencesUpdateSchema.safeParse({ expectedRevision: -1, autoTranslate: true }).success).toBe(false);
  expect(contracts.glossaryUpdateSchema.safeParse({ expectedRevision: 0, entries: [], ownerId: uuid }).success).toBe(false);
});
test('keeps link-only sources nullable without weakening PDF summaries', () => {
  const summary = { id: uuid, kind: 'article', title: 'Article', originalFilename: null, createdAt: '2026-10-27T00:00:00.000Z', url: 'https://example.com/', source: null, saveStatus: 'link-only', processingStatus: 'link-only', reader: null };
  expect(contracts.documentSummarySchema.parse(summary)).toEqual(summary);
  expect(contracts.documentSummarySchema.safeParse({ ...summary, kind: 'pdf' }).success).toBe(false);
});
test('restricts repository and paper entries to links in S3', () => {
  const source = { documentId: uuid, sourceVersionId: uuid, manifestAssetId: uuid, sha256: 'a'.repeat(64), snapshotSha256: 'b'.repeat(64), bytes: 100 };
  const value = { id: uuid, kind: 'repository', title: 'Repo', originalFilename: null, createdAt: '2026-10-27T00:00:00.000Z', url: 'https://example.com/', source, saveStatus: 'original-saved', processingStatus: 'reader-ready', reader: null };
  expect(contracts.webDocumentSummarySchema.safeParse(value).success).toBe(false);
});
test('distributes strict portable Web JSON shapes matching the public Zod DTOs', async () => {
  const { readFileSync } = await import('node:fs');
  const { Ajv2020 } = await import('ajv/dist/2020.js');
  const addFormats = (await import('ajv-formats')).default.default;
  const { ir, position, sha, blockId } = await import('./web-fixtures.js');
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const chunk = { id: 'c_000001', parseId: ir.parse.id, sourceSha256: sha, blocks: [{ source: ir.blocks[0], translation: null, sourceOnlyReason: 'pending' }], nodes: ir.nodes, roots: ir.roots, assets: [] };
  const index = { parseId: ir.parse.id, sourceSha256: sha, chunks: [{ id: 'c_000001', blockIds: [blockId], bytes: 100 }], toc: [], blockLocations: { [blockId]: { chunkId: 'c_000001', nodeId: 'source-1', previewId: null } }, language: ir.metadata.language, translationStatus: 'pending', generationKind: 'none', assetIds: [], warnings: [] };
  const source = { documentId: uuid, sourceVersionId: uuid, manifestAssetId: uuid, sha256: sha, snapshotSha256: sha, bytes: 100 };
  const timestamp = '2026-10-27T00:00:00.000Z';
  const translation = { ...JSON.parse(readFileSync(new URL('../fixtures/reader-v1/translation.json', import.meta.url), 'utf8')), schemaVersion: 'web-reader-translation/1' };
  const cases = [
    { name: 'web-capture', schema: contracts.webCaptureManifestSchema, value: manifest },
    { name: 'web-reader-ir', schema: contracts.webReaderIrSchema, value: ir },
    { name: 'web-reader-translation', schema: contracts.webTranslationSchema, value: translation },
    { name: 'web-reader-chunk', schema: contracts.webReaderChunkSchema, value: chunk },
    { name: 'web-reader-index', schema: contracts.webReaderIndexSchema, value: index },
    { name: 'web-reader-descriptor', schema: contracts.webReaderDescriptorSchema, value: { documentId: uuid, versionId: uuid, source, parseId: ir.parse.id, index, assetMap: {}, snapshots: manifest.snapshots, translationStatus: 'pending', warnings: [], progress: null, restoreHint: null } },
    { name: 'web-reading-position', schema: contracts.webReadingPositionSchema, value: position },
    { name: 'web-reading-progress', schema: contracts.webReadingProgressSchema, value: { position, revision: 0, updatedAt: timestamp } },
    { name: 'web-api', schema: contracts.createWebCaptureRequestSchema, value: { manifest, translationIntent: 'none' } },
    { name: 'devices', schema: contracts.deviceDtoSchema, value: { id: uuid, name: 'Browser', createdAt: timestamp, expiresAt: timestamp, revokedAt: null } },
    { name: 'web-job-request', schema: contracts.createWebJobRequestSchema, value: { sourceVersionId: uuid, parseId: ir.parse.id, profileRevision: 0, glossaryRevision: 0, sourceLanguage: 'pt-BR', selectionBlockIds: [blockId] } },
    { name: 'web-jobs', schema: contracts.webJobSchema, value: { id: uuid, documentId: uuid, kind: 'fetch-link', status: 'queued', sourceVersionId: null, parseId: null, profileRevision: null, glossaryRevision: null, sourceLanguage: null, selectionBlockIds: null, readerVersionId: null, completedUnits: 0, totalUnits: 0, errorCode: null, warnings: [], createdAt: timestamp, updatedAt: timestamp } },
    { name: 'save-preferences', schema: contracts.savePreferencesSchema, value: { revision: 0, autoTranslate: false } },
    { name: 'glossary', schema: contracts.glossaryRevisionSchema, value: { revision: 0, entries: [] } },
    { name: 'web-language', schema: contracts.webLanguageDecisionSchema, value: ir.metadata.language },
  ];
  for (const { name, schema, value } of cases) {
    const validate = ajv.compile(JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), 'utf8')));
    expect(validate(value), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
    expect(schema.safeParse(value).success, name).toBe(true);
    for (const candidate of [{ ...value, ownerId: uuid }, { ...value, token: 'private' }, null]) {
      expect(validate(candidate), name).toBe(false);
      expect(schema.safeParse(candidate).success, name).toBe(false);
    }
  }
});
test('represents immutable manual job language and bounded unique block selection', () => {
  const blockId = `b_${'a'.repeat(32)}`;
  const request = { sourceVersionId: uuid, parseId: `p_${'a'.repeat(64)}`, profileRevision: 0, glossaryRevision: 0, sourceLanguage: 'pt-BR', selectionBlockIds: [blockId] };
  expect(contracts.createWebJobRequestSchema.parse(request)).toEqual(request);
  for (const patch of [{ selectionBlockIds: [] }, { selectionBlockIds: [''] }, { selectionBlockIds: [blockId, blockId] }, { selectionBlockIds: Array(20001).fill(blockId) }, { sourceLanguage: 'und-Latn' }, { sourceLanguage: 'mul' }, { sourceLanguage: 'ZXX' }]) {
    expect(contracts.createWebJobRequestSchema.safeParse({ ...request, ...patch }).success).toBe(false);
  }
  const { sourceLanguage: _language, selectionBlockIds: _selection, ...wholeSource } = request;
  expect(contracts.createWebJobRequestSchema.parse(wholeSource)).toEqual(wholeSource);
  const job = { id: uuid, documentId: uuid, kind: 'translate', status: 'queued', ...request, readerVersionId: null, completedUnits: 0, totalUnits: 1, errorCode: null, warnings: [], createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z' };
  expect(contracts.webJobSchema.parse(job)).toEqual(job);
  expect(contracts.webJobSchema.safeParse({ ...job, ownerId: uuid }).success).toBe(false);
});
