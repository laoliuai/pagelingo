import { test, expect, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('用户名', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('test-admin-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/library$/);
  await page.getByRole('link', { name: '模型与账户' }).click();
}

test('settings creates one-time pairing codes, lists and revokes own devices on desktop and mobile', async ({ page, playwright }, testInfo) => {
  await login(page);
  const panel = page.getByRole('region', { name: '采集设备' });
  await expect(panel.getByText('尚未配对采集设备')).toBeVisible();
  const before = await (await page.request.get('/__test/metrics')).json();
  await panel.getByRole('button', { name: '生成一次性配对码' }).click();
  const code = await panel.getByLabel('一次性配对码', { exact: true }).inputValue();
  expect(code).toMatch(/^[A-Za-z0-9_-]{22,}$/);
  await expect(panel.getByText(/5 分钟内有效/)).toBeVisible();
  const extension = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4338' });
  try {
    const exchangeInput = { code, deviceName: 'My laptop browser', extensionId: 'test-extension', extensionVersion: '1.0.0' };
    const response = await extension.post('/api/v1/devices/exchange', { data: exchangeInput });
    expect(response.status()).toBe(201);
    const exchange = await response.json();
    expect((await extension.post('/api/v1/devices/exchange', { data: exchangeInput })).status()).toBe(401);
    await page.reload();
    await expect(panel.getByText('My laptop browser', { exact: true })).toBeVisible();
    await expect(panel.getByLabel('一次性配对码', { exact: true })).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toContain(exchange.token);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(code);
    expect((await extension.get('/api/v1/settings/provider', { headers: { Authorization: `Bearer ${exchange.token}` } })).status()).toBe(401);
    await panel.screenshot({ path: testInfo.outputPath('devices-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await panel.screenshot({ path: testInfo.outputPath('devices-mobile.png') });
    await page.getByRole('button', { name: '切换明暗主题' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await panel.screenshot({ path: testInfo.outputPath('devices-dark.png') });
    await panel.getByRole('button', { name: '撤销 My laptop browser' }).click();
    await page.getByRole('button', { name: '确认撤销设备' }).click();
    await expect(panel.getByText('已撤销', { exact: true })).toBeVisible();
    await page.reload();
    await expect(panel.getByText('已撤销', { exact: true })).toBeVisible();
    const after = await (await page.request.get('/__test/metrics')).json();
    expect(after.modelCalls).toBe(before.modelCalls);
  } finally { await extension.dispose(); }
});
