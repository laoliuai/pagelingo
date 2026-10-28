import { expect, it } from 'vitest';
import * as renderer from '../src/index.js';
import { offlineFixture, digest } from './web-static-fixtures.js';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

it('generates deterministic bounded Web files with real source previews and no PDF bridge', async () => {
  expect(renderer.createWebStaticFilePlan, 'Web offline file plan is missing').toBeTypeOf('function');
  const { input } = await offlineFixture(); const before = JSON.stringify(input);
  const plan = renderer.createWebStaticFilePlan(input), files = [...plan.generatedFiles];
  expect(files).toEqual([...renderer.createWebStaticFilePlan(input).generatedFiles]);
  expect(files.map(f => f.path)).toContain('render/data/c_000001.js');
  expect(files.find(f => f.path === 'render/index.html')!.content).not.toContain('type="module"');
  expect(files.filter(f => f.path.endsWith('.js')).every(f => !f.content.includes('</script>'))).toBe(true);
  expect(files.some(f => f.path.endsWith('.pdf'))).toBe(false);
  expect(JSON.stringify(input)).toBe(before);
  const catalog = renderer.resolveTrustedWebCatalog(plan.rendererVersion, plan.rendererSha256);
  expect([...catalog.generateFiles(input)]).toEqual(files);
  expect(() => renderer.resolveTrustedWebCatalog('unknown', plan.rendererSha256)).toThrow(/catalog/i);
  expect(() => renderer.resolveTrustedWebCatalog(plan.rendererVersion, '0'.repeat(64))).toThrow(/catalog/i);
  const require = createRequire(import.meta.url);
  for (const asset of plan.trustedAssets) {
    const base = asset.source.package === 'katex' ? dirname(require.resolve('katex/package.json')) : fileURLToPath(new URL('../', import.meta.url));
    const bytes = await readFile(join(base, asset.source.path)); expect(bytes.length).toBe(asset.bytes); expect(digest(bytes)).toBe(asset.sha256);
  }
});
it('rejects substituted chunks, translations, archive paths and preview bytes', async () => {
  expect(renderer.createWebStaticFilePlan).toBeTypeOf('function');
  const { input } = await offlineFixture(2);
  const generate = (value: typeof input) => [...renderer.createWebStaticFilePlan(value).generatedFiles];
  const changed = structuredClone(input); changed.chunks[0].blocks[0].source.sourceRefs[0].nodeId = 'other'; expect(() => generate(changed)).toThrow();
  const path = structuredClone(input); path.assets[0].path = 'render/data/index.js'; expect(() => generate(path)).toThrow();
  const preview = structuredClone(input); preview.previews[0].html += 'tamper'; expect(() => generate(preview)).toThrow(/preview/i);
  const source = structuredClone(input); source.capture.files[0].sha256 = '0'.repeat(64); expect(() => generate(source)).toThrow();
  const translation = structuredClone(input); translation.translation = null; expect(() => generate(translation)).toThrow();
});

it('preserves bounded formula source anchors and rejects substituted preview raster bytes', async () => {
  const { input } = await offlineFixture(2, false);
  const files = [...renderer.createWebStaticFilePlan(input).generatedFiles];
  const preview = files.find(file => file.path === 'render/previews/p_1.html')!.content;
  expect(preview).toContain('<math>'); expect(preview).toContain('<svg');
  expect(preview).toContain('data:image/jpeg;base64,'); expect(preview).not.toContain('https://evil.example');
  const changed = structuredClone(input); changed.previewImages[0].data[0] ^= 1;
  expect(() => [...renderer.createWebStaticFilePlan(changed).generatedFiles]).toThrow(/image/i);
});
it('bounds source inputs and rejects mismatched index, preview identity and image metadata', async () => {
  const { input } = await offlineFixture(2, false);
  const generate = (value: typeof input) => [...renderer.createWebStaticFilePlan(value).generatedFiles];
  for (const mutate of [
    (v: typeof input) => { v.index.chunks[0].blockIds.reverse(); },
    (v: typeof input) => { v.capture.files[0].bytes = 8 * 1024 * 1024 + 1; },
    (v: typeof input) => { Object.assign(v.assets[0], { mediaType: 'image/svg+xml' }); },
    (v: typeof input) => { v.previews[0].fileId = 'html'; },
    (v: typeof input) => { v.previewImages.push(v.previewImages[0]); },
    (v: typeof input) => { v.ir.blocks = Array.from({ length: 20001 }, () => v.ir.blocks[0]); },
  ]) { const value = structuredClone(input); mutate(value); expect(() => generate(value)).toThrow(); }
});
it('keeps generated chunk HTML lazy and makes absent preview bytes explicit', async () => {
  const { input } = await offlineFixture(2, false);
  const absent = { ...input, previews: undefined, previewImages: undefined };
  const files = [...renderer.createWebStaticFilePlan(absent).generatedFiles];
  expect(files.filter(file => file.path.startsWith('render/previews/'))).toHaveLength(0);
  expect(files.find(file => file.path === 'render/data/index.js')!.content).toContain('"path":null');
  const iterator = renderer.createWebStaticFilePlan(input).generatedFiles[Symbol.iterator]();
  Object.defineProperty(input.chunks[0], 'blocks', { get() { throw Error('lazy chunk accessed'); } });
  expect(iterator.next().value.path).toBe('render/index.html');
  expect(iterator.next().value.path).toBe('render/data/index.js');
  expect(() => iterator.next()).toThrow('lazy chunk accessed');
});
it('allows different local image IDs to share one registered identical image path', async () => {
  const { input } = await offlineFixture(2, false);
  const originals = JSON.stringify(input.ir);
  const first = input.assets[0];
  for (const image of input.assets) if (image.sha256 === first.sha256) image.path = first.path;
  const files = [...renderer.createWebStaticFilePlan(input).generatedFiles];
  const data = files.find(file => file.path === 'render/data/c_000001.js')!.content;
  expect(data).toContain('__proto__'); expect(data).toContain('constructor'); expect(data).toContain('toString');
  expect(data).not.toContain('constructor%20%23.jpg'); expect(JSON.stringify(input.ir)).toBe(originals);
});
