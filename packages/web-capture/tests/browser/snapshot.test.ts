import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { sanitizeNodeSnapshot } from '../../src/node.js';
import type * as Browser from '../../src/browser.js';
import { manifestFor, snapshotInput } from '../helpers.js';
declare global { interface Window { Capture: typeof Browser; executedScripts: number } }
let server: Server; let origin: string;
test.beforeAll(async () => {
  const result = await build({ entryPoints: [new URL('../../src/browser.ts', import.meta.url).pathname], bundle: true, format: 'iife', globalName: 'Capture', platform: 'browser', write: false, metafile: true });
  expect(Object.keys(result.metafile!.inputs).some(path => /jsdom|node:/.test(path))).toBe(false);
  const root = await build({ entryPoints: [new URL('../../src/index.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'browser', write: false, metafile: true });
  expect(Object.keys(root.metafile!.inputs).some(path => /jsdom|dompurify|node:/.test(path))).toBe(false);
  server = createServer((request, response) => {
    if (request.url === '/capture.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(result.outputFiles[0].text); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><script src="/capture.js"></script>'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server unavailable'); origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
test('native browser and Node sanitize identically without source requests or script execution', async ({ page }) => {
  const unregisteredRequests: string[] = [];
  await page.route('**/*', route => { if (!route.request().url().startsWith(origin)) { unregisteredRequests.push(route.request().url()); return route.abort(); } return route.continue(); });
  await page.goto(origin);
  const raw = snapshotInput('<article><script>window.executedScripts++</script><iframe src="https://unregistered.test/frame"></iframe><link rel="stylesheet" href="https://unregistered.test/x.css"><p style="background:url(https://unregistered.test/css);font-weight:bold">Hello <strong>reader</strong><img src="https://unregistered.test/image.png" onerror="window.executedScripts++"></p><svg><defs><path id="same" d="M0 0L1 1"/></defs><use href="#same"/></svg><math><mfrac><mi>x</mi><mn>2</mn></mfrac></math><table><tr><th>Head</th><td>Cell</td></tr></table></article>');
  const expected = sanitizeNodeSnapshot(raw);
  const browserSnapshot = await page.evaluate(input => { window.executedScripts = 0; return window.Capture.sanitizeBrowserSnapshot(input); }, raw);
  expect(browserSnapshot).toEqual(expected);
  const manifest = await manifestFor(expected);
  const actual = await page.evaluate(async ({ snapshot, manifest }) => {
    const built = await window.Capture.buildSnapshotPreviews(snapshot, manifest);
    const finalManifest = { ...manifest, files: [...manifest.files, ...built.files.map(file => file.descriptor)], snapshots: built.index };
    const ir = await window.Capture.projectWebReader(snapshot, finalManifest, { manifestBytes: window.Capture.canonicalManifestBytes(finalManifest), assets: [] });
    const frame = document.createElement('iframe'); frame.setAttribute('sandbox', '');
    const blob = new Blob([`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">${built.files[0].html}`], { type: 'text/html' });
    const url = URL.createObjectURL(blob); frame.src = url; document.body.append(frame);
    await new Promise<void>(resolve => frame.addEventListener('load', () => resolve(), { once: true }));
    frame.remove(); URL.revokeObjectURL(url);
    return { blocks: ir.blocks.length, anchors: built.index.nodeLocations, executedScripts: window.executedScripts };
  }, { snapshot: browserSnapshot, manifest });
  expect(actual.blocks).toBeGreaterThan(3);
  expect(Object.keys(actual.anchors)).toEqual(expect.arrayContaining(browserSnapshot.nodeIds));
  expect(actual.executedScripts).toBe(0);
  expect(unregisteredRequests).toEqual([]);
});
test('native image decoder accepts the bounded GIF fixture', async ({ page }) => {
  await page.goto(origin);
  expect(await page.evaluate(async () => {
    const image = new Image(); image.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    await image.decode(); return [image.naturalWidth, image.naturalHeight];
  })).toEqual([1, 1]);
});
test('inspects actual PNG, JPEG and WebP bytes produced and decoded by Chromium', async ({ page }) => {
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 7; canvas.height = 5;
    const context = canvas.getContext('2d')!; context.fillStyle = '#f40'; context.fillRect(0, 0, 7, 5);
    const results = [];
    for (const mediaType of ['image/png', 'image/jpeg', 'image/webp']) {
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), mediaType));
      const data = new Uint8Array(await blob.arrayBuffer());
      const descriptor = { id: mediaType, path: `images/${mediaType.split('/')[1]}`, bytes: data.length, sha256: await window.Capture.sha256(data), mediaType, role: 'image' as const };
      const inspected = await window.Capture.inspectImageResource(data, descriptor);
      const url = URL.createObjectURL(blob); const image = new Image(); image.src = url; await image.decode();
      results.push({ mediaType: inspected.mediaType, width: inspected.width, height: inspected.height, decodedWidth: image.naturalWidth, decodedHeight: image.naturalHeight }); URL.revokeObjectURL(url);
    }
    return results;
  });
  expect(result).toEqual(['image/png', 'image/jpeg', 'image/webp'].map(mediaType => ({ mediaType, width: 7, height: 5, decodedWidth: 7, decodedHeight: 5 })));
});
