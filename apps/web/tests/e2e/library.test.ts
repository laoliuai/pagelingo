import { test, expect } from '@playwright/test';
import { buildPdfFixture } from '../../../../tests/fixtures/pdf';
import { capture, newReader, origin, upload } from './library-helpers';

test('empty private library uploads real PDF, persists and searches with URL state', async ({
  page,
}) => {
  await newReader(page, 'library');
  await expect(page.getByText('还没有资料')).toBeVisible();
  await expect(page.getByText('共 0 份资料', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /链接|网页|文章/ })).toHaveCount(0);
  await upload(page);
  await expect(page.getByText('原文已保存', { exact: true })).toBeVisible();
  await expect(page.getByText('等待本地处理', { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('link', { name: 'Three page reading', exact: true }),
  ).toBeVisible();
  await page.getByLabel('搜索资料').fill('unmatched');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page).toHaveURL(/q=unmatched/);
  await expect(page.getByText('没有匹配的资料')).toBeVisible();
  await page.getByLabel('搜索资料').fill('Three');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'Three page reading', exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel('搜索资料')).toHaveValue('unmatched');
  await page.goForward();
  await expect(page.getByLabel('搜索资料')).toHaveValue('Three');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await capture(page, 'library-desktop-light');
  await page.getByRole('button', { name: '切换明暗主题' }).click();
  await capture(page, 'library-desktop-dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, 'library-mobile-dark');
  await page.getByRole('button', { name: '切换明暗主题' }).click();
  await capture(page, 'library-mobile-light');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
});

test('upload rejects invalid and oversized files, retries lost acknowledgement idempotently and cancels', async ({
  page,
}) => {
  await newReader(page, 'upload');
  await page.getByRole('button', { name: '上传 PDF', exact: true }).click();
  await page
    .getByLabel('PDF 文件')
    .setInputFiles({
      name: 'bad.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('not a PDF'),
    });
  await page.getByRole('button', { name: '保存原文', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('有效的 PDF');
  await expect(page.getByText('原文已保存', { exact: true })).toHaveCount(0);
  const oversized = Buffer.alloc(1024 * 1024 + 1);
  oversized.write('%PDF-1.7');
  await page
    .getByLabel('PDF 文件')
    .setInputFiles({ name: 'large.pdf', mimeType: 'application/pdf', buffer: oversized });
  await page.getByRole('button', { name: '保存原文', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('大小限制');
  await page
    .getByLabel('PDF 文件')
    .setInputFiles({
      name: 'retry.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(buildPdfFixture()),
    });
  let lost = false;
  const retryKeys: string[] = [];
  await page.route('**/api/v1/documents/pdf', async (route) => {
    retryKeys.push(route.request().headers()['idempotency-key']);
    if (lost) return route.continue();
    lost = true;
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    await route.abort('failed');
  });
  await page.getByRole('button', { name: '保存原文', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('重试');
  await page.getByRole('button', { name: '重试上传', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(retryKeys).toHaveLength(2);
  expect(retryKeys[0]).toBeTruthy();
  expect(retryKeys[1]).toBe(retryKeys[0]);
  expect((await (await page.request.get('/api/v1/documents')).json()).total).toBe(1);
  await page.unroute('**/api/v1/documents/pdf');
  await page.getByRole('button', { name: '上传 PDF', exact: true }).click();
  await page
    .getByLabel('PDF 文件')
    .setInputFiles({
      name: 'cancel.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(buildPdfFixture(2)),
    });
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/documents/pdf', async (route) => {
    started();
    await gate;
    await route.abort('failed').catch(() => {});
  });
  await page.getByRole('button', { name: '保存原文', exact: true }).click();
  await held;
  await expect(page.getByRole('status')).toContainText('等待服务器确认');
  await expect(page.getByRole('button', { name: '正在上传…' })).toBeDisabled();
  await page.getByRole('button', { name: '取消上传', exact: true }).click();
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.getByRole('dialog')).toBeHidden();
  expect((await (await page.request.get('/api/v1/documents')).json()).total).toBe(1);
});

test('pagination follows the server list and survives refresh; search returns to the first page', async ({
  page,
}) => {
  await newReader(page, 'pagination');
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  for (let index = 1; index <= 21; index++) {
    const response = await page.request.post('/api/v1/documents/pdf', {
      headers: {
        Origin: origin,
        'X-CSRF-Token': session.csrfToken,
        'Idempotency-Key': `page-${index}`,
      },
      multipart: {
        title: `Reading ${String(index).padStart(2, '0')}`,
        file: {
          name: 'page.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from(buildPdfFixture(index)),
        },
      },
    });
    expect(response.status()).toBe(201);
  }
  await page.reload();
  await expect(page.getByText('共 21 份资料', { exact: true })).toBeVisible();
  await expect(page.locator('.document-row')).toHaveCount(20);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator('.document-row')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Reading 01', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('第 2 页', { exact: true })).toBeVisible();
  await page.getByLabel('搜索资料').fill('Reading 01');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page).toHaveURL(/page=1/);
  await expect(page.getByText('共 1 份资料', { exact: true })).toBeVisible();
});

test('an upload denied after session revocation clears the pending private form', async ({
  page,
}) => {
  await newReader(page, 'upload401');
  await page.getByRole('button', { name: '上传 PDF', exact: true }).click();
  await page
    .getByLabel('PDF 文件')
    .setInputFiles({
      name: 'private.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(buildPdfFixture()),
    });
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  await page.request.post('/api/v1/auth/logout', {
    headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken },
    data: {},
  });
  const denied = page.waitForResponse(
    (response) => response.url().endsWith('/documents/pdf') && response.status() === 401,
  );
  await page.getByRole('button', { name: '保存原文', exact: true }).click();
  await denied;
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('input[type=file]')).toHaveCount(0);
});
