import { test, expect, type Page } from '@playwright/test';
import type { ReadingProgress } from '@pagelingo/document-contracts';
import { resolvePosition } from '../../src/features/reader/resolve-position';
import { capture, login, newReader, origin } from './library-helpers';
import { ingest, readingBundle } from './bundle-helpers';
import { readerBundle, blockId, mobileReadingGeometry } from './reader-helpers';

async function progress(page: Page, id: string) {
  return (await page.request.get(`/api/v1/documents/${id}/progress`)).json();
}
async function open(page: Page, id: string, version?: string) {
  await page.goto(`/library/${id}${version ? `?versionId=${version}` : ''}`);
  await expect(page.getByRole('region', { name: '阅读器', exact: true })).toBeVisible();
  await expect(page.locator('[data-reader-chunk]').first()).toBeAttached();
}
async function nextPdf(page: Page) {
  await page.getByLabel('阅读视图').selectOption('source');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
}

test('user reading saves after debounce; another device restores block offset and physical page without PUT or models', async ({ page, browser }) => {
  const username = await newReader(page, 'progress'); const bundle = await readerBundle(false, false, '译文 ', { longParagraph: true });
  const result = await ingest(page, bundle); const id = result.documentId;
  const metrics = await (await page.request.get('/__test/metrics')).json();
  await open(page, id); await page.waitForTimeout(1700); expect(await progress(page, id)).toBeNull();
  const content = page.locator('.reader-content'); await content.hover(); await page.mouse.wheel(0, 1);
  await content.evaluate((element, id) => { const block = element.querySelector<HTMLElement>(`[data-block-id="${id}"]`)!; element.scrollTop += block.getBoundingClientRect().top - element.getBoundingClientRect().top + block.getBoundingClientRect().height * 0.35; }, blockId(2));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await nextPdf(page);
  await expect.poll(async () => (await progress(page, id))?.revision).toBe(1);
  const saved = await progress(page, id); expect(saved.position.pdfPageIndex).toBe(1); expect(saved.position.blockId).toBe(blockId(2)); expect(saved.position.blockOffset).toBeGreaterThan(0.3); expect(saved.position.blockOffset).toBeLessThan(0.4);
  const context = await browser.newContext(); const device = await context.newPage();
  await login(device, username, 'reader-password-1');
  const writes: string[] = []; device.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith('/progress')) writes.push(request.url()); });
  await device.goto(`/library/${id}`);
  await expect(device.getByLabel('阅读视图')).toHaveValue('source');
  await expect(device.getByRole('img', { name: 'PDF 第 2 页' })).toHaveAttribute('data-rendered', 'true');
  await device.setViewportSize({ width: 1360, height: 900 });
  await device.getByLabel('正文字号').selectOption('large'); await device.getByLabel('正文字号').selectOption('normal');
  await device.setViewportSize({ width: 1280, height: 720 });
  await device.waitForTimeout(1800); expect(writes).toEqual([]);
  expect((await progress(device, id)).position).toEqual(saved.position);
  await device.getByLabel('阅读视图').selectOption('content');
  await expect(device.locator(`[data-block-id="${saved.position.blockId}"]`)).toBeAttached();
  const offset = await device.locator('.reader-content').evaluate((element, id) => {
    const block = element.querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;
    return Math.max(0, (element.getBoundingClientRect().top - block.getBoundingClientRect().top) / block.getBoundingClientRect().height);
  }, saved.position.blockId);
  expect(Math.abs(offset - saved.position.blockOffset), JSON.stringify({ saved: saved.position, offset, geometry: await device.locator('.reader-content').evaluate(el => ({ top: el.scrollTop, height: el.clientHeight, scrollHeight: el.scrollHeight })) })).toBeLessThan(0.03);
  expect((await (await device.request.get('/__test/metrics')).json()).modelCalls).toBe(metrics.modelCalls);
  await context.close();
});

