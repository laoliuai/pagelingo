// Actual PDF pages and the extension DOM adapter. Fixed mock text; no provider requests.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';

const [reportPath, directory] = process.argv.slice(2);
assert(reportPath && directory, 'Usage: node check-preview-layout-batch.mjs REPORT LLM_BUNDLE');
const root = path.resolve(directory);
const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const layout = JSON.parse(await readFile(path.join(root, 'source-layout.json'), 'utf8'));
const compiled = await build({ configFile: false, envDir: false, logLevel: 'error',
  build: { write: false, minify: false, lib: {
    entry: path.join(toolDirectory, 'preview-extension-bridge.ts'),
    formats: ['iife'], name: 'PageLingoPreviewRegression',
  } },
});
const outputs = (Array.isArray(compiled) ? compiled : [compiled]).flatMap(result => result.output);
const script = outputs.find(output => output.type === 'chunk').code;
const replacements = {
  135: [['Translate the following text from Chinese to English:', '将以下文本从中文翻译成英文：'],
    ['Chinese:', '中文：'], ['English:', '英文：']],
  136: [['Chinese:', '中文：'], ['English:', '英文：'], ['Refinement:', '改进译文：'],
    ['archaeological', '考古'], ['suggest', '表明'], ['various', '多个']],
  154: [['If we want the instruction to be simpler, we may rephrase it into a simpler form',
    '如果想让指令更简单，可以将它改写成更简洁的形式。']],
  162: [['The task involves developing a language model focused on healthcare and finance, capable of understanding and accurately responding to a wide range of user inquiries.',
    '任务是开发一个专注于医疗与金融领域的语言模型，能够理解并准确回答各类用户问题。']],
  172: [['Translate the text from English to Chinese.', '将文本从英文翻译成中文。']],
  171: [['SFT requires labeled data. This makes SFT quite different from pre-training',
    '监督微调需要标注数据，因此它与预训练有很大不同']],
  182: [['Illustrations of using small models to improve large models in LLMs.',
    '使用小模型改进大模型的示意图。']],
  184: [['Supervised fine-tuning vs. reinforcement learning from human feedback.',
    '监督微调与基于人类反馈的强化学习的比较。']],
};
const report = { schemaVersion: 'pagelingo-layout-batch-validation/1',
  scope: 'Native text completeness, labeled panels, field-template order, typography, underlines, colored slots, distinct panels, original math and grouped figures; mock translations only',
  pages: [], mobile: [], errors: [] };
