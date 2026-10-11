import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PageCommand, PageStatus, Result } from '../../src/shared/types';
import { test, extensionDist } from './extension-fixture';

async function command(control: Page, page: Page, command: PageCommand): Promise<PageStatus> {
  const result = await control.evaluate(async ({ url, command }) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((tab) => tab.url === url);
    if (tab?.id === undefined) throw new Error('Fixture tab not found.');
    return chrome.runtime.sendMessage({ type: 'extension:command', tabId: tab.id, command });
  }, { url: page.url(), command }) as Result<PageStatus>;
  if (!result?.ok) throw new Error(result?.error ?? 'No extension response.');
  return result.value;
}

async function configureApi(control: Page, model = 'fixture-model') {
  await fetch('http://127.0.0.1:4317/llm/reset', { method: 'POST' });
  await control.getByLabel('Base URL').fill('http://127.0.0.1:4317/llm');
  await control.getByLabel('API Key', { exact: true }).fill('local-test-secret');
  await control.getByLabel('Model', { exact: true }).fill(model);
  await control.getByRole('button', { name: '保存设置' }).click();
  await expect(control.getByText('设置已保存在本地')).toBeVisible();
}

async function apiMetrics(): Promise<{ requests: number; aborted: number }> {
  return (await fetch('http://127.0.0.1:4317/llm/metrics')).json();
}

