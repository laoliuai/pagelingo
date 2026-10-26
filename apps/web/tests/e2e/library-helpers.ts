import { expect, type Page } from '@playwright/test';
import { buildPdfFixture } from '../../../../tests/fixtures/pdf';
export const origin = 'http://127.0.0.1:4338';
export async function login(page: Page, username = 'admin', password = 'test-admin-password') {
  await page.goto('/login');
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/library$/);
}
export async function newReader(page: Page, prefix: string) {
  await login(page);
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const username = `${prefix}-${Date.now().toString(36)}`;
  const response = await page.request.post('/api/v1/admin/users', {
    headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken },
    data: { username, password: 'reader-password-1' },
  });
  expect(response.status()).toBe(201);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await login(page, username, 'reader-password-1');
  return username;
}
export async function upload(page: Page, title = 'Three page reading', pages = 3) {
  await page.getByRole('button', { name: '上传 PDF', exact: true }).click();
  await page.getByLabel('PDF 文件').setInputFiles({
    name: 'reading.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(buildPdfFixture(pages)),
  });
  await page.getByLabel('资料标题').fill(title);
  await page.getByRole('button', { name: '保存原文', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
}
export async function capture(page: Page, name: string, fullPage = true) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await page.mouse.move(0, 0);
  return page.screenshot({
    path: process.env.PAGELINGO_CAPTURE_DOCS === '1'
      ? `../../docs/superpowers/specs/assets/2026-10-27-s1-validation/${name}.png`
      : `test-results/captures/${name}.png`,
    fullPage,
  });
}
export async function canvasData(page: Page) {
  return page
    .getByRole('img', { name: /PDF 第/ })
    .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
}
