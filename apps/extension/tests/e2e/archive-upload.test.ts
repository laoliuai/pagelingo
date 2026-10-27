import { fileURLToPath } from 'node:url';
import { inspectImageResource, sha256 } from '@pagelingo/web-capture';
import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { createWebCaptureRequestSchema, createDocumentLinkRequestSchema, type WebCaptureResult } from '@pagelingo/document-contracts';
import { test } from './extension-fixture';

// A local fault-injection HTTP peer, not a replacement for the service integration suite.
function faultSite() {
  const siteId = randomUUID(); const owners = { A: randomUUID(), B: randomUUID() }; const records = new Map<string, { request: any; result: WebCaptureResult; owner: string }>();
  let hold = true; let lostAck = true; let documents = 0; let bUploadedA = false; let revoked = false; const filePuts: string[] = []; const links = new Map<string, unknown>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const bytes = Buffer.concat(chunks);
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const path = req.url!;
    try {
      if (path === '/api/v1/devices/exchange') { const body = JSON.parse(bytes.toString()); const owner = body.code === 'B' ? 'B' : 'A'; send(201, { token: owner, device: { id: randomUUID(), name: 'Browser', createdAt: new Date().toISOString(), expiresAt: '2027-01-01T00:00:00Z', revokedAt: null }, owner: { id: owners[owner], username: owner }, siteId }); return; }
      const owner = req.headers.authorization?.replace('Bearer ', '');
      if (!['A','B'].includes(owner ?? '') || revoked) { send(401, { error: { code: 'UNAUTHORIZED' } }); return; }
      if (path === '/api/v1/documents/links') {
        const input = createDocumentLinkRequestSchema.parse(JSON.parse(bytes.toString())); const key = `${owner}/${req.headers['idempotency-key']}`;
        if (!links.has(key)) links.set(key, { documentId: randomUUID(), jobId: null });
        expect(input.translationIntent).toBe('auto'); send(201, links.get(key)); return;
      }
      if (path === '/api/v1/captures' && req.method === 'POST') {
        const input = createWebCaptureRequestSchema.parse(JSON.parse(bytes.toString())); expect(input.translationIntent).toBe('auto'); const key = `${owner}/${req.headers['idempotency-key']}`;
        if (hold) { send(503, { error: { code: 'OFFLINE' } }); return; }
        let item = records.get(key);
        if (!item) { const timestamp = new Date().toISOString(); item = { request: input, owner: owner!, result: { id: randomUUID(), captureId: input.manifest.captureId, status: 'created', receivedFileIds: [], missingFileIds: input.manifest.files.map(f => f.id), documentId: null, sourceVersionId: null, readerVersionId: null, jobId: null, saveStatus: null, errorCode: null, warnings: [], createdAt: timestamp, updatedAt: timestamp } }; records.set(key, item); }
        else expect(input).toEqual(item.request);
        send(201, item.result); return;
      }
      const item = [...records.values()].find(item => path.startsWith(`/api/v1/captures/${item.result.id}`));
      if (!item) { send(404, {}); return; }
      if (item.owner !== owner) { bUploadedA = true; send(403, {}); return; }
      if (path.includes('/files/')) { const id = decodeURIComponent(path.split('/files/')[1]!); const descriptor = item.request.manifest.files.find((file: any) => file.id === id); expect(createHash('sha256').update(bytes).digest('hex')).toBe(descriptor.sha256); filePuts.push(id); item.result.receivedFileIds.push(id); item.result.missingFileIds = item.result.missingFileIds.filter(file => file !== id); }
      if (path.endsWith('/commit')) {
        expect(item.result.missingFileIds).toEqual([]);
        if (item.result.status !== 'completed') { documents++; Object.assign(item.result, { status: 'completed', documentId: randomUUID(), sourceVersionId: randomUUID(), readerVersionId: randomUUID(), saveStatus: item.request.manifest.resources.some((r: any) => r.status === 'missing') ? 'partial-resources' : 'original-saved' }); }
        if (lostAck) { lostAck = false; send(503, { error: { code: 'ACK_LOST_AFTER_COMMIT' } }); return; }
      }
      if (path.endsWith('/cancel') && item.result.status !== 'completed') item.result.status = 'cancelled';
      send(200, item.result);
    } catch (error) { send(400, { error: String(error) }); }
  });
  return { server, release: () => { hold = false; }, revoke: () => { revoked = true; }, count: () => documents, bUploadedA: () => bUploadedA, puts: filePuts, records, links };
}
async function listen(server: Server) { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; }
async function rpc(page: Page, input: unknown): Promise<any> { return page.evaluate(value => chrome.runtime.sendMessage(value), input); }
async function capture(control: Page, page: Page) { const tabId = await control.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url)!.id, page.url()); return rpc(control, { type: 'archive:capture', tabId }); }
async function pair(control: Page, origin: string, code = 'A') { const result = await rpc(control, { type: 'archive:pair', origin, code }); expect(result.ok).toBe(true); }