async function importTerms(control: Page, entries: unknown) {
  await control.getByLabel('导入词表文件').setInputFiles({ name: 'personal.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(entries)) });
  await control.getByRole('button', { name: '确认合并词表' }).click();
}

test('imports and reimports terms with last-write precedence, manual editing and persistence', async ({ control }) => {
  const entry = { source: 'token', target: '旧译文', policy: 'translate', domain: 'all' };
  await importTerms(control, [entry, { source: 'agent', target: '智能体', policy: 'translate', domain: 'all' }]);
  await importTerms(control, [{ ...entry, source: ' Token ', target: '中间译文' }, { ...entry, source: 'TOKEN', target: '词元' }]);
  await control.getByLabel('搜索术语').fill('token');
  const rows = control.locator('.glossary-table tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('词元');
  await rows.getByRole('button', { name: '编辑' }).click();
  await control.getByLabel('术语译文', { exact: true }).fill('个人新译法');
  await control.getByRole('button', { name: '添加或更新词条' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('个人新译法');
  await control.getByRole('button', { name: '保存设置' }).click();
  await expect(control.getByText('设置已保存在本地')).toBeVisible();
  await control.reload();
  await control.getByLabel('搜索术语').fill('token');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('个人新译法');
  await control.getByLabel('搜索术语').fill('agent');
  await expect(rows).toContainText('智能体');
  await control.getByLabel('导入词表文件').setInputFiles({ name: 'invalid.csv', mimeType: 'text/csv', buffer: Buffer.from('source,target,policy\ntoken,错误,bogus') });
  await expect(control.getByRole('alert')).toBeVisible();
  await control.getByLabel('搜索术语').fill('token');
  await expect(rows).toContainText('个人新译法');
});

test('loads and searches the repository CSV glossary and exports only glossary entries', async ({ control }) => {
  const csv = readFileSync(new URL('../../../../docs/glossaries/common-tech.en-zh.csv', import.meta.url));
  await control.getByLabel('导入词表文件').setInputFiles({ name: 'common.csv', mimeType: 'text/csv', buffer: csv });
  await control.getByRole('button', { name: '确认合并词表' }).click();
  await control.getByRole('button', { name: '保存设置' }).click();
  await expect(control.getByText('设置已保存在本地')).toBeVisible();
  await control.reload();
  await control.getByLabel('搜索术语').fill('Transformer');
  await expect(control.locator('.glossary-table tbody tr')).toContainText('Transformer');
  const downloaded = control.waitForEvent('download');
  await control.getByRole('button', { name: '导出 JSON 词表' }).click();
  const download = await downloaded;
  const data = JSON.parse(readFileSync((await download.path())!, 'utf8'));
  expect(Array.isArray(data)).toBe(true);
  expect(data.length).toBeGreaterThanOrEqual(363);
  expect(Object.keys(data[0]).sort()).toEqual(['domain', 'policy', 'source', 'target']);
});

test('requires committing a manual term before saving settings', async ({ control }) => {
  await control.getByRole('button', { name: '添加术语' }).click();
  await control.getByLabel('术语原词', { exact: true }).fill('harness');
  await expect(control.getByRole('button', { name: '保存设置' })).toBeDisabled();
  await control.getByRole('button', { name: '添加或更新词条' }).click();
  await expect(control.getByRole('button', { name: '保存设置' })).toBeEnabled();
});

test('applies imported terminology to heading and body and refreshes only affected cached blocks', async ({ page, control }) => {
  await configureApi(control);
  const entries = [
    { source: 'harness engineering', target: 'harness 工程', policy: 'translate', domain: 'machine-learning' },
    { source: 'harness', target: '', policy: 'keep', domain: 'machine-learning' },
  ];
  await importTerms(control, entries);
  await control.getByRole('button', { name: '保存设置' }).click();
  await expect(control.getByText('设置已保存在本地')).toBeVisible();
  await page.goto('http://127.0.0.1:4317/technical-doc.html');
  await page.evaluate(() => {
    document.title = 'Harness Engineering';
    document.querySelector('article')!.innerHTML = '<h1>Harness engineering for self-improvement</h1><p>The harness uses tools.</p><p>A separate paragraph about reliable systems.</p>';
  });
  const run = async () => {
    await command(control, page, { type: 'page:translate', mode: 'bilingual' });
    await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('completed');
    return command(control, page, { type: 'page:status' });
  };
  await run();
  const translations = page.locator('[data-pl-owned="translation"]');
  await expect(translations).toHaveCount(3);
  await expect(translations.nth(0)).toContainText('harness 工程');
  await expect(translations.nth(1)).toContainText('The harness uses tools');
  const firstRequests = (await apiMetrics()).requests;
  await importTerms(control, [{ ...entries[0], source: ' HARNESS ENGINEERING ', target: 'harness 系统工程' }]);
  await control.getByRole('button', { name: '保存设置' }).click();
  await expect(control.getByText('设置已保存在本地')).toBeVisible();
  expect((await run()).metrics?.cacheHits).toBe(2);
  await expect(translations.nth(0)).toContainText('harness 系统工程');
  expect((await apiMetrics()).requests).toBe(firstRequests + 1);
  await importTerms(control, [{ source: 'epsilon', target: '艾普西隆', policy: 'translate', domain: 'all' }]);
  await control.getByRole('button', { name: '保存设置' }).click();
  await expect(control.getByText('设置已保存在本地')).toBeVisible();
  expect((await run()).metrics?.cacheHits).toBe(3);
  expect((await apiMetrics()).requests).toBe(firstRequests + 1);
});

for (const fixture of ['arxiv', 'github-readme', 'technical-doc']) {
  test(`renders and restores ${fixture} without altering original nodes`, async ({ page, control }, testInfo) => {
    await page.goto(`http://127.0.0.1:4317/${fixture}.html`);
    const before = await page.locator('body').innerHTML();
    await page.evaluate(() => {
      (window as typeof window & { originalElements: Element[] }).originalElements = Array.from(document.body.querySelectorAll('*'));
    });
    await command(control, page, { type: 'page:preview', mode: 'bilingual' });
    await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('completed');
    const count = await page.locator('[data-pl-owned="translation"]').count();
    expect(count).toBeGreaterThan(4);
    await expect(page.locator('tr > [data-pl-owned],ul > [data-pl-owned],ol > [data-pl-owned]')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`${fixture}-bilingual.png`), fullPage: true, caret: 'initial' });
    await command(control, page, { type: 'page:mode', mode: 'translation' });
    for (const wrapper of await page.locator('[data-pl-source]').all()) await expect(wrapper).toBeHidden();
    if (fixture === 'arxiv') {
      await expect(page.locator('#original-math')).toBeVisible();
      await expect(page.locator('#code-block')).toHaveText('import torch\nmodel = torch.compile(model)\nprint("Do not translate this code")');
    }
    await command(control, page, { type: 'page:mode', mode: 'source' });
    for (const translation of await page.locator('[data-pl-owned="translation"]').all()) await expect(translation).toBeHidden();
    if (fixture === 'arxiv') {
      await page.locator('#paper-link').click();
      expect(await page.evaluate(() => (window as typeof window & { originalLinkClicks: number }).originalLinkClicks)).toBe(1);
    }
    await command(control, page, { type: 'page:mode', mode: 'bilingual' });
    expect(await page.locator('[data-pl-owned="translation"]').count()).toBe(count);
    expect(await page.evaluate(() => (window as typeof window & { originalElements: Element[] }).originalElements.every((element) => element.isConnected))).toBe(true);
    await command(control, page, { type: 'page:restore' });
    await expect(page.locator('[data-pl-owned], [data-pl-source]')).toHaveCount(0);
    expect(await page.locator('body').innerHTML()).toBe(before);
  });
}

test('X post translates the requested text visibly outside its clamp and ignores engagement updates', async ({ page, control }, testInfo) => {
  await configureApi(control);
  await page.goto('http://127.0.0.1:4317/x-post.html');
  await page.evaluate(() => history.replaceState({}, '', '/goyal__pramod/status/2106244243727507733'));
  const before = await page.locator('body').innerHTML();
  const originalText = await page.locator('#post-text').innerHTML();
  await command(control, page, { type: 'page:translate', mode: 'bilingual' });
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('completed');
  expect((await command(control, page, { type: 'page:status' })).total).toBe(1);
  const translation = page.locator('[data-pl-owned="translation"]');
  await expect(translation).toHaveCount(1);
  await expect(translation).toBeVisible();
  await expect(translation).toContainText('测试译文：Language models can use tools');
  await expect(page.locator('#post-text [data-pl-owned]')).toHaveCount(0);
  const sourceBounds = (await page.locator('#post-text').boundingBox())!;
  const translationBounds = (await translation.boundingBox())!;
  expect(translationBounds.y).toBeGreaterThanOrEqual(sourceBounds.y + sourceBounds.height);
  expect(await page.locator('#post-text').innerHTML()).toBe(originalText);
  await page.locator('#post-link').click();
  expect(await page.evaluate(() => (window as typeof window & { postLinkClicks: number }).postLinkClicks)).toBe(1);
  expect((await apiMetrics()).requests).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('x-post-bilingual.png') });
  await command(control, page, { type: 'page:mode', mode: 'source' });
  await expect(translation).toBeHidden();
  await command(control, page, { type: 'page:mode', mode: 'translation' });
  await expect(translation).toBeVisible();
  await expect(page.locator('#post-text')).toBeVisible();
  await command(control, page, { type: 'page:restore' });
  expect(await page.locator('body').innerHTML()).toBe(before);
  await command(control, page, { type: 'page:translate', mode: 'bilingual' });
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('completed');
  await page.evaluate(() => {
    document.getElementById('like-count')!.textContent = '13';
    document.querySelector('#long-reply p')!.textContent = 'An updated unrelated reply.';
    const richReply = document.createElement('div');
    richReply.dataset.testid = 'longformRichTextComponent';
    richReply.innerHTML = '<div class="longform-unstyled">An unrelated rich text reply.</div>';
    document.getElementById('long-reply')!.append(richReply);
  });
  await expect(translation).toBeVisible();
  expect((await command(control, page, { type: 'page:status' })).status).toBe('completed');
  await page.evaluate(() => { document.querySelector('#post-text span')!.textContent = 'The original post was edited.'; });
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('stale');
  await expect(translation).toHaveCount(0);
  await expect(page.locator('#post-text')).toContainText('The original post was edited.');
});

test('X article previews in the current page and translates rich text while preserving source parents', async ({ context, page, control }, testInfo) => {
  await configureApi(control);
  await page.goto('http://127.0.0.1:4317/x-article.html');
  const before = await page.locator('body').innerHTML();
  await page.evaluate(() => {
    (window as typeof window & { sourceNodes: { node: Node; parent: Node | null }[] }).sourceNodes =
      Array.from(document.querySelectorAll('#x-title,#x-rich-body [id]')).flatMap(element =>
        Array.from(element.childNodes).map(node => ({ node, parent: node.parentNode })));
  });
  await page.bringToFront();
  const opened = context.waitForEvent('page');
  await control.evaluate(() => chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/index.html'), active: false }));
  const popup = await opened;
  await expect(popup.getByRole('button', { name: '预览页面布局' })).toBeEnabled();
  await popup.getByRole('button', { name: '预览页面布局' }).click();
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('completed');
  const translations = page.locator('[data-pl-owned="translation"]');
  await expect(translations).toHaveCount(6);
  for (const translation of await translations.all()) {
    await expect(translation).toBeVisible();
    await expect(translation).toContainText('【布局预览】');
  }
  expect((await apiMetrics()).requests).toBe(0);
  const titleTranslation = page.locator('#x-title + [data-pl-owned="translation"]');
  await expect(titleTranslation).toHaveAttribute('role', 'heading');
  await expect(titleTranslation).toHaveAttribute('aria-level', '1');
  expect(await titleTranslation.evaluate(element => getComputedStyle(element).fontSize)).toBe(await page.locator('#x-title').evaluate(element => getComputedStyle(element).fontSize));
  await popup.close();
  await command(control, page, { type: 'page:restore' });
  expect(await page.locator('body').innerHTML()).toBe(before);
  await command(control, page, { type: 'page:translate', mode: 'bilingual' });
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('completed');
  await expect(translations).toHaveCount(6);
  for (const translation of await translations.all()) await expect(translation).toBeVisible();
  expect(await page.evaluate(() => (window as typeof window & { sourceNodes: { node: Node; parent: Node | null }[] }).sourceNodes.every(({ node, parent }) => node.isConnected && node.parentNode === parent))).toBe(true);
  await expect(page.locator('ul > [data-pl-owned]')).toHaveCount(0);
  await expect(page.locator('#x-code-only')).toContainText('Do not translate this code');
  expect((await apiMetrics()).requests).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('x-article-bilingual.png'), fullPage: true });
  await page.evaluate(() => { document.getElementById('article-engagement')!.textContent = '14 likes'; });
  await expect(translations).toHaveCount(6);
  expect((await command(control, page, { type: 'page:status' })).status).toBe('completed');
  await page.evaluate(() => { document.body.style.color = 'rgb(242, 242, 242)'; document.body.style.backgroundColor = 'rgb(21, 32, 43)'; });
  expect(await titleTranslation.evaluate(element => getComputedStyle(element).color)).toBe(await page.locator('#x-title').evaluate(element => getComputedStyle(element).color));
  await page.evaluate(() => { document.getElementById('article-engagement')!.textContent = '12 likes'; });
  await command(control, page, { type: 'page:restore' });
  expect(await page.locator('body').innerHTML()).toBe(before);
});

