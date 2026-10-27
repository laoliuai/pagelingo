import { test, expect } from '@playwright/test';
import { capture, newReader } from './library-helpers';
import { ingest } from './bundle-helpers';
import { readerBundle, blockId, mobileReadingGeometry } from './reader-helpers';

test('Reader splits, resizes, switches modes, locates four rotations against independent canvas pixels', async ({ page }) => {
  await newReader(page, 'split');
  const bundle = await readerBundle(); const result = await ingest(page, bundle);
  const metrics = await (await page.request.get('/__test/metrics')).json();
  const writes: string[] = []; page.on('request', r => { if (r.method() === 'PUT' && r.url().endsWith('/progress')) writes.push(r.url()); });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/library/${result.documentId}`);
  await expect(page.getByRole('separator', { name: '调整分栏' })).toBeVisible();
  await expect(page.locator('.reader-content')).toContainText('译文');
  await expect(page.getByText(/模拟译文/).first()).toBeVisible();
  const separator = page.getByRole('separator', { name: '调整分栏' });
  await separator.focus(); await page.keyboard.press('ArrowRight'); await expect(separator).toHaveAttribute('aria-valuenow', '55');
  await page.keyboard.press('End'); await expect(separator).toHaveAttribute('aria-valuenow', '70');
  await page.keyboard.press('Home'); await expect(separator).toHaveAttribute('aria-valuenow', '30');
  const box = (await separator.boundingBox())!; await page.mouse.move(box.x + 2, box.y + 20); await page.mouse.down(); await page.mouse.move(900, box.y + 20); await page.mouse.up();
  expect(Number(await separator.getAttribute('aria-valuenow'))).toBeGreaterThan(30);
  await page.getByRole('button', { name: '收起目录' }).click(); await expect(page.getByRole('navigation', { name: '阅读目录' })).toBeHidden();
  await page.getByRole('button', { name: '展开目录' }).click();
  await page.getByLabel('正文语言').selectOption('source'); await expect(page.locator('.reader-content')).not.toContainText('译文');
  await page.getByLabel('正文语言').selectOption('translation');
  for (let i = 0; i < 4; i++) {
    await page.locator(`[data-block-id="${blockId(1)}"]`).getByRole('button', { name: '定位原页', exact: true }).click();

    await page.getByRole('button', { name: `来源 ${i + 1} · 第 ${i + 1} 页` }).click();
    const canvas = page.getByRole('img', { name: `PDF 第 ${i + 1} 页` });
    await expect(canvas).toHaveAttribute('data-rendered', 'true');
    for (const scale of ['1', '1.5']) {
      await page.getByLabel('缩放', { exact: true }).selectOption(scale);
      await expect(canvas).toHaveAttribute('width', String((i % 2 === 0 ? 360 : 420) * Number(scale)));
      await expect(canvas).toHaveAttribute('data-rendered', 'true');
      const delta = await page.evaluate(() => {
        const canvas = document.querySelector('canvas')!; const ctx = canvas.getContext('2d')!;
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let x0 = Infinity, y0 = Infinity, x1 = 0, y1 = 0;
        for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
          const p = (y * canvas.width + x) * 4;
          if (data[p] > 200 && data[p + 1] < 50 && data[p + 2] < 50) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); }
        }
        const c = canvas.getBoundingClientRect(); const h = document.querySelector('.source-highlight')!.getBoundingClientRect();
        return [Math.abs(h.left - c.left - x0 * c.width / canvas.width), Math.abs(h.top - c.top - y0 * c.height / canvas.height), Math.abs(h.right - c.left - x1 * c.width / canvas.width), Math.abs(h.bottom - c.top - y1 * c.height / canvas.height)];
      });
      expect(Math.max(...delta)).toBeLessThanOrEqual(2);
    }
  }
  await page.locator(`[data-block-id="${blockId(2)}"]`).getByRole('button', { name: '定位原页', exact: true }).click();  await page.getByRole('button', { name: '来源 1 · 第 1 页' }).click();
  await expect(page.locator('.source-highlight')).toHaveCount(0); await expect(page.getByText('仅定位到原页；此段没有可信区域坐标。')).toBeVisible();
  await page.getByLabel('阅读视图').selectOption('content'); await expect(separator).toBeHidden();
  await page.getByLabel('阅读视图').selectOption('source'); await expect(page.locator('.reader-content')).toBeHidden();
  await page.getByLabel('阅读视图').selectOption('split');
  const content = page.locator('.reader-content'); const pdf = page.locator('.pdf-scroll');
  const before = await pdf.evaluate(el => el.scrollTop); await content.evaluate(el => { el.scrollTop = 100; }); expect(await pdf.evaluate(el => el.scrollTop)).toBe(before);
  await page.getByLabel('缩放', { exact: true }).selectOption('1');
  const capturedCanvas = page.getByRole('img', { name: 'PDF 第 1 页' });
  await expect(capturedCanvas).toHaveAttribute('width', '360'); await expect(capturedCanvas).toHaveAttribute('data-rendered', 'true');
  await expect.poll(() => capturedCanvas.evaluate((canvas: HTMLCanvasElement) => { const p = canvas.getContext('2d')!.getImageData(80, 300, 1, 1).data; return p[0] > 200 && p[1] < 50 && p[2] < 50; })).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1200 }); await page.evaluate(() => window.scrollTo(0, 0));
  await capture(page, 's2-reader-desktop-light'); await page.getByRole('button', { name: '切换明暗主题' }).click();
  await expect.poll(() => capturedCanvas.evaluate((canvas: HTMLCanvasElement) => { const p = canvas.getContext('2d')!.getImageData(80, 300, 1, 1).data; return p[0] > 200 && p[1] < 50 && p[2] < 50; })).toBe(true);
  const darkCapture = await capture(page, 's2-reader-desktop-dark');
  const screenshotRed = await page.evaluate(async base64 => { const image = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), char => char.charCodeAt(0))], { type: 'image/png' })); const canvas = new OffscreenCanvas(image.width, image.height); const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0); const data = context.getImageData(0, 0, image.width, image.height).data; let red = 0; for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] < 50 && data[i + 2] < 50) red++; image.close(); return red; }, darkCapture.toString('base64'));
  expect(screenshotRed).toBeGreaterThan(1000);
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
  await expect(page.locator('.reader-content')).toBeVisible(); await expect(page.locator('.pdf-source')).toBeHidden();
  await capture(page, 's2-reader-mobile-dark'); await page.getByRole('button', { name: '切换明暗主题' }).click(); await capture(page, 's2-reader-mobile-light');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('阅读视图').selectOption('source'); await page.getByRole('button', { name: '下一页', exact: true }).click(); await page.getByLabel('缩放', { exact: true }).selectOption('1.5'); await expect(page.getByRole('img', { name: 'PDF 第 2 页' })).toHaveAttribute('data-rendered', 'true');
  await page.getByLabel('阅读视图').selectOption('content'); await page.getByLabel('正文分片').fill('3'); await page.getByRole('button', { name: '跳转正文' }).click();
  await expect(page.locator('.reader-content pre')).toBeVisible(); expect(await page.locator('.reader-content pre').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(writes).toEqual([]); expect((await (await page.request.get('/__test/metrics')).json()).modelCalls).toBe(metrics.modelCalls);
});

test('mismatching PDF page metadata suppresses bounding box and explains fallback', async ({ page }) => {
  await newReader(page, 'geometry'); const result = await ingest(page, await readerBundle(false, true)); await page.goto(`/library/${result.documentId}`);
  await page.locator(`[data-block-id="${blockId(1)}"]`).getByRole('button', { name: '定位原页', exact: true }).click();  await page.getByRole('button', { name: '来源 2 · 第 2 页' }).click();
  await expect(page.getByRole('img', { name: 'PDF 第 2 页' })).toHaveAttribute('data-rendered', 'true'); await expect(page.locator('.source-highlight')).toHaveCount(0); await expect(page.getByText('页面几何信息不匹配，已仅定位到原页。')).toBeVisible();
});

test('20,000 imported blocks bound chunks and keep nested directory visibility behind every ancestor', async ({ page }) => {
  test.setTimeout(180000);
  await newReader(page, 'window'); const bundle = await readerBundle(true); const result = await ingest(page, bundle); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let received = false;
  await page.route('**/chunks/c_000002', async route => { const response = await route.fetch(); received = true; await held; await route.fulfill({ response }).catch(() => {}); });
  let releasePrevious!: () => void; const previousHeld = new Promise<void>(resolve => { releasePrevious = resolve; });
  const middle = Math.floor(bundle.build.chunks.length / 2);
  await page.route(`**/chunks/${bundle.build.chunks[middle - 2].id}`, async route => { const response = await route.fetch(); await previousHeld; await route.fulfill({ response }).catch(() => {}); });
  await page.goto(`/library/${result.documentId}`);
  await expect.poll(() => received).toBe(true);
  const toc = page.getByRole('navigation', { name: '阅读目录' });
  await expect(toc.locator('[data-toc-entry]')).toHaveCount(200);
  await expect(toc.getByRole('button', { name: '乙节', exact: true })).toHaveCount(0);
  await toc.getByRole('button', { name: '展开章节 甲章', exact: true }).click();
  await toc.getByRole('button', { name: '展开章节 乙节', exact: true }).click();
  await expect(toc.getByRole('button', { name: '丙小节', exact: true })).toBeVisible();
  await toc.getByRole('button', { name: '收起章节 甲章', exact: true }).click();
  await expect(toc.getByRole('button', { name: '乙节', exact: true })).toHaveCount(0);
  await expect(toc.getByRole('button', { name: '丙小节', exact: true })).toHaveCount(0);
  await expect(toc.locator('[data-toc-entry]')).toHaveCount(200);
  // Reopening an ancestor preserves the user's expansion of its descendants.
  await toc.getByRole('button', { name: '展开章节 甲章', exact: true }).click();
  await expect(toc.getByRole('button', { name: '乙节', exact: true })).toBeVisible();
  await expect(toc.getByRole('button', { name: '丙小节', exact: true })).toBeVisible();
  await expect(toc.getByRole('button', { name: '收起章节 乙节', exact: true })).toBeVisible();
  await expect(toc.locator('[data-toc-entry]')).toHaveCount(200);
  const content = page.locator('.reader-content'); await expect(content.locator('.reader-block').first()).toHaveAttribute('data-block-id', blockId(1));
  await page.getByLabel('缩放', { exact: true }).selectOption('2'); await expect(page.getByRole('img', { name: 'PDF 第 1 页' })).toHaveAttribute('data-rendered', 'true');
  const pdfScroll = page.locator('.pdf-scroll'); await pdfScroll.evaluate(el => { el.scrollTop = 100; });
  expect(await pdfScroll.evaluate(el => el.scrollTop)).toBe(100);
  await content.evaluate(el => { el.scrollTop = 100; }); expect(await content.evaluate(el => el.scrollTop)).toBe(100); expect(await pdfScroll.evaluate(el => el.scrollTop)).toBe(100);
  await pdfScroll.evaluate(el => { el.scrollTop = 150; }); expect(await content.evaluate(el => el.scrollTop)).toBe(100);
  for (const current of [bundle.build.chunks.length, Math.floor(bundle.build.chunks.length / 2), 1]) {
    await page.getByLabel('正文分片').fill(String(current)); await page.getByRole('button', { name: '跳转正文' }).click();
    if (current === bundle.build.chunks.length) release();
    const expected = bundle.build.chunks[current - 1]; await expect(content.locator(`[data-block-id="${expected.blockIds[0]}"]`)).toBeAttached();
    let userAnchor: { id: string; top: number } | undefined;
    if (current === middle) {
      const beforeWheel = await content.evaluate(el => el.scrollTop);
      await content.hover(); await page.mouse.wheel(0, 180);
      await expect.poll(() => content.evaluate(el => el.scrollTop)).not.toBe(beforeWheel);
      userAnchor = await content.evaluate(el => { const top = el.getBoundingClientRect().top; const block = [...el.querySelectorAll<HTMLElement>('[data-block-id]')].find(node => node.getBoundingClientRect().bottom > top + 1)!; return { id: block.dataset.blockId!, top: block.getBoundingClientRect().top - top }; });
      releasePrevious();
    }
    expect(await content.locator('[data-reader-chunk]').count()).toBeLessThanOrEqual(3);
    expect(Number(await content.getAttribute('data-cached-chunks'))).toBeLessThanOrEqual(3);
    const allowed = bundle.build.chunks.slice(Math.max(0, current - 2), current + 1).flatMap(chunk => chunk.blockIds);
    await expect.poll(async () => content.locator('.reader-block').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-block-id')))).toEqual(allowed);
    const topGap = await content.locator(`[data-block-id="${userAnchor?.id ?? expected.blockIds[0]}"]`).evaluate(el => el.getBoundingClientRect().top - el.closest('.reader-content')!.getBoundingClientRect().top);
    expect(Math.abs(topGap - (userAnchor?.top ?? 0))).toBeLessThanOrEqual(2);
    if (current > 3) await expect(content.locator(`[data-block-id="${blockId(1)}"]`)).toHaveCount(0);
    for (const list of await content.locator('ol').all()) { const firstId = await list.locator('li [data-block-id]').first().getAttribute('data-block-id'); expect(Number(await list.getAttribute('start'))).toBe(parseInt(firstId!.slice(2), 16) + 1); }
    expect(await page.getByRole('navigation', { name: '阅读目录' }).locator('[data-toc-entry]').count()).toBeLessThanOrEqual(200);
  }
  for (const next of [1, 2]) {
    const id = bundle.build.chunks[next].blockIds[0];
    await content.locator(`[data-block-id="${id}"]`).evaluate(el => { const scroller = el.closest('.reader-content')!; scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top; });
    await expect(page.getByLabel('正文分片')).toHaveValue(String(next));
    await content.hover(); await page.mouse.wheel(0, 40);
    await expect(page.getByLabel('正文分片')).toHaveValue(String(next + 1));
    await expect(content.locator(`[data-reader-chunk="${bundle.build.chunks[next + 1].id}"]`)).toBeAttached();
    expect(Number(await content.getAttribute('data-cached-chunks'))).toBeLessThanOrEqual(3);
  }
  await expect(content.locator(`[data-block-id="${blockId(1)}"]`)).toHaveCount(0);
  await page.getByRole('button', { name: '下一组目录' }).click();
  await expect(page.getByRole('navigation', { name: '阅读目录' }).locator('[data-toc-entry]')).toHaveCount(113);
});

test('version navigation and logout discard late real chunk responses and clear owned content', async ({ page }) => {
  await newReader(page, 'race');
  const first = await ingest(page, await readerBundle(false, false, '旧版本 '));
  const second = await ingest(page, await readerBundle(false, false, '新版本 '));
  expect(first.documentId).toBe(second.documentId);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let received = false;
  await page.route(`**/readers/${first.readerVersionId}/chunks/*`, async route => { const response = await route.fetch(); received = true; await held; await route.fulfill({ response }).catch(() => {}); });
  await page.goto(`/library/${first.documentId}?versionId=${first.readerVersionId}`); await expect.poll(() => received).toBe(true);
  await page.goto(`/library/${second.documentId}?versionId=${second.readerVersionId}`); await expect(page.locator('.reader-content')).toContainText('新版本'); release();
  await expect(page.locator('.reader-content')).not.toContainText('旧版本');
  let releaseLogout!: () => void; const logoutHeld = new Promise<void>(resolve => { releaseLogout = resolve; }); let logoutReceived = false;
  await page.route(`**/readers/${second.readerVersionId}/chunks/*`, async route => { const response = await route.fetch(); logoutReceived = true; await logoutHeld; await route.fulfill({ response }).catch(() => {}); });
  await page.reload(); await expect.poll(() => logoutReceived).toBe(true);
  await page.getByRole('button', { name: '退出登录', exact: true }).click(); await expect(page).toHaveURL(/\/login$/); releaseLogout();
  await expect(page.locator('.reader-content')).toHaveCount(0); await expect(page.locator('canvas')).toHaveCount(0);
});

test('a failed current chunk stays retryable after an adjacent response succeeds', async ({ page }) => {
  await newReader(page, 'retryreader'); const result = await ingest(page, await readerBundle());
  let fail = true; let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/chunks/c_000001', async route => { if (fail) { fail = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE' } }) }); } else await route.continue(); });
  await page.route('**/chunks/c_000002', async route => { const response = await route.fetch(); await held; await route.fulfill({ response }); });
  await page.goto(`/library/${result.documentId}`); await expect(page.getByRole('alert')).toContainText('正文加载失败'); release();
  await expect(page.locator('[data-reader-chunk="c_000002"]')).toBeAttached();
  await expect(page.getByRole('button', { name: '重试正文' })).toBeVisible(); await page.getByRole('button', { name: '重试正文' }).click();
  await expect(page.locator(`[data-block-id="${blockId(1)}"]`)).toBeAttached(); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('mobile ordinary entry shows useful body space in both themes without passive PUT', async ({ page }) => {
  await newReader(page, 'mobileentry'); const result = await ingest(page, await readerBundle());
  const writes: string[] = []; page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith('/progress')) writes.push(request.url()); });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => localStorage.setItem('pgl-theme', theme), theme);
    await page.goto(`/library/${result.documentId}`);
    await expect(page.locator('.reader-content')).toContainText('译文');
    await page.waitForTimeout(1800);
    const geometry = await mobileReadingGeometry(page); console.log('mobile entry', theme, geometry);
    expect(geometry.outerScroll).toBe(0); expect(geometry.visibleHeight).toBeGreaterThanOrEqual(240); expect(geometry.paragraphVisible).toBeGreaterThanOrEqual(50);
    await expect(page.getByLabel('阅读视图')).toBeInViewport();
    await expect(page.getByText(/模拟译文/).first()).toBeInViewport();
    await capture(page, `s2-final-mobile-entry-${theme}`, false);
    expect(await page.locator('[data-reader-chunk]').count()).toBeLessThanOrEqual(3);
  }
  expect(writes).toEqual([]);
});

