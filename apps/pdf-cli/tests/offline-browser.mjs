// Explicit Chromium acceptance using owned fixtures; no Python, models or API.
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { defaultBundleLimits } from '@pagelingo/document-contracts';
import { createArchiveFileSource, validateBundle, readArchive } from '@pagelingo/document-bundle';
import { exportBundle, processPdf } from '../dist/index.js';
import { fixture, english } from './fixtures/legacy-preview/create.ts';
import { buildPdfFixture } from '../../../tests/fixtures/pdf.ts';

const html = `<article class="docvortex-document">${Array.from({ length: 360 }, (_, i) =>
  `<h2>Section ${i + 1}</h2><p>${english} <span data-docvortex-latex="x^2+\\alpha"><math>fallback</math></span></p>${i % 20 === 0 ? '<img src="../assets/picture.png" alt="Owned diagram">' : ''}`,
).join('')}</article>`;
const f = await fixture(html, buildPdfFixture(1), {
  pageIndex: 0, mediaBox: [0, 0, 300, 400], cropBox: [0, 0, 300, 400],
  displayCropBox: [0, 0, 300, 400], rotation: 0, displayWidth: 300,
  displayHeight: 400, pdfToDisplay: [1, 0, 0, -1, 0, 400],
});
let browser;
try {
  await processPdf({ ...f, p0RunDir: f.run, previewDir: f.preview }, { inspectPdf: async () => f.inspection });
  const outputDir = join(f.root, 'bundle'); const archivePath = join(f.root, 'bundle.zip');
  await exportBundle({ runDir: f.runDir, outputDir, archivePath });
  const validated = await validateBundle(createArchiveFileSource(archivePath, defaultBundleLimits), { limits: defaultBundleLimits });
  assert(validated.readerBuild.chunks.length >= 5);
  // Extract only validated manifest members to a fresh test directory; input ZIP paths
  // never enter a production filesystem extractor.
  const unpacked = join(f.root, 'unpacked'); await mkdir(unpacked);
  const allowed = new Set(['manifest.json', ...validated.files.map(file => file.path)]);
  for await (const entry of readArchive(archivePath, defaultBundleLimits)) {
    assert(allowed.has(entry.path));
    const path = join(unpacked, entry.path); await mkdir(dirname(path), { recursive: true });
    const parts = []; for await (const part of entry.content) parts.push(part);
    await writeFile(path, Buffer.concat(parts));
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const network = []; const errors = []; const resources = [];
  let deferredImagesObserved = 0;
  await context.route(/^https?:/i, async route => { network.push(route.request().url()); await route.abort(); });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.url().startsWith('file://')) resources.push({ url: response.url(), status: response.status() }); });
  await page.goto(pathToFileURL(join(unpacked, 'render/index.html')).href);
  const chunks = validated.readerBuild.chunks.length;
  for (let position = 0; position < chunks; position++) {
    if (position) await page.locator('#next').click();
    const expected = validated.readerBuild.chunks.slice(Math.max(0, position - 1), position + 2).map(chunk => chunk.id);
    await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('#content > section')].map(section => section.dataset.chunkId)) === JSON.stringify(expected), expected).catch(async error => {
      console.error(JSON.stringify({ position, expected, actual: await page.locator('#content > section').evaluateAll(sections => sections.map(section => section.dataset.chunkId)), location: await page.locator('#location').textContent(), errors }));
      throw error;
    });
    assert((await page.locator('#content').textContent()).includes(english));
    assert.equal(await page.locator('script[src^="data/c_"]').count(), expected.length);
    if ([0, Math.floor(chunks / 2), chunks - 1].includes(position)) {
      const image = page.locator(`#content > section[data-chunk-id="${validated.readerBuild.chunks[position].id}"] img`).first();
      assert(await image.count() > 0);
      deferredImagesObserved += await page.locator('#content img').evaluateAll(images => images.filter(image => image.loading === 'lazy' && (!image.complete || !image.naturalWidth)).length);
      // The shared renderer intentionally uses loading=lazy. Read the selected
      // image by scrolling it into view; distant neighbor images may stay deferred.
      await image.evaluate(image => image.scrollIntoView({ block: 'center' }));
      await page.waitForFunction(image => image.complete && image.naturalWidth > 0, await image.elementHandle());
      assert(await page.locator('#content .katex').count() > 0);
      await page.evaluate(async () => { await document.fonts.ready; });
      assert(await page.evaluate(() => [...document.fonts].some(font => font.status === 'loaded' && font.family.includes('KaTeX'))));
    }
  }
  const pdfUrl = await page.locator('a[href="../source.pdf"]').evaluate(link => link.href);
  assert.equal(pdfUrl, pathToFileURL(join(unpacked, 'source.pdf')).href);
  assert.deepEqual(await readFile(fileURLToPath(pdfUrl)), await readFile(f.sourcePath));
  assert(resources.some(resource => resource.url.endsWith('/source.pdf') && resource.status === 200));
  assert(resources.some(resource => /\/assets\/.*\.(png|jpg|webp)$/.test(resource.url) && resource.status === 200));
  assert(resources.some(resource => /\/fonts\/.*\.woff2?$/.test(resource.url) && resource.status === 200));
  await page.locator('#divider').focus(); await page.keyboard.press('Home');
  assert.equal(await page.locator('#divider').getAttribute('aria-valuenow'), '30');
  assert.deepEqual(network, []); assert.deepEqual(errors, []);
  console.log(`file:// ZIP acceptance passed: ${chunks} chunks, first/middle/last content/image/math/font loads, <=3 DOM/data scripts, original PDF bytes/link, zero HTTP(S), zero page errors; ${deferredImagesObserved} deferred lazy images observed before scrolling`);
} finally { await browser?.close(); await rm(f.root, { recursive: true, force: true }); }