test('archive survives popup/page close and actual worker termination; lost commit ACK creates one document', async ({ control, context, page, extensionId }) => {
  const site = faultSite(); const origin = await listen(site.server);
  try {
    await pair(control, origin); await page.goto('http://127.0.0.1:4317/archive-source.html?utm_source=test&part=two#here');
    const saved = await capture(control, page); expect(saved.ok, JSON.stringify(saved)).toBe(true);
    await expect.poll(async () => (await rpc(control, { type: 'archive:status' })).value.items[0]?.state).toBe('retry');
    const before = (await rpc(control, { type: 'archive:status' })).value.items[0]; expect(before.saveStatus).toBeNull();
    await page.close(); await control.close();
    const reopened = await context.newPage(); await reopened.goto(`chrome-extension://${extensionId}/src/options/index.html`);
    const session = await context.newCDPSession(reopened); await session.send('ServiceWorker.enable'); await session.send('ServiceWorker.stopAllWorkers');
    site.release(); await rpc(reopened, { type: 'archive:retry', id: saved.value.id });
    await expect.poll(async () => (await rpc(reopened, { type: 'archive:status' })).value.items[0]?.state).toBe('completed');
    expect(site.count()).toBe(1); expect(new Set(site.puts).size).toBe(site.puts.length);
    expect(site.records.values().next().value!.request.manifest.resources[0].status).toBe('available');
  } finally { await new Promise<void>(resolve => site.server.close(() => resolve())); }
});
test('new owner cannot inspect or deliver queued archives; same-owner reconnect retains capture UUID', async ({ control, page }) => {
  const site = faultSite(); const origin = await listen(site.server);
  try {
    await pair(control, origin); await page.goto('http://127.0.0.1:4317/archive-source.html'); const saved = await capture(control, page); expect(saved.ok, JSON.stringify(saved)).toBe(true);
    await expect.poll(async () => (await rpc(control, { type: 'archive:status' })).value.items[0]?.state).toBe('retry');
    await pair(control, origin, 'B'); expect((await rpc(control, { type: 'archive:status' })).value.items).toEqual([]);
    site.release(); await rpc(control, { type: 'archive:retry' }); expect(site.bUploadedA()).toBe(false); expect(site.count()).toBe(0);
    await pair(control, origin); await rpc(control, { type: 'archive:retry', id: saved.value.id }); await rpc(control, { type: 'archive:retry', id: saved.value.id });
    await expect.poll(async () => (await rpc(control, { type: 'archive:status' })).value.items[0]?.state).toBe('completed'); expect(site.count()).toBe(1);
  } finally { await new Promise<void>(resolve => site.server.close(() => resolve())); }
});
test('connection and capture UI keep server confirmation and resource consent visible', async ({ control, context, page, extensionId }) => {
  const site = faultSite(); const origin = await listen(site.server);
  try {
    await expect(control.getByRole('heading', { name: '资料站点' })).toBeVisible();
    await control.getByLabel('站点地址').fill(origin); await control.getByLabel('一次性配对码').fill('A');
    await control.getByRole('button', { name: '授权并连接站点' }).click();
    await expect(control.getByText('已连接 · A')).toBeVisible();
    await page.goto('http://127.0.0.1:4317/archive-source.html');
    await page.evaluate(() => { const img = document.createElement('img'); img.src = 'https://resources.example.test/photo.png'; document.querySelector('article')!.append(img); });
    const saved = await capture(control, page); expect(saved.ok, JSON.stringify(saved)).toBe(true);
    const popup = await context.newPage(); await popup.setViewportSize({ width: 360, height: 600 }); await page.bringToFront(); await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
    await expect(popup.getByText('等待资源授权')).toBeVisible();
    await expect(popup.getByText('原文已保存', { exact: true })).toHaveCount(0);
    await popup.locator('.popup').screenshot({ path: fileURLToPath(new URL('../../../../.superpowers/sdd/2026-10-27-learning-site-s3/task-8-popup.png', import.meta.url)) });
    await control.screenshot({ path: fileURLToPath(new URL('../../../../.superpowers/sdd/2026-10-27-learning-site-s3/task-8-options.png', import.meta.url)), fullPage: true });
    await popup.screenshot({ path: fileURLToPath(new URL('../../../../.superpowers/sdd/2026-10-27-learning-site-s3/task-8-popup-viewport.png', import.meta.url)) });
    await popup.emulateMedia({ colorScheme: 'dark' });
    await popup.screenshot({ path: fileURLToPath(new URL('../../../../.superpowers/sdd/2026-10-27-learning-site-s3/task-8-popup-dark.png', import.meta.url)) });
    await control.setViewportSize({ width: 390, height: 844 });
    await control.getByRole('region', { name: '资料站点连接' }).screenshot({ path: fileURLToPath(new URL('../../../../.superpowers/sdd/2026-10-27-learning-site-s3/task-8-options-mobile.png', import.meta.url)) });
    expect(await control.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await popup.evaluate(() => { chrome.permissions.request = async () => false; });
    await popup.getByRole('button', { name: '授权资源并保存' }).click();
    await expect(popup.getByRole('region', { name: '保存资料' }).getByRole('alert')).toContainText('资源访问未获授权');
    await popup.getByRole('button', { name: '不授权，继续保存' }).click();
    await expect(popup.getByText('等待重试')).toBeVisible();
    site.release(); await rpc(control, { type: 'archive:retry', id: saved.value.id });
    await expect(popup.getByText('原文已保存，部分资源缺失')).toBeVisible();
  } finally { await new Promise<void>(resolve => site.server.close(() => resolve())); }
});
test('unavailable source uses the real link request shape; revoked token leaves original unconfirmed', async ({ control, page }) => {
  const site = faultSite(); const origin = await listen(site.server);
  try {
    await pair(control, origin); await page.goto('http://127.0.0.1:4317/archive-source.html?utm_source=test&part=link#read');
    await page.evaluate(() => { document.body.innerHTML = '<article>First candidate</article><article>Second candidate</article>'; });
    expect((await capture(control, page)).ok).toBe(true);
    await expect.poll(async () => (await rpc(control, { type: 'archive:status' })).value.items[0]?.saveStatus).toBe('link-only'); expect(site.links.size).toBe(1); expect(site.count()).toBe(0);
    await page.reload(); site.revoke(); expect((await capture(control, page)).ok).toBe(true);
    await expect.poll(async () => (await rpc(control, { type: 'archive:status' })).value.items[0]?.state).toBe('manual');
    expect((await rpc(control, { type: 'archive:status' })).value.items[0].saveStatus).toBeNull();
  } finally { await new Promise<void>(resolve => site.server.close(() => resolve())); }
});
test('native blob acquisition preserves actual bytes while an encoded-but-undecodable image stays missing', async ({ control, page }) => {
  const site = faultSite(); const origin = await listen(site.server); site.release();
  // Valid PNG framing/dimensions, corrupted compressed stream: header inspection alone accepts it.
  const corrupt = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
  corrupt[43] = 0; corrupt[44] = 0;
  await inspectImageResource(corrupt, { id: 'bad', path: 'bad.png', bytes: corrupt.length, sha256: await sha256(corrupt), mediaType: 'image/png', role: 'image' });
  try {
    await pair(control, origin); await page.goto('http://127.0.0.1:4317/archive-source.html');
    await page.evaluate(async data => {
      const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 3; canvas.getContext('2d')!.fillRect(0, 0, 4, 3);
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
      const image = document.createElement('img'); image.src = URL.createObjectURL(blob); document.querySelector('article')!.append(image);
      const broken = document.createElement('img'); broken.src = `data:image/png;base64,${data}`; document.querySelector('article')!.append(broken);
    }, corrupt.toString('base64'));
    expect((await capture(control, page)).ok).toBe(true);
    await expect.poll(async () => (await rpc(control, { type: 'archive:status' })).value.items[0]?.state).toBe('completed');
    const resources = site.records.values().next().value!.request.manifest.resources;
    expect(resources.find((r: any) => r.url.startsWith('blob:')).status).toBe('available');
    expect(resources.find((r: any) => r.url.startsWith('data:image/png')).status).toBe('missing');
    expect((await rpc(control, { type: 'archive:status' })).value.items[0].saveStatus).toBe('partial-resources');
  } finally { await new Promise<void>(resolve => site.server.close(() => resolve())); }
});