test('two tabs freeze on CAS conflict until explicit continue uses fresh global revision', async ({ page, context }) => {
  await newReader(page, 'conflict'); const result = await ingest(page, await readerBundle()); const id = result.documentId;
  await open(page, id); const other = await context.newPage(); await open(other, id);
  await nextPdf(page); await expect.poll(async () => (await progress(page, id))?.revision).toBe(1);
  await nextPdf(other); await expect(other.getByRole('button', { name: '从当前位置继续', exact: true })).toBeVisible();
  await other.getByRole('button', { name: '下一页', exact: true }).click(); await other.waitForTimeout(1800);
  expect((await progress(page, id)).revision).toBe(1);
  await other.getByRole('button', { name: '从当前位置继续', exact: true }).click();
  await expect.poll(async () => (await progress(page, id))?.revision).toBe(2);
  expect((await progress(page, id)).position.pdfPageIndex).toBe(2);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByRole('button', { name: '从当前位置继续', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 }); await capture(page, 's2-progress-conflict-desktop-light');
  await page.getByRole('button', { name: '切换明暗主题' }).click(); await capture(page, 's2-progress-conflict-desktop-dark');
  await page.setViewportSize({ width: 390, height: 844 }); await capture(page, 's2-progress-conflict-mobile-dark');
  await page.getByRole('button', { name: '切换明暗主题' }).click(); await capture(page, 's2-progress-conflict-mobile-light');
  await other.close();
});

test('new current falls back by physical page; historical positions resume explicitly with fresh global CAS', async ({ page }) => {
  test.setTimeout(60000);
  await newReader(page, 'versions');
  const first = await ingest(page, await readerBundle(false, false, '旧译文 ')); const id = first.documentId;
  await open(page, id); await nextPdf(page);
  await expect.poll(async () => (await progress(page, id))?.revision).toBe(1);
  const old = await progress(page, id);
  const second = await ingest(page, await readerBundle(false, false, '新解析 ', { newParse: true }));
  await page.goto(`/library/${id}`); await expect(page.getByLabel('阅读版本')).toHaveValue(second.readerVersionId);
  await expect(page.getByText(/版本已更新，已定位到原页/)).toBeVisible();
  await expect(page.getByRole('img', { name: 'PDF 第 2 页' })).toHaveAttribute('data-rendered', 'true');
  await page.waitForTimeout(1700); expect(await progress(page, id)).toEqual(old);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect.poll(async () => (await progress(page, id))?.revision).toBe(2);
  await page.getByLabel('阅读版本').selectOption(first.readerVersionId);
  await expect(page.getByRole('img', { name: 'PDF 第 2 页' })).toHaveAttribute('data-rendered', 'true');
  await page.waitForTimeout(1700); expect((await progress(page, id)).revision).toBe(2);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect.poll(async () => (await progress(page, id))?.revision).toBe(3);
  expect((await progress(page, id)).position.readerVersionId).toBe(first.readerVersionId);
  await page.getByRole('link', { name: '← 返回资料库' }).click();
  const continuation = page.getByRole('link', { name: '继续上次阅读', exact: true });
  await expect(continuation).toHaveAttribute('href', `/library/${id}?versionId=${first.readerVersionId}`);
  await page.setViewportSize({ width: 1440, height: 1000 }); await capture(page, 's2-progress-library-desktop-light');
  await page.getByRole('button', { name: '切换明暗主题' }).click(); await capture(page, 's2-progress-library-desktop-dark');
  await page.setViewportSize({ width: 390, height: 844 }); await capture(page, 's2-progress-library-mobile-dark');
  await page.getByRole('button', { name: '切换明暗主题' }).click(); await capture(page, 's2-progress-library-mobile-light');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await continuation.click(); await expect(page.getByLabel('阅读版本')).toHaveValue(first.readerVersionId);
  await page.getByLabel('阅读版本').selectOption(''); await expect(page.getByLabel('阅读版本')).toHaveValue(second.readerVersionId);
  const third = await ingest(page, await readerBundle(false, false, '待处理 ', { pending: true }));
  await page.reload(); await expect(page.getByLabel('阅读版本')).toHaveValue(second.readerVersionId);
  await page.getByLabel('阅读版本').selectOption(third.readerVersionId);
  await expect(page.getByText('原文可读，译文待处理', { exact: true })).toBeVisible();
  await page.getByLabel('正文语言').selectOption('source'); await page.waitForTimeout(1700);
  expect((await progress(page, id)).position.readerVersionId).toBe(third.readerVersionId);
});

