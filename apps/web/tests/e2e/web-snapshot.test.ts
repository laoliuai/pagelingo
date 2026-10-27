import { test, expect } from '@playwright/test';
import { newReader } from './library-helpers';
import { archive } from './web-helpers';
test('source-node preview is one opaque bounded frame and external anchor clicks cannot navigate', async ({ page }, testInfo) => {
  const diagnostics: string[] = []; page.on('console', message => diagnostics.push(message.text())); page.on('requestfailed', request => diagnostics.push(request.url() + ' ' + request.failure()?.errorText));
  const outbound: string[] = []; page.on('request', request => { if (request.url().includes('evil.example')) outbound.push(request.url()); });
  await newReader(page, 'web-preview');
  const value = await archive(page, '<article><h1>快照</h1><p><a href="https://evil.example/out">外部链接</a>安全原文</p><script>fetch("https://evil.example/script")</script><p>末尾段落</p></article>');
  await page.goto(`/library/${value.documentId}`);
  await page.getByRole('button', { name: '定位快照', exact: true }).nth(1).click();
  const frame = page.frameLocator('iframe[title="归档快照"]');
  try { await expect(frame.getByText('安全原文', { exact: false })).toBeVisible(); } finally { const { writeFile } = await import('node:fs/promises'); await writeFile(testInfo.outputPath('browser-diagnostics.txt'), diagnostics.join('\n')); await testInfo.attach('browser-diagnostics', { path: testInfo.outputPath('browser-diagnostics.txt'), contentType: 'text/plain' }); }
  expect(await page.locator('iframe').count()).toBe(1);
  expect(await page.locator('iframe').getAttribute('sandbox')).toBe('');
  await frame.getByText('外部链接', { exact: true }).click();
  await page.waitForTimeout(300);
  expect(outbound).toEqual([]);
  await expect(frame.getByText('安全原文', { exact: false })).toBeVisible();
  expect(await frame.locator('body').evaluate(() => { try { return window.parent.document.cookie; } catch { return 'opaque'; } })).toBe('opaque');
  await page.getByRole('button', { name: '返回正文', exact: true }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
});
test('snapshot blobs are released on close and logout and cannot cross accounts', async ({ page }) => {
  await page.addInitScript(() => {
    const active = new Set<string>(); (window as unknown as { previewBlobs: Set<string> }).previewBlobs = active;
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = value => { const url = create(value); if (value instanceof Blob && value.type === 'text/html') active.add(url); return url; };
    URL.revokeObjectURL = url => { active.delete(url); revoke(url); };
  });
  await newReader(page, 'web-blobs'); const value = await archive(page);
  await page.goto(`/library/${value.documentId}`);
  await page.getByRole('button', { name: '定位快照', exact: true }).nth(1).click();
  await expect(page.locator('iframe')).toBeVisible();
  const count = () => page.evaluate(() => (window as unknown as { previewBlobs: Set<string> }).previewBlobs.size);
  expect(await count()).toBe(1);
  await page.getByRole('button', { name: '返回正文', exact: true }).click(); expect(await count()).toBe(0);
  await page.getByRole('button', { name: '定位快照', exact: true }).nth(1).click(); await expect(page.locator('iframe')).toBeVisible();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.locator('iframe')).toHaveCount(0); expect(await count()).toBe(0);
});
test('archived image bytes with prototype-like local IDs decode after original site is unavailable', async ({ page }) => {
  const { capture } = await import('../../../document-service/tests/helpers/web-capture'); const { uploadArchive } = await import('./web-helpers'); const { createHash } = await import('node:crypto');
  await newReader(page, 'web-images');
  const image = Buffer.from(await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 7; canvas.height = 5; const context = canvas.getContext('2d')!; context.fillStyle = '#248576'; context.fillRect(0,0,7,5); return canvas.toDataURL('image/png').split(',')[1]; }), 'base64');
  const fixture = capture('<article><p>离线插图</p>' + [1,2,3].map(i => `<img data-pl-resource="r_${i}" alt="归档插图${i}">`).join('') + '</article>');
  ['__proto__','constructor','toString'].forEach((id, i) => {
    fixture.manifest.files.push({ id, path: `${i}.png`, role: 'image', mediaType: 'image/png', bytes: image.length, sha256: createHash('sha256').update(image).digest('hex') });
    fixture.manifest.resources.push({ id: `r_${i+1}`, url: `https://example.com/${i}.png`, role: 'image', status: 'available', fileId: id });
  });
  const value = await uploadArchive(page, { ...fixture, image });
  await page.route('https://example.com/**', route => route.abort()); await page.goto(`/library/${value.documentId}`);
  for (const i of [1,2,3]) await expect.poll(() => page.getByRole('img', { name: `归档插图${i}`, exact: true }).evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(7);
  await page.getByRole('button', { name: '定位快照', exact: true }).first().click();
  const frame = page.frameLocator('iframe[title="归档快照"]');
  for (const i of [1,2,3]) { const image = frame.getByRole('img', { name: `归档插图${i}`, exact: true }); await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/); expect(await image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(7); }
});
test('table context has no canonical progress or selection anchors and TOC returns from snapshot to content', async ({ page }) => {
  await newReader(page, 'web-table');
  const value = await archive(page, '<article><h1>表格目录</h1><table><thead><tr><th>重复表头</th><th>数据列</th></tr></thead><tbody>' + Array.from({ length: 220 }, (_, i) => `<tr><td>原始行${i}</td><td>内容${i}</td></tr>`).join('') + '</tbody></table></article>');
  await page.goto(`/library/${value.documentId}`); const body = page.getByLabel('正文，可独立滚动');
  await page.getByLabel('正文分片', { exact: true }).fill('2'); await page.getByRole('button', { name: '跳转正文', exact: true }).click();
  await expect.poll(() => body.locator('.reader-context').count()).toBeGreaterThan(0);
  expect(await body.locator('.reader-context [data-block-id], .reader-context [data-locate-block], .reader-context input').count()).toBe(0);
  const ids = await body.locator('[data-block-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-block-id'))); expect(new Set(ids).size).toBe(ids.length);
  await body.getByRole('button', { name: '定位快照', exact: true }).first().click(); await expect(page.locator('iframe')).toHaveCount(1);
  await page.getByText('版本与目录', { exact: true }).click(); await page.getByRole('button', { name: '表格目录', exact: true }).click();
  await expect(page.locator('iframe')).toHaveCount(0); await expect(body).toContainText('表格目录');
});
test('unavailable snapshot metadata reports failure while trusted original remains recoverable', async ({ page }) => {
  await newReader(page, 'web-metadata'); const value = await archive(page);
  await page.route('**/web-snapshots/**/manifest', route => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND' } }) }));
  await page.goto(`/library/${value.documentId}`); await page.getByRole('button', { name: '定位快照', exact: true }).first().click();
  await expect(page.getByRole('button', { name: '重试快照信息', exact: true })).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.getByRole('button', { name: '返回正文', exact: true }).click(); await expect(page.getByLabel('正文，可独立滚动')).toContainText('这是已经归档');
});
test('version switching releases the old preview and late binary delivery cannot mount after logout', async ({ page }) => {
  const { capture } = await import('../../../document-service/tests/helpers/web-capture'); const { uploadArchive } = await import('./web-helpers');
  await page.addInitScript(() => {
    const active = new Set<string>(); (window as unknown as { previewBlobs: Set<string> }).previewBlobs = active;
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = value => { const url = create(value); if (value instanceof Blob && value.type === 'text/html') active.add(url); return url; };
    URL.revokeObjectURL = url => { active.delete(url); revoke(url); };
  });
  await newReader(page, 'web-frame-fence'); const first = await archive(page);
  const second = await uploadArchive(page, capture('<article><p>新来源的独立段落。</p></article>'), first.documentId);
  await page.goto(`/library/${first.documentId}?versionId=${first.readerVersionId}`);
  await page.getByRole('button', { name: '定位快照', exact: true }).first().click(); await expect(page.locator('iframe')).toBeVisible();
  const oldUrl = await page.locator('iframe').getAttribute('src');
  await page.getByText('版本与目录', { exact: true }).click(); await page.getByLabel('阅读版本', { exact: true }).selectOption(second.readerVersionId);
  await expect(page.getByLabel('正文，可独立滚动')).toContainText('新来源');
  expect(await page.evaluate(url => (window as unknown as { previewBlobs: Set<string> }).previewBlobs.has(url!.split('#')[0]), oldUrl)).toBe(false);
  let started = false, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/web-snapshots/**/files/*', async route => { const response = await route.fetch(); started = true; await gate; await route.fulfill({ response }).catch(() => {}); });
  await page.getByRole('button', { name: '定位快照', exact: true }).first().click(); await expect.poll(() => started).toBe(true);
  await page.getByRole('button', { name: '退出登录', exact: true }).click(); release(); await page.unrouteAll({ behavior: 'wait' });
  await expect(page.locator('iframe')).toHaveCount(0); expect(await page.evaluate(() => (window as unknown as { previewBlobs: Set<string> }).previewBlobs.size)).toBe(0);
});
