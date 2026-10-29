import { test, expect } from '@playwright/test';
import { defaultProviderProfile, type WebJobList } from '@pagelingo/document-contracts';
import { login, newReader, origin } from './library-helpers';

for (const scenario of [
  { name: 'enabled', autoTranslate: true, key: true, skip: false, language: 'en', translates: true },
  { name: 'disabled', autoTranslate: false, key: true, skip: false, language: 'en', translates: false },
  { name: 'no-Key', autoTranslate: true, key: false, skip: false, language: 'en', translates: false },
  { name: 'explicit opt-out', autoTranslate: true, key: true, skip: true, language: 'en', translates: false },
  { name: 'Chinese', autoTranslate: true, key: true, skip: false, language: 'zh', translates: false },
]) {
  test(`new site link follows future-save policy: ${scenario.name}`, async ({ page }) => {
    await newReader(page, 'link-policy');
    const session = await (await page.request.get('/api/v1/auth/session')).json();
    const headers = { Origin: origin, 'X-CSRF-Token': session.csrfToken };
    const { revision, hasApiKey, ...settings } = defaultProviderProfile;
    const saveProvider = (expectedRevision: number) => page.request.put('/api/v1/settings/provider', {
      headers,
      data: { expectedRevision, settings: { ...settings, baseUrl: 'https://mock.example/v1', model: 'test-model' }, key: scenario.key ? { action: 'replace', value: 'test-only-key' } : { action: 'keep' } },
    });
    expect((await saveProvider(0)).status()).toBe(200);
    expect((await page.request.put('/api/v1/settings/save-preferences', { headers, data: { expectedRevision: 0, autoTranslate: scenario.autoTranslate } })).status()).toBe(200);
    await page.getByRole('button', { name: '添加链接', exact: true }).click();
    await page.getByLabel('网页地址').fill(`https://site-link-fixture.example/${scenario.language}`);
    await page.getByLabel('链接标题').fill(`Future save ${scenario.name}`);
    if (scenario.skip) await page.getByLabel('本次不自动翻译').check();
    const saving = page.waitForResponse(response => response.url().endsWith('/documents/links') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '保存链接', exact: true }).click();
    const response = await saving;
    expect(response.status()).toBe(201);
    expect(response.request().postDataJSON().translationIntent).toBe(scenario.skip ? 'none' : 'auto');
    const saved = await response.json();
    const jobs = async () => (await (await page.request.get(`/api/v1/documents/${saved.documentId}/web-jobs`)).json()) as WebJobList;
    await expect.poll(async () => (await jobs()).items.find(job => job.id === saved.jobId)?.status).toBe('completed');
    if (scenario.translates) await expect.poll(async () => (await jobs()).items.find(job => job.kind === 'translate')?.status).toBe('completed');
    const before = (await jobs()).items;
    expect(before.filter(job => job.kind === 'translate')).toHaveLength(scenario.translates ? 1 : 0);
    await page.goto(`/library/${saved.documentId}`);
    await expect(page.getByLabel('正文，可独立滚动')).toContainText(scenario.language === 'zh' ? '这是已保存的中文原文' : 'The reader can save');
    await page.reload();
    await expect(page.getByLabel('正文，可独立滚动')).toBeVisible();
    // Configuration changes affect future saves, never backfill this accepted link.
    expect((await page.request.put('/api/v1/settings/save-preferences', { headers, data: { expectedRevision: 1, autoTranslate: !scenario.autoTranslate } })).status()).toBe(200);
    expect((await saveProvider(1)).status()).toBe(200);
    await page.waitForTimeout(1700);
    expect((await jobs()).items.map(job => job.id).sort()).toEqual(before.map(job => job.id).sort());
  });
}