test('rapid reading coalesces the last position and continuous reading saves within five seconds', async ({ page }) => {
  test.setTimeout(45000);
  await newReader(page, 'timing'); const result = await ingest(page, await readerBundle()); const id = result.documentId;
  await open(page, id); await page.getByLabel('阅读视图').selectOption('source');
  const requests: { at: number; body: any }[] = [];
  page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith('/progress')) requests.push({ at: Date.now(), body: request.postDataJSON() }); });
  for (let i = 0; i < 5; i++) {
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await page.getByRole('button', { name: '上一页', exact: true }).click();
  }
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.waitForTimeout(1000); expect(requests).toHaveLength(0);
  await expect.poll(async () => (await progress(page, id))?.revision).toBe(1);
  expect(requests).toHaveLength(1); expect(requests[0].body.position.pdfPageIndex).toBe(1);
  const started = Date.now();
  for (let i = 0; i < 10; i++) {
    await page.getByLabel('正文语言').selectOption(i % 2 ? 'translation' : 'source');
    await page.waitForTimeout(550);
  }
  expect(requests.length).toBeGreaterThanOrEqual(2);
  expect(requests[1].at - started).toBeLessThan(5500);
  await expect.poll(async () => (await progress(page, id))?.position.contentMode).toBe('translation');
});

test('delayed stale tab request cannot overwrite an acknowledged position and late responses cannot revive a switched version', async ({ page, context }) => {
  await newReader(page, 'progressrace'); const first = await ingest(page, await readerBundle()); const id = first.documentId;
  const second = await ingest(page, await readerBundle(false, false, '第二版本 '));
  await open(page, id, first.readerVersionId); const other = await context.newPage(); await open(other, id, second.readerVersionId);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let started = false;
  await page.route('**/progress', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    started = true; await gate;
    const response = await route.fetch(); await route.fulfill({ response }).catch(() => {});
  });
  await nextPdf(page); await expect.poll(() => started).toBe(true);
  await nextPdf(other); await expect.poll(async () => (await progress(other, id))?.revision).toBe(1);
  const acknowledged = await progress(other, id); release();
  await expect(page.getByRole('button', { name: '从当前位置继续', exact: true })).toBeVisible();
  expect(await progress(other, id)).toEqual(acknowledged);
  await page.getByLabel('阅读版本').selectOption(second.readerVersionId);
  await expect(page.locator('.reader-content')).toContainText('第二版本');
  await page.waitForTimeout(1700); expect(await progress(other, id)).toEqual(acknowledged);
  await other.close();
});

test('exit flushes only pending user position and logout/account switch discards late save acknowledgement', async ({ page }) => {
  const username = await newReader(page, 'exitprogress'); const result = await ingest(page, await readerBundle()); const id = result.documentId;
  await open(page, id); await nextPdf(page); await page.getByRole('link', { name: '← 返回资料库' }).click();
  await expect.poll(async () => (await progress(page, id))?.revision).toBe(1);
  await open(page, id);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let saved = false;
  await page.route('**/progress', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    const response = await route.fetch(); saved = true; await gate; await route.fulfill({ response }).catch(() => {});
  });
  await page.getByRole('button', { name: '下一页', exact: true }).click(); await expect.poll(() => saved).toBe(true);
  await page.getByRole('button', { name: '退出登录', exact: true }).click(); await expect(page).toHaveURL(/\/login$/);
  await login(page); release(); await page.unrouteAll({ behavior: 'wait' });
  await expect(page.locator('.native-reader')).toHaveCount(0); await expect(page.getByText('阅读位置已保存')).toHaveCount(0);
  expect((await page.request.get(`/api/v1/documents/${id}/progress`)).status()).toBe(404);
  await page.getByRole('button', { name: '退出登录', exact: true }).click(); await login(page, username, 'reader-password-1');
  expect((await progress(page, id)).revision).toBe(2);
});

test('revoked password interrupts pending saves and does not revive old reader state', async ({ page, browser }) => {
  await newReader(page, 'resetprogress'); const result = await ingest(page, await readerBundle()); const id = result.documentId;
  const reader = await (await page.request.get('/api/v1/auth/session')).json(); await open(page, id);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let started = false;
  await page.route('**/progress', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    started = true; await gate; const response = await route.fetch(); await route.fulfill({ response }).catch(() => {});
  });
  await nextPdf(page); await expect.poll(() => started).toBe(true);
  const adminContext = await browser.newContext({ baseURL: origin }); const admin = await adminContext.newPage(); await login(admin);
  const session = await (await admin.request.get('/api/v1/auth/session')).json();
  expect((await admin.request.post(`/api/v1/admin/users/${reader.user.id}/reset-password`, { headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken }, data: { newPassword: 'reset-reader-password' } })).status()).toBe(204);
  release(); await expect(page).toHaveURL(/\/login$/); await expect(page.locator('.native-reader')).toHaveCount(0);
  await expect(page.getByText('阅读位置已保存')).toHaveCount(0); await adminContext.close();
});


