import { expect, test } from 'vitest';
import * as contracts from '../src/index.js';
import { uuid } from './web-fixtures.js';
import { portable } from './portable-schema-fixtures.js';

const timestamp = '2026-10-27T00:00:00.000Z';
const asset = { assetId: uuid, sha256: 'a'.repeat(64), bytes: 100, mediaType: 'application/pdf', filename: 'paper.pdf' };
const github = { kind: 'github', id: uuid, sourceVersionId: null, repository: { id: '123', owner: 'Owner', name: 'Repo', description: null, url: 'https://github.com/Owner/Repo' }, commitSha: 'a'.repeat(40), readme: { path: 'README.md', blobSha: 'b'.repeat(40), raw: { ...asset, mediaType: 'text/markdown', filename: 'README.md' }, renderedHtml: null }, capturedAt: timestamp };
const arxiv = { kind: 'arxiv', id: uuid, baseId: '2401.12345', version: 1, title: 'Paper', authors: ['Author'], summary: 'Abstract', publishedAt: timestamp, updatedAt: timestamp, capturedAt: timestamp, sourceVersionId: uuid, pdf: asset };
const link = { kind: 'link', documentId: uuid, url: 'https://unknown.example/paper.pdf', resolution: 'self', canonicalDocumentId: null, fetchJobId: null, status: 'link-only', errorCode: null, warnings: [], latestAttempt: null };

test('keeps unknown source URLs as links and separates selected revision from latest attempt', () => {
  expect(contracts.sourceDetailsSchema).toBeDefined();
  const details = { ...link, kind: 'github', status: 'source-saved', current: github, latestAttempt: { jobId: uuid, status: 'failed', requestedRef: 'Main', resolvedRevision: null, errorCode: 'FETCH_FAILED' } };
  for (const value of [link, details, { ...link, kind: 'arxiv', current: arxiv }, { ...link, kind: 'github', current: null }]) expect(contracts.sourceDetailsSchema.parse(value)).toEqual(value);
  for (const value of [{ ...link, current: null }, { ...details, current: arxiv }, { ...details, ownerId: uuid }, { ...details, current: { ...github, commitSha: 'abc' } }, { ...link, kind: 'arxiv', current: { ...arxiv, version: 0 } }, { ...link, kind: 'arxiv', current: { ...arxiv, version: Number.MAX_SAFE_INTEGER + 1 } }, { ...link, kind: 'arxiv', current: { ...arxiv, pdf: { ...asset, objectKey: 'private' } } }]) expect(contracts.sourceDetailsSchema.safeParse(value).success).toBe(false);
});

test('bounds refresh refs and preserves provider-specific identities', () => {
  expect(contracts.sourceRefreshRequestSchema).toBeDefined();
  expect(contracts.sourceRefreshRequestSchema.parse({ ref: 'Main', translationIntent: 'none' })).toEqual({ ref: 'Main', translationIntent: 'none' });
  for (const value of [{ ref: '', translationIntent: 'none' }, { ref: 'x'.repeat(201), translationIntent: 'auto' }, { translationIntent: 'translate' }, { translationIntent: 'none', ownerId: uuid }]) expect(contracts.sourceRefreshRequestSchema.safeParse(value).success).toBe(false);
  const reference = { provider: 'github', owner: 'Owner', repo: 'Repo', requestedRef: 'Main', url: 'https://github.com/Owner/Repo' };
  expect(contracts.sourceReferenceSchema.parse(reference)).toEqual(reference);
  expect(contracts.sourceReferenceSchema.parse({ provider: 'arxiv', baseId: 'hep-th/9901001', version: null, url: 'https://arxiv.org/abs/hep-th/9901001' })).toMatchObject({ provider: 'arxiv', version: null });
  expect(contracts.sourceVersionsQuerySchema.parse({})).toEqual({ limit: 20 });
  expect(contracts.sourceVersionsQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
});

test('portable source shapes reject provider mixing and private storage fields', () => {
  expect(contracts.sourceDetailsSchema).toBeDefined();
  const validate = portable('source-details');
  for (const value of [link, { ...link, kind: 'github', current: github }, { ...link, kind: 'arxiv', current: arxiv }]) expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  for (const value of [{ ...link, current: github }, { ...link, ownerId: uuid }, { ...link, kind: 'github', current: arxiv }, { ...link, kind: 'arxiv', current: { ...arxiv, version: 0 } }]) { expect(validate(value)).toBe(false); expect(contracts.sourceDetailsSchema.safeParse(value).success).toBe(false); }
  const refresh = portable('source-refresh-request');
  expect(refresh({ ref: 'Main', translationIntent: 'none' })).toBe(true);
  expect(refresh({ ref: '', translationIntent: 'none' })).toBe(false);
});
