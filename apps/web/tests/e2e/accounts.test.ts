import { test, expect, type Page } from '@playwright/test';
async function login(page: Page, username = 'admin', password = 'test-admin-password') {
  await page.goto('/login');
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/library$/);
}
async function capture(page: Page, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: `../../docs/superpowers/specs/assets/2026-10-27-s1-validation/${name}.png`,
    fullPage: true,
  });
}
test('accounts enforce roles, password revocation and disabled old tabs', async ({
  page,
  browser,
}) => {
  await login(page);
  await page.getByRole('link', { name: '用户管理' }).click();
  const trigger = page.getByRole('button', { name: '创建用户', exact: true });
  await trigger.click();
  await page.getByRole('dialog').getByLabel('用户名').fill('reader');
  await page.getByLabel('初始密码').fill('reader-password-1');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(trigger).toBeFocused();
  const readerContext = await browser.newContext({ baseURL: 'http://127.0.0.1:4338' });
  const reader = await readerContext.newPage();
  await login(reader, 'reader', 'reader-password-1');
  await expect(reader.getByRole('link', { name: '用户管理' })).toHaveCount(0);
  await reader.goto('/admin/users');
  await expect(reader.getByRole('heading', { name: '无权访问' })).toBeVisible();
  expect((await reader.request.get('/api/v1/admin/users')).status()).toBe(403);
  await reader.getByRole('link', { name: '模型与账户' }).click();
  await reader.getByLabel('当前密码').fill('reader-password-1');
  await reader.getByLabel('新密码', { exact: true }).fill('reader-password-2');
  await reader.getByRole('button', { name: '修改密码并重新登录' }).click();
  await expect(reader).toHaveURL(/\/login$/);
  await login(reader, 'reader', 'reader-password-2');
  await page
    .getByRole('row')
    .filter({ hasText: 'reader' })
    .getByRole('button', { name: '重置密码' })
    .click();
  await page.getByRole('dialog').getByLabel('新密码').fill('reader-reset-password');
  await page.getByRole('button', { name: '确认重置密码' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await reader.getByRole('link', { name: '模型与账户' }).click();
  await expect(reader).toHaveURL(/\/login$/);
  await login(reader, 'reader', 'reader-reset-password');
  await page
    .getByRole('row')
    .filter({ hasText: 'reader' })
    .getByRole('button', { name: '停用' })
    .click();
  await page.getByRole('alertdialog').getByRole('button', { name: '确认停用' }).click();
  await reader.getByRole('link', { name: '模型与账户' }).click();
  await expect(reader).toHaveURL(/\/login$/);
  await expect(reader.getByLabel('密码', { exact: true })).toHaveValue('');
  await readerContext.close();
});
test('provider settings save before explicit test, clear keys and persist only theme', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('link', { name: '模型与账户' }).click();
  await page.getByLabel('Base URL').fill('https://api.example.com/v1');
  await page.getByLabel('模型名称').fill('test-model');
  await page.getByLabel('API Key', { exact: true }).fill('test-only-provider-key');
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '保存并测试' }).click();
  await expect(page.getByRole('status')).toContainText('连接成功');
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  await expect(page.getByText('已保存 Key', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('模型名称')).toHaveValue('test-model');
  await page.getByLabel('模型名称').fill('updated-model');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('配置已保存');
  await page.getByRole('link', { name: '资料库' }).click();
  await page.getByRole('link', { name: '模型与账户' }).click();
  await expect(page.getByLabel('模型名称')).toHaveValue('updated-model');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('配置已保存');
  const profile = await (await page.request.get('/api/v1/settings/provider')).json();
  expect(profile.hasApiKey).toBe(true);
  expect(JSON.stringify(profile)).not.toContain('test-only-provider-key');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toMatch(
    /key|token|password/i,
  );
  await page.getByRole('button', { name: '删除已保存 Key', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '取消' }).click();
  expect((await (await page.request.get('/api/v1/settings/provider')).json()).hasApiKey).toBe(true);
  await page.getByRole('button', { name: '删除已保存 Key', exact: true }).click();
  await page.getByRole('button', { name: '确认删除 Key' }).click();
  await expect(page.getByText('未配置 Key', { exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/v1/settings/provider')).json()).hasApiKey).toBe(
    false,
  );
});
test('same-origin shell excludes API and missing assets and sends CSP and private no-store', async ({
  request,
}) => {
  const shell = await request.get('/settings');
  expect(shell.status()).toBe(200);
  expect(shell.headers()['content-security-policy']).toContain("script-src 'self'");
  expect(shell.headers()['content-security-policy']).not.toContain('upgrade-insecure-requests');
  for (const path of ['/api/missing', '/api/v1/admin/users', '/assets/missing.js']) {
    const response = await request.get(path);
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.headers()['content-type']).not.toContain('text/html');
    if (path.startsWith('/api')) expect(response.headers()['cache-control']).toBe('no-store');
  }
});
test('errors focus accessibly, dialogs restore focus and layout works in both themes', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('用户名', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('incorrect-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, 'login-mobile');
  await login(page);
  await page.getByRole('link', { name: '模型与账户' }).click();
  await expect(page.getByLabel('Base URL')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await capture(page, 'settings-mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('link', { name: '用户管理' }).click();
  await expect(page).toHaveURL(/\/admin\/users$/);
  await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await capture(page, 'admin-light');
  await page.getByRole('button', { name: '切换明暗主题' }).click();
  await capture(page, 'admin-dark');
  await page.getByRole('link', { name: '模型与账户' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: '模型与账户' })).toBeVisible();
  await expect(page.getByLabel('Base URL')).toBeVisible();
  await capture(page, 'settings-dark');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(['pgl-theme']);
});
test('a cross-tab account switch clears secrets and rejects a delayed old-user profile', async ({
  page,
  context,
}) => {
  await login(page);
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const created = await page.request.post('/api/v1/admin/users', {
    headers: { Origin: 'http://127.0.0.1:4338', 'X-CSRF-Token': session.csrfToken },
    data: { username: 'isolated-reader', password: 'isolated-password' },
  });
  expect(created.status()).toBe(201);
  await page.getByRole('link', { name: '模型与账户' }).click();
  await page.getByLabel('API Key', { exact: true }).fill('unsaved-sensitive-key');
  await page.getByLabel('当前密码').fill('unsaved-sensitive-password');
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted = false;
  await page.route('**/api/v1/settings/provider', async (route) => {
    if (intercepted || route.request().method() !== 'GET') return route.continue();
    intercepted = true;
    const response = await route.fetch();
    started();
    await gate;
    await route.fulfill({ response }).catch(() => {}); // The account transition aborts this real response.
  });
  try {
    await page.getByRole('link', { name: '资料库' }).click();
    await page.getByRole('link', { name: '模型与账户' }).click();
    await held;
    const switcher = await context.newPage();
    await switcher.goto('/library');
    await switcher.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('input[type=password]')).toHaveValue('');
    await login(switcher, 'isolated-reader', 'isolated-password');
    await expect(page).toHaveURL(/\/library$/);
    await page.getByRole('link', { name: '模型与账户' }).click();
    await expect(page.getByLabel('模型名称')).toHaveValue('');
    release();
    await expect(page.getByLabel('Base URL')).toHaveValue('');
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('当前密码')).toHaveValue('');
    await expect(page.getByText('未配置 Key', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '用户管理' })).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
      ),
    ).not.toMatch(/key|token|password/i);
    await switcher.close();
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
