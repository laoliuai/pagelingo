import { test, expect } from '@playwright/test';
import { buildIccPdfFixture } from '../../../../tests/fixtures/pdf';
import { canvasData, capture, newReader, origin, upload } from './library-helpers';

async function captureReader(page: import('@playwright/test').Page, name: string) {
  const canvas = page.getByRole('img', { name: 'PDF 第 2 页' });
  await expect(canvas).toHaveAttribute('data-rendered', 'true');
  // The synthetic page has a colored rectangle at this point; a ready white bitmap is a bug.
  await expect
    .poll(() =>
      canvas.evaluate((node: HTMLCanvasElement) => {
        const pixel = node
          .getContext('2d')!
          .getImageData(Math.floor(node.width / 2), Math.floor(node.height / 5), 1, 1).data;
        return Array.from(pixel);
      }),
    )
    .not.toEqual([255, 255, 255, 255]);
  const box = (await canvas.boundingBox())!;
  const sourcePixel = await canvas.evaluate((node: HTMLCanvasElement) =>
    Array.from(
      node
        .getContext('2d')!
        .getImageData(Math.floor(node.width / 2), Math.floor(node.height / 5), 1, 1).data,
    ),
  );
  // Full-page capture can resize Chromium's desktop surface by a few pixels.
  // Keep the desktop viewport fixed; mobile captures include the lower reader.
  const screenshot = await capture(page, name, (page.viewportSize()?.width ?? 0) < 800);
  const screenshotPixel = await page.evaluate(
    async ({ png, x, y }) => {
      const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const target = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = target.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      return Array.from(context.getImageData(x, y, 1, 1).data);
    },
    {
      png: screenshot.toString('base64'),
      x: Math.floor(box.x + box.width / 2),
      y: Math.floor(box.y + box.height / 5),
    },
  );
  expect(screenshotPixel).toEqual(sourcePixel);
}

test('PDF.js draws all three pages, zooms, cleans up and never calls a model', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const dimensions: { width: number; rendered: string | undefined }[] = [];
    Object.defineProperty(window, '__pdfDimensions', { get: () => dimensions });
    const width = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width')!;
    Object.defineProperty(HTMLCanvasElement.prototype, 'width', {
      ...width,
      set(value: number) {
        if (this.closest('.pdf-scroll'))
          dimensions.push({ width: value, rendered: this.dataset.rendered });
        width.set!.call(this, value);
      },
    });
    const NativeWorker = window.Worker;
    const active = new Set<Worker>();
    Object.defineProperty(window, '__activePdfWorkers', { get: () => active.size });
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        active.add(this);
      }
      override terminate() {
        active.delete(this);
        super.terminate();
      }
    };
  });
  await newReader(page, 'pdf');
  const before = await (await page.request.get('/__test/metrics')).json();
  await upload(page);
  await page.getByRole('link', { name: 'Three page reading', exact: true }).click();
  await expect(page).toHaveURL(/\/library\/[0-9a-f-]+$/);
  await expect(
    page.getByRole('heading', { name: 'Three page reading', level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation').getByRole('link', { name: '资料库', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('第 1 / 3 页', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'PDF 第 1 页' })).toHaveAttribute(
    'data-rendered',
    'true',
  );
  await page.reload();
  await expect(page.getByRole('img', { name: 'PDF 第 1 页' })).toHaveAttribute(
    'data-rendered',
    'true',
  );
  const first = await canvasData(page);
  expect(await page.evaluate(() => Reflect.get(window, '__activePdfWorkers'))).toBe(1);
  const oldCanvas = await page.locator('canvas').elementHandle();
  expect(await page.locator('canvas').count()).toBe(1);
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.getByRole('img', { name: 'PDF 第 2 页' })).toHaveAttribute(
    'data-rendered',
    'true',
  );
  expect(await canvasData(page)).not.toBe(first);
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.getByRole('img', { name: 'PDF 第 3 页' })).toHaveAttribute(
    'data-rendered',
    'true',
  );
  await expect(page.getByRole('button', { name: '下一页' })).toBeDisabled();
  await page.getByRole('button', { name: '上一页' }).click();
  await expect(page.getByRole('img', { name: 'PDF 第 2 页' })).toHaveAttribute(
    'data-rendered',
    'true',
  );
  await page.getByLabel('缩放').selectOption('1.5');
  await expect(page.getByRole('img', { name: 'PDF 第 2 页' })).toHaveAttribute('width', '450');
  await expect(page.getByRole('img', { name: 'PDF 第 2 页' })).toHaveAttribute(
    'data-rendered',
    'true',
  );
  const dimensions = (await page.evaluate(() => Reflect.get(window, '__pdfDimensions'))) as {
    width: number;
    rendered?: string;
  }[];
  expect(
    dimensions.filter((event) => event.width > 0).every((event) => event.rendered !== 'true'),
  ).toBe(true);
  await expect(page.getByText('译文', { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await captureReader(page, 'reader-desktop-light');
  await page.getByRole('button', { name: '切换明暗主题' }).click();
  await captureReader(page, 'reader-desktop-dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await captureReader(page, 'reader-mobile-dark');
  await page.getByRole('button', { name: '切换明暗主题' }).click();
  await captureReader(page, 'reader-mobile-light');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  expect((await (await page.request.get('/__test/metrics')).json()).modelCalls).toBe(
    before.modelCalls,
  );
  await page.getByRole('link', { name: '返回资料库' }).click();
  await expect(page.locator('canvas')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, '__activePdfWorkers')))
    .toBe(0);
  expect(
    await oldCanvas!.evaluate((canvas) => [
      (canvas as HTMLCanvasElement).width,
      (canvas as HTMLCanvasElement).height,
    ]),
  ).toEqual([0, 0]);
});