test('Chinese source-only reopen and missing-chunk retry are passive and make no model calls', async ({ page }) => {
  await newReader(page, 'chineserestore'); const result = await ingest(page, await readingBundle('chinese')); const id = result.documentId;
  const before = await (await page.request.get('/__test/metrics')).json(); let writes = 0; let fail = true;
  page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith('/progress')) writes++; });
  await page.route('**/chunks/c_000001', async route => {
    if (fail) { fail = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE' } }) }); }
    else await route.continue();
  });
  await page.goto(`/library/${id}`); await page.getByRole('button', { name: '重试正文', exact: true }).click();
  await expect(page.locator('.reader-content')).toContainText('这是一份中文文档');
  await page.waitForTimeout(1700); expect(writes).toBe(0); expect(await progress(page, id)).toBeNull();
  await page.reload(); await expect(page.locator('.reader-content')).toContainText('这是一份中文文档');
  await page.waitForTimeout(1700); expect(writes).toBe(0);
  expect((await (await page.request.get('/__test/metrics')).json()).modelCalls).toBe(before.modelCalls);
});

test('a committed response arriving after version switch or page close cannot restore old state', async ({ page, context }) => {
  await newReader(page, 'ackrace'); const first = await ingest(page, await readerBundle()); const id = first.documentId;
  const second = await ingest(page, await readerBundle(false, false, '当前译文 '));
  await open(page, id, first.readerVersionId);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let committed = false;
  await page.route('**/progress', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    const response = await route.fetch(); committed = true; await gate; await route.fulfill({ response }).catch(() => {});
  });
  await nextPdf(page); await expect.poll(() => committed).toBe(true);
  await page.getByLabel('阅读版本').selectOption(second.readerVersionId);
  await expect(page.getByLabel('阅读版本')).toHaveValue(second.readerVersionId);
  release(); await page.unrouteAll({ behavior: 'wait' });
  await expect(page.getByRole('img', { name: 'PDF 第 2 页' })).toHaveAttribute('data-rendered', 'true');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect.poll(async () => (await progress(page, id))?.revision).toBe(2);
  expect((await progress(page, id)).position.readerVersionId).toBe(second.readerVersionId);
  const closing = await context.newPage(); await open(closing, id, first.readerVersionId);
  let releaseClose!: () => void; const closeGate = new Promise<void>(resolve => { releaseClose = resolve; }); let closeCommitted = false;
  await closing.route('**/progress', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    const response = await route.fetch(); closeCommitted = true; await closeGate; await route.fulfill({ response }).catch(() => {});
  });
  await closing.getByRole('button', { name: '下一页', exact: true }).click(); await expect.poll(() => closeCommitted).toBe(true);
  const acknowledged = await progress(page, id); expect(acknowledged.revision).toBe(3);
  await closing.close(); releaseClose(); await page.waitForTimeout(1700);
  expect(await progress(page, id)).toEqual(acknowledged);
  await expect(page.getByLabel('阅读版本')).toHaveValue(second.readerVersionId);
});


test('position resolver retains valid block offsets and falls back by physical page without inventing a block', async () => {
  const { build } = await readerBundle();
  const saved: ReadingProgress = { revision: 4, updatedAt: '2026-10-27T00:00:00.000Z', position: {
    readerVersionId: '00000000-0000-4000-8000-000000000001', sourceVersionId: '00000000-0000-4000-8000-000000000002',
    parseId: build.index.parseId, blockId: blockId(2), blockOffset: 0.35, pdfPageIndex: 2, view: 'split', contentMode: 'translation',
  } };
  expect(resolvePosition(build.index, saved)).toEqual({ chunkId: 'c_000001', blockId: blockId(2), blockOffset: 0.35, pdfPageIndex: 2 });
  saved.position.blockId = blockId(999);
  expect(resolvePosition(build.index, saved)).toEqual({ chunkId: 'c_000002', blockId: null, blockOffset: 0, pdfPageIndex: 2, fallbackReason: 'version-updated-source-page' });
  saved.position.blockId = null;
  expect(resolvePosition(build.index, saved)).toEqual({ chunkId: 'c_000002', blockId: null, blockOffset: 0, pdfPageIndex: 2 });
});

