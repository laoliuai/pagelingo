export const uuid = '00000000-0000-4000-8000-000000000001';
export const sha = 'a'.repeat(64);
export const blockId = `b_${'a'.repeat(32)}`;
export const nodeId = `n_${'a'.repeat(32)}`;
export const position = { readerVersionId: uuid, sourceVersionId: uuid, parseId: `p_${sha}`, blockId: null, blockOffset: 0, view: 'content', contentMode: 'bilingual' };
export const file = { id: 'html', path: 'snapshot/index.html', bytes: 100, sha256: sha, mediaType: 'text/html', role: 'html' };
export const manifest = {
  schemaVersion: 'web-capture/1', captureId: uuid,
  source: { url: 'https://example.com/read?id=1#part', canonicalUrl: null, kind: 'article', method: 'extension' },
  metadata: { title: 'Article', author: null, publishedAt: null, capturedAt: '2026-10-27T00:00:00.000Z' },
  scope: { kind: 'article', rootNodeId: 'source-1', completeWithinScope: true, warnings: [] },
  htmlFileId: 'html', files: [file], resources: [], stylesheetFileIds: [], snapshots: { previews: [], nodeLocations: {} }, existingTranslation: null,
};
export const ir = {
  schemaVersion: 'web-reader-ir/1', metadata: { title: 'Article', language: { language: 'en', sourceLanguage: 'en', reason: 'english-heuristic' } },
  source: { kind: 'web', manifestSha256: sha, snapshotSha256: sha, bytes: 100 },
  parse: { id: `p_${sha}`, inputManifestSha256: sha, projectorVersion: '1', configSha256: sha, coverage: 'full', status: 'complete' },
  roots: [nodeId], nodes: [{ id: nodeId, kind: 'block', children: [], blockId }],
  blocks: [{ id: blockId, type: 'rule', sourceRefs: [{ nodeId: 'source-1', quote: '', prefix: '', suffix: '' }] }], assets: [], warnings: [],
};
