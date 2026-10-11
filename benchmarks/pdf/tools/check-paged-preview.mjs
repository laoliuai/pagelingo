// Verify extracted offline packages, including every page and actual navigation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const [reportPath, ...directories] = process.argv.slice(2);
assert(reportPath && directories.length, 'Usage: node check-paged-preview.mjs REPORT BUNDLE...');
const browser = await chromium.launch({ headless: true });
const report = {
  schemaVersion: 'pagelingo-paged-preview-browser-validation/1',
  browser: `Chromium ${browser.version()}, file://, offline=true`,
  scope: 'All exported pages, local resources, font/image loading, navigation and scroll smoke test; not parser accuracy acceptance',
  bundles: [],
};
try {
  for (const directory of directories) {
    const root = path.resolve(directory);
    const preview = JSON.parse(await readFile(path.join(root, 'preview.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    for (const entry of manifest.files) {
      const target = path.resolve(root, entry.path);
      assert(target.startsWith(root + path.sep), 'Manifest path must stay in package');
      const data = await readFile(target);
      assert.equal(data.length, entry.bytes, entry.path);
      assert.equal(createHash('sha256').update(data).digest('hex'), entry.sha256, entry.path);
    }
    const context = await browser.newContext({ offline: true, viewport: { width: 1180, height: 960 } });
    const page = await context.newPage();
    const errors = [], failedRequests = [], remoteRequests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('requestfailed', (request) => failedRequests.push(request.url()));
    page.on('request', (request) => {
      if (/^https?:/.test(request.url())) remoteRequests.push(request.url());
    });
    const url = (relative) => pathToFileURL(path.join(root, relative)).href;
    const summary = {
      name: path.basename(root), sourceRunId: preview.sourceRunId,
      filesVerified: manifest.files.length, pagesOpened: 0, math: 0, images: 0,
      originalVisuals: 0, maxDomElements: 0, maxLoadMs: 0,
      callouts: 0, algorithmImages: 0, protectedSourceImages: 0,
      listItems: 0, notationRows: 0, completionSlots: 0, coloredSpans: 0,
    };
    for (const entry of preview.pages) {
      const started = performance.now();
      await page.goto(url(entry.path), { waitUntil: 'load' });
      const loaded = await page.evaluate(async () => {
        for (const image of document.images) image.loading = 'eager';
        await Promise.all([...document.images].map((image) => image.decode()));
        await document.fonts.ready;
        return {
          dom: document.querySelectorAll('*').length,
          math: document.querySelectorAll('.katex').length,
          fallbacks: document.querySelectorAll('.pl-math-fallback').length,
          images: document.images.length,
          originals: document.querySelectorAll('img[data-original-pdf]').length,
          callouts: document.querySelectorAll('.pl-callout').length,
          algorithms: document.querySelectorAll('img[data-original-role="algorithm"]').length,
          protectedSources: document.querySelectorAll('img[data-original-role="source-fallback"]').length,
          listItems: document.querySelectorAll('.pl-source-list > li').length,
          notationRows: document.querySelectorAll('.pl-notation-entry').length,
          completionSlots: document.querySelectorAll('.pl-completion-slot').length,
          coloredSpans: document.querySelectorAll('.pl-source-color').length,
          invalidText: /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd\ufffe\uffff]/.test(document.body.textContent),
          bookPage: document.querySelector('.pl-book-page')?.textContent,
          tables: document.querySelectorAll('table').length,
          pages: document.querySelectorAll('section[data-page-idx]').length,
          selectedPage: document.querySelector('.pl-jump select').selectedOptions[0].text,
          sourcePdf: document.querySelector('.pl-toolbar a[href*="source.pdf"]').getAttribute('href'),
          fonts: document.fonts.status,
          resources: [...document.querySelectorAll('a[href],link[href],script[src],img[src]')]
            .map((node) => node.getAttribute('href') || node.getAttribute('src')),
        };
      });
      assert.equal(loaded.math, entry.renderedMathCount, entry.path);
      assert.equal(loaded.fallbacks, entry.mathFallbackCount, entry.path);
      assert.equal(loaded.images, entry.imageCount, entry.path);
      if (entry.calloutCount !== undefined) {
        assert.equal(loaded.callouts, entry.calloutCount, entry.path);
        assert.equal(loaded.algorithms, entry.algorithmImageCount, entry.path);
        assert.equal(loaded.protectedSources, entry.protectedSourceCount, entry.path);
        assert.equal(loaded.invalidText, false, 'Invalid text glyphs must use the source fallback');
        if (entry.bookPageLabel) assert.equal(loaded.bookPage, `书内 ${entry.bookPageLabel}`);
      }
      if (entry.listItemCount !== undefined) {
        assert.equal(loaded.listItems, entry.listItemCount, entry.path);
        assert.equal(loaded.notationRows, entry.notationRowCount, entry.path);
        assert.equal(loaded.completionSlots, entry.completionSlotCount, entry.path);
        assert.equal(loaded.coloredSpans, entry.coloredSpanCount, entry.path);
      }
      assert.equal(loaded.tables, 0, 'Tables must use original PDF crops');
      assert.equal(loaded.pages, 1, 'Only one source page may be loaded');
      assert.equal(Number(loaded.selectedPage), entry.sourcePageIndex + 1);
      assert.equal(loaded.sourcePdf, `../source.pdf#page=${entry.sourcePageIndex + 1}`);
      assert.equal(loaded.fonts, 'loaded');
      for (const reference of loaded.resources) {
        const resolved = new URL(reference, page.url());
        if (resolved.protocol !== 'file:') continue; // Outgoing citations are links, not dependencies.
        const localPath = fileURLToPath(resolved);
        assert(localPath.startsWith(root + path.sep), reference);
        assert((await stat(localPath)).isFile(), reference);
      }
      summary.pagesOpened++;
      summary.math += loaded.math;
      summary.images += loaded.images;
      summary.originalVisuals += loaded.originals;
      summary.callouts += loaded.callouts;
      summary.algorithmImages += loaded.algorithms;
      summary.protectedSourceImages += loaded.protectedSources;
      summary.listItems += loaded.listItems;
      summary.notationRows += loaded.notationRows;
      summary.completionSlots += loaded.completionSlots;
      summary.coloredSpans += loaded.coloredSpans;
      summary.maxDomElements = Math.max(summary.maxDomElements, loaded.dom);
      summary.maxLoadMs = Math.max(summary.maxLoadMs, performance.now() - started);
      if (summary.pagesOpened % 50 === 0) console.log(`${summary.name}: opened ${summary.pagesOpened}/${preview.pages.length}`);
    }
    assert.equal(summary.math, preview.renderedMathCount);
    assert.equal(summary.originalVisuals, preview.originalVisuals.length);
    const home = url('index.html');
    const first = url(preview.pages[0].path), second = url(preview.pages[1].path);
    await page.goto(home);
    await page.locator('.pl-start').click();
    await page.waitForURL(first);
    assert.equal(await page.locator('a[rel="prev"]').count(), 0);
    await page.keyboard.press('ArrowRight');
    await page.waitForURL(second);
    await page.locator('.pl-toolbar a[rel="prev"]').click();
    await page.waitForURL(first);
    const densest = preview.pages.reduce((a, b) => a.domElements > b.domElements ? a : b);
    await page.locator('.pl-jump select').selectOption(path.basename(densest.path));
    await page.locator('.pl-jump button').click();
    await page.waitForURL(url(densest.path));
    summary.scroll = await page.evaluate(async () => {
      const intervals = [];
      let previous = performance.now();
      for (let i = 0; i < 100; i++) {
        window.scrollTo(0, (i % 2) * document.documentElement.scrollHeight);
        const now = await new Promise(requestAnimationFrame);
        intervals.push(now - previous);
        previous = now;
      }
      return { frames: intervals.length, maxFrameMs: Math.max(...intervals),
        meanFrameMs: intervals.reduce((a, b) => a + b) / intervals.length,
        domElements: document.querySelectorAll('*').length };
    });
    assert(summary.scroll.maxFrameMs < 2000, 'Scroll smoke test encountered a multi-second stall');
    await page.goto(url(preview.pages.at(-1).path));
    assert.equal(await page.locator('a[rel="next"]').count(), 0);
    await page.locator('.pl-toolbar a[rel="prev"]').click();
    await page.waitForURL(url(preview.pages.at(-2).path));
    await page.goto(home);
    const toc = page.locator('.pl-toc a').first();
    const tocUrl = new URL(await toc.getAttribute('href'), home).href;
    await toc.click();
    await page.waitForURL(tocUrl);
    assert(await page.evaluate(() => Boolean(document.getElementById(decodeURIComponent(location.hash.slice(1))))));
    assert.deepEqual(errors, []);
    assert.deepEqual(failedRequests, []);
    assert.deepEqual(remoteRequests, []);
    Object.assign(summary, { navigation: 'passed', errors, failedRequests, remoteRequests });
    report.bundles.push(summary);
    await context.close();
    console.log(`${summary.name}: all pages and navigation passed`);
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
} finally {
  await browser.close();
}