test('full-coverage imported warnings remain complete inert and bounded after keyboard expansion', async ({ page }) => {
  await newReader(page, 'warnings');
  const warnings = ['source-binding-unavailable:source-only-block', 'unsupported-list-markers:chapter', '<img src="https://example.invalid/leak" onerror="alert(1)">', ...Array.from({ length: 300 }, (_, i) => `source-evidence-conflict:block-${i}`)];
  const result = await ingest(page, await readerBundle(false, false, '译文 ', { warnings, mathFallback: true }));
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`/library/${result.documentId}`);
  const disclosure = page.locator('.reader-warnings'); const summary = disclosure.locator('summary');
  await expect(summary).toContainText('303'); await expect(disclosure).not.toHaveAttribute('open');
  await expect(page.getByText(/解析不完整/)).toHaveCount(0);
  await summary.focus(); await page.keyboard.press('Enter'); await expect(disclosure).toHaveAttribute('open', '');
  expect(await disclosure.locator('li code').allTextContents()).toEqual(warnings);
  await expect(disclosure).toContainText('仅保留原文'); await expect(disclosure).toContainText('列表');
  await expect(disclosure.locator('img, script')).toHaveCount(0);
  const box = await disclosure.locator('ul').evaluate(list => ({ height: list.clientHeight, scroll: list.scrollHeight, overflow: getComputedStyle(list).overflowY }));
  expect(box.height).toBeLessThanOrEqual(170); expect(box.scroll).toBeGreaterThan(box.height); expect(box.overflow).toBe('auto');
  await capture(page, 's2-final-mobile-warnings', false);
  await summary.focus(); await page.keyboard.press('Enter');
  await page.getByLabel('正文分片').fill('3'); await page.getByRole('button', { name: '跳转正文' }).click();
  await expect(page.locator('.reader-content')).toContainText('公式无法在显示预算内排版，已保留原始 LaTeX。');
});
