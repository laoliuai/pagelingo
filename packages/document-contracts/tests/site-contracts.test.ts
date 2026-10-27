import { describe, expect, it } from 'vitest';
import {
  changePasswordRequestSchema,
  createUserRequestSchema,
  defaultProviderProfile,
  documentListQuerySchema,
  documentListSchema,
  documentSummarySchema,
  errorResponseSchema,
  loginRequestSchema,
  logoutRequestSchema,
  providerProfileSchema,
  providerProfileUpdateSchema,
  providerTestResultSchema,
  publicUserSchema,
  resetPasswordRequestSchema,
  sessionViewSchema,
  sourceIdentitySchema,
  updateUserRequestSchema,
} from '../src/index.js';

const user = {
  id: '00000000-0000-4000-8000-000000000001',
  username: 'reader_1', role: 'user', active: true, createdAt: '2026-10-27T00:00:00.000Z',
};
const profile = {
  revision: 0, baseUrl: '', model: '', temperature: 0.1, responseFormat: 'json-object',
  maxOutputTokens: 4096, maxTokensParameter: 'max_tokens', thinkingMode: 'auto', stream: false,
  maxInputTokens: 6000, contextWindowTokens: 32768, hasApiKey: false,
};
const { revision: _revision, hasApiKey: _hasApiKey, ...settings } = profile;
const update = { expectedRevision: 0, settings, key: { action: 'keep' } };
const source = {
  documentId: user.id,
  sourceVersionId: '00000000-0000-4000-8000-000000000002',
  sha256: 'a'.repeat(64), assetId: '00000000-0000-4000-8000-000000000003', bytes: 1024,
};
const summary = {
  id: user.id, kind: 'pdf', title: 'A document', originalFilename: 'paper.pdf',
  createdAt: user.createdAt, source, saveStatus: 'original-saved',
  reader: null, processingStatus: 'awaiting-local-processing',
};

describe('public auth contracts', () => {
  it('rejects credentials and ownership fields on public user output', () => {
    expect(publicUserSchema.parse(user)).toEqual(user);
    for (const field of ['passwordHash', 'ownerId', 'authVersion']) {
      expect(publicUserSchema.safeParse({ ...user, [field]: 'private' }).success).toBe(false);
    }
    expect(publicUserSchema.safeParse({ ...user, id: 'not-a-uuid' }).success).toBe(false);
    expect(publicUserSchema.safeParse({ ...user, createdAt: 'today' }).success).toBe(false);
  });

  it('represents anonymous and authenticated sessions without exposing tokens', () => {
    expect(sessionViewSchema.parse({ user: null, csrfToken: null })).toEqual({ user: null, csrfToken: null });
    expect(sessionViewSchema.safeParse({ user, csrfToken: 'csrf-token' }).success).toBe(true);
    expect(sessionViewSchema.safeParse({ user, csrfToken: 'csrf-token', token: 'secret' }).success).toBe(false);
    expect(sessionViewSchema.safeParse({ user, csrfToken: null }).success).toBe(false);
    expect(sessionViewSchema.safeParse({ user: null, csrfToken: 'csrf-token' }).success).toBe(false);
  });

  it('normalizes usernames while preserving password whitespace and Unicode code points', () => {
    const password = ' 😀😀😀😀😀😀😀😀😀😀 ';
    expect(loginRequestSchema.parse({ username: 'READER_1', password })).toEqual({ username: 'reader_1', password });
    expect(createUserRequestSchema.parse({ username: 'READER_1', password })).toEqual({ username: 'reader_1', password });
    for (const username of ['ab', '1abc', ' abc', 'a'.repeat(33)]) {
      expect(createUserRequestSchema.safeParse({ username, password }).success).toBe(false);
    }
    for (const invalid of ['😀'.repeat(11), 'a'.repeat(129)]) {
      expect(createUserRequestSchema.safeParse({ username: 'reader', password: invalid }).success).toBe(false);
    }
    expect(createUserRequestSchema.safeParse({ username: 'reader', password: '😀'.repeat(128) }).success).toBe(true);
    expect(createUserRequestSchema.safeParse({ username: 'reader', password, role: 'admin' }).success).toBe(false);
  });

  it('validates password and administrative writes without accepting client ownership', () => {
    expect(changePasswordRequestSchema.safeParse({ currentPassword: 'old password', newPassword: 'new password' }).success).toBe(true);
    expect(changePasswordRequestSchema.safeParse({ currentPassword: 'old password', newPassword: 'short' }).success).toBe(false);
    expect(resetPasswordRequestSchema.safeParse({ newPassword: 'new password' }).success).toBe(true);
    expect(updateUserRequestSchema.parse({ active: false })).toEqual({ active: false });
    expect(updateUserRequestSchema.safeParse({ active: true, ownerId: user.id }).success).toBe(false);
    expect(logoutRequestSchema.parse({})).toEqual({ allDevices: false });
    expect(logoutRequestSchema.parse({ allDevices: true })).toEqual({ allDevices: true });
  });
});

