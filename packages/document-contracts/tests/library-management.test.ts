import { portable } from './portable-schema-fixtures.js';
import { expect, test } from 'vitest';
import * as contracts from '../src/index.js';
import { manifest, uuid } from './web-fixtures.js';

const timestamp = '2026-10-27T00:00:00.000Z';
const pdf = { id: uuid, kind: 'pdf', title: 'PDF', originalFilename: 'paper.pdf', createdAt: timestamp,
  source: { documentId: uuid, sourceVersionId: uuid, assetId: uuid, sha256: 'a'.repeat(64), bytes: 100 },
  saveStatus: 'original-saved', processingStatus: 'awaiting-local-processing', reader: null };
const link = { id: uuid, kind: 'article', title: 'Web', originalFilename: null, createdAt: timestamp, url: 'https://example.com/not-a-pdf', source: null, saveStatus: 'link-only', processingStatus: 'link-only', reader: null };
const webSource = { documentId: uuid, sourceVersionId: uuid, manifestAssetId: uuid, sha256: 'a'.repeat(64), snapshotSha256: 'b'.repeat(64), bytes: 100 };
const tagIds = Array.from({ length: 33 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
const organization = { documentId: uuid, revision: 0, lifecycleEpoch: 1, title: 'Title', collectionId: null, tagIds: [], note: '', readingStatus: 'unread', updatedAt: timestamp };

test('keeps old summaries while distinguishing paper PDF and repository Web', () => {
  expect(contracts.isPdfReadableDocument).toBeTypeOf('function');
  const paper = { ...pdf, kind: 'paper', url: link.url };
  const readyPaper = { ...paper, processingStatus: 'reader-ready', reader: { versionId: uuid, translationStatus: 'pending', parseCoverage: 'full', warnings: [] } };
  const repository = { ...link, kind: 'repository', source: webSource, saveStatus: 'original-saved', processingStatus: 'reader-ready', reader: { versionId: uuid, translationStatus: 'pending', warnings: [] } };
  for (const value of [pdf, link, { ...link, kind: 'x-post' }, { ...link, kind: 'paper' }, { ...link, kind: 'repository' }, paper, readyPaper, repository]) {
    expect(contracts.documentSummarySchema.parse(value)).toEqual(value);
    expect(contracts.isPdfReadableDocument(contracts.documentSummarySchema.parse(value))).toBe(value === pdf || value === paper || value === readyPaper);
  }
  for (const value of [{ ...paper, source: webSource }, { ...repository, source: pdf.source }, { ...paper, processingStatus: 'reader-ready' }, { ...repository, source: null }, { ...repository, kind: 'paper' }, { ...paper, reader: { versionId: uuid, translationStatus: 'pending', warnings: [] } }]) {
    expect(contracts.documentSummarySchema.safeParse(value).success).toBe(false);
  }
});

test('rejects invalid organization and pagination', () => {
  expect(contracts.documentOrganizationSchema).toBeDefined();
  expect(contracts.documentOrganizationSchema.parse(organization)).toEqual(organization);
  expect(contracts.documentOrganizationSchema.safeParse({ ...organization, tagIds: tagIds.slice(0, 32) }).success).toBe(true);
  const { lifecycleEpoch: _epoch, ...withoutEpoch } = organization;
  expect(contracts.documentOrganizationSchema.safeParse(withoutEpoch).success).toBe(false);
  expect(contracts.documentOrganizationSchema.parse({ ...organization, title: 'x'.repeat(501) }).title).toHaveLength(501);
  for (const patch of [{ ownerId: uuid }, { unknown: true }, { tagIds: [uuid, uuid] }, { tagIds }, { revision: -1 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { lifecycleEpoch: 0 }, { lifecycleEpoch: -1 }, { lifecycleEpoch: 1.5 }, { lifecycleEpoch: Number.MAX_SAFE_INTEGER + 1 }, { note: 'x'.repeat(10001) }]) {
    expect(contracts.documentOrganizationSchema.safeParse({ ...organization, ...patch }).success, JSON.stringify(patch)).toBe(false);
  }
  expect(contracts.documentOrganizationSchema.safeParse({ ...organization, lifecycleEpoch: Number.MAX_SAFE_INTEGER }).success).toBe(true);
  expect(contracts.patchDocumentOrganizationSchema.parse({ expectedRevision: 0, note: '' })).toEqual({ expectedRevision: 0, note: '' });
  for (const value of [{ expectedRevision: 0 }, { expectedRevision: 0, title: '' }, { expectedRevision: 0, title: 'x'.repeat(501) }, { expectedRevision: -1, note: '' }, { expectedRevision: Number.MAX_SAFE_INTEGER + 1, note: '' }, { expectedRevision: 0, lifecycleEpoch: 1 }, { expectedRevision: 0, ownerId: uuid, note: '' }]) expect(contracts.patchDocumentOrganizationSchema.safeParse(value).success).toBe(false);
  expect(contracts.libraryQuerySchema.safeParse({ tagIds: tagIds.slice(0, 16) }).success).toBe(true);
  expect(contracts.libraryQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
  expect(contracts.libraryQuerySchema.parse({ page: '2', pageSize: '100', collectionId: 'none', tagIds: uuid })).toEqual({ page: 2, pageSize: 100, collectionId: 'none', tagIds: [uuid] });
  for (const value of [{ page: 1000001 }, { page: 0 }, { page: true }, { pageSize: 101 }, { page: '1.5' }, { q: 'x'.repeat(201) }, { tagIds: [uuid, uuid] }, { tagIds: tagIds.slice(0, 17) }, { tagIds: `${uuid},${uuid}` }, { ownerId: uuid }, { kind: 'unknown' }, { origin: 'unknown' }]) expect(contracts.libraryQuerySchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  const page = { items: [{ document: pdf, organization, origin: 'upload' }], total: 1, page: 1, pageSize: 20 };
  expect(contracts.libraryPageSchema.parse(page)).toEqual(page);
  expect(contracts.libraryPageSchema.safeParse({ ...page, ownerId: uuid }).success).toBe(false);
});

test('preserves omitted save hints and validates new hints without caller ownership', () => {
  const requests = [
    { schema: contracts.createDocumentLinkRequestSchema, value: { url: link.url, translationIntent: 'none' } },
    { schema: contracts.createWebCaptureRequestSchema, value: { manifest, translationIntent: 'none' } },
    { schema: contracts.createBundleImportRequestSchema, value: {} },
  ];
  for (const { schema, value } of requests) {
    expect(schema.parse(value)).toEqual(value);
    const hints = { organization: { collectionId: null, tagIds: [uuid] }, discoveredFromDocumentId: uuid };
    expect(schema.parse({ ...value, ...hints })).toEqual({ ...value, ...hints });
    for (const organization of [{ collectionId: uuid, tagIds: [uuid, uuid] }, { collectionId: null, tagIds: [], ownerId: uuid }]) expect(schema.safeParse({ ...value, organization }).success).toBe(false);
  }
  const target = { targetDocumentId: uuid, targetSourceVersionId: uuid, targetPaperVersion: 2 };
  expect(contracts.createBundleImportRequestSchema.parse(target)).toEqual(target);
  for (const value of [{ targetSourceVersionId: uuid }, { targetPaperVersion: 1 }, { ...target, targetPaperVersion: 0 }, { ...target, targetPaperVersion: Number.MAX_SAFE_INTEGER + 1 }]) expect(contracts.createBundleImportRequestSchema.safeParse(value).success).toBe(false);
});

test('portable management shapes enforce strictness, uniqueness and patch fields', () => {
  for (const [name, schema, valid, invalid] of [
    ['document-organization', contracts.documentOrganizationSchema, organization, [{ ...organization, lifecycleEpoch: 0 }, { ...organization, lifecycleEpoch: Number.MAX_SAFE_INTEGER + 1 }, { ...organization, tagIds: [uuid, uuid] }, { ...organization, ownerId: uuid }]],
    ['patch-document-organization', contracts.patchDocumentOrganizationSchema, { expectedRevision: 0, note: '' }, [{ expectedRevision: 0 }, { expectedRevision: 0, lifecycleEpoch: 1 }, { expectedRevision: 0, title: 'x'.repeat(501) }]],
    ['library-page', contracts.libraryPageSchema, { items: [{ document: pdf, organization, origin: 'upload' }], total: 1, page: 1, pageSize: 20 }, [{ items: [], total: 0, page: 1000001, pageSize: 20 }]],
  ] as const) {
    expect(schema).toBeDefined();
    const validate = portable(name);
    expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
    expect(schema.safeParse(valid).success).toBe(true);
    for (const value of invalid) { expect(validate(value), name).toBe(false); expect(schema.safeParse(value).success, name).toBe(false); }
  }
});

test('portable summaries retain PDF readiness and Web source capability checks', () => {
  const validate = portable('document-summary');
  const paper = { ...pdf, kind: 'paper', url: link.url };
  const repository = { ...link, kind: 'repository', source: webSource, saveStatus: 'original-saved', processingStatus: 'reader-ready' };
  for (const value of [pdf, paper, link, repository]) expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  for (const value of [{ ...paper, processingStatus: 'reader-ready' }, { ...repository, kind: 'paper' }, { ...repository, source: null }, { ...link, reader: { versionId: uuid, translationStatus: 'pending', warnings: [] } }]) {
    expect(contracts.documentSummarySchema.safeParse(value).success).toBe(false);
    expect(validate(value), JSON.stringify(value)).toBe(false);
  }
});

test('portable library query validates bounded wire strings and repeated tag parameters', () => {
  const validate = portable('library-query');
  for (const value of [{}, { page: '2', pageSize: '100', tagIds: uuid }, { page: '0001000000', pageSize: '00020', tagIds: [uuid] }]) {
    expect(contracts.libraryQuerySchema.safeParse(value).success).toBe(true);
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  }
  for (const value of [{ page: '1000001' }, { page: '0' }, { pageSize: '101' }, { tagIds: [uuid, uuid] }, { tagIds: `${uuid},${uuid}` }, { ownerId: uuid }]) {
    expect(validate(value)).toBe(false);
    expect(contracts.libraryQuerySchema.safeParse(value).success).toBe(false);
  }
});

test('rejects mixed-case logical UUID duplicates beyond portable structural uniqueness', () => {
  const lower = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const upper = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  const tagIds = [lower, upper];
  expect(contracts.documentOrganizationSchema.safeParse({ ...organization, tagIds }).success).toBe(false);
  expect(contracts.patchDocumentOrganizationSchema.safeParse({ expectedRevision: 0, tagIds }).success).toBe(false);
  expect(contracts.libraryQuerySchema.safeParse({ tagIds }).success).toBe(false);
  expect(contracts.saveOrganizationSchema.safeParse({ collectionId: null, tagIds }).success).toBe(false);
  // JSON Schema's uniqueItems compares raw JSON strings; runtime validates UUID identity.
  expect(portable('document-organization')({ ...organization, tagIds })).toBe(true);
  expect(contracts.saveOrganizationSchema.parse({ collectionId: null, tagIds: [upper] }).tagIds).toEqual([upper]);
});