const numbers = [135, 136, 139, 140, 143, 154, 160, 162, 171, 172, 182, 184, 194];
const browser = await chromium.launch({ headless: true });
await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
try {
  const context = await browser.newContext({ offline: true, viewport: { width: 1180, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  for (const number of numbers) {
    await page.goto(pathToFileURL(path.join(root, 'pages', `page-${String(number).padStart(4, '0')}.html`)).href);
    await page.evaluate(async () => {
      for (const image of document.images) image.loading = 'eager';
      await Promise.all([...document.images].map(image => image.decode()));
      await document.fonts.ready;
    });
    await page.addScriptTag({ content: script });
    const result = await page.evaluate(({ number, replacements }) => {
      const article = document.querySelector('article');
      const before = article.innerHTML;
      const source = index => article.querySelector(`.docvortex-block[data-block-index="${index}"]`);
      const leaves = node => {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        const result = [];
        while (walker.nextNode()) if (walker.currentNode.textContent.replace(/^测试译文\s*/, '').trim()) result.push(walker.currentNode);
        return result;
      };
      const metrics = node => node ? ({
        tag: node.tagName, text: node.textContent.trim(),
        size: parseFloat(getComputedStyle(node).fontSize),
        weight: getComputedStyle(node).fontWeight,
        weights: [...new Set(leaves(node).map(leaf => getComputedStyle(leaf.parentElement).fontWeight))],
        italic: leaves(node).every(leaf => getComputedStyle(leaf.parentElement).fontStyle === 'italic'),
      }) : null;
      const fullyUnderlined = node => node && leaves(node).every(leaf => leaf.parentElement.closest('u'));
      const visibleSlots = () => [...article.querySelectorAll('.pl-completion-slot')]
        .filter(node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0)
        .map(node => ({ background: getComputedStyle(node).backgroundColor,
          width: node.getBoundingClientRect().width, text: node.textContent }));
      const languageRows = [135, 136].includes(number) ? [...article.querySelectorAll('.pl-prompt-line')] : [];
      const chineseNode = languageRows.find(row => row.textContent.startsWith('一系列'));
      const chinese = chineseNode ? metrics(chineseNode) : null;
      const refinement = number === 136 ? languageRows.at(-1) : null;
      const underlined = refinement ? fullyUnderlined(refinement) : null;
      const originalLanguageRows = languageRows.map(row => row.textContent.trim());
      const orderedTemplate = () => {
        if (number !== 172) return null;
        const template = source(0);
        const variables = [...template.querySelectorAll('.pl-prompt-placeholder')]
          .filter(node => node.getBoundingClientRect().width && node.getBoundingClientRect().height);
        return {
          roles: [...template.querySelectorAll('.pl-prompt-role')].map(role => role.textContent),
          afterIntroduction: source(8).getBoundingClientRect().bottom <= template.getBoundingClientRect().top,
          beforeContinuation: template.getBoundingClientRect().bottom <= source(9).getBoundingClientRect().top,
          instructionOccurrences: article.innerText.split('Translate the text from English to Chinese.').length - 1,
          translatedInstructionOccurrences: article.innerText.split('将文本从英文翻译成中文。').length - 1,
          variables: variables.map(node => node.textContent),
          outputUnderlined: variables.some(node => node.textContent === '{∗translation∗}' && fullyUnderlined(node)),
        };
      };
      const template172 = orderedTemplate();
      const listState = () => number === 171 ? {
        items: [...article.querySelectorAll('.pl-source-list > li')].map(item => ({
          display: getComputedStyle(item).display,
          marker: getComputedStyle(item).listStyleType,
          text: item.innerText.trim(), left: item.getBoundingClientRect().left,
        })),
      } : null;
      const figureState = () => [182, 184].includes(number) ? {
        images: article.querySelectorAll('img[data-original-pdf]').length,
        width: source(2).querySelector('img').naturalWidth,
        height: source(2).querySelector('img').naturalHeight,
        visible: source(2).querySelector('img').getBoundingClientRect().width > 0,
        captions: [...article.querySelectorAll('.docvortex-caption')].map(node => ({
          text: node.innerText.trim(), weight: getComputedStyle(node).fontWeight,
        })),
      } : null;
      const denseFootnoteState = () => number === 194 ? {
        images: article.querySelectorAll('img[data-original-role="source-fallback"]').length,
        source: source(8).querySelector('img')?.outerHTML,
        width: source(8).querySelector('img')?.naturalWidth,
        height: source(8).querySelector('img')?.naturalHeight,
        visible: source(8).querySelector('img')?.getBoundingClientRect().width > 0,
        flattenedFootnotes: article.querySelectorAll('.docvortex-page-footnote').length,
        bodyMath: [...article.querySelectorAll('.katex')].filter(node => !node.closest('[data-block-index="8"]')).length,
        note: source(8).querySelector('.pl-source-note')?.innerText.trim(),
      } : null;
      const originalList = listState();
      const originalGroup = figureState();
      const originalDenseFootnote = denseFootnoteState();
      const slots = visibleSlots();
      const templates = number === 140 ? [...article.querySelectorAll('.pl-callout')].map(box =>
        [...box.querySelectorAll('p')].map(row => row.textContent.trim())) : [];
      const prose = number === 154 ? metrics(source(9).firstElementChild) : null;
      const italic = number === 162 ? metrics(source(11).querySelector('p')) : null;
      const figure = number === 160 ? {
        images: article.querySelectorAll('img[data-original-pdf]').length,
        caption: source(2).querySelector('.docvortex-caption')?.textContent.trim(),
        width: source(2).querySelector('img').naturalWidth,
        height: source(2).querySelector('img').naturalHeight,
      } : null;
      const footnote = number === 143 ? {
        original: Boolean(source(14).querySelector('img[data-original-role="source-fallback"]')),
        width: source(14).querySelector('img')?.naturalWidth,
        proseKept: source(12).textContent.includes('minimum Bayes risk'),
      } : null;
      window.plBatchRender = () => {
        const api = window.plPreviewRegression;
        const renderer = api.renderer();
        for (const block of api.extract()) {
          let text = block.input.protectedText;
          for (const [original, target] of replacements[number] ?? []) text = text.replaceAll(original, target);
          if (!renderer.render(block, `测试译文 ${text}`)) throw new Error('Mock translation rejected');
        }
        renderer.setMode('translation');
        return renderer;
      };
      const renderer = window.plBatchRender();
      const translatedSlots = visibleSlots();
      const translatedUnderline = refinement ? fullyUnderlined(refinement.querySelector('[data-pl-owned="translation"]')) : null;
      const translatedLanguageRows = languageRows.map(row => row.innerText.trim());
      const translated172 = orderedTemplate();
      const translatedList = listState();
      const translatedGroup = figureState();
      const translatedDenseFootnote = denseFootnoteState();
      const translatedProse = number === 154 ? metrics(source(9).querySelector('[data-pl-owned="translation"]')) : null;
      const translatedItalic = number === 162 ? metrics(source(11).querySelector('[data-pl-owned="translation"]')) : null;
      const translatedFigure = number === 160 ? source(2).querySelector('img').getBoundingClientRect().width > 0 : null;
      renderer.setMode('bilingual');
      renderer.restore();
      return { chinese, underlined, originalLanguageRows, translatedLanguageRows, template172, translated172,
        originalList, translatedList, originalGroup, translatedGroup,
        originalDenseFootnote, translatedDenseFootnote,
        slots, templates, prose, italic, figure, footnote,
        translatedSlots, translatedUnderline, translatedProse, translatedItalic, translatedFigure,
        restored: article.innerHTML === before };
    }, { number, replacements });
    assert.equal(result.restored, true, `${number}: original DOM must restore exactly`);
    assert.deepEqual(result.translatedSlots.map(slot => slot.background), result.slots.map(slot => slot.background));
    if ([135, 136].includes(number)) {
      assert(result.chinese, 'The complete Chinese paragraph, including its leading 一, must exist');
      assert.deepEqual(result.chinese.weights, ['400'], 'Chinese prose must have uniform regular weight');
      assert.equal(result.originalLanguageRows.length, number === 135 ? 5 : 7);
      assert.deepEqual(result.originalLanguageRows.slice(1, 4).filter((_, index) => index !== 1), ['Chinese:', 'English:']);
      const expectedChinese = '一系列考古发现奠定红山文化在中华文明起源研究中的重要地位。最新公布的研究成果认为，大约从距今5800年开始，中华大地上各个区域相继出现较为明显的社会分化，进入文明起源的加速阶段。';
      assert.equal(result.chinese.text, expectedChinese, 'CJK line wrapping must not insert spaces into words');
      assert(result.translatedLanguageRows.some(row => row.includes(expectedChinese)));
      assert(result.translatedLanguageRows.some(row => row.includes('中文：')));
      assert(result.translatedLanguageRows.some(row => row.includes('英文：')));
    }
    if (number === 136) assert(result.underlined && result.translatedUnderline, 'All refinement prose must remain underlined');
    if (number === 139) {
      assert.equal(result.slots.length, 3);
      assert.equal(result.slots.filter(slot => slot.background === 'rgb(241, 148, 138)').length, 1);
      assert.equal(result.slots.filter(slot => slot.background === 'rgb(153, 202, 240)').length, 2);
    }
    if (number === 140) {
      assert.deepEqual(result.templates, [
        ['Make this text simpler.', '{∗text∗}', '____'],
        ['Condense and simplify this text.', '{∗text∗}', '____'],
        ['Rewrite for easy reading.', '{∗text∗}', '____'],
      ]);
      assert.equal(result.slots.length, 3);
    }
    if (number === 143) assert(result.footnote.original && result.footnote.width > 0 && result.footnote.proseKept);
    if (number === 154) {
      assert.equal(result.prose.tag, 'P');
      assert.equal(result.prose.size, 16);
      assert.equal(result.prose.weight, '400');
      assert.equal(result.translatedProse.size, 16);
      assert.equal(result.translatedProse.weight, '400');
      assert(result.translatedProse.text.includes(replacements[154][0][1]));
    }
    if (number === 160) {
      assert.equal(result.figure.images, 1, 'The four subfigures and labels must share one source crop');
      assert(result.figure.caption.startsWith('Fig. 3.8:'));
      assert(result.figure.width > result.figure.height);
      assert.equal(result.translatedFigure, true);
      const group = layout.supplements.figureGroups.find(group => group.sourcePageIndex === 159);
      assert.deepEqual([group.rows, group.columns, group.blockIndices], [2, 2, [2, 3, 6, 8]]);
    }
    if (number === 162) {
      assert(result.italic.italic && result.translatedItalic.italic);
      assert(result.translatedItalic.text.includes(replacements[162][0][1]));
    }
    if (number === 172) {
      for (const template of [result.template172, result.translated172]) {
        assert.deepEqual(template.roles, ['Instruction', 'User Input', 'Output']);
        assert(template.afterIntroduction && template.beforeContinuation, 'The template belongs between its surrounding paragraphs');
        assert.deepEqual(template.variables, ['{∗text∗}', '{∗translation∗}']);
        assert(template.outputUnderlined, 'The output variable must retain its underline');
      }
      assert.equal(result.template172.instructionOccurrences, 1, 'The source template must appear exactly once');
      assert.equal(result.translated172.instructionOccurrences, 0);
      assert.equal(result.translated172.translatedInstructionOccurrences, 1, 'The translated template must appear exactly once');
    }
    if (number === 171) {
      for (const state of [result.originalList, result.translatedList]) {
        assert.equal(state.items.length, 2, 'Both SFT paragraphs must be list items');
        assert(state.items.every(item => item.display === 'list-item' && item.marker === 'disc'));
        assert(Math.abs(state.items[0].left - state.items[1].left) < 1, 'Sibling bullets must align');
      }
      assert(result.originalList.items[0].text.startsWith('SFT requires labeled data.'));
      assert(result.translatedList.items[0].text.includes(replacements[171][0][1]));
      const group = layout.supplements.lists.find(group => group.sourcePageIndex === 170);
      assert.deepEqual(group.items.map(item => item.blockIndex), [7, 8]);
      assert.equal(group.items[0].nativeMarkerRepair.marker, '•');
    }
    if ([182, 184].includes(number)) {
      for (const state of [result.originalGroup, result.translatedGroup]) {
        assert.equal(state.images, 1, 'Subfigures and all local labels must share one source crop');
        assert(state.width > 0 && state.height > 0 && state.visible);
        assert.equal(state.captions.length, 1, 'Only the shared main caption remains a separate paragraph');
        assert.equal(state.captions[0].weight, '400');
      }
      assert(result.translatedGroup.captions[0].text.includes(replacements[number][0][1]));
      const group = layout.supplements.figureGroups.find(group => group.sourcePageIndex === number - 1);
      assert.deepEqual(group.rowLengths, number === 182 ? [2, 2, 1] : [1, 1]);
      if (number === 184) {
        assert.deepEqual(group.nativeSubcaptions.map(label => label.text.slice(0, 3)), ['(a)', '(b)']);
      }
    }
    if (number === 194) {
      for (const state of [result.originalDenseFootnote, result.translatedDenseFootnote]) {
        assert.equal(state.images, 1);
        assert(state.width > 0 && state.height > 0 && state.visible);
        assert.equal(state.flattenedFootnotes, 0, 'Unparsed footnote formulas must never be flattened prose');
        assert(state.bodyMath > 0, 'Regular body formulas must retain KaTeX rendering');
        assert(state.note.includes('已按原 PDF 保留'));
      }
      assert.equal(result.originalDenseFootnote.source, result.translatedDenseFootnote.source);
    }
    await page.screenshot({ path: `${reportPath.replace(/\.json$/, '')}-${number}-source.png`, fullPage: true });
    await page.evaluate(() => { window.plBatchRender(); });
    await page.screenshot({ path: `${reportPath.replace(/\.json$/, '')}-${number}-mock-translation.png`, fullPage: true });
    report.pages.push({ pdfPage: number, ...result });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const number of numbers) {
    await page.goto(pathToFileURL(path.join(root, 'pages', `page-${String(number).padStart(4, '0')}.html`)).href);
    await page.evaluate(() => document.fonts.ready);
    const width = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert(width.scroll <= width.viewport + 1, `${number}: layout must fit a narrow viewport`);
    report.mobile.push({ pdfPage: number, ...width });
  }
  assert.deepEqual(report.errors, []);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`${numbers.length} PDF pages: complete native prose, ordered templates, typography, full underlines, colored slots, original math, grouped figures and exact restore passed`);
} finally { await browser.close(); }