test('X post that has not loaded does not send unrelated replies to the API', async ({ page, control }) => {
  await configureApi(control);
  await page.goto('http://127.0.0.1:4317/x-post.html');
  await page.evaluate(() => {
    history.replaceState({}, '', '/goyal__pramod/status/2106244243727507733');
    document.getElementById('main-post')!.remove();
  });
  await command(control, page, { type: 'page:translate', mode: 'bilingual' });
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('error');
  expect((await command(control, page, { type: 'page:status' })).total).toBe(0);
  await expect(page.locator('[data-pl-owned="translation"]')).toHaveCount(0);
  expect((await apiMetrics()).requests).toBe(0);
});

test('X article finishes without scrolling during automatic layout, media and tab title updates', async ({ page, control }) => {
  await configureApi(control, 'slow-model');
  await page.goto('http://127.0.0.1:4317/x-article.html');
  await page.evaluate(() => {
    const media = document.createElement('div'); media.id = 'background-media';
    media.innerHTML = '<img alt="Article media"><span>Loading 0%</span>';
    document.getElementById('x-rich-body')!.append(media);
  });
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await command(control, page, { type: 'page:translate', mode: 'bilingual' });
  await expect(page.locator('[data-pl-owned="translation"]').first()).toBeVisible();
  await page.evaluate(() => {
    let revision = 0;
    (window as typeof window & { updateTimer: number }).updateTimer = window.setInterval(() => {
      revision++;
      const span = document.querySelector<HTMLElement>('#x-paragraph-1 > span')!;
      span.style.width = `${600 + revision}px`; span.className = `layout-${revision}`;
      span.dataset.renderRevision = String(revision);
      document.title = `(${revision}) Notifications / X`;
      document.querySelector('#background-media span')!.textContent = `Loading ${revision}%`;
    }, 50);
  });
  try {
    await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('completed');
    await expect(page.locator('[data-pl-owned="translation"]')).toHaveCount(6);
    expect((await command(control, page, { type: 'page:status' })).completed).toBe(6);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    const metrics = await apiMetrics() as Awaited<ReturnType<typeof apiMetrics>> & { attempts: Record<string, number> };
    expect(Object.values(metrics.attempts).every(count => count === 1)).toBe(true);
  } finally {
    await page.evaluate(() => clearInterval((window as typeof window & { updateTimer: number }).updateTimer));
  }
});