test('PDF-only actual scrolling saves its physical page while passive PDF scroll stays read-only', async ({ page }) => {
  await newReader(page, 'pdfscrollprogress'); const result = await ingest(page, await readerBundle()); const id = result.documentId;
  await open(page, id); await page.getByLabel('阅读视图').selectOption('source');
  await expect.poll(async () => (await progress(page, id))?.revision).toBe(1);
  await page.reload(); await expect(page.getByRole('img', { name: 'PDF 第 1 页' })).toHaveAttribute('data-rendered', 'true');
  await page.setViewportSize({ width: 1100, height: 650 });
  const pdf = page.locator('.pdf-scroll'); await pdf.evaluate(el => { el.scrollTop = 20; });
  await page.waitForTimeout(1700); expect((await progress(page, id)).revision).toBe(1);
  await pdf.hover(); await page.mouse.wheel(0, 50);
  await expect.poll(async () => (await progress(page, id))?.revision).toBe(2);
  expect((await progress(page, id)).position).toMatchObject({ pdfPageIndex: 0, view: 'source' });
});

test('a slow successful save preserves the first unsent deadline during continuous input without overlapping PUTs', async ({ page }) => {
  await newReader(page, 'slowackdeadline'); const result = await ingest(page, await readerBundle()); const id = result.documentId;
  await open(page, id);
  const start = new Date('2026-10-27T12:00:00.000Z');
  await page.clock.install({ time: start }); await page.clock.pauseAt(start);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let firstCommitted = false; let firstReleased = false; let overlap = false;
  const requests: { at: number; mode: string; expectedRevision: number }[] = [];
  await page.route('**/progress', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    const body = route.request().postDataJSON();
    const at = await page.evaluate(() => Date.now());
    requests.push({ at: at - start.getTime(), mode: body.position.contentMode, expectedRevision: body.expectedRevision });
    if (requests.length > 1 && !firstReleased) overlap = true;
    const response = await route.fetch();
    if (requests.length === 1) { firstCommitted = true; await held; firstReleased = true; }
    await route.fulfill({ response }).catch(() => {});
  });
  let mode = 'source'; await page.getByLabel('正文语言').selectOption(mode);
  await page.clock.runFor(1500); await expect.poll(() => firstCommitted).toBe(true);
  expect(requests).toEqual([{ at: 1500, mode: 'source', expectedRevision: 0 }]);
  for (const at of [1600, 2100, 2600, 3100, 3600, 4100]) {
    const current = await page.evaluate(() => Date.now()); await page.clock.runFor(start.getTime() + at - current);
    mode = mode === 'source' ? 'translation' : 'source'; await page.getByLabel('正文语言').selectOption(mode);
  }
  expect(requests).toHaveLength(1); release();
  await expect(page.getByText('阅读位置已保存', { exact: true })).toBeVisible();
  for (const at of [4600, 5100, 5600, 6100, 6500]) {
    const current = await page.evaluate(() => Date.now()); await page.clock.runFor(start.getTime() + at - current);
    mode = mode === 'source' ? 'translation' : 'source'; await page.getByLabel('正文语言').selectOption(mode);
  }
  await page.clock.runFor(100);
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual({ at: 6600, mode: 'translation', expectedRevision: 1 });
  expect(overlap).toBe(false);
  await expect.poll(async () => (await progress(page, id))?.revision).toBe(2);
});

