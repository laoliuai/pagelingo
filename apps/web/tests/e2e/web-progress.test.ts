import { test, expect } from '@playwright/test';
import { newReader, origin } from './library-helpers';
import { archive } from './web-helpers';
for (const contentMode of ['source', 'translation', 'bilingual']) test(`passive ${contentMode} restore does not write progress or start a model job`, async ({ page }) => {
  await newReader(page, `web-${contentMode}`); const value = await archive(page, '<article><h1>保存位置</h1>' + Array.from({ length: 260 }, (_, i) => `<p>归档段落 ${i}，这是保存在服务器的原文。</p>`).join('') + '</article>');
  const descriptor = await (await page.request.get(`/api/v1/documents/${value.documentId}/web-reader`)).json();
  const blockId = descriptor.index.chunks[1].blockIds[10];
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const position = { readerVersionId: descriptor.versionId, sourceVersionId: descriptor.source.sourceVersionId, parseId: descriptor.parseId, blockId, blockOffset: 0.25, view: 'content', contentMode };
  expect((await page.request.put(`/api/v1/documents/${value.documentId}/web-progress`, { headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken }, data: { expectedRevision: 0, position } })).status()).toBe(200);
  let puts = 0, jobs = 0; page.on('request', request => { if (request.method() === 'PUT' && request.url().includes('/web-progress')) puts++; if (request.method() === 'POST' && request.url().includes('/web-jobs')) jobs++; });
  await page.goto(`/library/${value.documentId}`); await expect(page.getByLabel('正文模式', { exact: true })).toHaveValue(contentMode);
  await expect(page.locator(`[data-block-id="${blockId}"]`)).toBeVisible();
  await page.waitForTimeout(1800); expect(puts).toBe(0); expect(jobs).toBe(0);
  expect(await page.getByLabel('正文，可独立滚动').evaluate((element, id) => { const block = element.querySelector(`[data-block-id="${id}"]`)!; return Math.abs((element.getBoundingClientRect().top - block.getBoundingClientRect().top) / block.getBoundingClientRect().height - 0.25); }, blockId)).toBeLessThan(0.03);
});
test('Web progress conflict requires explicit continue and uses Web-only coordinates', async ({ page }) => {
  await newReader(page, 'web-conflict'); const value = await archive(page);
  await page.goto(`/library/${value.documentId}`); await expect(page.getByLabel('正文，可独立滚动')).toContainText('这是已经归档');
  const descriptor = await (await page.request.get(`/api/v1/documents/${value.documentId}/web-reader`)).json();
  const position = { readerVersionId: descriptor.versionId, sourceVersionId: descriptor.source.sourceVersionId, parseId: descriptor.parseId, blockId: null, blockOffset: 0, view: 'content', contentMode: 'source' };
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  await page.request.put(`/api/v1/documents/${value.documentId}/web-progress`, { headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken }, data: { expectedRevision: 0, position } });
  await page.getByLabel('正文模式', { exact: true }).selectOption('bilingual');
  await expect(page.getByRole('alert')).toContainText('其他设备');
  await page.getByRole('button', { name: '从当前位置继续' }).click();
  await expect.poll(async () => (await (await page.request.get(`/api/v1/documents/${value.documentId}/web-progress`)).json()).revision).toBe(2);
  const saved = await (await page.request.get(`/api/v1/documents/${value.documentId}/web-progress`)).json();
  expect(saved.position.contentMode).toBe('bilingual'); expect(saved.position).not.toHaveProperty('pdfPageIndex');
});
test('mobile and desktop themes retain useful body with source fallback, conflict and collapsed warnings', async ({ page }, testInfo) => {
  const { capture } = await import('../../../document-service/tests/helpers/web-capture'); const { uploadArchive } = await import('./web-helpers');
  await newReader(page, 'web-layout'); const old = await archive(page, '<article><p>旧版本的唯一原始段落。</p></article>');
  const previous = await (await page.request.get(`/api/v1/documents/${old.documentId}/web-reader`)).json();
  const session = await (await page.request.get('/api/v1/auth/session')).json(); const headers = { Origin: origin, 'X-CSRF-Token': session.csrfToken };
  const oldPosition = { readerVersionId: previous.versionId, sourceVersionId: previous.source.sourceVersionId, parseId: previous.parseId, blockId: Object.keys(previous.index.blockLocations)[0], blockOffset: 0, view: 'content', contentMode: 'source' };
  await page.request.put(`/api/v1/documents/${old.documentId}/web-progress`, { headers, data: { expectedRevision: 0, position: oldPosition } });
  const fixture = capture('<article><h1>让知识留在身边</h1><p>保存原文，慢慢理解。每一次阅读的位置都属于当前账号，来源和译文各自保留。</p><p>新来源无法唯一对应旧段落时，我们从起点开始，旧版本仍可回看。</p><pre>' + 'a_long_local_code_line'.repeat(40) + '</pre><table><tr><th>项目</th><th>阅读目标</th></tr><tr><td>归档</td><td>长文本与结构内容只在表格区域内横向滚动</td></tr></table><img src="https://example.com/unavailable.png" alt="未保存的插图"></article>'); fixture.manifest.metadata.title = '让知识留在身边';
  const newer = await uploadArchive(page, fixture, old.documentId);
  await page.goto(`/library/${old.documentId}?versionId=${newer.readerVersionId}`);
  await expect(page.getByText('来源已更新', { exact: false })).toBeVisible();
  const descriptor = await (await page.request.get(`/api/v1/documents/${old.documentId}/web-reader?versionId=${newer.readerVersionId}`)).json();
  expect(newer.readerVersionId).toBe(descriptor.versionId);
  await page.request.put(`/api/v1/documents/${old.documentId}/web-progress`, { headers, data: { expectedRevision: 1, position: { ...oldPosition, readerVersionId: descriptor.versionId, sourceVersionId: descriptor.source.sourceVersionId, parseId: descriptor.parseId, blockId: null } } });
  await page.getByLabel('正文模式', { exact: true }).selectOption('bilingual'); await expect(page.getByRole('alert')).toContainText('其他设备');
  const body = page.getByLabel('正文，可独立滚动');
  for (const mobile of [false, true]) for (const theme of ['light','dark']) {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.evaluate(() => window.scrollTo(0,0));
    const visibleTextHeight = await body.evaluate(node => { const rect = node.getBoundingClientRect(); return Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)); });
    expect(visibleTextHeight).toBeGreaterThanOrEqual(240);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: process.env.PAGELINGO_CAPTURE_S3_WEB === '1' ? `../../docs/superpowers/specs/assets/2026-10-27-s3-validation/web-reader-${mobile ? 'mobile' : 'desktop'}-${theme}.png` : testInfo.outputPath(`web-reader-${mobile ? 'mobile' : 'desktop'}-${theme}.png`), fullPage: true });
  }
  await expect(body.locator('pre')).toHaveCSS('overflow-x','auto');
  await expect(body.locator('.reader-table')).toHaveCSS('overflow-x','auto');
});

