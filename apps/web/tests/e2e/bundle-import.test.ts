import { test, expect } from '@playwright/test';
import { newReader, upload, capture } from './library-helpers';
import { readingBundle, selectBundle, imports } from './bundle-helpers';

test('bundle import from library preserves truthful pending state and deduplicates a repeated package', async ({ page }) => {
  await newReader(page, 'bundle');
  const bundle = await readingBundle();
  await selectBundle(page, bundle);
  await page.getByRole('button', { name: '开始导入', exact: true }).click();
  await expect(page.getByText('阅读包导入完成', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('原文可读，译文待处理');
  await expect(page.getByRole('dialog')).not.toContainText(/\d+%/);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('.document-row')).toHaveCount(1);
  await selectBundle(page, bundle);
  await page.getByRole('button', { name: '开始导入', exact: true }).click();
  await expect(page.getByText('阅读包导入完成', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  expect((await (await page.request.get('/api/v1/documents')).json()).total).toBe(1);
});

test('bundle import on original detail preserves document id and original PDF', async ({ page }) => {
  await newReader(page, 'bundletarget');
  await upload(page, 'Original four pages', 4);
  await page.getByRole('link', { name: 'Original four pages', exact: true }).click();
  const url = page.url();
  const before = await (await page.request.get(`/api/v1/documents/${url.split('/').pop()}`)).json();
  await selectBundle(page, await readingBundle('chinese'));
  await page.getByRole('button', { name: '开始导入', exact: true }).click();
  await expect(page.getByText('阅读包导入完成', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('无需翻译');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page).toHaveURL(url);
  const after = await (await page.request.get(`/api/v1/documents/${before.id}`)).json();
  expect(after.source).toEqual(before.source);
  await expect(page.getByRole('img', { name: 'PDF 第 1 页' })).toBeVisible();
});

test('bundle import partial discloses unfinished text, parse limits, original regions and mock generation with light dark mobile screenshots', async ({ page }) => {
  await newReader(page, 'bundlepartial');
  await selectBundle(page, await readingBundle('partial'));
  await page.getByRole('button', { name: '开始导入', exact: true }).click();
  await expect(page.getByText('阅读包导入完成', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('仍有文本未完成');
  await expect(page.getByRole('dialog')).toContainText('可能缺页');
  await expect(page.getByRole('dialog')).toContainText('区域图');
  await expect(page.getByRole('dialog')).toContainText('模拟译文');
  await capture(page, 'bundle-import-desktop-light');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '切换明暗主题' }).click();
  await page.getByRole('button', { name: '导入阅读包', exact: true }).click();
  await capture(page, 'bundle-import-desktop-dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, 'bundle-import-mobile-dark');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '切换明暗主题' }).click();
  await page.getByRole('button', { name: '导入阅读包', exact: true }).click();
  await capture(page, 'bundle-import-mobile-light');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('bundle import recovers a lost create and upload response with stable identity and GET before retry', async ({ page }) => {
  await newReader(page, 'bundleloss');
  await selectBundle(page, await readingBundle());
  let creates = 0;
  const keys: string[] = [];
  await page.route('**/api/v1/bundle-imports', async route => {
    if (route.request().method() !== 'POST') {
      if (creates === 1) return route.abort('failed');
      return route.continue();
    }
    keys.push(route.request().headers()['idempotency-key']);
    const response = await route.fetch();
    if (++creates === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '开始导入', exact: true }).click();
  await expect(page.locator('form').getByRole('alert')).toContainText('重试');
  let lost = false;
  let checked = false;
  await page.route('**/api/v1/bundle-imports/*', async route => {
    if (route.request().method() === 'GET') checked = true;
    await route.continue();
  });
  await page.route('**/api/v1/bundle-imports/*/content', async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    lost = true;
    await route.abort('failed');
  });
  await page.getByRole('button', { name: '重试导入', exact: true }).click();
  await expect(page.getByText('阅读包导入完成', { exact: true })).toBeVisible();
  expect(lost && checked).toBe(true);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(await imports(page)).toHaveLength(1);
});

test('bundle import closes without cancelling, restores active state and cancels server before local upload', async ({ page }) => {
  await newReader(page, 'bundlecancel');
  await selectBundle(page, await readingBundle());
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const held = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/v1/bundle-imports/*/content', async route => {
    started(); await gate;
    await route.continue().catch(() => {});
  });
  try {
    await page.getByRole('button', { name: '开始导入', exact: true }).click();
    await held;
    await expect(page.getByText('阅读包导入完成', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '正在导入…' })).toBeDisabled();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    expect((await imports(page))[0].status).toBe('created');
    await page.getByRole('button', { name: '导入阅读包', exact: true }).click();
    await expect(page.getByRole('button', { name: '取消导入', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '取消导入', exact: true }).click();
    await expect(page.getByText('导入已取消', { exact: true })).toBeVisible();
    expect((await imports(page))[0].status).toBe('cancelled');
    release();
    expect((await (await page.request.get('/api/v1/documents')).json()).total).toBe(0);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('bundle import rejects bad hash, wrong target and effective size limit while preserving existing source', async ({ page }) => {
  await newReader(page, 'bundleerrors');
  await upload(page, 'Existing readable source', 3);
  await page.getByRole('link', { name: 'Existing readable source', exact: true }).click();
  await selectBundle(page, await readingBundle('pending', true));
  await page.getByRole('button', { name: '开始导入', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('阅读包校验失败');
  await expect(page.getByRole('button', { name: '重试导入', exact: true })).toBeEnabled();
  await page.getByLabel('阅读包 ZIP').setInputFiles(await readingBundle());
  await page.getByRole('button', { name: '开始导入', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('原件不匹配');
  const limits = await (await page.request.get('/api/v1/bundle-imports/limits')).json();
  await page.getByLabel('阅读包 ZIP').setInputFiles({ name: 'reading.zip', mimeType: 'application/zip', buffer: Buffer.alloc(limits.maxArchiveBytes + 1) });
  await expect(page.getByRole('alert')).toContainText('大小限制');
  await expect(page.getByRole('button', { name: '开始导入', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('img', { name: 'PDF 第 1 页' })).toBeVisible();
  expect((await (await page.request.get('/api/v1/documents')).json()).total).toBe(1);
});

test('bundle import reports stored pending version without downgrading an existing completed reader', async ({ page }) => {
  await newReader(page, 'bundleversion');
  const { ingest } = await import('./bundle-helpers');
  const original = await ingest(page, await readingBundle('completed'));
  await page.goto(`/library/${original.documentId}`);
  await selectBundle(page, await readingBundle());
  await page.getByRole('button', { name: '开始导入', exact: true }).click();
  await expect(page.getByText('阅读包导入完成', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('原文可读，译文待处理');
  const latest = (await imports(page))[0];
  expect(latest.readerVersionId).not.toBe(original.readerVersionId);
  const current = await (await page.request.get(`/api/v1/documents/${original.documentId}/reader`)).json();
  expect(current.versionId).toBe(original.readerVersionId);
  expect((await page.request.get(`/api/v1/documents/${original.documentId}/readers/${original.readerVersionId}/chunks/c_000001`)).status()).toBe(200);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByText('译文已完成', { exact: true })).toBeVisible();
  await expect(page.getByText(/模拟译文/)).toBeVisible();
});

test('bundle import restores after reload, resumes a selected file and never treats filenames as identity', async ({ page }) => {
  await newReader(page, 'bundlerestore');
  const bundle = await readingBundle();
  await selectBundle(page, bundle);
  await page.route('**/api/v1/bundle-imports/*/content', route => route.abort('internetdisconnected'));
  await page.getByRole('button', { name: '开始导入', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('检查网络');
  expect((await imports(page))[0].status).toBe('created');
  await page.unrouteAll();
  await page.reload();
  await page.getByRole('button', { name: '导入阅读包', exact: true }).click();
  await expect(page.getByText('等待上传阅读包…', { exact: true })).toBeVisible();
  await expect(page.getByLabel('阅读包 ZIP')).toBeEnabled();
  await page.getByLabel('阅读包 ZIP').setInputFiles(bundle);
  await page.getByRole('button', { name: '开始导入', exact: true }).click();
  await expect(page.getByText('阅读包导入完成', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await selectBundle(page, await readingBundle('pending', false, '\n%second source\n'));
  await page.getByRole('button', { name: '开始导入', exact: true }).click();
  await expect(page.getByText('阅读包导入完成', { exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/v1/documents')).json()).total).toBe(2);
});

test('bundle import cancellation respects a late server completion rather than claiming cancelled', async ({ page }) => {
  await newReader(page, 'bundlelate');
  await selectBundle(page, await readingBundle());
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const held = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/v1/bundle-imports/*/content', async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    started(); await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  let cancelRequested = false;
  await page.route('**/api/v1/bundle-imports/*/cancel', async route => { cancelRequested = true; await route.continue(); });
  await page.route('**/api/v1/bundle-imports/*', async route => {
    if (route.request().method() === 'GET' && !cancelRequested) { await gate; }
    await route.continue().catch(() => {});
  });
  try {
    await page.getByRole('button', { name: '开始导入', exact: true }).click();
    await held;
    await expect(page.getByText('阅读包导入完成', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '取消导入', exact: true }).click();
    await expect(page.getByText('阅读包导入完成', { exact: true })).toBeVisible();
    await expect(page.getByText('导入已取消', { exact: true })).toHaveCount(0);
    await expect(page.locator('form').getByRole('alert')).toHaveCount(0);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('bundle import owner and administrator isolation survives account switch with a late version response', async ({ page, browser }) => {
  const { login, origin } = await import('./library-helpers');
  await newReader(page, 'bundleprivate');
  await selectBundle(page, await readingBundle('partial'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const held = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/v1/documents/*/reader?*', async route => {
    const response = await route.fetch(); started(); await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  const otherContext = await browser.newContext({ baseURL: origin });
  try {
    await page.getByRole('button', { name: '开始导入', exact: true }).click();
    await held;
    const owned = (await imports(page))[0];
    const other = await otherContext.newPage();
    await newReader(other, 'bundleother');
    expect(await imports(other)).toEqual([]);
    expect((await other.request.get(`/api/v1/bundle-imports/${owned.id}`)).status()).toBe(404);
    expect((await other.request.get(`/api/v1/documents/${owned.documentId}/reader`)).status()).toBe(404);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await login(page, 'admin');
    release();
    await page.unrouteAll({ behavior: 'wait' });
    expect((await page.request.get(`/api/v1/bundle-imports/${owned.id}`)).status()).toBe(404);
    expect((await page.request.get(`/api/v1/documents/${owned.documentId}/reader`)).status()).toBe(404);
    await page.getByRole('button', { name: '导入阅读包', exact: true }).click();
    await expect(page.getByText('阅读包导入完成', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/模拟译文/)).toHaveCount(0);
    expect(await page.getByLabel('阅读包 ZIP').inputValue()).toBe('');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); await otherContext.close(); }
});

test('bundle import clears private state when a disabled account upload is denied', async ({ page, browser }) => {
  const { login, origin } = await import('./library-helpers');
  await newReader(page, 'bundledisabled');
  const owner = await (await page.request.get('/api/v1/auth/session')).json();
  await selectBundle(page, await readingBundle());
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const held = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/v1/bundle-imports/*/content', async route => {
    started(); await gate; await route.continue().catch(() => {});
  });
  const adminContext = await browser.newContext({ baseURL: origin });
  try {
    await page.getByRole('button', { name: '开始导入', exact: true }).click(); await held;
    const admin = await adminContext.newPage(); await login(admin);
    const session = await (await admin.request.get('/api/v1/auth/session')).json();
    const disabled = await admin.request.patch(`/api/v1/admin/users/${owner.user.id}`, {
      headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken }, data: { active: false },
    });
    expect(disabled.status()).toBe(200);
    release();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('input[type=file]')).toHaveCount(0);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); await adminContext.close(); }
});


test('bundle import restored on another PDF detail identifies the prior task without assuming its target', async ({ page }) => {
  const { origin } = await import('./library-helpers');
  await newReader(page, 'bundlerestoredtarget');
  await upload(page, 'Another original', 3);
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const created = await page.request.post('/api/v1/bundle-imports', {
    headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': 'prior-created' }, data: {},
  });
  expect(created.status()).toBe(201);
  await page.getByRole('link', { name: 'Another original', exact: true }).click();
  await page.getByRole('button', { name: '导入阅读包', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('此前的导入任务');
  await expect(page.getByRole('dialog')).toContainText('如需导入当前 PDF，请先取消此前任务');
  await expect(page.getByRole('button', { name: '开始导入', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '取消导入', exact: true }).click();
  await expect(page.getByText('导入已取消', { exact: true })).toBeVisible();
});
