// Real exported HTML + the extension's current extraction / rendering code.
// Mock output validates layout only; it does not test translation quality.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';

const [reportPath, llmDirectory, rlDirectory] = process.argv.slice(2);
assert(reportPath && llmDirectory && rlDirectory,
  'Usage: node check-preview-structure.mjs REPORT LLM_BUNDLE RL_BUNDLE');
const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
const compiled = await build({
  configFile: false, envDir: false, logLevel: 'error',
  build: { write: false, minify: false,
    lib: { entry: path.join(toolDirectory, 'preview-extension-bridge.ts'),
      formats: ['iife'], name: 'PageLingoPreviewRegression' } },
});
const outputs = (Array.isArray(compiled) ? compiled : [compiled]).flatMap(result => result.output);
const script = outputs.find(output => output.type === 'chunk').code;
const browser = await chromium.launch({ headless: true });
const report = { schemaVersion: 'pagelingo-preview-structure-validation/1',
  scope: 'Original HTML layout plus mock extension render / mode switch / exact restore; no LLM requests',
  pages: [], errors: [] };
try {
  const context = await browser.newContext({ offline: true, viewport: { width: 1180, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  const cases = [
    [llmDirectory, 5], [llmDirectory, 17], [llmDirectory, 30],
    [llmDirectory, 34], [llmDirectory, 137], [llmDirectory, 218], [rlDirectory, 74],
  ];
  for (const [directory, pageNumber] of cases) {
    const root = path.resolve(directory);
    await page.goto(pathToFileURL(path.join(root, 'pages', `page-${String(pageNumber).padStart(4, '0')}.html`)).href);
    await page.evaluate(() => document.fonts.ready);
    await page.addScriptTag({ content: script });
    const result = await page.evaluate(() => {
      const article = document.querySelector('article');
      const before = article.innerHTML;
      const api = window.plPreviewRegression;
      const blocks = api.extract();
      const renderer = api.renderer();
      const rows = [...article.querySelectorAll('.pl-label-row')];
      const listItems = article.querySelectorAll('.pl-source-list > li').length;
      const notation = article.querySelectorAll('.pl-notation dd').length;
      const layout = [...article.querySelectorAll('.pl-source-paragraph')].map(node => ({
        block: Number(node.dataset.blockIndex), inset: node.dataset.sourceInsetEm,
        margin: parseFloat(getComputedStyle(node).marginInlineStart),
        textIndent: node.querySelector(':scope > .docvortex-text')
          ? parseFloat(getComputedStyle(node.querySelector(':scope > .docvortex-text')).textIndent) : 0,
      }));
      const labels = rows.map(row => ({ label: row.querySelector('dt').textContent,
        value: row.querySelector('dd').textContent,
        labelHeight: row.querySelector('dt').getBoundingClientRect().height,
        labelLineHeight: parseFloat(getComputedStyle(row.querySelector('dt')).lineHeight),
        columns: getComputedStyle(row).gridTemplateColumns,
        ddLeft: row.querySelector('dd').getBoundingClientRect().left }));
      const explanation = [...article.querySelectorAll('li .docvortex-text')]
        .find(node => node.textContent.startsWith('Although predicting an unchanged'));
      const marker = explanation?.closest('li')?.querySelector(':scope > p');
      const continuationAligned = !explanation ||
        Math.abs(explanation.getBoundingClientRect().left - marker.getBoundingClientRect().left) < 1;
      for (const block of blocks) {
        if (!renderer.render(block, `测试译文 ${block.input.protectedText}`)) {
          throw new Error(`Mock render rejected ${block.input.id}`);
        }
      }
      const translations = rows.map(row => row.querySelectorAll('dd [data-pl-owned="translation"]').length);
      renderer.setMode('translation');
      const rowsKept = article.querySelectorAll('.pl-label-row').length === rows.length;
      const listsKept = article.querySelectorAll('.pl-source-list > li').length === listItems;
      const notationKept = article.querySelectorAll('.pl-notation dd').length === notation;
      renderer.setMode('bilingual');
      renderer.restore();
      return { blocks: blocks.length, labels, translations, layout, continuationAligned,
        rowsKept, listsKept, notationKept, restored: article.innerHTML === before,
        callouts: article.querySelectorAll('.pl-callout').length,
        underlines: article.querySelectorAll('.pl-label-row u').length,
        colors: article.querySelectorAll('.pl-label-row .pl-source-color').length,
        sourceText: blocks.map(block => block.input.sourceText) };
    });
    assert(result.blocks > 0);
    assert.equal(result.restored, true, 'The extension must restore the original article exactly');
    assert(result.rowsKept && result.listsKept && result.notationKept);
    assert(result.continuationAligned, 'A list explanation must align with its list item');
    if (pageNumber === 34) {
      assert.deepEqual(result.labels.map(row => row.label),
        ['Original:', 'Unchanged Token:', 'Sequence:', 'Label:', 'Sequence:', 'Label:']);
      assert.deepEqual(result.translations, [1, 1, 1, 1, 1, 1]);
      assert(result.labels[3].value === 'IsNext' && result.labels[5].value === 'NotNext');
      assert(Math.abs(result.labels[2].ddLeft - result.labels[3].ddLeft) < 1);
      assert(Math.abs(result.labels[4].ddLeft - result.labels[5].ddLeft) < 1);
      assert(result.layout.find(entry => entry.block === 6).textIndent > 15);
      assert(result.layout.find(entry => entry.block === 5).margin < 1,
        'Continuation inside a list must not receive a second indent');
      assert(result.underlines === 2 && result.colors > 0);
      assert(result.labels.every(row => row.labelHeight <= row.labelLineHeight + 1),
        'Desktop labels must fit on one line');
    }
    await page.screenshot({ path: `${reportPath.replace(/\.json$/, '')}-${path.basename(root)}-${pageNumber}.png`, fullPage: true });
    delete result.sourceText;
    report.pages.push({ bundle: path.basename(root), pdfPage: pageNumber, ...result });
  }
  // A narrow viewport must preserve semantic rows without horizontal page overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(pathToFileURL(path.join(path.resolve(llmDirectory), 'pages/page-0034.html')).href);
  report.mobile = await page.evaluate(() => ({ width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    labels: document.querySelectorAll('.pl-label-row').length }));
  assert(report.mobile.scrollWidth <= report.mobile.width + 1);
  assert.equal(report.mobile.labels, 6);
  assert.deepEqual(report.errors, []);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.pages.length} representative pages: source layout, mock translation and exact restore passed`);
} finally {
  await browser.close();
}
