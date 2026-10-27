import { test, expect } from '@playwright/test';
test('personal save preferences and glossary persist without model calls or historical work', async ({
  page,
}, testInfo) => {
  await page.goto('/login');
  await page.getByLabel('用户名', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('test-admin-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('link', { name: '模型与账户' }).click();
  const before = await (await page.request.get('/__test/metrics')).json();
  const preferences = page.getByRole('region', { name: '保存偏好' });
  const glossary = page.getByRole('region', { name: '个人术语表' });
  await expect(preferences.getByLabel('自动翻译新保存的外文资料')).not.toBeChecked();
  await preferences.getByLabel('自动翻译新保存的外文资料').check();
  await preferences.getByRole('button', { name: '保存偏好', exact: true }).click();
  await expect(preferences.getByRole('status')).toContainText('偏好已保存');
  await glossary.getByRole('button', { name: '添加术语' }).click();
  await glossary.getByLabel('原词 1', { exact: true }).fill('PageLingo');
  await glossary.getByLabel('译词 1', { exact: true }).fill('PageLingo');
  await glossary.getByRole('button', { name: '保存术语表' }).click();
  await expect(glossary.getByRole('status')).toContainText('术语表已保存');
  await page.reload();
  await expect(preferences.getByLabel('自动翻译新保存的外文资料')).toBeChecked();
  await expect(glossary.getByLabel('原词 1', { exact: true })).toHaveValue('PageLingo');
  expect((await (await page.request.get('/__test/metrics')).json()).modelCalls).toBe(before.modelCalls);
  for (const mode of ['light', 'dark', 'mobile'] as const) {
    if (mode === 'dark') await page.getByRole('button', { name: '切换明暗主题' }).click();
    if (mode === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
    await preferences.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({
      path:
        process.env.PAGELINGO_CAPTURE_S3_SETTINGS === '1'
          ? `../../docs/superpowers/specs/assets/2026-10-27-s3-validation/settings-${mode}.png`
          : testInfo.outputPath(`settings-${mode}.png`),
      fullPage: true,
    });
  }
  // Keep shared test account defaults independent of test order.
  await preferences.getByLabel('自动翻译新保存的外文资料').uncheck();
  await preferences.getByRole('button', { name: '保存偏好', exact: true }).click();
  await expect(preferences.getByRole('status')).toContainText('偏好已保存');
});
test('settings surface CAS conflicts and clear private glossary drafts on account change', async ({ page }) => {
  const { newReader, login, origin } = await import('./library-helpers');
  await newReader(page, 'settings-owner');
  await page.getByRole('link', { name: '模型与账户' }).click();
  const preferences = page.getByRole('region', { name: '保存偏好' });
  const glossary = page.getByRole('region', { name: '个人术语表' });
  await expect(preferences.getByLabel('自动翻译新保存的外文资料')).not.toBeChecked();
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  expect(
    (
      await page.request.put('/api/v1/settings/save-preferences', {
        headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken },
        data: { expectedRevision: 0, autoTranslate: true },
      })
    ).status(),
  ).toBe(200);
  await preferences.getByRole('button', { name: '保存偏好', exact: true }).click();
  await expect(preferences.getByRole('alert')).toContainText('其他页面更新');
  await glossary.getByRole('button', { name: '添加术语' }).click();
  await glossary.getByLabel('原词 1', { exact: true }).fill('private-owner-sentinel');
  await glossary.getByLabel('译词 1', { exact: true }).fill('private draft');
  await glossary.getByRole('button', { name: '保存术语表' }).click();
  await expect(glossary.getByRole('status')).toContainText('术语表已保存');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await login(page);
  await page.getByRole('link', { name: '模型与账户' }).click();
  await expect(page.locator('input[value="private-owner-sentinel"]')).toHaveCount(0);
  expect(JSON.stringify(await (await page.request.get('/api/v1/settings/glossary')).json())).not.toContain(
    'private-owner-sentinel',
  );
});
