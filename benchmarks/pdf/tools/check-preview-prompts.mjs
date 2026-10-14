// Actual offline book pages and the extension's SDK-backed DOM adapter; no LLM calls.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';

const [reportPath, directory] = process.argv.slice(2);
assert(reportPath && directory, 'Usage: node check-preview-prompts.mjs REPORT LLM_BUNDLE');
const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
const compiled = await build({ configFile: false, envDir: false, logLevel: 'error',
  build: { write: false, minify: false, lib: {
    entry: path.join(toolDirectory, 'preview-extension-bridge.ts'),
    formats: ['iife'], name: 'PageLingoPreviewRegression',
  } },
});
const outputs = (Array.isArray(compiled) ? compiled : [compiled]).flatMap(result => result.output);
const script = outputs.find(output => output.type === 'chunk').code;
const browser = await chromium.launch({ headless: true });
const report = { schemaVersion: 'pagelingo-preview-prompt-validation/1',
  scope: 'Source geometry and actual extension mock rendering, protected slots and style restoration; no LLM requests',
  pages: [], errors: [] };
try {
  const context = await browser.newContext({ offline: true, viewport: { width: 1180, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  for (const number of [17, 108, 109, 110, 111, 112, 114, 117, 118, 119, 120, 122, 123, 124, 125, 131, 145, 146, 147, 154]) {
    const root = path.resolve(directory);
    await page.goto(pathToFileURL(path.join(root, 'pages', `page-${String(number).padStart(4, '0')}.html`)).href);
    await page.evaluate(() => document.fonts.ready);
    await page.addScriptTag({ content: script });
    const result = await page.evaluate(number => {
      const article = document.querySelector('article');
      const before = article.innerHTML;
      const visible = selector => [...article.querySelectorAll(selector)]
        .filter(node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);
      const blanks = visible('.pl-completion-slot').length;
      const variables = visible('.pl-prompt-placeholder').map(node => node.textContent);
      const roles = [...article.querySelectorAll('.pl-prompt-role')];
      const roleColors = roles.map(node => getComputedStyle(node).color);
      const bodyLefts = [...article.querySelectorAll('.pl-prompt')].filter(node => node.querySelector('.pl-prompt-role'))
        .map(node => [...node.querySelectorAll('.pl-prompt-value')].map(body => body.getBoundingClientRect().left));
      const roleGeometry = roles.map(node => ({
        width: node.getBoundingClientRect().width, right: node.getBoundingClientRect().right,
        fontSize: parseFloat(getComputedStyle(node).fontSize),
        bodyWidth: node.nextElementSibling.getBoundingClientRect().width,
        bodyRight: node.nextElementSibling.getBoundingClientRect().right,
      }));
      const promptLines = [...article.querySelectorAll('.pl-prompt')]
        .map(prompt => [...prompt.querySelectorAll('p')].map(row => row.textContent.trim()));
      const sourceBlocks = index => article.querySelector(`.docvortex-block[data-block-index="${index}"]`);
      const emphasis = selector => visible(selector).map(node => ({
        text: node.textContent.trim(), background: getComputedStyle(node).backgroundColor,
      }));
      const sourceHighlights = emphasis('.pl-source-highlight');
      const answerUnderline = number !== 117 || sourceBlocks(6).querySelector('u')?.textContent === 'negative';
      const indentPositions = number === 120 ? [13, 14, 15].map(index => ({
        left: sourceBlocks(index).querySelector('p').getBoundingClientRect().left,
        align: getComputedStyle(sourceBlocks(index).querySelector('p')).textAlign,
        inset: Number(sourceBlocks(index).dataset.sourceInsetEm),
      })) : [];
      const demonstration = [124, 131].includes(number) ? [...article.querySelectorAll('.pl-prompt-value')]
        .map(body => [...body.querySelectorAll('p')].map(row => row.textContent.trim())) : [];
      const exampleIndex = {125:7,145:9,154:8}[number];
      const exampleNode = exampleIndex === undefined ? null : sourceBlocks(exampleIndex);
      const exampleAppearance = exampleNode ? {
        element: exampleNode.firstElementChild.tagName,
        align: getComputedStyle(exampleNode.firstElementChild).textAlign,
        fontSize: parseFloat(getComputedStyle(exampleNode.firstElementChild).fontSize),
        bodyFontSize: parseFloat(getComputedStyle(article.querySelector('.docvortex-block[data-block-type="text"]:not(.pl-source-example) p')).fontSize),
        weight: getComputedStyle(exampleNode.firstElementChild).fontWeight,
        style: getComputedStyle(exampleNode.querySelector('em')).fontStyle,
        text: exampleNode.querySelector('em').textContent,
        realHeadings: number === 125 ? [3,5].map(index => sourceBlocks(index).firstElementChild.tagName) : [],
      } : null;
      let prologueFitsGrid = true;
      if (number === 131) {
        const prompt = article.querySelector('.pl-prompt-roles');
        const prologue = document.createElement('p');
        prologue.className = 'pl-prompt-line';
        prologue.textContent = 'Read all of these examples carefully before answering the question. '.repeat(4);
        prompt.prepend(prologue);
        prologueFitsGrid = prologue.getBoundingClientRect().width > prompt.getBoundingClientRect().width * .85 &&
          [...prompt.querySelectorAll('.pl-prompt-value')].every((body,index) =>
            Math.abs(body.getBoundingClientRect().left - bodyLefts[0][index]) < 1);
        prologue.remove();
      }
      const questionOrder = number !== 109 ||
        Boolean(sourceBlocks(6).compareDocumentPosition(sourceBlocks(0)) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        Boolean(sourceBlocks(0).compareDocumentPosition(sourceBlocks(7)) & Node.DOCUMENT_POSITION_FOLLOWING);
      const introductionKept = number !== 110 || Boolean(sourceBlocks(3) &&
        sourceBlocks(3).textContent.includes('example is to assign a role to the LLM') &&
        sourceBlocks(3).compareDocumentPosition(sourceBlocks(0)) & Node.DOCUMENT_POSITION_FOLLOWING);
      const blankGeometry = visible('.pl-completion-slot').map(node => ({
        height: node.getBoundingClientRect().height, fontSize: parseFloat(getComputedStyle(node).fontSize),
        lineStyle: getComputedStyle(node).borderBottomStyle,
        lineWidth: parseFloat(getComputedStyle(node).borderBottomWidth),
      }));
      const assignment = article.querySelector('[data-source-prose-assignment]');
      const api = window.plPreviewRegression;
      const blocks = api.extract();
      const renderer = api.renderer();
      let removedSlotsRejected = 0, translatedPrompts = 0;
      for (const block of blocks) {
        const isPrompt = Boolean(block.parent.closest('.pl-prompt'));
        if (isPrompt) {
          translatedPrompts++;
          const atom = block.input.slots.find(slot => slot.kind === 'atom' && slot.inline.type === 'protected' && slot.inline.kind === 'literal');
          if (atom) {
            try { renderer.render(block, block.input.protectedText.replace(atom.token, '')); }
            catch { removedSlotsRejected++; }
          }
        }
        const translated = block.input.protectedText
          .replaceAll('Calculate the average of the numbers 2, 4, and 9.', '计算数字 2、4 和 9 的平均值。')
          .replaceAll('Where will the 2028 Olympics be held?', '2028 年奥运会将在哪里举办？')
          .replaceAll('Translate the following sentence from English to Chinese.', '将以下句子从英文翻译成中文。')
          .replaceAll('Analyze the polarity of the following text and classify it as positive, negative, or neutral.', '分析以下文本的情感，并将其分类为正面、负面或中性。')
          .replaceAll('negative', '负面');
        if (!renderer.render(block, `测试译文 ${translated}`)) throw new Error('Mock render rejected ' + block.input.id);
      }
      renderer.setMode('translation');
      const translatedBlanks = visible('.pl-completion-slot').length;
      const translatedVariables = visible('.pl-prompt-placeholder').map(node => node.textContent);
      const translatedColors = roles.map(node => getComputedStyle(node).color);
      const translatedSourceStyleRuns = [...article.querySelectorAll('[data-pl-owned="translation"] span[style*="color"]')].length;
      const translatedUnderlines = article.querySelectorAll('[data-pl-owned="translation"] u').length;
      const translatedHighlights = emphasis('[data-pl-owned="translation"] span[style*="background-color"]')
        .filter(node => node.background === 'rgb(154, 245, 175)');
      const translatedAnswerUnderline = number !== 117 || sourceBlocks(6)
        .querySelector('[data-pl-owned="translation"] u')?.textContent === '负面';
      const translatedIndentPositions = number === 120 ? [13, 14, 15]
        .map(index => sourceBlocks(index).querySelector('[data-pl-owned="translation"]')?.getBoundingClientRect().left) : [];
      const translatedDemonstration = [124,131].includes(number) ? [...article.querySelectorAll('.pl-prompt-value')]
        .map(body => [...body.querySelectorAll('[data-pl-owned="translation"]')].map(row => row.textContent.trim())) : [];
      const translatedExampleNode = exampleNode?.querySelector('[data-pl-owned="translation"]');
      const translatedExample = translatedExampleNode ? {
        fontSize: parseFloat(getComputedStyle(translatedExampleNode).fontSize),
        weight: getComputedStyle(translatedExampleNode).fontWeight,
        style: getComputedStyle(translatedExampleNode.querySelector('em')).fontStyle,
        align: getComputedStyle(translatedExampleNode).textAlign,
        text: translatedExampleNode.querySelector('em').textContent,
      } : null;
      const translatedRoleGeometry = roles.map(node => ({
        width: node.getBoundingClientRect().width,
        bodyWidth: node.nextElementSibling.getBoundingClientRect().width,
        bodyRight: node.nextElementSibling.getBoundingClientRect().right,
      }));
      const hasSourceCodePrompt = article.querySelectorAll('.pl-prompt pre,.pl-prompt table').length;
      const sourceRepaired = Boolean(assignment && assignment.querySelector('p').textContent.includes('premise = the weather is nice this weekend,'));
      renderer.setMode('bilingual');
      renderer.restore();
      return { prompts: promptLines.length, blanks, translatedBlanks, variables, translatedVariables,
        roles: roles.map(node => node.textContent), roleColors, translatedColors, bodyLefts, promptLines,
        questionOrder, introductionKept, blankGeometry, sourceRepaired, translatedPrompts, removedSlotsRejected, translatedSourceStyleRuns,
        translatedUnderlines, hasSourceCodePrompt, sourceHighlights, translatedHighlights, answerUnderline,
        translatedAnswerUnderline, indentPositions, translatedIndentPositions, demonstration, translatedDemonstration,
        exampleAppearance, translatedExample, roleGeometry, translatedRoleGeometry, prologueFitsGrid,
        restored: article.innerHTML === before };
    }, number);
    assert.equal(result.restored, true);
    assert.equal(result.hasSourceCodePrompt, 0);
    assert.equal(result.questionOrder, true, 'Q/A must follow its introducing paragraph');
    assert.equal(result.introductionKept, true, 'The preceding paragraph must not merge into a native prompt');
    assert(result.blankGeometry.every(blank => blank.height <= blank.fontSize + 2 &&
      blank.lineStyle === 'solid' && blank.lineWidth === 1), 'Answer slots must be single-line rules');
    assert.equal(result.translatedBlanks, result.blanks, 'Answer lines must remain visible in translation mode');
    assert.deepEqual(result.translatedVariables.sort(), result.variables.sort());
    assert.deepEqual(result.translatedColors, result.roleColors);
    assert(result.roleColors.every(color => color === 'rgb(128, 128, 128)'));
    assert(result.bodyLefts.every(lefts => Math.max(...lefts) - Math.min(...lefts) < 1));
    if (number === 108) { assert.equal(result.blanks, 3); assert.equal(result.sourceRepaired, true); }
    if (number === 109) { assert.equal(result.prompts, 4); assert(result.removedSlotsRejected >= 2); }
    if (number === 110) assert.deepEqual(result.roles, ['SYSTEM', 'USER']);
    if (number === 111) assert.deepEqual(result.roles, ['SYSTEM', 'DEMO', 'USER', 'SYSTEM', 'DEMO1', 'DEMO2', 'USER']);
    if (number === 112) {
      assert.deepEqual(result.roles, ['DEMO', 'USER', 'DEMO', 'USER']);
      assert.equal(result.blanks, 2);
      assert.equal(result.translatedPrompts, 0, 'Literal demonstration pairs must remain unchanged');
    }
    if (number === 114) {
      assert.deepEqual(result.promptLines[1], [
        'You will be provided with a math problem. Please solve the problem.', '{∗problem∗}', '____',
      ]);
      assert.equal(result.blanks, 3);
    }
    if (number === 17) assert(result.translatedSourceStyleRuns > 0, 'Colored dialogue emphasis must survive translation');
    if (number === 117) {
      assert.equal(result.prompts, 2);
      assert.equal(result.sourceHighlights.length, 2, 'Both green instructions must be reconstructed');
      assert(result.sourceHighlights.every(node => node.background === 'rgb(154, 245, 175)' &&
        node.text === 'Analyze the polarity of the following text and classify it as positive, negative, or neutral.'));
      assert.equal(result.translatedHighlights.length, 2);
      assert(result.translatedHighlights.every(node => node.text === '分析以下文本的情感，并将其分类为正面、负面或中性。'));
      assert(result.answerUnderline && result.translatedAnswerUnderline, 'The answer word must remain underlined in Chinese');
    }
    if (number === 120) {
      assert(result.indentPositions.every(node => node.align !== 'center' && node.inset > 3), 'Instructions are indented, never centered');
      assert(Math.max(...result.indentPositions.map(node => node.left)) - Math.min(...result.indentPositions.map(node => node.left)) < 1);
      assert(result.translatedIndentPositions.every(left => typeof left === 'number'));
      assert(Math.max(...result.translatedIndentPositions) - Math.min(...result.translatedIndentPositions) < 1, 'Translated instructions must share one left margin');
      assert(result.translatedHighlights.length > 0, 'A highlighted protected variable must keep its color');
    }
    if (number === 124) {
      assert.deepEqual(result.roles, ['DEMO', 'USER']);
      assert.deepEqual(result.demonstration.map(body => body.length), [4, 2]);
      assert(result.demonstration[0][1].startsWith('A: Jerry will spend') && result.demonstration[0][1].endsWith('#### 96'));
      assert(result.demonstration[0][2].startsWith('Q: Mary bought six apples'));
      assert(result.demonstration[0][3].startsWith('A: She planted eight trees.') && result.demonstration[0][3].endsWith('#### 2'));
      assert(result.demonstration[1][0].startsWith('Q: Boris has 100 apples.'));
      assert(result.demonstration[1][1].endsWith('#### 3'));
      assert.deepEqual(result.translatedDemonstration, result.demonstration.map(body => body.map(text => `测试译文 ${text}`)), 'All six recovered Q/A paragraphs must reach translation and remain visible');
    }
    if ([125,145,154].includes(number)) {
      assert.equal(result.exampleAppearance.element, 'P');
      assert.equal(result.exampleAppearance.fontSize, result.exampleAppearance.bodyFontSize);
      assert.equal(result.exampleAppearance.style, 'italic');
      assert.equal(result.exampleAppearance.align, 'center');
      assert.equal(result.exampleAppearance.weight, '400');
      if (number === 125) assert.deepEqual(result.exampleAppearance.realHeadings, ['H2','H2']);
      assert.equal(result.translatedExample.fontSize, result.exampleAppearance.bodyFontSize);
      assert.equal(result.translatedExample.style, 'italic');
      assert.equal(result.translatedExample.align, 'center');
      assert.equal(result.translatedExample.weight, '400');
      assert.equal(result.translatedExample.text, {
        125: '计算数字 2、4 和 9 的平均值。',
        145: '2028 年奥运会将在哪里举办？',
        154: '将以下句子从英文翻译成中文。',
      }[number]);
    }
    if (number === 131) {
      assert.deepEqual(result.roles, ['TASK','DEMO','USER']);
      assert.deepEqual(result.demonstration.map(body => body.length), [1,4,2]);
      assert.deepEqual(result.translatedDemonstration, result.demonstration.map(body => body.map(text => `测试译文 ${text}`)));
      assert(result.roleGeometry.every(node => node.width < node.fontSize * 5 && node.bodyWidth > 400 && node.bodyRight <= 1180));
      assert(result.translatedRoleGeometry.every(node => node.bodyWidth > 400 && node.bodyRight <= 1180));
      assert.equal(result.prologueFitsGrid, true, 'An introductory paragraph must span the grid without enlarging its role column');
    }
    await page.screenshot({ path: `${reportPath.replace(/\.json$/, '')}-${number}-source.png`, fullPage: true });
    await page.evaluate(() => {
      const renderer = window.plPreviewRegression.renderer();
      for (const block of window.plPreviewRegression.extract()) renderer.render(block, `测试译文 ${block.input.protectedText
        .replaceAll('Calculate the average of the numbers 2, 4, and 9.', '计算数字 2、4 和 9 的平均值。')
        .replaceAll('Where will the 2028 Olympics be held?', '2028 年奥运会将在哪里举办？')
        .replaceAll('Translate the following sentence from English to Chinese.', '将以下句子从英文翻译成中文。')
        .replaceAll('Analyze the polarity of the following text and classify it as positive, negative, or neutral.', '分析以下文本的情感，并将其分类为正面、负面或中性。')
        .replaceAll('negative', '负面')}`);
      renderer.setMode('translation');
    });
    await page.screenshot({ path: `${reportPath.replace(/\.json$/, '')}-${number}-mock-translation.png`, fullPage: true });
    report.pages.push({ pdfPage: number, ...result });
  }
  report.mobile = [];
  await page.setViewportSize({ width: 390, height: 844 });
  for (const number of [110, 111, 112, 114, 117, 120, 124, 125, 131]) {
    await page.goto(pathToFileURL(path.join(path.resolve(directory), 'pages', `page-${String(number).padStart(4, '0')}.html`)).href);
    await page.evaluate(() => document.fonts.ready);
    const result = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      roleBodies: [...document.querySelectorAll('.pl-prompt-value')].map(body => ({ width: body.getBoundingClientRect().width,
        right: body.getBoundingClientRect().right })),
      roles: [...document.querySelectorAll('.pl-prompt-role')].map(role => ({ width: role.getBoundingClientRect().width,
        fontSize: parseFloat(getComputedStyle(role).fontSize) })) }));
    assert(result.scrollWidth <= result.width + 1, 'Role prompts must fit a narrow viewport');
    assert(result.roleBodies.every(body => body.width > 30));
    assert(result.roleBodies.every(body => body.right <= result.width + 1));
    assert(result.roles.every(role => role.width < role.fontSize * 6));
    report.mobile.push({ pdfPage: number, ...result });
  }
  assert.deepEqual(report.errors, []);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.pages.length} actual prompt pages: slots, order, gray roles, alignment, styles and exact restore passed`);
} finally { await browser.close(); }
