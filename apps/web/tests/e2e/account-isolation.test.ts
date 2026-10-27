import { test, expect } from '@playwright/test';
import { ingest } from './bundle-helpers';
import { readerBundle } from './reader-helpers';
import { login, newReader, origin, upload } from './library-helpers';

test('another context and same-tab account switch cannot read old documents or stale responses', async ({
  page,
  browser,
  context,
}) => {
  await newReader(page, 'owner');
  await upload(page, 'Private owner PDF');
  const list = await (await page.request.get('/api/v1/documents')).json();
  const id = list.items[0].id;
  const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const otherContext = await browser.newContext({ baseURL: origin });
  try {
    const other = await otherContext.newPage();
    await newReader(other, 'other');
    await expect(other.getByText('还没有资料')).toBeVisible();
    expect((await other.request.get(`/api/v1/documents/${id}`)).status()).toBe(404);
    expect((await other.request.get(`/api/v1/documents/${id}/source`)).status()).toBe(404);
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/v1/documents/*/source', async (route) => {
      const response = await route.fetch();
      started();
      await gate;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.getByRole('link', { name: 'Private owner PDF' }).click();
    await held;
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await login(page, 'admin');
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(page.locator('canvas')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Private owner PDF' })).toHaveCount(0);
    expect(
      (
        await page.request.get(`/api/v1/documents/${id}/source`, {
          headers: { Cookie: cookie },
        })
      ).status(),
    ).toBe(401);
    await page.goto(`/library/${id}`);
    await expect(page.getByRole('alert')).toContainText('资料不存在');
  } finally {
    await otherContext.close();
  }
});

test('imported warning disclosure does not survive logout or reveal another account document', async ({ page }) => {
  await newReader(page, 'warningowner');
  const result = await ingest(page, await readerBundle(false, false, '译文 ', { warnings: ['source-binding-unavailable:private-warning-sentinel'] }));
  await page.goto(`/library/${result.documentId}`);
  await page.locator('.reader-warnings summary').click();
  await expect(page.locator('.reader-warnings')).toContainText('private-warning-sentinel');
  await page.getByRole('button', { name: '退出登录', exact: true }).click(); await login(page);
  await expect(page.locator('.reader-warnings')).toHaveCount(0);
  await page.goto(`/library/${result.documentId}`);
  await expect(page.getByRole('alert')).toContainText('资料不存在');
  await expect(page.getByText(/private-warning-sentinel/)).toHaveCount(0);
});
