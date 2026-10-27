import { expect, test } from 'vitest';
import * as contracts from '../src/index.js';
import { file, manifest, sha } from './web-fixtures.js';

test('retains_query_and_hash', () => {
  expect(contracts.webCaptureManifestSchema.parse(manifest).source.url).toBe('https://example.com/read?id=1#part');
  for (const url of ['file:///tmp/page', 'https://user:pass@example.com/', 'javascript:alert(1)', 'https://example.com:99999/']) {
    expect(contracts.webCaptureManifestSchema.safeParse({ ...manifest, source: { ...manifest.source, url } }).success).toBe(false);
  }
});
test('distinguishes manifest byte SHA from a content fingerprint and rejects forged ownership', () => {
  const identity = { documentId: manifest.captureId, sourceVersionId: manifest.captureId, manifestAssetId: manifest.captureId, sha256: sha, snapshotSha256: 'b'.repeat(64), bytes: 100 };
  expect(contracts.webSourceIdentitySchema.parse(identity)).toEqual(identity);
  expect(contracts.webSourceIdentitySchema.safeParse({ ...identity, contentFingerprint: sha }).success).toBe(false);
  for (const field of ['ownerId', 'token', 'headers', 'apiKey']) {
    expect(contracts.webCaptureManifestSchema.safeParse({ ...manifest, [field]: 'secret' }).success).toBe(false);
  }
});
test('requires resource declarations and unique portable files within byte budgets', () => {
  const resource = { id: 'image', url: 'https://images.example.com/a.png', status: 'missing', reason: 'unavailable' };
  expect(contracts.webCaptureManifestSchema.safeParse({ ...manifest, resources: [resource] }).success).toBe(true);
  const mutations = [
    { files: [file, file] }, { htmlFileId: 'absent' }, { files: [{ ...file, bytes: 8 * 1024 * 1024 + 1 }] },
    { files: [{ ...file, path: '../index.html' }] }, { resources: [{ ...resource, status: 'available', fileId: 'absent', reason: undefined }] },
    { resources: [{ ...resource, reason: undefined }] }, { resources: [resource, resource] },
    { files: [file, { ...file, id: 'undeclared', path: 'other.html' }] },
  ];
  for (const patch of mutations) expect(contracts.webCaptureManifestSchema.safeParse({ ...manifest, ...patch }).success).toBe(false);
});
test('bounds math AST nodes, fragments and references without extending SDK protected kinds', () => {
  const ast = { kind: 'svg', roots: ['root'], nodes: [{ id: 'root', tag: 'svg', attributes: {}, children: ['path'] }, { id: 'path', tag: 'path', attributes: { d: 'M0 0L1 1' }, children: [] }] };
  expect(contracts.safeMathAstSchema.safeParse(ast).success).toBe(true);
  for (const patch of [
    { nodes: [{ ...ast.nodes[0], attributes: { href: 'https://evil.test/a' } }] },
    { nodes: [{ ...ast.nodes[0], tag: 'foreignObject' }] },
    { nodes: [{ ...ast.nodes[0], children: ['missing'] }] },
    { nodes: [ast.nodes[0], ast.nodes[0]] },
    { nodes: [{ ...ast.nodes[0], attributes: { d: 'x'.repeat(65537) } }] },
  ]) expect(contracts.safeMathAstSchema.safeParse({ ...ast, ...patch }).success).toBe(false);
});
test('enforces scope completeness warnings and UTF-8 snapshot budgets', () => {
  expect(contracts.webCaptureManifestSchema.safeParse({ ...manifest, scope: { ...manifest.scope, completeWithinScope: false } }).success).toBe(false);
  expect(contracts.webCaptureManifestSchema.safeParse({ ...manifest, scope: { ...manifest.scope, completeWithinScope: false, warnings: ['Answer not fully expanded'] } }).success).toBe(true);
  expect(contracts.snapshotInputSchema.safeParse({ html: '汉'.repeat(3 * 1024 * 1024), url: manifest.source.url, scope: manifest.scope }).success).toBe(false);
});
test('accepts preview resource closure while rejecting missing locations and illegal file media', () => {
  const previewFile = { ...file, id: 'preview', path: 'snapshot/preview.html', role: 'preview' };
  const image = { ...file, id: 'image', path: 'snapshot/image.png', mediaType: 'image/png', role: 'image' };
  const value = { ...manifest, files: [file, previewFile, image], resources: [{ id: 'resource', url: 'https://example.com/image.png', status: 'available', fileId: 'image' }], snapshots: { previews: [{ id: 'preview-1', fileId: 'preview', nodeIds: ['source-1'], blockIds: [], resourceFileIds: ['image'], htmlBytes: 100, resourceBytes: 100 }], nodeLocations: { 'source-1': { previewId: 'preview-1', anchorId: 'source-1' } } } };
  expect(contracts.webCaptureManifestSchema.safeParse(value).success).toBe(true);
  expect(contracts.webCaptureManifestSchema.safeParse({ ...value, files: [file, previewFile, { ...image, mediaType: 'image/svg+xml' }] }).success).toBe(false);
  expect(contracts.webCaptureManifestSchema.safeParse({ ...value, snapshots: { ...value.snapshots, nodeLocations: { 'unknown-node': { previewId: 'preview-1', anchorId: 'source-1' } } } }).success).toBe(false);
});
test('rejects recursive SVG use references', () => {
  const recursive = { kind: 'svg', roots: ['svg'], nodes: [
    { id: 'svg', tag: 'svg', attributes: { id: 'equation' }, children: ['use'] },
    { id: 'use', tag: 'use', attributes: { href: '#equation' }, children: [] },
  ] };
  expect(contracts.safeMathAstSchema.safeParse(recursive).success).toBe(false);
});
test('returns validation errors for malformed resource URLs without throwing', () => {
  const value = { ...manifest, resources: [{ id: 'broken', url: 'https://example.com:99999/image.png', status: 'missing', reason: 'invalid' }] };
  expect(() => contracts.webCaptureManifestSchema.safeParse(value)).not.toThrow();
  expect(contracts.webCaptureManifestSchema.safeParse(value).success).toBe(false);
});
