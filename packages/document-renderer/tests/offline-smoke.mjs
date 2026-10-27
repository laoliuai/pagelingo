// Focused file:// smoke, run explicitly after the package build (no server/API).
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { buildReader, createStaticFilePlan } from '../dist/index.js';
const require = createRequire(import.meta.url);
const ir = JSON.parse(await readFile(new URL('../../document-contracts/fixtures/reader-v1/source-ir.json', import.meta.url)));
const translation = JSON.parse(await readFile(new URL('../../document-contracts/fixtures/reader-v1/translation.json', import.meta.url)));
const id = (kind, value) => `${kind}_${value.toString(16).padStart(32, '0')}`;
ir.blocks = Array.from({ length: 800 }, (_, i) => ({ type: 'code', id: id('b', i + 1), code: `Offline line ${i + 1}`, sourceRefs: [{ pageIndex: 0, precision: 'page' }] }));
ir.nodes = ir.blocks.map((block, i) => ({ id: id('n', i + 1), kind: 'block', blockId: block.id, children: [] }));
ir.roots = ir.nodes.map(node => node.id); ir.assets = [];
Object.assign(translation, { promptVersion: '3', protectionVersion: '1', selectionBlockIds: [], blocks: [], units: [], status: 'not-required' });
const build = buildReader(ir, translation);
const root = await mkdtemp(join(tmpdir(), 'pagelingo-offline-'));
let browser;
try {
  const plan = createStaticFilePlan(build, { title: 'Offline </script> & title', originalFilename: 'book.pdf' });
  for (const file of plan.generatedFiles) {
    const path = join(root, file.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.content);
  }
  for (const asset of plan.trustedAssets) {
    const packageRoot = asset.source.package === 'katex' ? dirname(require.resolve('katex/package.json')) : fileURLToPath(new URL('../', import.meta.url));
    const path = join(root, asset.path); await mkdir(dirname(path), { recursive: true }); await copyFile(join(packageRoot, asset.source.path), path);
  }
  await writeFile(join(root, 'source.pdf'), '%PDF-1.4\n%%EOF');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/^https?:/, route => { throw new Error(`Unexpected network: ${route.request().url()}`); });
  await page.goto(pathToFileURL(join(root, 'render/index.html')).href);
  await page.locator('#content .reader-block').first().waitFor();
  assert.equal(await page.locator('#title').textContent(), 'Offline </script> & title');
  assert.equal(await page.locator('#content > section').count(), 2);
  for (let i = 0; i < 4; i++) {
    await page.locator('#next').click();
    await page.waitForFunction(() => document.getElementById('content').children.length === 3);
  }
  assert.equal(await page.locator('#content > section').count(), 3);
  assert.equal(await page.locator('script[src^="data/c_"]').count(), 3);
  await page.locator('#divider').focus(); await page.keyboard.press('Home');
  assert.equal(await page.locator('#divider').getAttribute('aria-valuenow'), '30');
  assert.deepEqual(errors, []);
  console.log('file:// smoke passed: local registrations, 3-chunk DOM/script window, keyboard divider; no network or page errors');
} finally {
  await browser?.close(); await rm(root, { recursive: true, force: true });
}