test('showing a hidden short window reaches the saved fraction before passive restoration is reported', async ({ page }) => {
  await newReader(page, 'shortrestore'); const bundle = await readerBundle(false, false, '译文 ', { shortWindow: true });
  const result = await ingest(page, bundle); const id = result.documentId;
  const descriptor = await (await page.request.get(`/api/v1/documents/${id}/reader`)).json();
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const savedPosition = { readerVersionId: descriptor.versionId, sourceVersionId: descriptor.source.sourceVersionId,
    parseId: descriptor.parseId, blockId: blockId(2), blockOffset: 0.5, pdfPageIndex: 0, view: 'source', contentMode: 'translation' };
  const seeded = await page.request.put(`/api/v1/documents/${id}/progress`, {
    headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken }, data: { expectedRevision: 0, position: savedPosition },
  });
  expect(seeded.status()).toBe(200);
  const writes: unknown[] = []; page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith('/progress')) writes.push(request.postDataJSON()); });
  await page.goto(`/library/${id}`); await expect(page.getByLabel('阅读视图')).toHaveValue('source');
  await expect(page.locator(`[data-block-id="${blockId(2)}"]`)).toBeAttached();
  await page.locator('.reader-content').evaluate(element => {
    element.style.flex = 'none'; element.style.height = '400px'; element.style.padding = '0';
    const block = element.querySelector<HTMLElement>('[data-block-id]')!;
    block.style.height = '100px'; block.style.minHeight = '100px'; block.style.maxHeight = '100px'; block.style.boxSizing = 'border-box';
  });
  await page.waitForTimeout(1700); expect(writes).toEqual([]);
  await page.getByLabel('阅读视图').selectOption('content');
  const fraction = () => page.locator('.reader-content').evaluate(element => {
    const rect = element.querySelector<HTMLElement>('[data-block-id]')!.getBoundingClientRect();
    return { fraction: (element.getBoundingClientRect().top - rect.top) / rect.height, top: element.scrollTop,
      height: element.clientHeight, blockHeight: rect.height, scrollHeight: element.scrollHeight };
  });
  await expect.poll(async () => (await fraction()).scrollHeight).toBe(500);
  expect(await fraction()).toMatchObject({ height: 400, blockHeight: 100 });
  expect((await fraction()).fraction).toBeCloseTo(0.5, 2);
  await expect.poll(async () => (await progress(page, id))?.revision).toBe(2);
  await page.waitForTimeout(1700); expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ expectedRevision: 1, position: { ...savedPosition, view: 'content' } });
});

test('mobile restore and conflict messages leave useful body space and retain explicit CAS recovery', async ({ page, context }) => {
  await newReader(page, 'mobilemessages'); const first = await ingest(page, await readerBundle()); const id = first.documentId;
  await open(page, id); await page.getByLabel('阅读视图').selectOption('content');
  await expect.poll(async () => (await progress(page, id))?.revision).toBe(1);
  await ingest(page, await readerBundle(false, false, '新解析 ', { newParse: true }));
  await page.setViewportSize({ width: 390, height: 844 });
  const writes: string[] = []; page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith('/progress')) writes.push(request.url()); });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => localStorage.setItem('pgl-theme', theme), theme);
    await open(page, id); await expect(page.getByText(/版本已更新，已定位到原页/)).toBeInViewport();
    await page.waitForTimeout(1800); expect(writes).toEqual([]);
    const geometry = await mobileReadingGeometry(page); if (process.env.PAGELINGO_DEBUG_GEOMETRY === '1') console.log(theme, geometry);
    expect(geometry.outerScroll).toBe(0); expect(geometry.visibleHeight).toBeGreaterThanOrEqual(240); expect(geometry.paragraphVisible).toBeGreaterThanOrEqual(50);
    await capture(page, `s2-final-mobile-restore-${theme}`, false);
  }
  const other = await context.newPage(); await open(other, id);
  await other.getByLabel('正文语言').selectOption('source'); await expect.poll(async () => (await progress(other, id))?.revision).toBe(2);
  await page.getByLabel('正文语言').selectOption('source'); await expect(page.getByRole('alert')).toContainText('自动保存已暂停');
  for (const theme of ['dark', 'light']) {
    const geometry = await mobileReadingGeometry(page); if (process.env.PAGELINGO_DEBUG_GEOMETRY === '1') console.log(theme, geometry);
    expect(geometry.outerScroll).toBe(0); expect(geometry.visibleHeight).toBeGreaterThanOrEqual(240);
    await expect(page.getByRole('button', { name: '从当前位置继续', exact: true })).toBeInViewport();
    await capture(page, `s2-final-mobile-conflict-${theme}`, false);
    if (theme === 'dark') await page.getByRole('button', { name: '切换明暗主题' }).click();
  }
  await page.waitForTimeout(1800); expect((await progress(page, id)).revision).toBe(2);
  await page.getByRole('button', { name: '从当前位置继续', exact: true }).click(); await expect.poll(async () => (await progress(page, id))?.revision).toBe(3);
  await other.close();
});