test('X article rebinds identical React source and recovers its worker without losing or duplicating translations', async ({ context, page, control }) => {
  await configureApi(control, 'slow-model');
  await page.goto('http://127.0.0.1:4317/x-article.html');
  await page.evaluate(() => {
    for (let i = 0; i < 15; i++) document.getElementById('x-rich-body')!.append(Object.assign(document.createElement('p'), { textContent: `Extra original paragraph ${i} for source rebinding.` }));
  });
  await command(control, page, { type: 'page:translate', mode: 'bilingual' });
  await expect(page.locator('[data-pl-owned="translation"]').first()).toBeVisible();
  await page.evaluate(() => {
    const reader = document.querySelector('[data-testid="twitterArticleReadView"]')!;
    const replacement = reader.cloneNode(true) as HTMLElement;
    for (const output of replacement.querySelectorAll('[data-pl-owned]')) output.remove();
    reader.replaceWith(replacement);
    (window as typeof window & { replacedTitle: HTMLElement; rebuiltLinkClicks: number }).replacedTitle = document.getElementById('x-title')!;
    (window as typeof window & { rebuiltLinkClicks: number }).rebuiltLinkClicks = 0;
    document.querySelector('#x-paragraph-1 a')!.addEventListener('click', event => {
      event.preventDefault(); (window as typeof window & { rebuiltLinkClicks: number }).rebuiltLinkClicks++;
    });
  });
  const session = await context.newCDPSession(control); await session.send('ServiceWorker.enable'); await session.send('ServiceWorker.stopAllWorkers');
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status, { timeout: 20000 }).toBe('completed');
  const state = await command(control, page, { type: 'page:status' });
  expect(state.completed).toBe(21); expect(state.total).toBe(21); expect(state.recoveries).toBeGreaterThan(0);
  await expect(page.locator('[data-pl-owned="translation"]')).toHaveCount(21);
  await expect(page.locator('#x-title + [data-pl-owned="translation"]')).toBeVisible();
  await page.locator('#x-paragraph-1 a').click();
  expect(await page.evaluate(() => (window as typeof window & { rebuiltLinkClicks: number }).rebuiltLinkClicks)).toBe(1);
  await command(control, page, { type: 'page:restore' });
  await expect(page.locator('[data-pl-owned], [data-pl-source]')).toHaveCount(0);
  expect(await page.evaluate(() => document.getElementById('x-title') === (window as typeof window & { replacedTitle: HTMLElement }).replacedTitle)).toBe(true);
});

