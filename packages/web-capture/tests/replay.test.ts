import { expect, it } from 'vitest';
import { replayResourcesFromManifest } from '../src/index.js';
import { sanitizeNodeSnapshot } from '../src/node.js';
import { manifestFor, snapshotInput } from './helpers.js';
it('reconstructs missing CSS/image roles from the manifest without guessing URL extensions', async () => {
  const snapshot = sanitizeNodeSnapshot(snapshotInput('<p>Text</p>')); const manifest = await manifestFor(snapshot);
  manifest.resources = [{ id: 'css', role: 'css', url: 'https://e.test/opaque', status: 'missing', reason: 'unavailable' }, { id: 'image', role: 'image', url: 'https://e.test/no-extension', status: 'missing', reason: 'not-loaded' }];
  expect(replayResourcesFromManifest(manifest)).toEqual([{ id: 'css', role: 'css', url: 'https://e.test/opaque' }, { id: 'image', role: 'image', url: 'https://e.test/no-extension' }]);
});