test('a slow successful save preserves the first unsent deadline during continuous input without overlapping PUTs', async ({ page }) => {
  await newReader(page, 'web-slowack'); const result = await archive(page); const id = result.documentId;
  await page.goto(`/library/${id}`); await expect(page.getByLabel('正文，可独立滚动')).toContainText('这是已经归档');
  const progress = async (_page: unknown, id: string) => (await page.request.get(`/api/v1/documents/${id}/web-progress`)).json();
  const start = new Date('2026-10-27T12:00:00.000Z');
  await page.clock.install({ time: start }); await page.clock.pauseAt(start);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let firstCommitted = false; let firstReleased = false; let overlap = false;
  const requests: { at: number; mode: string; expectedRevision: number }[] = [];
  await page.route('**/web-progress', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    const body = route.request().postDataJSON();
    const at = await page.evaluate(() => Date.now());
    requests.push({ at: at - start.getTime(), mode: body.position.contentMode, expectedRevision: body.expectedRevision });
    if (requests.length > 1 && !firstReleased) overlap = true;
    const response = await route.fetch();
    if (requests.length === 1) { firstCommitted = true; await held; firstReleased = true; }
    await route.fulfill({ response }).catch(() => {});
  });
  let mode = 'translation'; await page.getByLabel('正文模式').selectOption(mode);
  await page.clock.runFor(1500); await expect.poll(() => firstCommitted).toBe(true);
  expect(requests).toEqual([{ at: 1500, mode: 'translation', expectedRevision: 0 }]);
  for (const at of [1600, 2100, 2600, 3100, 3600, 4100]) {
    const current = await page.evaluate(() => Date.now()); await page.clock.runFor(start.getTime() + at - current);
    mode = mode === 'source' ? 'translation' : 'source'; await page.getByLabel('正文模式').selectOption(mode);
  }
  expect(requests).toHaveLength(1); const ack = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/web-progress')); release(); await ack;
  for (const at of [4600, 5100, 5600, 6100, 6500]) {
    const current = await page.evaluate(() => Date.now()); await page.clock.runFor(start.getTime() + at - current);
    mode = mode === 'source' ? 'translation' : 'source'; await page.getByLabel('正文模式').selectOption(mode);
  }
  await page.clock.runFor(100);
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual({ at: 6600, mode: 'source', expectedRevision: 1 });
  expect(overlap).toBe(false);
  await expect.poll(async () => (await progress(page, id))?.revision).toBe(2);
});