test('unreadable PDF shows actual failure with download and retry; source 401 clears the session', async ({
  page,
}) => {
  await newReader(page, 'pdferror');
  await page.getByRole('button', { name: '上传 PDF', exact: true }).click();
  await page.getByLabel('PDF 文件').setInputFiles({
    name: 'broken.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\ninvalid'),
  });
  await page.getByRole('button', { name: '保存原文', exact: true }).click();
  await page.getByRole('link', { name: 'broken.pdf', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('原件加载失败');
  await expect(page.getByRole('link', { name: '下载原件', exact: true })).toBeVisible();
  const retryResponse = page.waitForResponse((response) => response.url().endsWith('/source'));
  await page.getByRole('button', { name: '重试加载' }).click();
  await retryResponse;
  await expect(page.getByRole('alert')).toContainText('原件加载失败');
  await page.route('**/api/v1/documents/*/source', async (route) => {
    const session = await (await page.request.get('/api/v1/auth/session')).json();
    await page.request.post('/api/v1/auth/logout', {
      headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken },
      data: {},
    });
    await route.continue();
  });
  await page.getByRole('button', { name: '重试加载' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator('canvas')).toHaveCount(0);
});

test('missing source returns real 404 with download and retry fallback', async ({ page }) => {
  await newReader(page, 'missing');
  await upload(page);
  const document = (await (await page.request.get('/api/v1/documents')).json()).items[0];
  expect((await page.request.post(`/__test/missing-source/${document.id}`)).status()).toBe(204);
  await page.getByRole('link', { name: 'Three page reading', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('原件加载失败');
  const download = page.getByRole('link', { name: '下载原件', exact: true });
  expect((await page.request.get((await download.getAttribute('href'))!)).status()).toBe(404);
  const retry = page.waitForResponse(
    (response) => response.url().endsWith('/source') && response.status() === 404,
  );
  await page.getByRole('button', { name: '重试加载' }).click();
  await retry;
  await expect(page.getByRole('alert')).toContainText('原件加载失败');
  await expect(page.locator('canvas')).toHaveCount(0);
});

test('large source uses authenticated bounded byte ranges and local decoding assets', async ({
  page,
}) => {
  await newReader(page, 'range');
  await upload(page, 'Large original', 500);
  const requested: string[] = [];
  const ranges: string[] = [];
  page.on('request', (request) => {
    requested.push(request.url());
    if (request.headers()['range']) ranges.push(request.headers()['range']);
  });
  const partial = page.waitForResponse(
    (response) => response.url().endsWith('/source') && response.status() === 206,
  );
  await page.getByRole('link', { name: 'Large original', exact: true }).click();
  await partial;
  await expect(page.getByRole('img', { name: 'PDF 第 1 页' })).toHaveAttribute(
    'data-rendered',
    'true',
  );
  await expect(page.getByText('第 1 / 500 页', { exact: true })).toBeVisible();
  expect(ranges.length).toBeGreaterThan(0);
  for (const range of ranges) {
    const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    expect(match).toBeTruthy();
    expect(Number(match[2]) - Number(match[1]) + 1).toBeLessThanOrEqual(65536);
  }
  expect(requested.every((url) => new URL(url).origin === origin)).toBe(true);
  const cmap = await page.request.get('/assets/pdfjs/cmaps/UniGB-UCS2-H.bcmap');
  expect(cmap.status()).toBe(200);
  expect(cmap.headers()['content-type']).not.toContain('text/html');
});

test('ICC color conversion uses local WASM under the effective worker CSP', async ({
  page,
}) => {
  await newReader(page, 'icc');
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (/ICCBased|WebAssembly|wasm|compile/i.test(message.text()))
      warnings.push(message.text());
  });
  await page.getByRole('button', { name: '上传 PDF', exact: true }).click();
  await page.getByLabel('PDF 文件').setInputFiles({
    name: 'icc.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(buildIccPdfFixture()),
  });
  await page.getByRole('button', { name: '保存原文', exact: true }).click();
  const workerResponse = page.waitForResponse((response) =>
    /\/assets\/pdf\.worker[^/]*\.js$/.test(new URL(response.url()).pathname),
  );
  const decoderResponse = page.waitForResponse((response) =>
    response.url().endsWith('/qcms_bg.wasm'),
  );
  await page.getByRole('link', { name: 'icc.pdf', exact: true }).click();
  const worker = await workerResponse;
  expect((await decoderResponse).status()).toBe(200);
  const canvas = page.getByRole('img', { name: 'PDF 第 1 页' });
  await expect(canvas).toHaveAttribute('data-rendered', 'true');
  const pixel = await canvas.evaluate((node: HTMLCanvasElement) =>
    Array.from(node.getContext('2d')!.getImageData(100, 100, 1, 1).data),
  );
  // The embedded custom profile maps red input to blue. DeviceRGB fallback stays red.
  expect(pixel[0]).toBeLessThan(20);
  expect(pixel[1]).toBeLessThan(20);
  expect(pixel[2]).toBeGreaterThan(230);
  expect(pixel[3]).toBe(255);
  expect(warnings).toEqual([]);
  const scriptPolicy = worker
    .headers()
    ['content-security-policy'].split(';')
    .find((value) => value.trim().startsWith('script-src '))!;
  expect(scriptPolicy).toContain("'wasm-unsafe-eval'");
  expect(scriptPolicy).not.toContain("'unsafe-eval'");
});