test('popup offers a direct retry after actual X edits and can stop and retry the new task', async ({ context, page, control }) => {
  await configureApi(control, 'slow-model');
  await page.goto('http://127.0.0.1:4317/x-article.html');
  await page.bringToFront();
  const opened = context.waitForEvent('page');
  await control.evaluate(() => chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/index.html'), active: false }));
  const popup = await opened;
  await expect(popup.getByRole('button', { name: '翻译当前页面' })).toBeEnabled();
  await popup.getByRole('button', { name: '翻译当前页面' }).click();
  await expect(page.locator('[data-pl-owned="translation"]').first()).toBeVisible();
  await page.evaluate(() => { document.querySelector('#x-paragraph-1 span span')!.textContent = 'The host updated this original paragraph. '; });
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('stale');
  await expect(popup.getByRole('button', { name: '重新翻译', exact: true })).toBeEnabled();
  await expect(popup.getByRole('button', { name: '已停止', exact: true })).toBeDisabled();
  await popup.getByRole('button', { name: '重新翻译', exact: true }).click();
  await expect(page.locator('#x-title + [data-pl-owned="translation"]')).toBeVisible();
  await expect(popup.getByRole('button', { name: '停止', exact: true })).toBeEnabled();
  await popup.getByRole('button', { name: '停止', exact: true }).click();
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('cancelled');
  await expect(popup.getByRole('button', { name: '重新翻译', exact: true })).toBeEnabled();
  await popup.getByRole('button', { name: '重新翻译', exact: true }).click();
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('completed');
  await expect(page.locator('[data-pl-owned="translation"]')).toHaveCount(6);
  await expect(page.locator('#x-paragraph-1 + [data-pl-owned="translation"]')).toContainText('The host updated this original paragraph.');
  expect((await command(control, page, { type: 'page:status' })).metrics?.cacheHits).toBeGreaterThan(0);
  await popup.close();
});

test('stops, avoids duplicate injection, and ignores stale work after a SPA route change', async ({ page, control }) => {
  await page.goto('http://127.0.0.1:4317/technical-doc.html');
  await page.evaluate(() => {
    const article = document.querySelector('article')!;
    for (let index = 0; index < 100; index++) {
      const paragraph = document.createElement('p');
      paragraph.textContent = `Extra paragraph ${index} for cancellation testing.`;
      article.append(paragraph);
    }
  });
  await command(control, page, { type: 'page:preview', mode: 'bilingual' });
  await expect(page.locator('[data-pl-owned="translation"]').first()).toBeVisible();
  const stopped = await command(control, page, { type: 'page:stop' });
  expect(stopped.status).toBe('cancelled');
  const count = await page.locator('[data-pl-owned="translation"]').count();
  await page.waitForTimeout(250);
  expect(await page.locator('[data-pl-owned="translation"]').count()).toBe(count);
  expect(count).toBeGreaterThan(0);
  await command(control, page, { type: 'page:preview', mode: 'bilingual' });
  await expect(page.locator('[data-pl-owned="translation"]').first()).toBeVisible();
  await page.evaluate(() => {
    history.pushState({}, '', '/technical-doc.html?chapter=next');
    document.querySelector('article')!.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'A completely new chapter.' }));
  });
  await expect(page.locator('[data-pl-owned="translation"]')).toHaveCount(0);
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('idle');
  await page.waitForTimeout(300);
  await expect(page.locator('article')).toHaveText('A completely new chapter.');
  await expect(page.locator('[data-pl-owned="translation"]')).toHaveCount(0);
  await command(control, page, { type: 'page:preview', mode: 'bilingual' });
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('completed');
  await expect(page.locator('[data-pl-owned="translation"]')).toHaveCount(1);
});

test('marks edited source stale and preserves the host edit on restoration', async ({ page, control }) => {
  await page.goto('http://127.0.0.1:4317/technical-doc.html');
  await command(control, page, { type: 'page:preview', mode: 'translation' });
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('completed');
  await page.evaluate(() => { document.querySelector('#changing [data-pl-source]')!.firstChild!.textContent = 'Content updated by the host application.'; });
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('stale');
  await expect(page.locator('#changing')).toHaveText('Content updated by the host application.');
  await expect(page.locator('[data-pl-owned="translation"]')).toHaveCount(0);
});

test('persists React settings while blocking content script access to the key', async ({ control, page, extensionId }, testInfo) => {
  await control.getByLabel('Base URL').fill('https://api.example.com/v1');
  await control.getByLabel('API Key', { exact: true }).fill('local-test-secret');
  await control.getByLabel('Model', { exact: true }).fill('translation-model');
  await control.getByRole('button', { name: '添加术语' }).click();
  await control.getByLabel('术语原词', { exact: true }).fill('Transformer');
  await control.getByRole('button', { name: '添加或更新词条' }).click();
  await control.getByRole('button', { name: '保存设置' }).click();
  await expect(control.getByText('设置已保存在本地')).toBeVisible();
  await control.reload();
  await expect(control.getByLabel('Model', { exact: true })).toHaveValue('translation-model');
  await expect(control.getByLabel('API Key', { exact: true })).toHaveAttribute('type', 'password');
  await expect(control.locator('.glossary-table tbody tr')).toContainText('Transformer');
  await control.screenshot({ path: testInfo.outputPath('settings.png'), fullPage: true });
  await page.goto('http://127.0.0.1:4317/arxiv.html');
  const access = await control.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      func: async () => {
        try { return { readable: Boolean((await chrome.storage.local.get('settings')).settings) }; }
        catch { return { readable: false }; }
      },
    });
    return result.result;
  });
  expect(access).toEqual({ readable: false });
  const manifest = JSON.parse(readFileSync(path.join(extensionDist, 'manifest.json'), 'utf8'));
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.content_scripts).toBeUndefined();
  expect(extensionId).toBeTruthy();
});

