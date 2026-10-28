import { expect, it } from 'vitest';
import { replayResourcesFromManifest } from '../src/index.js';
import { sanitizeNodeSnapshot } from '../src/node.js';
import { manifestFor, snapshotInput } from './helpers.js';
it('reconstructs missing CSS/image roles from the manifest without guessing URL extensions', async () => {
  const snapshot = sanitizeNodeSnapshot(snapshotInput('<p>Text</p>')); const manifest = await manifestFor(snapshot);
  manifest.resources = [{ id: 'css', role: 'css', url: 'https://e.test/opaque', status: 'missing', reason: 'unavailable' }, { id: 'image', role: 'image', url: 'https://e.test/no-extension', status: 'missing', reason: 'not-loaded' }];
  expect(replayResourcesFromManifest(manifest)).toEqual([{ id: 'css', role: 'css', url: 'https://e.test/opaque' }, { id: 'image', role: 'image', url: 'https://e.test/no-extension' }]);
});
it('keeps inline stylesheet provenance in the archive without inventing replay text or a resource URL', async () => {
  const snapshot = sanitizeNodeSnapshot(snapshotInput('<p>Text</p>')); const manifest = await manifestFor(snapshot);
  manifest.resources = [{ id: 'inline', role: 'css', url: null, provenance: { kind: 'inline-style', documentUrl: snapshot.sourceUrl, index: 0 }, status: 'missing', reason: 'unsupported' }];
  expect(replayResourcesFromManifest(manifest)).toEqual([]);
  expect(manifest.resources[0]).toMatchObject({ url: null, provenance: { index: 0 }, status: 'missing', reason: 'unsupported' });
});