test('a late Web save acknowledgement cannot restore the old account after logout', async ({ page }) => {
  const { login } = await import('./library-helpers'); const owner = await newReader(page, 'web-late'); const value = await archive(page);
  await page.goto(`/library/${value.documentId}`); await expect(page.getByLabel('正文，可独立滚动')).toContainText('这是已经归档');
  let release!: () => void, committed = false; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/web-progress', async route => { if (route.request().method() !== 'PUT') return route.continue(); const response = await route.fetch(); committed = true; await gate; await route.fulfill({ response }).catch(() => {}); });
  await page.getByLabel('正文模式', { exact: true }).selectOption('bilingual'); await expect.poll(() => committed).toBe(true);
  await page.getByRole('button', { name: '退出登录', exact: true }).click(); await login(page); release(); await page.unrouteAll({ behavior: 'wait' });
  await expect(page.getByRole('region', { name: '网页阅读器', exact: true })).toHaveCount(0);
  expect((await page.request.get(`/api/v1/documents/${value.documentId}/web-progress`)).status()).toBe(404);
  await page.getByRole('button', { name: '退出登录', exact: true }).click(); await login(page, owner, 'reader-password-1');
  const saved = await (await page.request.get(`/api/v1/documents/${value.documentId}/web-progress`)).json(); expect(saved.revision).toBe(1); expect(saved.position.contentMode).toBe('bilingual');
});
test('Web library continuation links to the server-resolved reading version', async ({ page }) => {
  const value = await (async () => { await newReader(page, 'web-continue'); return archive(page); })();
  await page.goto(`/library/${value.documentId}`);
  let release!: () => void, emptyRead = false, committed = false; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/web-progress', async route => {
    if (route.request().method() !== 'PUT') { const response = await route.fetch(); emptyRead ||= await response.json() === null; return route.fulfill({ response }); }
    await gate; const response = await route.fetch(); committed = true; await route.fulfill({ response });
  });
  await page.getByLabel('正文模式', { exact: true }).selectOption('bilingual');
  await page.getByRole('link', { name: '← 返回资料库', exact: true }).click();
  try { await expect.poll(() => emptyRead).toBe(true); } finally { release(); }
  await expect.poll(() => committed).toBe(true);
  expect((await (await page.request.get(`/api/v1/documents/${value.documentId}/web-progress`)).json()).position.contentMode).toBe('bilingual');
  await expect(page.getByRole('link', { name: '继续阅读', exact: true })).toHaveAttribute('href', `/library/${value.documentId}?versionId=${value.readerVersionId}`);
});
test('another browser explicitly restores a historical Web version without rewriting its retained position', async ({ page, browser }) => {
  const { login } = await import('./library-helpers'); const { capture } = await import('../../../document-service/tests/helpers/web-capture'); const { uploadArchive } = await import('./web-helpers');
  const owner = await newReader(page, 'web-history'); const first = await archive(page, '<article><p>历史原文段落，保留原来的阅读位置。</p><p>历史第二段。</p></article>');
  const descriptor = await (await page.request.get(`/api/v1/documents/${first.documentId}/web-reader`)).json();
  const session = await (await page.request.get('/api/v1/auth/session')).json(); const headers = { Origin: origin, 'X-CSRF-Token': session.csrfToken };
  const position = { readerVersionId: descriptor.versionId, sourceVersionId: descriptor.source.sourceVersionId, parseId: descriptor.parseId, blockId: descriptor.index.chunks[0].blockIds[0], blockOffset: 0.4, view: 'content', contentMode: 'bilingual' };
  expect((await page.request.put(`/api/v1/documents/${first.documentId}/web-progress`, { headers, data: { expectedRevision: 0, position } })).status()).toBe(200);
  const second = await uploadArchive(page, capture('<article><p>全新的来源内容，旧版本仍然可以选择。</p></article>'), first.documentId);
  expect(second.readerVersionId).not.toBe(first.readerVersionId);
  const context = await browser.newContext(); const other = await context.newPage();
  try {
    await login(other, owner, 'reader-password-1'); let puts = 0; other.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith('/web-progress')) puts++; });
    await other.goto(`/library/${first.documentId}?versionId=${first.readerVersionId}`);
    await expect(other.getByLabel('正文模式', { exact: true })).toHaveValue('bilingual'); await expect(other.getByLabel('正文，可独立滚动')).toContainText('历史原文段落');
    await other.waitForTimeout(1700); expect(puts).toBe(0);
    expect(await other.getByLabel('正文，可独立滚动').evaluate((element, id) => { const block = element.querySelector(`[data-block-id="${id}"]`)!; return Math.abs((element.getBoundingClientRect().top - block.getBoundingClientRect().top) / block.getBoundingClientRect().height - 0.4); }, position.blockId)).toBeLessThan(0.03);
    expect((await (await other.request.get(`/api/v1/documents/${first.documentId}/web-progress?versionId=${first.readerVersionId}`)).json()).position).toEqual(position);
  } finally { await context.close(); }
});