test('selection preview treats HTML as text and cleans up on close', async ({ page, control }) => {
  await page.goto('http://127.0.0.1:4317/arxiv.html');
  const before = await page.locator('article').innerHTML();
  await command(control, page, { type: 'page:selection-preview', text: 'A <script>bad()</script> ⟦A0⟧ snippet.' });
  await expect(page.getByRole('dialog', { name: '选中内容布局预览' })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('【布局预览】A <script>bad()</script> ⟦A0⟧ snippet.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '复制预览', exact: true })).toBeEnabled();
  await expect(page.getByRole('dialog').locator('script')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('[data-pl-owned="selection"]')).toHaveCount(0);
  expect(await page.locator('article').innerHTML()).toBe(before);
});

test('popup page starts a preview and keeps it running after the UI closes', async ({ context, page, control }, testInfo) => {
  await page.goto('http://127.0.0.1:4317/technical-doc.html');
  await page.evaluate(() => {
    const article = document.querySelector('article')!;
    for (let index = 0; index < 70; index++) article.append(Object.assign(document.createElement('p'), { textContent: `Long page paragraph ${index}.` }));
  });
  await page.bringToFront();
  const opened = context.waitForEvent('page', { timeout: 5_000 });
  // Headless Chromium does not expose the native action bubble as a Playwright
  // Page. Open the same production popup in an inactive extension tab, so its
  // real tabs.query() still resolves the active article rather than itself.
  await control.evaluate(() => chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/index.html'), active: false }));
  const popup = await opened;
  await expect(popup.getByRole('button', { name: '预览页面布局' })).toBeEnabled();
  await popup.getByRole('button', { name: '预览页面布局' }).click();
  await expect(page.locator('[data-pl-owned="translation"]').first()).toBeVisible();
  await popup.screenshot({ path: testInfo.outputPath('popup.png'), caret: 'initial' });
  await popup.close();
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('completed');
  expect(await page.locator('[data-pl-owned="translation"]').count()).toBeGreaterThan(70);
});

test('tests a connection and translates through the background after the popup closes', async ({ context, page, control }) => {
  await configureApi(control);
  await control.getByRole('button', { name: '授权并测试连接' }).click();
  await expect(control.getByRole('status')).toContainText('连接成功');
  expect((await apiMetrics()).requests).toBe(1);
  await page.goto('http://127.0.0.1:4317/arxiv.html');
  const before = await page.locator('body').innerHTML();
  await page.bringToFront();
  const opened = context.waitForEvent('page');
  await control.evaluate(() => chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/index.html'), active: false }));
  const popup = await opened;
  await expect(popup.getByRole('button', { name: '翻译当前页面' })).toBeEnabled();
  await popup.getByRole('button', { name: '翻译当前页面' }).click();
  await expect(page.locator('[data-pl-owned="translation"]').first()).toContainText('测试译文');
  await popup.close();
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('completed');
  expect((await command(control, page, { type: 'page:status' })).execution).toBe('translation');
  expect((await apiMetrics()).requests).toBeGreaterThan(2);
  await expect(page.locator('#original-math')).toBeVisible();
  await command(control, page, { type: 'page:restore' });
  expect(await page.locator('body').innerHTML()).toBe(before);
});

test('stopping a real transport aborts the request and preserves completed translations', async ({ page, control }) => {
  await configureApi(control, 'cancellation-model');
  await page.goto('http://127.0.0.1:4317/technical-doc.html');
  await command(control, page, { type: 'page:translate', mode: 'bilingual' });
  await expect(page.locator('[data-pl-owned="translation"]').first()).toBeVisible();
  await expect.poll(async () => (await apiMetrics()).requests).toBe(2);
  const stopped = await command(control, page, { type: 'page:stop' });
  expect(stopped.status).toBe('cancelled');
  const count = await page.locator('[data-pl-owned="translation"]').count();
  await expect.poll(async () => (await apiMetrics()).aborted).toBe(1);
  await page.waitForTimeout(400);
  expect((await apiMetrics()).requests).toBe(2);
  expect(await page.locator('[data-pl-owned="translation"]').count()).toBe(count);
});

test('drops in-flight transport results when the host changes its article', async ({ page, control }) => {
  await configureApi(control, 'slow-model');
  await page.goto('http://127.0.0.1:4317/technical-doc.html');
  await command(control, page, { type: 'page:translate', mode: 'bilingual' });
  await expect.poll(async () => (await apiMetrics()).requests).toBe(1);
  await page.evaluate(() => { document.querySelector('article')!.textContent = 'A new article replaced the source.'; });
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('stale');
  await page.waitForTimeout(400);
  await expect(page.locator('[data-pl-owned="translation"]')).toHaveCount(0);
  await expect(page.locator('article')).toHaveText('A new article replaced the source.');
  expect((await apiMetrics()).requests).toBe(1);
});

test('refuses API use before the configured host has been authorized', async ({ page, control }) => {
  await configureApi(control);
  await control.getByLabel('Base URL').fill('http://localhost:4317/llm');
  await control.getByRole('button', { name: '保存设置' }).click();
  await expect(control.getByText('设置已保存在本地')).toBeVisible();
  await page.goto('http://127.0.0.1:4317/technical-doc.html');
  await expect(command(control, page, { type: 'page:translate', mode: 'bilingual' })).rejects.toThrow('尚未授权 API 服务');
  expect((await apiMetrics()).requests).toBe(0);
  await expect(page.locator('[data-pl-owned="translation"]')).toHaveCount(0);
});

test('rejects forged content-script commands and ungranted translation sessions', async ({ page, control }) => {
  await configureApi(control);
  await page.goto('http://127.0.0.1:4317/technical-doc.html');
  await command(control, page, { type: 'page:status' });
  const response = await control.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: async () => {
      const command = await chrome.runtime.sendMessage({ type: 'extension:command', tabId: 0, command: { type: 'page:translate', mode: 'bilingual' } }).catch(() => undefined);
      const session = await new Promise<{ type: string; error: string }>((resolve) => {
        const port = chrome.runtime.connect({ name: 'pagelingo:translation' });
        port.onMessage.addListener((value) => { resolve(value); port.disconnect(); });
        port.postMessage({ type: 'translation:start', sessionId: crypto.randomUUID(), document: {
          id: 'forged', blocks: [{ id: 'p1', kind: 'paragraph', content: [{ type: 'text', text: 'Unauthorized translation.' }] }],
        } });
      });
      return { commandAccepted: Boolean(command), session };
    } });
    return result.result;
  });
  if (!response) throw new Error('No content script result.');
  expect(response.commandAccepted).toBe(false);
  expect(response.session.type).toBe('translation:error');
  expect(response.session.error).toContain('未获授权');
  expect((await apiMetrics()).requests).toBe(0);
});

