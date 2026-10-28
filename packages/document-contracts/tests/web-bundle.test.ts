import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.js';
const hash = 'a'.repeat(64);
const manifest = {
  schemaVersion: 'pagelingo-web-document-bundle/1', packageId: '11111111-1111-4111-8111-111111111111', createdAt: '2026-10-28T00:00:00Z',
  title: 'Legacy title '.repeat(100), source: { manifestPath: 'source/manifest.json', manifestSha256: hash, snapshotSha256: hash, contentFingerprint: hash },
  parse: { id: `p_${hash}`, readerIrSha256: hash }, translation: null,
  renderer: { version: 'web-0.3.0', codeSha256: hash }, files: [],
};
describe('independent Web bundle contract', () => {
  it('admits original-only and partial packages with legacy title snapshots', () => {
    expect(contracts.webDocumentBundleManifestSchema).toBeDefined();
    expect(contracts.webDocumentBundleManifestSchema.parse(manifest)).toEqual(manifest);
    expect(contracts.webDocumentBundleManifestSchema.parse({ ...manifest, translation: { path: 'translation.json', sha256: hash, status: 'partial', generationKind: 'import' } }).translation?.status).toBe('partial');
  });
  it('rejects PDF masquerading and invented metadata fields', () => {
    expect(contracts.webDocumentBundleManifestSchema).toBeDefined();
    for (const change of [{ schemaVersion: 'pagelingo-document-bundle/1' }, { source: { ...manifest.source, manifestPath: 'source.pdf' } }, { note: 'private' }, { parse: { ...manifest.parse, model: 'fake' } }]) {
      expect(contracts.webDocumentBundleManifestSchema.safeParse({ ...manifest, ...change }).success).toBe(false);
    }
    expect(contracts.documentBundleManifestSchema.safeParse(manifest).success).toBe(false);
  });
});
