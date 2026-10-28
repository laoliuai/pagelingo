import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { writeOfflineFixture } from '../../../../packages/document-renderer/tests/web-static-fixtures';

async function blockNetwork(page: Page) {
  const outbound: string[] = []; const diagnostics: string[] = [];
  page.on('request', request => { if (/^https?:/.test(request.url())) outbound.push(request.url()); });
  page.on('console', message => diagnostics.push(message.type() + ': ' + message.text()));
  page.on('pageerror', error => diagnostics.push('pageerror: ' + error.message));
  await page.route(/^https?:/, route => route.abort());
  await page.addInitScript(() => { (window as unknown as { pwned: number }).pwned = 0; });
  return { outbound, diagnostics };
}

test('opens all Web reading modes from file without the origin', async ({ page }, info) => {
  const root = info.outputPath('offline'); await mkdir(root, { recursive: true });
  await writeOfflineFixture(root); const { outbound, diagnostics } = await blockNetwork(page);
  await page.goto(pathToFileURL(join(root, 'render/index.html')).href);
  await expect(page.locator('[data-web-chunk]')).toHaveCount(1);
  for (const name of ['原文', '译文', '双语']) { await page.getByRole('button', { name, exact: true }).click(); await expect(page.locator('#content')).toContainText(name === '原文' ? 'Original English paragraph.' : '译文段落。'); }
  for (const id of ['__proto__', 'constructor', 'toString']) await expect.poll(() => page.getByRole('img', { name: id, exact: true }).evaluateAll((images: HTMLImageElement[]) => images.every(image => image.naturalWidth === 7))).toBe(true);
  await expect(page.locator('#content')).toContainText('图片无法读取或解码：broken');
  await expect(page.locator('#provenance')).toContainText('unavailable');
  await expect(page.locator('#content pre')).toContainText('const code'); await expect(page.locator('.katex').first()).toBeVisible();
  await page.getByRole('button', { name: '定位快照', exact: true }).first().click();
  await expect(page.locator('iframe')).toHaveCount(1); expect(await page.locator('iframe').getAttribute('sandbox')).toBe('');
  const frame = page.frameLocator('iframe'); await expect(frame.getByRole('heading', { name: 'Offline article' })).toBeVisible();
  expect(await frame.locator('script,form,iframe').count()).toBe(0);
  for (const id of ['__proto__', 'constructor', 'toString']) await expect.poll(() => frame.getByRole('img', { name: id, exact: true }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(7);
  expect(await frame.locator('body').evaluate(() => { try { return window.parent.document.title; } catch { return 'opaque'; } })).toBe('opaque');
  await page.getByRole('button', { name: '返回正文', exact: true }).click(); await expect(page.locator('iframe')).toHaveCount(0);
  await page.getByRole('button', { name: '原文', exact: true }).click(); await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('desktop-light.png') });
  await page.getByRole('button', { name: '切换主题', exact: true }).click(); await page.screenshot({ path: info.outputPath('desktop-dark.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: info.outputPath('mobile-dark.png') });
  expect(outbound).toEqual([]); expect(await page.evaluate(() => (window as unknown as { pwned: number }).pwned)).toBe(0);
  await writeFile(info.outputPath('browser-diagnostics.txt'), diagnostics.join('\n'));
});

test('keeps long documents within three mounted chunks', async ({ page }, info) => {
  test.setTimeout(180_000);
  const root = info.outputPath('offline'); await mkdir(root, { recursive: true });
  const input = await writeOfflineFixture(root, 12000, false); const { outbound } = await blockNetwork(page);
  expect(input.ir.blocks.length).toBeLessThanOrEqual(20000);
  await page.goto(pathToFileURL(join(root, 'render/index.html')).href);
  for (let n = 1; n <= input.chunks.length; n++) {
    await page.getByLabel('正文分片', { exact: true }).fill(String(n)); await page.getByRole('button', { name: '跳转正文', exact: true }).click();
    await expect(page.locator(`[data-web-chunk="${input.chunks[n-1].id}"]`)).toBeVisible();
    expect(await page.locator('[data-web-chunk]').count()).toBeLessThanOrEqual(3); expect(await page.locator('iframe').count()).toBeLessThanOrEqual(1);
  }
  await page.getByLabel('正文分片', { exact: true }).fill('2'); await page.getByRole('button', { name: '跳转正文', exact: true }).click();
  await expect(page.locator('.reader-context')).not.toHaveCount(0); expect(outbound).toEqual([]);
});

test('never executes archived HTML CSS or payload scripts', async ({ page }, info) => {
  const root = info.outputPath('offline'); await mkdir(root, { recursive: true }); await writeOfflineFixture(root, 2, false);
  const { outbound } = await blockNetwork(page); await page.goto(pathToFileURL(join(root, 'render/index.html')).href);
  await expect(page.locator('#content')).toContainText('</script><script>window.pwned=1</script>');
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: '定位快照', exact: true }).nth(i).click();
    await expect(page.locator('iframe')).toHaveCount(1); const frame = page.frameLocator('iframe');
    expect(await frame.locator('script,form,iframe,[onerror]').count()).toBe(0);
    await page.getByRole('button', { name: '返回正文', exact: true }).click();
  }
  expect(outbound).toEqual([]); expect(await page.evaluate(() => (window as unknown as { pwned: number }).pwned)).toBe(0);
});

test('reports missing local data without restoring a stale chunk when mode changes', async ({ page }, info) => {
  const { unlink } = await import('node:fs/promises');
  const root = info.outputPath('offline'); await mkdir(root, { recursive: true }); await writeOfflineFixture(root, 400, false);
  await unlink(join(root, 'render/data/c_000002.js')); const { outbound } = await blockNetwork(page);
  await page.goto(pathToFileURL(join(root, 'render/index.html')).href); await expect(page.locator('[data-web-chunk]')).toHaveCount(1);
  await page.getByLabel('正文分片', { exact: true }).fill('2'); await page.getByRole('button', { name: '跳转正文', exact: true }).click();
  await expect(page.locator('#status')).toContainText('本地分片缺失');
  await page.getByRole('button', { name: '译文', exact: true }).click(); await expect(page.locator('[data-web-chunk]')).toHaveCount(0);
  await page.getByLabel('正文分片', { exact: true }).fill('1'); await page.getByRole('button', { name: '跳转正文', exact: true }).click();
  await expect(page.locator('#content')).toContainText('Original English paragraph.'); expect(outbound).toEqual([]);
});


test('reports absent archived preview bytes while source-only reading remains usable', async ({ page }, info) => {
  const root = info.outputPath('offline'); await mkdir(root, { recursive: true });
  await writeOfflineFixture(root, 2, false, { omitPreviews: true }); const { outbound } = await blockNetwork(page);
  await page.goto(pathToFileURL(join(root, 'render/index.html')).href);
  await page.getByRole('button', { name: '定位快照', exact: true }).first().click();
  await expect(page.locator('#preview-status')).toContainText('归档快照不可用'); await expect(page.locator('iframe')).toHaveCount(0);
  await page.getByRole('button', { name: '返回正文', exact: true }).click();
  await page.getByRole('button', { name: '译文', exact: true }).click();
  await expect(page.locator('#content')).toContainText('待翻译，保留原文'); await expect(page.locator('#content')).toContainText('Original English paragraph.');
  expect(outbound).toEqual([]);
});