for (const model of ['broken-model', 'http-error-model']) {
  test(`preserves failed source on ${model} and shows a safe error`, async ({ page, control }) => {
    await configureApi(control, model);
    await page.goto('http://127.0.0.1:4317/arxiv.html');
    const before = await page.locator('body').innerHTML();
    await command(control, page, { type: 'page:translate', mode: 'translation' });
    await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status, { timeout: 20000 }).toBe(model === 'broken-model' ? 'partial' : 'error');
    const status = await command(control, page, { type: 'page:status' });
    expect(status.error).toBeTruthy();
    expect(status.error).not.toContain('local-test-secret');
    expect(status.failed).toBeGreaterThan(0);
    if (model === 'http-error-model') expect(status.completed).toBe(0);
    await command(control, page, { type: 'page:restore' });
    expect(await page.locator('body').innerHTML()).toBe(before);
  });
}

test('translates a selection through the background and renders HTML-looking text safely', async ({ page, control }) => {
  await configureApi(control);
  await page.goto('http://127.0.0.1:4317/arxiv.html');
  await command(control, page, { type: 'page:selection', text: 'A <script>bad()</script> ⟦A0⟧ snippet.' });
  const dialog = page.getByRole('dialog', { name: '选中内容翻译' });
  await expect(dialog.getByRole('button', { name: '复制译文', exact: true })).toBeEnabled();
  await expect(dialog.getByText('测试译文：A <script>bad()</script> ⟦A0⟧ snippet.', { exact: true })).toBeVisible();
  await expect(dialog.locator('script')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect((await apiMetrics()).requests).toBe(1);
});

test('shares a two-request limit across three tabs', async ({ context, page, control }) => {
  await configureApi(control, 'slow-model');
  const pages = [page, await context.newPage(), await context.newPage()];
  for (let i = 0; i < pages.length; i++) {
    await pages[i].goto(`http://127.0.0.1:4317/technical-doc.html?tab=${i}`);
    await pages[i].evaluate((index) => { document.querySelector('article')!.replaceChildren(...Array.from({ length: 9 }, (_, n) => Object.assign(document.createElement('p'), { textContent: `Tab ${index} paragraph ${n}.` }))); }, i);
  }
  await Promise.all(pages.map((p) => command(control, p, { type: 'page:translate', mode: 'bilingual' })));
  for (const p of pages) await expect.poll(async () => (await command(control, p, { type: 'page:status' })).status).toBe('completed');
  const metrics = await apiMetrics() as Awaited<ReturnType<typeof apiMetrics>> & { peak: number };
  expect(metrics.peak).toBe(2);
});

test('streams a slow response beyond worker idle timeout while keeping the task bounded', async ({ page, control }) => {
  test.setTimeout(65000);
  await configureApi(control, 'slow-stream-model');
  await control.locator('summary').filter({ hasText: '接口兼容设置' }).click();
  await control.getByLabel(/^响应方式/).selectOption('stream');
  await control.getByRole('button', { name: '保存设置' }).click();
  await expect(control.getByText('设置已保存在本地')).toBeVisible();
  await page.goto('http://127.0.0.1:4317/technical-doc.html');
  await page.evaluate(() => { document.querySelector('article')!.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'A single paragraph for a slowly streamed translation.' })); });
  await command(control, page, { type: 'page:translate', mode: 'bilingual' });
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status, { timeout: 45000 }).toBe('completed');
  expect((await apiMetrics()).requests).toBe(1);
  expect((await command(control, page, { type: 'page:status' })).metrics?.usageRequests).toBe(1);
});

test('reuses the complete page cache after reload and only translates three edited blocks out of one hundred', async ({ page, control }) => {
  await configureApi(control);
  await page.goto('http://127.0.0.1:4317/technical-doc.html');
  const prepare = async () => page.evaluate(() => {
    const article = document.querySelector('article')!;
    article.replaceChildren(...Array.from({ length: 100 }, (_, i) => Object.assign(document.createElement('p'), { textContent: `Unique paragraph ${i} for cache verification.` })));
  });
  await prepare();
  await command(control, page, { type: 'page:translate', mode: 'bilingual' });
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status, { timeout: 15000 }).toBe('completed');
  await page.reload(); await prepare();
  await fetch('http://127.0.0.1:4317/llm/reset', { method: 'POST' });
  await command(control, page, { type: 'page:translate', mode: 'bilingual' });
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('completed');
  expect((await apiMetrics()).requests).toBe(0);
  expect((await command(control, page, { type: 'page:status' }) as PageStatus & { metrics?: { cacheHits: number } }).metrics?.cacheHits).toBe(100);
  await command(control, page, { type: 'page:restore' });
  await page.evaluate(() => { for (const i of [5, 49, 99]) document.querySelectorAll('article p')[i].textContent += ' Revised content.'; });
  await command(control, page, { type: 'page:translate', mode: 'bilingual' });
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('completed');
  expect((await command(control, page, { type: 'page:status' }) as PageStatus & { metrics?: { cacheHits: number } }).metrics?.cacheHits).toBe(97);
  expect((await apiMetrics()).requests).toBeLessThanOrEqual(3);
  await control.getByRole('button', { name: '清理译文缓存', exact: true }).click();
  await expect(control.getByText('缓存已清理', { exact: false })).toBeVisible();
});

