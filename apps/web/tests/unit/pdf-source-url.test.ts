import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPdfSourceUrl } from '../../src/features/library/pdf-source-url.ts';
const id = '8a974e22-9f7a-4af9-8d4e-112233445566';
test('admits only exact document-current or registered-asset PDF routes', () => {
  assert.equal(isPdfSourceUrl(`/api/v1/documents/${id}/source`), true);
  assert.equal(isPdfSourceUrl(`/api/v1/assets/${id}/content`), true);
});
test('rejects foreign origins, unregistered paths, malformed IDs and caller-supplied queries', () => {
  for (const path of [
    `https://example.com/api/v1/assets/${id}/content`,
    `//example.com/api/v1/assets/${id}/content`,
    `/api/v1/assets/${id}/content?download=true`,
    `/api/v1/documents/${id}/source?sourceVersionId=${id}`,
    `/api/v1/assets/${id}/content#fragment`,
    `/api/v1/assets/${id}/content/`,
    `/api/v1/assets/${id}/../content`,
    `/api/v1/assets/${id}/%63ontent`,
    `/api/v1/assets/${id}/content\n`,
    `/api/v1/assets/${id}/content\\`,
    '/api/v1/assets/not-a-uuid/content',
    `/api/v1/assets/${id}/anything-else`,
  ]) assert.equal(isPdfSourceUrl(path), false, path);
});
