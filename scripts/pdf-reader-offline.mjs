// Browser verification of a current, fully validated formal bundle. No HTTP server.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

export async function verifyOffline(directory, validated, output) {
  await mkdir(output, { recursive: false });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, offline: true });
    const network = []; const errors = []; const resources = new Set();
    await context.route(/^https?:/i, async route => { network.push(route.request().url()); await route.abort(); });
    const page = await context.newPage();
    page.on('request', request => { if (/^https?:/i.test(request.url())) network.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.url().startsWith('file://') && response.ok()) resources.add(response.url()); });
    await page.goto(pathToFileURL(join(directory, 'render/index.html')).href);
    await page.locator('#content .reader-block').first().waitFor();
    const initialGeometry = await page.evaluate(() => {
      const header = document.querySelector('header').getBoundingClientRect();
      const pane = document.getElementById('content-pane').getBoundingClientRect();
      return { scrollY, headerTop: header.top, headerHeight: header.height, paneTop: pane.top,
        visibleTextHeight: Math.min(innerHeight, pane.bottom) - Math.max(0, pane.top) };
    });
    assert.equal(initialGeometry.scrollY, 0); assert.equal(initialGeometry.headerTop, 0);
    assert(initialGeometry.visibleTextHeight >= 240, 'initial package exposes useful text space');
    await page.screenshot({ path: join(output, 'initial-viewport.png') });
    await page.locator('#toc-toggle').click();
    await page.locator('button[data-view=content]').click();
    const chunks = validated.readerBuild.chunks;
    const captures = new Set([0, Math.floor(chunks.length / 2), chunks.length - 1]);
    // Preserve first occurrences of richer structures in addition to book positions.
    for (const kind of ['callout', 'list']) {
      const index = chunks.findIndex(chunk => chunk.nodes.some(node => node.kind === kind));
      if (index >= 0) captures.add(index);
    }
    const features = new Map();
    for (const [label, predicate] of [
      ['image', block => block.source.type === 'image'],
      ['math', block => block.source.type === 'math' || block.source.bindings?.some(binding => binding.kind === 'protected' && binding.object.type === 'math')],
      ['role', block => /SYSTEM|ASSISTANT|USER/.test(JSON.stringify(block.source))],
    ]) {
      const position = chunks.findIndex(chunk => chunk.blocks.some(predicate));
      if (position >= 0) {
        const block = chunks[position].blocks.find(predicate);
        features.set(position, [...(features.get(position) ?? []), { label, blockId: block.source.id }]);
      }
    }
    let images = 0; let math = 0; const screenshots = [{ path: 'initial-viewport.png', note: 'Fresh goto before navigation; title/status/controls visible and full warning text available in collapsed details.' }]; const locatedPages = new Set();
    for (let position = 0; position < chunks.length; position++) {
      if (position) await page.locator('#next').click();
      const expected = chunks.slice(Math.max(0, position - 1), position + 2).map(chunk => chunk.id);
      await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('#content > section')].map(section => section.dataset.chunkId)) === JSON.stringify(expected), expected);
      assert.equal(await page.locator('script[src^="data/c_"]').count(), expected.length);
      assert.equal(await page.evaluate(() => scrollY), 0, 'chunk navigation stays in the pane');
      const current = page.locator(`#content > section[data-chunk-id="${chunks[position].id}"]`);
      const firstBlock = chunks[position].blockIds[0];
      if (firstBlock) {
        if (position) { const gap = await current.locator(`[data-block-id="${firstBlock}"]`).evaluate(block => block.getBoundingClientRect().top - document.getElementById('content-pane').getBoundingClientRect().top); assert(Math.abs(gap) <= 2, `current chunk ${position + 1} starts at pane top: gap ${gap}`); }
        await current.locator(`[data-block-id="${firstBlock}"]`).evaluate(block => block.click());
        const sourcePage = validated.readerBuild.index.blockLocations[firstBlock].pageIndices[0];
        assert.equal(await page.locator('#pdf').getAttribute('src'), `../source.pdf#page=${sourcePage + 1}`);
        locatedPages.add(sourcePage);
      }
      const pictures = current.locator('img');
      for (let i = 0; i < await pictures.count(); i++) {
        const picture = pictures.nth(i);
        await picture.evaluate(image => { const pane = document.getElementById('content-pane'); pane.scrollTop += image.getBoundingClientRect().top - pane.getBoundingClientRect().top - Math.max(0, (pane.clientHeight - image.clientHeight) / 2); });
        await page.waitForFunction(image => image.complete && image.naturalWidth > 0, await picture.elementHandle());
        images++;
      }
      math += await current.locator('.katex').count();
      await page.evaluate(async () => { await document.fonts.ready; });
      if (captures.has(position)) {
        await current.evaluate(section => { const pane = document.getElementById('content-pane'); pane.scrollTop += section.getBoundingClientRect().top - pane.getBoundingClientRect().top; });
        const name = `chunk-${String(position + 1).padStart(4, '0')}.png`;
        await page.screenshot({ path: join(output, name) });
        screenshots.push({ path: name, chunkId: chunks[position].id, blockIds: chunks[position].blockIds });
      }
      for (const feature of features.get(position) ?? []) {
        await current.locator(`[data-block-id="${feature.blockId}"]`).evaluate(block => { const pane = document.getElementById('content-pane'); pane.scrollTop += block.getBoundingClientRect().top - pane.getBoundingClientRect().top; });
        const name = `${feature.label}-chunk-${String(position + 1).padStart(4, '0')}.png`;
        await page.screenshot({ path: join(output, name) });
        screenshots.push({ path: name, chunkId: chunks[position].id, blockIds: [feature.blockId] });
      }
    }
    const pdfUrl = await page.locator('a[href="../source.pdf"]').evaluate(link => link.href);
    assert.equal(pdfUrl, pathToFileURL(join(directory, 'source.pdf')).href);
    assert((await readFile(join(directory, 'source.pdf'))).subarray(0, 5).equals(Buffer.from('%PDF-')));
    assert(resources.has(pdfUrl), 'browser opened bundled original PDF');
    // Probe every packaged font directly; CSS only loads the glyph families used on a page.
    const fonts = validated.files.filter(file => /\.(?:woff2?|ttf)$/.test(file.path));
    for (let i = 0; i < fonts.length; i++) {
      const url = pathToFileURL(join(directory, fonts[i].path)).href;
      assert(await page.evaluate(async ({ url, index }) => {
        try { const face = new FontFace(`probe${index}`, `url("${url}")`); await face.load(); return face.status === 'loaded'; } catch { return false; }
      }, { url, index: i }), `font ${fonts[i].path}`);
    }
    assert.deepEqual(network, []); assert.deepEqual(errors, []);
    return { initialGeometry, chunksVisited: chunks.length, sourcePagesLocated: [...locatedPages].sort((a, b) => a - b), imagesDecoded: images, mathRendered: math, fontsLoaded: fonts.length, httpRequests: network.length, pageErrors: errors, originalPdfOpened: true, maximumMountedChunks: 3, screenshots };
  } finally { await browser.close(); }
}