test('recovers from actual worker termination and applies checkpointed results exactly once', async ({ context, page, control }) => {
  await configureApi(control, 'slow-model');
  await page.goto('http://127.0.0.1:4317/technical-doc.html');
  await page.evaluate(() => { for (let i = 0; i < 15; i++) document.querySelector('article')!.append(Object.assign(document.createElement('p'), { textContent: `Worker recovery paragraph ${i}.` })); });
  await command(control, page, { type: 'page:translate', mode: 'bilingual' });
  await expect(page.locator('[data-pl-owned="translation"]').first()).toBeVisible();
  await expect.poll(async () => (await apiMetrics()).requests).toBeGreaterThanOrEqual(2);
  const session = await context.newCDPSession(control);
  await session.send('ServiceWorker.enable');
  await session.send('ServiceWorker.stopAllWorkers');
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status, { timeout: 20000 }).toBe('completed');
  const state = await command(control, page, { type: 'page:status' });
  expect((state as PageStatus & { recoveries?: number }).recoveries).toBeGreaterThan(0);
  expect(await page.locator('[data-pl-owned="translation"]').count()).toBe(state.total);
  expect(state.completed).toBe(state.total);
  const requests = (await apiMetrics()).requests;
  await page.waitForTimeout(300); expect((await apiMetrics()).requests).toBe(requests);
});

test('a duplicate resume cannot corrupt an already running authorized job', async ({ page, control }) => {
  await configureApi(control, 'slow-model');
  await page.goto('http://127.0.0.1:4317/technical-doc.html');
  await command(control, page, { type: 'page:translate', mode: 'bilingual' });
  await expect.poll(async () => (await apiMetrics()).requests).toBeGreaterThanOrEqual(1);
  const attempt = await control.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('pagelingo'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const jobs = await new Promise<Array<{ id: string; document: unknown; status: string }>>((resolve) => { const request = db.transaction('jobs').objectStore('jobs').getAll(); request.onsuccess = () => resolve(request.result); });
    db.close();
    const job = jobs.find((j) => j.status === 'running')!;
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id! }, args: [job.id, job.document], func: async (id, document) => {
      return new Promise<string>((resolve) => { const port = chrome.runtime.connect({ name: 'pagelingo:translation' }); port.onMessage.addListener((event) => { if (event.type === 'translation:error') { port.disconnect(); resolve(event.error); } }); port.postMessage({ type: 'translation:start', sessionId: id, document, resume: true }); });
    } });
    return result.result;
  });
  expect(attempt).toContain('无法接续');
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('completed');
});

for (const mutation of ['append', 'reorder', 'title', 'language'] as const) {
  test(`rejects recovery after full document ${mutation} changes`, async ({ context, page, control }) => {
    await configureApi(control, 'slow-model');
    await page.goto('http://127.0.0.1:4317/technical-doc.html');
    await command(control, page, { type: 'page:translate', mode: 'translation' });
    await expect(page.locator('[data-pl-owned="translation"]').first()).toBeVisible();
    const session = await context.newCDPSession(control); await session.send('ServiceWorker.enable'); await session.send('ServiceWorker.stopAllWorkers');
    await page.evaluate((kind) => {
      const article = document.querySelector('article')!;
      if (kind === 'append') article.append(Object.assign(document.createElement('p'), { textContent: 'A newly added paragraph.' }));
      if (kind === 'reorder') article.prepend(article.querySelector('p')!);
      if (kind === 'title') document.title += ' New context';
      if (kind === 'language') document.documentElement.lang = 'de';
    }, mutation);
    await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('stale');
    await expect(page.locator('[data-pl-owned="translation"]')).toHaveCount(0);
    const count = (await apiMetrics()).requests; await page.waitForTimeout(400); expect((await apiMetrics()).requests).toBe(count);
  });
}

test('restores the configured one MiB cache budget before saving recovered results', async ({ context, page, control }) => {
  await configureApi(control, 'slow-model');
  await control.getByLabel('缓存容量预算（MiB）').fill('1');
  await control.getByRole('button', { name: '保存设置' }).click(); await expect(control.getByText('设置已保存在本地')).toBeVisible();
  await page.goto('http://127.0.0.1:4317/technical-doc.html');
  await command(control, page, { type: 'page:translate', mode: 'bilingual' });
  await expect(page.locator('[data-pl-owned="translation"]').first()).toBeVisible();
  const session = await context.newCDPSession(control); await session.send('ServiceWorker.enable'); await session.send('ServiceWorker.stopAllWorkers');
  await control.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open('pagelingo'); request.onsuccess = () => resolve(request.result); });
    const tx = db.transaction('translations', 'readwrite');
    for (let i = 0; i < 5; i++) tx.objectStore('translations').put({ key: `capacity-seed-${i}`, schemaVersion: 1, text: 'x'.repeat(300000), bytes: 300256, createdAt: Date.now(), lastAccessedAt: 0 });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
  });
  await expect.poll(async () => (await command(control, page, { type: 'page:status' })).status).toBe('completed');
  const result = await control.evaluate(() => chrome.runtime.sendMessage({ type: 'extension:cache', action: 'stats' }));
  expect(result.value.bytes).toBeLessThanOrEqual(1024 * 1024);
});