test('link retries retain unresolved identity until acknowledgement and explicit new actions reset intent', async ({ page }, testInfo) => {
  await newReader(page, 'link-retry');
  const requests: { key: string; body: Record<string, unknown>; documentId: string }[] = [];
  await page.route('**/api/v1/documents/links', async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    requests.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON(), documentId: (await response.json()).documentId });
    if (requests.length <= 2) return route.fulfill({ status: 503, json: { error: { code: 'RESPONSE_LOST' } } });
    return route.fulfill({ response });
  });
  const open = () => page.getByRole('button', { name: '添加链接', exact: true }).click();
  const save = () => page.getByRole('button', { name: '保存链接', exact: true }).click();
  const retry = () => page.getByRole('button', { name: '重试本次保存', exact: true }).click();
  await open();
  await page.getByLabel('网页地址').fill('https://github.com/example/retry-intent');
  await page.getByLabel('链接标题').fill('Retry identity');
  await page.screenshot({ path: testInfo.outputPath('link-dialog-desktop-light.png'), fullPage: true });
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('link-dialog-mobile-light.png'), fullPage: true });
  await page.setViewportSize(viewport);
  await save();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('本次不自动翻译')).toBeDisabled();
  await retry();
  await expect.poll(() => requests.length).toBe(2);
  await expect(page.getByRole('alert')).toBeVisible();
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0].body.translationIntent).toBe('auto');
  await expect(page.getByLabel('本次不自动翻译')).toBeDisabled();
  await page.getByRole('dialog').locator('form').getByRole('button', { name: '关闭', exact: true }).click();
  await open();
  await retry();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(requests[2]).toEqual(requests[0]);
  await open();
  await page.getByLabel('网页地址').fill('https://github.com/example/retry-intent');
  await page.getByLabel('链接标题').fill('Retry identity');
  await page.getByLabel('本次不自动翻译').check();
  await save();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(requests[3].key).not.toBe(requests[0].key);
  expect(requests[3].body.translationIntent).toBe('none');
  expect(requests[3].documentId).toBe(requests[0].documentId);
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const headers = { Origin: origin, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': requests[0].key };
  expect((await page.request.post('/api/v1/documents/links', { headers, data: requests[0].body })).status()).toBe(201);
  expect((await page.request.post('/api/v1/documents/links', { headers, data: requests[3].body })).status()).toBe(409);
  await open();
  await expect(page.getByLabel('本次不自动翻译')).not.toBeChecked();
  await page.getByLabel('本次不自动翻译').check();
  await page.getByLabel('网页地址').fill('https://github.com/private/draft');
  await page.getByRole('dialog').locator('form').getByRole('button', { name: '关闭', exact: true }).click();
  await open();
  await expect(page.getByLabel('本次不自动翻译')).not.toBeChecked();
  await expect(page.getByLabel('网页地址')).toBeEmpty();
  await page.getByLabel('本次不自动翻译').check();
  await page.getByLabel('网页地址').fill('https://github.com/private/account-draft');
  expect((await page.request.post('/api/v1/auth/logout', { headers, data: {} })).status()).toBe(200);
  await page.evaluate(() => { const channel = new BroadcastChannel('pgl-session'); channel.postMessage('changed'); channel.close(); });
  await expect(page).toHaveURL(/\/login$/);
  await login(page);
  await open();
  await expect(page.getByLabel('本次不自动翻译')).not.toBeChecked();
  await expect(page.getByLabel('网页地址')).toBeEmpty();
});

test('stale classification rejection releases the frozen link action for correction', async ({ page, browser }) => {
  await newReader(page, 'stale-classification');
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const headers = { Origin: origin, 'X-CSRF-Token': session.csrfToken };
  const collection = await (await page.request.post('/api/v1/collections', { headers, data: { name: 'Soon deleted' } })).json();
  await page.getByRole('button', { name: '添加链接', exact: true }).click();
  await page.getByLabel('网页地址').fill('https://www.zhihu.com/question/stale-choice');
  await page.getByLabel('所属集合').selectOption(collection.id);
  // A second authenticated tab deletes the selected classification after form selection.
  const second = await browser.newContext({ storageState: await page.context().storageState() });
  expect((await second.request.delete(`${origin}/api/v1/collections/${collection.id}`, { headers })).status()).toBe(204);
  await second.close();
  const sent: { key: string; body: any }[] = [];
  page.on('request', request => { if (request.url().endsWith('/documents/links') && request.method() === 'POST') sent.push({ key: request.headers()['idempotency-key'], body: request.postDataJSON() }); });
  await page.getByRole('button', { name: '保存链接', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('网页地址')).toBeEnabled();
  await page.getByLabel('所属集合').selectOption('');
  await page.getByRole('button', { name: '保存链接', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(sent).toHaveLength(2); expect(sent[1].key).not.toBe(sent[0].key);
  expect(sent[0].body.organization.collectionId).toBe(collection.id);
  expect(sent[1].body.organization).toBeUndefined();
});

test('a trashed duplicate shows a restore path and releases the rejected action', async ({ page }) => {
  await newReader(page, 'trashed-save');
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const headers = { Origin: origin, 'X-CSRF-Token': session.csrfToken };
  const url = 'https://www.zhihu.com/question/restore-save';
  const original = await (await page.request.post('/api/v1/documents/links', { headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() }, data: { url, translationIntent: 'none' } })).json();
  expect((await page.request.post(`/api/v1/documents/${original.documentId}/trash`, { headers, data: { expectedEpoch: 1 } })).status()).toBe(200);
  await page.getByRole('button', { name: '添加链接', exact: true }).click(); await page.getByLabel('网页地址').fill(url);
  await page.getByRole('button', { name: '保存链接', exact: true }).click();
  await expect(page.getByRole('link', { name: '前往回收站恢复' })).toHaveAttribute('href', '/trash');
  await expect(page.getByLabel('网页地址')).toBeEnabled();
  expect((await page.request.post(`/api/v1/documents/${original.documentId}/restore`, { headers, data: { expectedEpoch: 2 } })).status()).toBe(200);
  await page.getByRole('button', { name: '保存链接', exact: true }).click(); await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('link', { name: '查看已保存资料', exact: true })).toHaveAttribute('href', `/library/${original.documentId}`);
});
