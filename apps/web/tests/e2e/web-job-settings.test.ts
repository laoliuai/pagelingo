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
test('imports glossary files with a preview, then searches and pages through thousands of terms', async ({ page }) => {
  const { newReader } = await import('./library-helpers');
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  await newReader(page, 'glossary-import');
  await page.getByRole('link', { name: '模型与账户' }).click();
  const before = (await (await page.request.get('/__test/metrics')).json()).modelCalls;
  const glossary = page.getByRole('region', { name: '个人术语表' });
  const file = glossary.getByLabel('导入词表文件');
  const rows = glossary.locator('.glossary-entry');
  const send = (name: string, text: string) =>
    file.setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
  const save = async () => {
    await glossary.getByRole('button', { name: '保存术语表' }).click();
    await expect(glossary.getByRole('status')).toContainText('术语表已保存');
  };

  // Rejected files explain themselves and change nothing.
  await send('terms.txt', 'x');
  await expect(glossary.getByRole('alert')).toContainText('JSON、CSV 或 TSV');
  await send('bad.json', JSON.stringify([
    { source: 'ok', target: '好', policy: 'translate', domain: 'all' },
    { source: 'bad', target: '', policy: 'translate', domain: 'all' },
  ]));
  await expect(glossary.getByRole('alert')).toContainText('第 2 条');
  await expect(glossary.getByText('0 / 5000 条')).toBeVisible();

  // A row added but never filled in does not block an import.
  await glossary.getByRole('button', { name: '添加术语' }).click();
  await glossary.getByLabel('原词 1', { exact: true }).fill('Kept term');
  await glossary.getByLabel('译词 1', { exact: true }).fill('旧译法');
  await save();
  await glossary.getByRole('button', { name: '添加术语' }).click();

  // The preview counts additions and overwrites, and cancelling keeps the list as it was.
  const csv = 'source,target\nharness,线束\nkept TERM,新译法\n';
  await send('terms.csv', csv);
  await expect(glossary.locator('.glossary-preview')).toContainText('terms.csv：2 个不同词条，新增 1 条，覆盖 1 条');
  await glossary.getByRole('button', { name: '取消导入' }).click();
  await expect(glossary.getByText('2 / 5000 条')).toBeVisible();
  await send('terms.csv', csv);
  await glossary.getByRole('button', { name: '确认合并词表' }).click();
  await expect(glossary.getByRole('status')).toContainText('已合并：新增 1 条，覆盖 1 条');
  await expect(glossary.getByText('2 / 5000 条')).toBeVisible();
  await save();
  await page.reload();
  await expect(glossary.getByLabel('原词 1', { exact: true })).toHaveValue('harness');
  await expect(glossary.getByLabel('译词 2', { exact: true })).toHaveValue('新译法');

  // Pasted rows go through the same preview.
  await glossary.getByText('从表格粘贴批量导入').click();
  await glossary.getByLabel('批量词条').fill('source\ttarget\tpolicy\tdomain\npasted\t\tkeep\tphysics');
  await glossary.getByRole('button', { name: '预览粘贴词表' }).click();
  await expect(glossary.locator('.glossary-preview')).toContainText('粘贴内容：1 个不同词条，新增 1 条，覆盖 0 条');
  await glossary.getByRole('button', { name: '确认合并词表' }).click();
  await expect(glossary.getByText('3 / 5000 条')).toBeVisible();

  // The real shipped glossary stays usable: only one page of rows is rendered.
  const path = fileURLToPath(new URL('../../../../docs/glossaries/merged-tech.en-zh.json', import.meta.url));
  const shipped = JSON.parse(readFileSync(path, 'utf8')) as { source: string; domain: string }[];
  const ours = [['harness', 'all'], ['kept term', 'all'], ['pasted', 'physics']];
  const overlap = shipped.filter((e) => ours.some(([s, d]) => e.source.trim().toLowerCase() === s && e.domain === d)).length;
  const total = shipped.length + ours.length - overlap;
  await file.setInputFiles(path);
  await expect(glossary.locator('.glossary-preview')).toContainText(`${shipped.length} 个不同词条`);
  await glossary.getByRole('button', { name: '确认合并词表' }).click();
  await expect(glossary.getByText(`${total} / 5000 条`)).toBeVisible();
  await expect(rows).toHaveCount(50);
  await glossary.getByRole('button', { name: '下一页' }).click();
  await expect(glossary.getByLabel('原词 51', { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(50);

  // Searching narrows the list, Enter does not save, and editing keeps the row on screen.
  const search = glossary.getByLabel('搜索术语');
  await search.fill(shipped[0]!.source);
  await search.press('Enter');
  await expect(glossary.getByRole('status')).toContainText('已合并');
  await expect(glossary.getByText(/，匹配 \d+ 条/)).toBeVisible();
  await search.fill('no-such-term-anywhere');
  await expect(glossary.getByText('没有匹配的术语。')).toBeVisible();
  await search.fill('pasted');
  await expect(rows).toHaveCount(1);
  const pasted = rows.first().getByLabel(/^原词 \d+$/);
  await pasted.fill('renamed');
  await expect(rows).toHaveCount(1);
  await pasted.fill('pasted');

  // A bad row on another page is brought into view instead of failing with no visible cause.
  await glossary.getByRole('button', { name: '添加术语' }).click();
  await glossary.getByRole('button', { name: '上一页' }).click();
  await glossary.getByRole('button', { name: '保存术语表' }).click();
  await expect(glossary.getByRole('alert')).toContainText(`第 ${total + 1} 条`);
  const blank = glossary.getByLabel(`原词 ${total + 1}`, { exact: true });
  await expect(blank).toBeVisible();
  await glossary.getByRole('button', { name: `删除术语 ${total + 1}` }).click();
  await save();
  await page.reload();
  await expect(glossary.getByText(`${total} / 5000 条`)).toBeVisible();

  expect((await (await page.request.get('/__test/metrics')).json()).modelCalls).toBe(before);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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