describe('provider profile contracts', () => {
  it('returns the initial profile and rejects any key material in reads', () => {
    expect(defaultProviderProfile).toEqual(profile);
    expect(providerProfileSchema.parse(profile)).toEqual(profile);
    for (const field of ['key', 'apiKey', 'ownerId']) {
      expect(providerProfileSchema.safeParse({ ...profile, [field]: { value: 'secret' } }).success).toBe(false);
    }
  });

  it.each([{ action: 'keep' }, { action: 'replace', value: 'secret' }, { action: 'delete' }])('accepts explicit key action $action', (key) => {
    expect(providerProfileUpdateSchema.parse({ ...update, key }).key).toEqual(key);
  });

  it('rejects empty replacements, misplaced secrets and invalid revisions', () => {
    for (const key of [{ action: 'replace', value: '' }, { action: 'keep', value: 'secret' }, { action: 'delete', value: 'secret' }]) {
      expect(providerProfileUpdateSchema.safeParse({ ...update, key }).success).toBe(false);
    }
    for (const expectedRevision of [-1, 0.5]) {
      expect(providerProfileUpdateSchema.safeParse({ ...update, expectedRevision }).success).toBe(false);
    }
    expect(providerProfileUpdateSchema.safeParse({ ...update, settings: { ...settings, apiKey: 'secret' } }).success).toBe(false);
  });

  it('accepts SDK provider choices and rejects invalid settings', () => {
    expect(providerProfileUpdateSchema.safeParse({ ...update, settings: { ...settings, baseUrl: 'https://api.example.com/v1', model: 'model', responseFormat: 'json-schema', maxTokensParameter: 'max_completion_tokens', thinkingMode: 'disabled' } }).success).toBe(true);
    for (const invalid of [
      { baseUrl: 'http://localhost/v1' }, { baseUrl: 'https://user:pass@example.com' },
      { baseUrl: 'https://example.com?q=secret' }, { baseUrl: 'https://example.com#fragment' },
      { baseUrl: 'https://example.com?' }, { baseUrl: 'https://example.com#' },
      { responseFormat: 'xml' }, { maxTokensParameter: 'tokens' }, { thinkingMode: 'enabled' },
      { temperature: 3 }, { maxInputTokens: 0 }, { maxOutputTokens: 0.5 }, { contextWindowTokens: -1 },
    ]) {
      expect(providerProfileUpdateSchema.safeParse({ ...update, settings: { ...settings, ...invalid } }).success).toBe(false);
    }
  });

  it('exposes connection test outcome, profile revision, timestamp and optional usage only', () => {
    expect(providerTestResultSchema.safeParse({ ok: true, profileRevision: 1, checkedAt: '2026-10-27T00:00:00.000Z', usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 } }).success).toBe(true);
    expect(providerTestResultSchema.safeParse({ ok: true, profileRevision: 1, checkedAt: '2026-10-27T00:00:00.000Z', response: 'private' }).success).toBe(false);
    expect(providerTestResultSchema.safeParse({ ok: true, profileRevision: 0, checkedAt: 'today' }).success).toBe(false);
    expect(providerTestResultSchema.safeParse({ ok: true, profileRevision: 1, checkedAt: '2026-10-27T00:00:00.000Z', usage: { promptTokens: -1, completionTokens: 0, totalTokens: 0 } }).success).toBe(false);
  });
});

describe('document contracts', () => {
  it('requires immutable source identity and fixed initial PDF states', () => {
    expect(documentSummarySchema.parse(summary).source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(documentSummarySchema.safeParse({ ...summary, source: undefined }).success).toBe(false);
    expect(documentSummarySchema.safeParse({ ...summary, processingStatus: 'completed' }).success).toBe(false);
    expect(documentSummarySchema.safeParse({ ...summary, saveStatus: 'pending' }).success).toBe(false);
    expect(documentSummarySchema.safeParse({ ...summary, ownerId: user.id }).success).toBe(false);
    expect(sourceIdentitySchema.safeParse({ ...source, sha256: 'A'.repeat(64) }).success).toBe(false);
    expect(sourceIdentitySchema.safeParse({ ...source, bytes: 0 }).success).toBe(false);
    expect(sourceIdentitySchema.safeParse({ ...source, assetId: 'paper.pdf' }).success).toBe(false);
  });

  it('validates list pagination defaults, limits and search bounds', () => {
    expect(documentListQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(documentListQuerySchema.parse({ page: '2', pageSize: '100', q: 'paper' })).toEqual({ page: 2, pageSize: 100, q: 'paper' });
    for (const invalid of [{ page: 0 }, { pageSize: 101 }, { page: true }, { pageSize: [20] }, { q: 'x'.repeat(201) }, { ownerId: user.id }]) {
      expect(documentListQuerySchema.safeParse(invalid).success).toBe(false);
    }
    expect(documentListSchema.parse({ items: [summary], total: 1, page: 1, pageSize: 20 }).items).toHaveLength(1);
    expect(documentListSchema.safeParse({ items: [], total: -1, page: 1, pageSize: 20 }).success).toBe(false);
  });
});

it('returns only the versioned error envelope fields', () => {
  expect(errorResponseSchema.parse({ error: { code: 'not-found', message: 'Not found', requestId: 'request-1' } })).toEqual({ error: { code: 'not-found', message: 'Not found', requestId: 'request-1' } });
  expect(errorResponseSchema.safeParse({ error: { code: 'internal', message: 'Failure', requestId: 'request-1', stack: 'private' } }).success).toBe(false);
});

it('ties reader-ready summaries to a reader version while preserving original-only entries', () => {
  const reader = { versionId: user.id, translationStatus: 'pending', parseCoverage: 'partial', warnings: ['Only selected pages parsed'] };
  expect(documentSummarySchema.safeParse({ ...summary, processingStatus: 'reader-ready', reader }).success).toBe(true);
  expect(documentSummarySchema.safeParse({ ...summary, processingStatus: 'reader-ready', reader: null }).success).toBe(false);
  expect(documentSummarySchema.safeParse({ ...summary, reader }).success).toBe(false);
});
