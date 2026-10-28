import { test, expect, type Page } from '@playwright/test';
import { newReader, origin } from './library-helpers';
import { archive } from './web-helpers';

async function save(page: Page, url: string) {
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const response = await page.request.post('/api/v1/documents/links', {
    headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() },
    data: { url, translationIntent: 'none' },
  });
  expect(response.status()).toBe(201);
  return response.json();
}

test('reads fixed sources after origin disappears and retries one explicit refresh after lost acknowledgement', async ({ page }, info) => {
  await newReader(page, 'source-ui');
  const saved = await save(page, 'https://github.com/Org/Repo');
  await expect.poll(async () => (await page.request.get(`/api/v1/documents/${saved.documentId}/web-reader`)).status(), { timeout: 10000 }).toBe(200);
  await page.route('https://github.com/**', route => route.abort());
  await page.goto(`/library/${saved.documentId}`);
  await expect(page.getByLabel('正文，可独立滚动')).toContainText('Fixed source');
  await page.getByText('管理资料', { exact: true }).click();
  await expect(page.getByLabel('来源详情')).toContainText('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  await expect(page.getByRole('link', { name: '下载 README 原文' })).toHaveAttribute('href', /source-assets\/[a-f0-9-]+$/);
  const attempts: { key: string; body: unknown; job: string }[] = [];
  await page.route(`**/api/v1/documents/${saved.documentId}/source-refresh`, async route => {
    const response = await route.fetch();
    attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON(), job: (await response.json()).jobId });
    if (attempts.length === 1) return route.abort('connectionreset');
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '获取新来源版本', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试本次更新', exact: true })).toBeVisible();
  await expect(page.getByLabel('来源版本引用')).toBeDisabled();
  await page.getByText('管理资料', { exact: true }).click();
  await page.getByText('管理资料', { exact: true }).click();
  await expect(page.getByLabel('来源版本引用')).toBeDisabled();
  await page.getByRole('button', { name: '重试本次更新', exact: true }).click();
  await expect.poll(() => attempts.length).toBe(2);
  expect(attempts[1]).toEqual(attempts[0]);
  await expect.poll(async () => (await (await page.request.get(`/api/v1/documents/${saved.documentId}/source-details`)).json()).latestAttempt.status).toBe('completed');
  await page.getByRole('button', { name: '刷新来源状态', exact: true }).click();
  await expect(page.getByLabel('最近来源请求')).toContainText('完成');
  for (const [width, theme] of [[1280, 'light'], [1280, 'dark'], [375, 'light'], [375, 'dark']] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: process.env.PAGELINGO_TEST_SOURCE_EVIDENCE_DIR ? `${process.env.PAGELINGO_TEST_SOURCE_EVIDENCE_DIR}/source-${width}-${theme}.png` : info.outputPath(`source-${width}-${theme}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  const summary = page.locator('.management-panel > summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.management-panel')).not.toHaveAttribute('open');
  await expect(summary).toBeFocused();
  expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await page.getByLabel('正文，可独立滚动').boundingBox())!.height).toBeGreaterThanOrEqual(240);
});

test('links an explicitly selected discovered document and preserves the existing collection', async ({ page }) => {
  await newReader(page, 'source-discovery');
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const headers = { Origin: origin, 'X-CSRF-Token': session.csrfToken };
  const originalCollection = await (await page.request.post('/api/v1/collections', { headers, data: { name: '原有收藏' } })).json();
  const selectedCollection = await (await page.request.post('/api/v1/collections', { headers, data: { name: '本次选择' } })).json();
  const existing = await save(page, 'https://github.com/Org/Repo');
  expect((await page.request.patch(`/api/v1/documents/${existing.documentId}/organization`, { headers, data: { expectedRevision: 0, collectionId: originalCollection.id } })).status()).toBe(200);
  const source = await archive(page, '<article><h1>发现来源</h1><p>这是归档正文。<a href="https://github.com/Org/Repo">项目文档</a></p></article>');
  await page.goto(`/library/${source.documentId}`);
  await page.getByText('收藏本段外链', { exact: true }).click();
  await page.getByRole('button', { name: '收藏外链：项目文档', exact: true }).click();
  await expect(page.getByLabel('网页地址')).toHaveValue('https://github.com/Org/Repo');
  await page.getByRole('combobox', { name: '所属集合', exact: true }).selectOption(selectedCollection.id);
  await page.getByLabel('本次不自动翻译').check();
  const attempts: { key: string; body: unknown }[] = [];
  await page.route('**/api/v1/documents/links', async route => {
    const response = await route.fetch();
    attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
    if (attempts.length === 1) return route.abort('connectionreset');
    await route.fulfill({ response });
  });
  const posted = page.waitForResponse(r => r.url().endsWith('/documents/links') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '保存链接', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试本次保存', exact: true })).toBeVisible();
  await expect(page.getByLabel('网页地址')).toBeDisabled();
  await page.getByRole('button', { name: '重试本次保存', exact: true }).click();
  const response = await posted;
  expect(attempts[1]).toEqual(attempts[0]);
  expect(response.request().postDataJSON().discoveredFromDocumentId).toBe(source.documentId);
  const result = await response.json();
  expect(result.documentId).toBe(existing.documentId);
  const organization = await (await page.request.get(`/api/v1/documents/${result.documentId}/organization`)).json();
  expect(organization.collectionId).toBe(originalCollection.id);
  const relations = await (await page.request.get(`/api/v1/documents/${result.documentId}/relations`)).json();
  expect(relations.items).toEqual(expect.arrayContaining([expect.objectContaining({ fromDocumentId: result.documentId, toDocumentId: source.documentId, kind: 'discovered-from' })]));
  await expect(page.getByRole('link', { name: '查看已保存资料', exact: true })).toHaveAttribute('href', `/library/${result.documentId}`);
});

test('paper selection imports an explicit fixed target, retains historical originals, and refuses mismatched Reader pairs', async ({ page }) => {
  test.setTimeout(45000); // Three fixed arXiv acquisitions honor the real cross-process cooldown.
  const { readerBundle } = await import('./reader-helpers');
  const bundle = await readerBundle();
  await newReader(page, 'paper-ui');
  expect((await page.request.post('/__test/source-fixture', { data: { version: 1, pdf: bundle.pdf.toString('base64') } })).status()).toBe(200);
  const saved = await save(page, 'https://arxiv.org/html/2401.12345v1');
  const details = () => page.request.get(`/api/v1/documents/${saved.documentId}/source-details`).then(r => r.json());
  await expect.poll(async () => (await details()).status, { timeout: 12000 }).toBe('source-saved');
  const first = (await details()).current;
  await page.goto(`/library/${saved.documentId}`);
  await expect(page.getByRole('img', { name: /PDF 第 1 页/ })).toBeVisible();
  await page.getByText('管理资料', { exact: true }).click();
  await page.getByRole('button', { name: '导入阅读包', exact: true }).click();
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { bundleFixture } = await import('../../../document-service/tests/helpers/bundles');
  const root = await mkdtemp(join(tmpdir(), 'task10-paper-mismatch-'));
  let wrongBytes: Buffer;
  try { wrongBytes = (await bundleFixture(root)).bytes; }
  finally { await rm(root, { recursive: true, force: true }); }
  await page.getByLabel('阅读包 ZIP').setInputFiles({ name: 'wrong-source.zip', mimeType: 'application/zip', buffer: wrongBytes });
  await page.getByRole('button', { name: '开始导入', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('阅读包与此 PDF 原件不匹配');
  await page.getByLabel('阅读包 ZIP').setInputFiles(bundle);
  const admission = page.waitForResponse(r => r.url().endsWith('/api/v1/bundle-imports') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '开始导入', exact: true }).click();
  const accepted = await admission;
  expect(accepted.request().postDataJSON()).toEqual({ targetDocumentId: saved.documentId, targetSourceVersionId: first.sourceVersionId, targetPaperVersion: 1 });
  await expect.poll(async () => (await (await page.request.get(`/api/v1/documents/${saved.documentId}`)).json()).reader?.versionId).toMatch(/^[a-f0-9-]{36}$/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  const original = await page.request.get(`/api/v1/assets/${first.pdf.assetId}/content`);
  expect(Buffer.from(await original.body())).toEqual(bundle.pdf);
  expect((await page.request.post('/__test/source-fixture', { data: { version: 2, pdf: bundle.pdf.toString('base64') } })).status()).toBe(200);
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const refresh = await page.request.post(`/api/v1/documents/${saved.documentId}/source-refresh`, { headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() }, data: { ref: '2401.12345v2', translationIntent: 'none' } });
  expect(refresh.status()).toBe(202);
  await expect.poll(async () => (await details()).current?.version, { timeout: 12000 }).toBe(2);
  const second = (await details()).current;
  expect(second.sourceVersionId).toBe(first.sourceVersionId);
  const summary = await (await page.request.get(`/api/v1/documents/${saved.documentId}`)).json();
  await page.goto(`/library/${saved.documentId}?versionId=${summary.reader.versionId}`);
  await page.getByText('管理资料', { exact: true }).click();
  await expect(page.getByLabel('来源详情')).toContainText('对应多个来源版本');
  await page.getByText('来源版本与材料', { exact: true }).click();
  await page.getByRole('combobox', { name: '来源版本', exact: true }).selectOption(first.id);
  await page.getByRole('button', { name: '查找此来源的阅读版本', exact: true }).click();
  await page.getByRole('link', { name: '阅读已验证版本 1', exact: true }).click();
  await expect(page.getByLabel('来源详情')).toContainText('arXiv 2401.12345v1');
  const { buildPdfFixture } = await import('../../../../tests/fixtures/pdf');
  await page.request.post('/__test/source-fixture', { data: { version: 3, pdf: Buffer.from(buildPdfFixture(3)).toString('base64') } });
  expect((await page.request.post(`/api/v1/documents/${saved.documentId}/source-refresh`, { headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() }, data: { ref: '2401.12345v3', translationIntent: 'none' } })).status()).toBe(202);
  await expect.poll(async () => (await details()).current?.version, { timeout: 12000 }).toBe(3);
  const third = (await details()).current;
  expect(third.sourceVersionId).not.toBe(first.sourceVersionId);
  expect((await page.request.get(`/api/v1/documents/${saved.documentId}/source-details?readerVersionId=${summary.reader.versionId}&revisionId=${third.id}`)).status()).toBe(404);
  const originals: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/v1/assets/') && request.url().includes('/content')) originals.push(request.url()); });
  await page.reload();
  await page.getByText('管理资料', { exact: true }).click();
  await expect(page.getByLabel('来源详情')).toContainText('arXiv 2401.12345v1');
  await page.getByRole('combobox', { name: '阅读视图', exact: true }).selectOption('source');
  await expect(page.getByRole('img', { name: /PDF 第 1 页/ })).toBeVisible();
  await expect(page.locator('.page-header')).not.toContainText('等待本地处理');
  expect(originals.some(url => url.includes(first.pdf.assetId))).toBe(true);
  expect(originals.some(url => url.includes(third.pdf.assetId))).toBe(false);
  for (const [width, theme] of [[1280, 'light'], [1280, 'dark'], [375, 'light'], [375, 'dark']] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: process.env.PAGELINGO_TEST_SOURCE_EVIDENCE_DIR ? `${process.env.PAGELINGO_TEST_SOURCE_EVIDENCE_DIR}/paper-${width}-${theme}.png` : test.info().outputPath(`paper-${width}-${theme}.png`), fullPage: true });
  }
  expect((await (await page.request.get('/__test/metrics')).json()).modelCalls).toBe(0);
});

test('aliases navigate explicitly and conflict records keep edited data', async ({ page }) => {
  await newReader(page, 'source-alias');
  const canonical = await save(page, 'https://github.com/Org/Repo');
  await expect.poll(async () => (await (await page.request.get(`/api/v1/documents/${canonical.documentId}/source-details`)).json()).status, { timeout: 10000 }).toMatch(/source-saved|partial-resources/);
  const alias = await save(page, 'https://github.com/Renamed/Repo');
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const conflictResponse = await page.request.post('/api/v1/documents/links', { headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() }, data: { url: 'https://github.com/Edited/Repo', title: 'Keep my edited source', translationIntent: 'none' } });
  const conflict = await conflictResponse.json();
  for (const [item, resolution] of [[alias, 'alias'], [conflict, 'conflict']] as const) {
    await expect.poll(async () => (await (await page.request.get(`/api/v1/documents/${item.documentId}/source-details`)).json()).resolution).toBe(resolution);
    await page.goto(`/library/${item.documentId}`);
    await page.getByText('管理资料', { exact: true }).click();
    await expect(page.getByRole('link', { name: '查看本人已保存资料', exact: true })).toHaveAttribute('href', `/library/${canonical.documentId}`);
    expect(page.url()).toContain(item.documentId);
  }
  await expect(page.getByLabel('资料标题', { exact: true })).toHaveValue('Keep my edited source');
  await page.getByRole('link', { name: '查看本人已保存资料', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(canonical.documentId));
});

test('late source responses cannot enter the next account or authentication epoch', async ({ page }) => {
  const { login } = await import('./library-helpers');
  await newReader(page, 'source-owner');
  const saved = await save(page, 'https://github.com/Org/Repo');
  await expect.poll(async () => (await (await page.request.get(`/api/v1/documents/${saved.documentId}/source-details`)).json()).current?.sourceVersionId).toMatch(/^[a-f0-9-]{36}$/);
  await page.goto(`/library/${saved.documentId}`);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  await page.route(`**/api/v1/documents/${saved.documentId}/source-details*`, async route => {
    const response = await route.fetch();
    entered();
    await held;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.getByText('管理资料', { exact: true }).click();
  await started;
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await login(page);
  release();
  await page.waitForTimeout(300);
  await expect(page.getByText('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { exact: true })).toHaveCount(0);
  await page.goto(`/library/${saved.documentId}`);
  await expect(page.getByRole('alert')).toContainText('资料不存在或当前账号无权读取');
});
test('unconfirmed paper import retains its File and exact target when the current source changes', async ({ page }) => {
  test.setTimeout(45000);
  const { readerBundle } = await import('./reader-helpers');
  const { buildPdfFixture } = await import('../../../../tests/fixtures/pdf');
  const { createHash } = await import('node:crypto');
  const bundle = await readerBundle();
  await newReader(page, 'paper-admission');
  await page.request.post('/__test/source-fixture', { data: { version: 1, pdf: bundle.pdf.toString('base64') } });
  const saved = await save(page, 'https://arxiv.org/abs/2401.12345v1');
  const details = () => page.request.get(`/api/v1/documents/${saved.documentId}/source-details`).then(response => response.json());
  await expect.poll(async () => (await details()).status, { timeout: 12000 }).toBe('source-saved');
  const first = (await details()).current;
  await page.goto(`/library/${saved.documentId}`);
  await page.getByText('管理资料', { exact: true }).click();
  const admissions: { key: string; body: unknown }[] = [];
  await page.route('**/api/v1/bundle-imports', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    admissions.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
    if (admissions.length === 1) return route.abort('connectionreset');
    await route.fulfill({ response });
  });
  const uploaded: string[] = [];
  page.on('request', request => {
    if (request.method() === 'PUT' && /\/bundle-imports\/[^/]+\/content$/.test(request.url())) {
      uploaded.push(createHash('sha256').update(request.postDataBuffer()!).digest('hex'));
    }
  });
  await page.getByRole('button', { name: '导入阅读包', exact: true }).click();
  await page.getByLabel('阅读包 ZIP').setInputFiles(bundle);
  await page.getByRole('button', { name: '开始导入', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('导入尚未确认');
  await expect(page.getByRole('dialog').locator('.recent-imports button').first()).toBeDisabled();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  await page.request.post('/__test/source-fixture', { data: { version: 2, pdf: Buffer.from(buildPdfFixture(3)).toString('base64') } });
  expect((await page.request.post(`/api/v1/documents/${saved.documentId}/source-refresh`, {
    headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() },
    data: { ref: '2401.12345v2', translationIntent: 'none' },
  })).status()).toBe(202);
  await expect.poll(async () => (await details()).current?.version, { timeout: 12000 }).toBe(2);
  await page.getByRole('button', { name: '刷新来源状态', exact: true }).click();
  await expect(page.getByLabel('来源详情')).toContainText('Paper version 2');
  await page.getByText('来源版本与材料', { exact: true }).click();
  await expect(page.getByRole('combobox', { name: '来源版本', exact: true })).toBeDisabled();
  const retained = page.getByRole('region', { name: '待确认的论文导入', exact: true });
  await expect(retained).toContainText('arXiv 2401.12345v1');
  await retained.getByRole('button', { name: '导入阅读包', exact: true }).click();
  await expect(page.getByText('已选择：reader.zip', { exact: true })).toBeVisible();
  await expect(page.getByLabel('阅读包 ZIP')).toBeDisabled();
  await page.getByRole('button', { name: '重试导入', exact: true }).click();
  await expect.poll(() => uploaded.length).toBe(1);
  expect(admissions[1]).toEqual(admissions[0]);
  expect(admissions[0].body).toEqual({ targetDocumentId: saved.documentId, targetSourceVersionId: first.sourceVersionId, targetPaperVersion: 1 });
  expect(uploaded[0]).toBe(createHash('sha256').update(bundle.buffer).digest('hex'));
  await expect.poll(async () => (await (await page.request.get('/api/v1/bundle-imports')).json())[0]?.status).toBe('completed');
  const current = await (await page.request.get(`/api/v1/documents/${saved.documentId}`)).json();
  expect(current.source.sourceVersionId).not.toBe(first.sourceVersionId);
  expect(current.reader).toBeNull();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('combobox', { name: '来源版本', exact: true })).toBeEnabled();
});

test('a repeated link save offers the owned existing item explicitly', async ({ page }) => {
  await newReader(page, 'source-existing');
  const saved = await save(page, 'https://github.com/Org/Repo');
  await page.goto('/library');
  await page.getByRole('button', { name: '添加链接', exact: true }).click();
  await page.getByLabel('网页地址').fill('https://github.com/Org/Repo');
  await page.getByRole('button', { name: '保存链接', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('link', { name: '查看已保存资料', exact: true })).toHaveAttribute('href', `/library/${saved.documentId}`);
});
