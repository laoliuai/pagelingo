// Deterministic registration order: no server, APIs or automatic chunk arrival.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const runtime = fileURLToPath(new URL('../static/offline-runtime.js', import.meta.url));
const browser = await chromium.launch({ headless: true });
try {
  for (const [userScrolled, blockHeight] of [[false, 500], [true, 500], [false, 100]]) await test(userScrolled ? 'user scroll survives reversed registrations' : `TOC jump survives reversed registrations with ${blockHeight}px blocks`, async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(`<!doctype html><style>
      body{margin:0}#content-pane{height:300px;width:600px;overflow:auto;overflow-anchor:none}body{min-height:1500px}
      .reader-block{height:${blockHeight}px;margin:0}#content>section{margin:0}
      </style><div id="title"></div><div id="status"></div><details id="warnings"><ul id="warning-list"></ul></details><nav id="toc"></nav>
      <main id="reader"><iframe id="pdf"></iframe><div id="divider"></div>
      <section id="content-pane"><div id="content"></div></section></main>
      <span id="location"></span><button id="previous"></button><button id="next"></button>
      <button id="mode"></button><button id="font"></button><button id="toc-toggle"></button>`);
    await page.addScriptTag({ path: runtime });
    await page.evaluate(() => {
      const chunks = [
        { id: 'c_000001', blockIds: ['prior'] },
        { id: 'c_000002', blockIds: ['middle', 'user'] },
        { id: 'c_000003', blockIds: ['following'] },
      ];
      const index = {
        chunks, toc: [{ blockId: 'middle', title: 'Middle', depth: 1 }],
        blockLocations: Object.fromEntries(chunks.flatMap(chunk => chunk.blockIds.map(id => [id, { chunkId: chunk.id, pageIndices: [0] }]))),
        translationStatus: 'not-required', parseCoverage: 'full', generationKind: 'none', warnings: [],
      };
      window.PageLingoReader.registerIndex({ metadata: { title: 'Anchor regression' }, index });
      const html = '<div class="reader-block" data-block-id="middle" id="middle">Middle</div><div class="reader-block" data-block-id="user" id="user">User</div>';
      window.PageLingoReader.registerChunk({ chunk: { id: 'c_000002' }, source: { html, warnings: [] }, translation: { html, warnings: [] } });
    });
    await page.locator('#toc a').click();
    if (userScrolled) await page.locator('#content-pane').evaluate(pane => { pane.scrollTop = 650; });
    const anchorId = userScrolled ? 'user' : 'middle';
    const position = () => page.evaluate(id => {
      const pane = document.getElementById('content-pane');
      return { offset: document.getElementById(id).getBoundingClientRect().top - pane.getBoundingClientRect().top, scrollTop: pane.scrollTop };
    }, anchorId);
    assert.equal(await page.evaluate(() => scrollY), 0, 'TOC jump must not scroll the outer page');
    const before = await position();
    assert.equal(before.offset, userScrolled ? -150 : 0);
    await page.evaluate(() => {
      const html = '<div class="reader-block" data-block-id="prior" id="prior">Prior</div>';
      window.PageLingoReader.registerChunk({ chunk: { id: 'c_000001' }, source: { html, warnings: [] }, translation: { html, warnings: [] } });
    });
    const after = await position();
    assert.equal(after.offset, before.offset, `Late preceding chunk must preserve ${userScrolled ? 'user scroll' : 'TOC jump'} anchor: ${JSON.stringify({ before, after })}`);
    assert.equal(after.scrollTop, before.scrollTop + blockHeight);
    await page.evaluate(() => {
      const html = '<div class="reader-block" data-block-id="following" id="following">Next</div>';
      window.PageLingoReader.registerChunk({ chunk: { id: 'c_000003' }, source: { html, warnings: [] }, translation: { html, warnings: [] } });
    });
    assert.equal((await position()).offset, before.offset, 'Late following chunk must preserve current anchor');
    assert.equal(await page.locator('#content > section').count(), 3);
    assert.equal(await page.evaluate(() => scrollY), 0, 'late neighbors must not scroll the outer page');
    await page.locator('#next').click();
    assert.equal(await page.evaluate(() => scrollY), 0, 'chunk jump must not scroll the outer page');
    assert.equal(await page.locator('#content > section').count(), 2);
    await page.evaluate(() => { window.scrollTo(0, 80); const link = document.createElement('a'); link.dataset.blockLink = 'middle'; document.getElementById('content').append(link); link.click(); });
    assert.equal(await page.evaluate(() => scrollY), 80, 'block links preserve a deliberately scrolled outer page');
    assert.deepEqual(errors, []);
    console.log(`Reversed registration ${userScrolled ? 'user-scroll' : 'TOC-jump'} anchor passed: ${JSON.stringify({ before, after })}`);
    await page.close();
  });
} finally {
  await browser.close();
}
