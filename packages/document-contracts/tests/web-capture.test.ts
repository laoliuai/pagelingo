import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
  const resource = { id: 'image', role: 'image', url: 'https://images.example.com/a.png', status: 'missing', reason: 'unavailable' };
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
  const value = { ...manifest, files: [file, previewFile, image], resources: [{ id: 'resource', role: 'image', url: 'https://example.com/image.png', status: 'available', fileId: 'image' }], snapshots: { previews: [{ id: 'preview-1', fileId: 'preview', nodeIds: ['source-1'], blockIds: [], resourceFileIds: ['image'], htmlBytes: 100, resourceBytes: 100 }], nodeLocations: { 'source-1': { previewId: 'preview-1', anchorId: 'source-1' } } } };
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
  const value = { ...manifest, resources: [{ id: 'broken', role: 'image', url: 'https://example.com:99999/image.png', status: 'missing', reason: 'invalid' }] };
  expect(() => contracts.webCaptureManifestSchema.safeParse(value)).not.toThrow();
  expect(contracts.webCaptureManifestSchema.safeParse(value).success).toBe(false);
});
test('shares a source-bound SDK candidate file instead of translated DOM HTML', () => {
  const candidate = { schemaVersion: 'web-capture-translation-candidate/1', sourceSnapshotSha256: sha, sourceContentFingerprint: 'b'.repeat(64), sourceLanguage: 'en', targetLanguage: 'zh', sdkVersion: '0.4.0', promptVersion: '1', protectionVersion: '1', blocks: [{ nodeId: 'source-1', sourceTextSha256: sha, source: { id: 'original-1', kind: 'paragraph', content: [{ type: 'text', text: 'Original input' }] }, rawText: '译文' }] };
  expect(contracts.webCaptureTranslationCandidateSchema.parse(candidate)).toEqual(candidate);
  expect(contracts.captureDraftSchema.safeParse({ captureId: manifest.captureId, snapshot: { html: '<p>Original input</p>', sourceUrl: manifest.source.url, scope: manifest.scope, nodeIds: ['source-1'], resources: [], warnings: [] }, metadata: manifest.metadata, canonicalUrl: null, kind: 'article', pendingResources: [], existingTranslation: candidate }).success).toBe(true);
  for (const patch of [{ translatedHtml: '<p>not authoritative</p>' }, { ownerId: manifest.captureId }, { readerIrSha256: sha }, { blocks: [candidate.blocks[0], candidate.blocks[0]] }, { blocks: [{ ...candidate.blocks[0], rawText: '汉'.repeat(180000) }] }]) {
    expect(contracts.webCaptureTranslationCandidateSchema.safeParse({ ...candidate, ...patch }).success).toBe(false);
  }
});
test.each([
  ['fill', String.raw`u\72l(https://example.com/external.svg#paint)`],
  ['stroke', String.raw`\75rl(https://example.com/external.svg#paint)`],
  ['fill', 'var(--external-paint)'],
  ['stroke', 'env(external-paint)'],
  ['fill', 'image-set("https://example.com/image.png" 1x)'],
  ['fill', 'url/**/(https://example.com/external.svg#paint)'],
  ['fill', 'rgb(from var(--paint) r g b)'],
  ['font-size', 'calc(1em + 2px)'],
  ['font-family', String.raw`u\72l(https://example.com/font)`],
])('rejects escaped or unsupported CSS in SafeMath attribute %s=%s', (attribute, value) => {
  const ast = { kind: 'svg', roots: ['root'], nodes: [
    { id: 'root', tag: 'svg', attributes: {}, children: ['path'] },
    { id: 'path', tag: 'path', attributes: { [attribute]: value }, children: [] },
  ] };
  expect(contracts.safeMathAstSchema.safeParse(ast).success).toBe(false);
});
test('preserves supported SVG geometry, colors, fonts and local math references', () => {
  const ast = { kind: 'svg', roots: ['root'], nodes: [
    { id: 'root', tag: 'svg', attributes: { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 100 100', width: '10em', height: '20px' }, children: ['path', 'label', 'reuse'] },
    { id: 'path', tag: 'path', attributes: { id: 'glyph', d: 'M0 0L1 1', fill: 'currentColor', stroke: '#123abc', 'stroke-width': '0.2', 'fill-rule': 'evenodd', transform: 'translate(10,20) scale(1.5)' }, children: [] },
    { id: 'label', tag: 'text', attributes: { x: '1', y: '2', fill: 'rgb(20, 30, 40)', 'font-family': 'Cambria Math, serif', 'font-size': '1em', 'font-weight': '700', 'text-anchor': 'middle' }, children: [], text: 'x' },
    { id: 'reuse', tag: 'use', attributes: { href: '#glyph', x: '10', y: '10' }, children: [] },
  ] };
  expect(contracts.safeMathAstSchema.parse(ast)).toEqual(ast);
  const math = { kind: 'mathml', roots: ['root'], nodes: [
    { id: 'root', tag: 'math', attributes: { xmlns: 'http://www.w3.org/1998/Math/MathML', displaystyle: 'true', scriptlevel: '+1', mathcolor: 'blue', mathsize: '1.2em' }, children: ['symbol'] },
    { id: 'symbol', tag: 'mi', attributes: { mathvariant: 'bold-italic' }, children: [], text: 'x' },
  ] };
  expect(contracts.safeMathAstSchema.parse(math)).toEqual(math);
});

test.each(['zod', 'json-schema'])('bounds adversarial transform validation in %s', kind => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./web-transform-probe.mjs', import.meta.url)), kind], {
    encoding: 'utf8', timeout: 3000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ invalid: [false, false, false], valid: [true, true, true, true] });
});
test('keeps missing resource roles replayable and rejects role/file mismatches', () => {
  const missing = { id: 'sheet', url: 'https://example.com/resource', status: 'missing', reason: 'unavailable' };
  expect(contracts.captureResourceSchema.safeParse(missing).success).toBe(false);
  expect(contracts.captureResourceSchema.parse({ ...missing, role: 'css' }).role).toBe('css');
  const image = { ...file, id: 'image', path: 'image.png', role: 'image', mediaType: 'image/png' };
  const resource = { id: 'resource', url: 'https://example.com/resource', status: 'available', role: 'css', fileId: 'image' };
  expect(contracts.webCaptureManifestSchema.safeParse({ ...manifest, files: [file, image], resources: [resource] }).success).toBe(false);
});
test('validates resource-only local image locators with portable/runtime parity and bounded large input', async () => {
  const { Ajv2020 } = await import('ajv/dist/2020.js');
  const { z } = await import('zod');
  const validate = new Ajv2020({ strict: true }).compile(z.toJSONSchema(contracts.captureResourceSchema));
  for (const [url, valid] of [
    ['data:image/png;base64,aGVsbG8=', true],
    ['blob:https://example.com/ca64f96f-205e-46f3-af4a-47e1a61e1310', true],
    ['BLOB:https://other.test/ca64f96f-205e-46f3-af4a-47e1a61e1310', false],
    ['blob:https://example.com/CA64F96F-205E-46F3-AF4A-47E1A61E1310', false],
    ['data:image/png;base64,', false], ['data:image/png;base64,a=', false],
    ['data:image/png;base64,ab==', false], ['data:image/svg+xml;base64,PHN2Zz4=', false],
    ['blob:https://user@example.com/ca64f96f-205e-46f3-af4a-47e1a61e1310', false],
    ['data:image/png;base64,' + 'a'.repeat(12 * 1024 * 1024), true],
    ['data:image/png;base64,' + 'a'.repeat(12 * 1024 * 1024) + '!', false],
  ] as const) {
    const resource = { id: 'image', role: 'image', url, status: 'missing', reason: 'unavailable' };
    expect(contracts.captureResourceSchema.safeParse(resource).success).toBe(valid);
    expect(validate(resource)).toBe(valid);
    expect(contracts.captureUrlSchema.safeParse(url).success).toBe(false);
  }
  const css = { id: 'css', role: 'css', url: 'data:image/png;base64,aGVsbG8=', status: 'missing', reason: 'unavailable' };
  expect(contracts.captureResourceSchema.safeParse(css).success).toBe(false);
  expect(validate(css)).toBe(false);
});

test('admits only canonical same-source-origin blob resources in a capture manifest', () => {
  for (const [url, accepted] of [
    ['blob:https://example.com/ca64f96f-205e-46f3-af4a-47e1a61e1310', true],
    ['blob:https://other.test/ca64f96f-205e-46f3-af4a-47e1a61e1310', false],
    ['BLOB:https://other.test/ca64f96f-205e-46f3-af4a-47e1a61e1310', false],
    ['blob:https://example.com/CA64F96F-205E-46F3-AF4A-47E1A61E1310', false],
  ] as const) {
    const resources = [{ id: 'image', role: 'image', url, status: 'missing', reason: 'unavailable' }];
    expect(contracts.webCaptureManifestSchema.safeParse({ ...manifest, resources }).success).toBe(accepted);
  }
});
