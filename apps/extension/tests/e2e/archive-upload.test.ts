import { fileURLToPath } from 'node:url';
import { inspectImageResource, sha256 } from '@pagelingo/web-capture';
import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { createWebCaptureRequestSchema, createDocumentLinkRequestSchema, type WebCaptureResult } from '@pagelingo/document-contracts';
import { test } from './extension-fixture';
import { ownPngUrl } from '../helpers/archive-boundary';
test.use({ archiveDatabaseHarness: true });

// A local fault-injection HTTP peer, not a replacement for the service integration suite.
function faultSite() {
  const siteId = randomUUID(); const owners = { A: randomUUID(), B: randomUUID() }; const records = new Map<string, { request: any; result: WebCaptureResult; owner: string }>();
  let hold = true; let lostAck = true; let documents = 0; let bUploadedA = false; let revoked = false; const filePuts: string[] = []; const calls: string[] = []; const links = new Map<string, unknown>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const bytes = Buffer.concat(chunks);
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const path = req.url!; calls.push(`${req.method} ${path}`);
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
  return { server, release: () => { hold = false; }, revoke: () => { revoked = true; }, count: () => documents, bUploadedA: () => bUploadedA, puts: filePuts, records, links, calls };
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
    const stored = await reopened.evaluate(async id => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('pagelingo-archives-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const tx = db.transaction('files'); const files = await new Promise<any[]>(resolve => { const request = tx.objectStore('files').getAll(); request.onsuccess = () => resolve(request.result); }); db.close();
      return files.filter(file => file.captureId === id).length;
    }, saved.value.id);
    expect(stored).toBe(0);
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
    await popup.locator('.popup').screenshot({ path: fileURLToPath(new URL('../../../../.superpowers/sdd/2026-10-28-learning-site-s4/task-5-evidence/popup.png', import.meta.url)) });
    await control.screenshot({ path: fileURLToPath(new URL('../../../../.superpowers/sdd/2026-10-28-learning-site-s4/task-5-evidence/options.png', import.meta.url)), fullPage: true });
    await popup.screenshot({ path: fileURLToPath(new URL('../../../../.superpowers/sdd/2026-10-28-learning-site-s4/task-5-evidence/popup-viewport.png', import.meta.url)) });
    await popup.emulateMedia({ colorScheme: 'dark' });
    await popup.screenshot({ path: fileURLToPath(new URL('../../../../.superpowers/sdd/2026-10-28-learning-site-s4/task-5-evidence/popup-dark.png', import.meta.url)) });
    await control.setViewportSize({ width: 390, height: 844 });
    await control.getByRole('region', { name: '资料站点连接' }).screenshot({ path: fileURLToPath(new URL('../../../../.superpowers/sdd/2026-10-28-learning-site-s4/task-5-evidence/options-mobile.png', import.meta.url)) });
    expect(await control.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await popup.evaluate(() => { chrome.permissions.request = async () => false; });
    await popup.getByRole('button', { name: '授权资源并保存' }).click();
    await expect(popup.getByRole('region', { name: '保存资料' }).getByRole('alert')).toContainText('资源访问未获授权');
    await popup.getByRole('button', { name: '不授权，继续保存' }).click();
    await expect(popup.getByText('等待重试')).toBeVisible();
    site.release(); await rpc(control, { type: 'archive:retry', id: saved.value.id });
    await expect(popup.getByText('原文已保存，部分资源缺失')).toBeVisible();
    await popup.screenshot({ path: fileURLToPath(new URL('../../../../.superpowers/sdd/2026-10-28-learning-site-s4/task-5-evidence/native-remove-visible.png', import.meta.url)) });
    await popup.getByRole('button', { name: '移除本地记录' }).click();
    await expect(popup.locator('.archive-item')).toHaveCount(0); expect(site.count()).toBe(1);
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

test('native v1 cursor migration is atomic under quota failure and preserves old request bytes', async ({ control }) => {
  const result = await control.evaluate(async () => {
    const { ArchiveDatabase } = await import(chrome.runtime.getURL('archive-database-harness.js'));
    const binding = { siteOrigin: 'https://own.example', siteId: crypto.randomUUID(), ownerId: crypto.randomUUID(), deviceId: crypto.randomUUID(), generation: crypto.randomUUID() };
    const partition = JSON.stringify([binding.siteOrigin,binding.siteId,binding.ownerId]); const name = `native-v1-${crypto.randomUUID()}`;
    const entry = { id: crypto.randomUUID(), partition, kind: 'link', state: 'retry', linkRequest: { url: 'https://own.example/original', translationIntent: 'none' }, resources: [], warnings: ['Own old input'], attempts: 1, nextAttemptAt: 0, createdAt: 1 };
    const bytes = new Uint8Array([0,1,2,128,255]); const file = { partition, captureId: entry.id, descriptor: { id: 'own', path: 'own.bin', role: 'image', mediaType: 'image/png', bytes: 5, sha256: 'a'.repeat(64) }, bytes };
    const open = (version: number) => new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name, version); request.onupgradeneeded = () => { const db = request.result; db.createObjectStore('entries', { keyPath: ['partition','id'] }).createIndex('partition','partition'); db.createObjectStore('files', { keyPath: ['partition','captureId','descriptor.id'] }).createIndex('capture',['partition','captureId']); }; request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const old = await open(1); const tx = old.transaction(['entries','files'], 'readwrite'); tx.objectStore('entries').put(entry); const second = { ...entry, id: crypto.randomUUID() }; tx.objectStore('entries').put(second); tx.objectStore('files').put(file); await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); old.close();
    const originalPut = IDBObjectStore.prototype.put; let attempted = false; let writes = 0;
    IDBObjectStore.prototype.put = function(...args) { if (this.name === 'payloads' && ++writes === 2) { attempted = true; throw new DOMException('Injected owned quota boundary', 'QuotaExceededError'); } return originalPut.apply(this, args); };
    let rejected = false;
    try { await new ArchiveDatabase(name).get(binding, entry.id); } catch { rejected = true; } finally { IDBObjectStore.prototype.put = originalPut; }
    const intact = await open(1); const version = intact.version; const stores = Array.from(intact.objectStoreNames);
    const read = intact.transaction(['entries','files']);
    const unchanged = await new Promise<any>(resolve => { const request = read.objectStore('entries').get([partition,entry.id]); request.onsuccess = () => resolve(request.result); });
    const unchangedSecond = await new Promise<any>(resolve => { const request = read.objectStore('entries').get([partition,second.id]); request.onsuccess = () => resolve(request.result); });
    const originalFile = await new Promise<any>(resolve => { const request = read.objectStore('files').get([partition,entry.id,'own']); request.onsuccess = () => resolve(request.result); }); intact.close();
    const upgraded = new ArchiveDatabase(name); const joined = await upgraded.get(binding, entry.id); const headers = await upgraded.list(binding); const recoveredFiles = await upgraded.files(binding, entry.id);
    return { attempted, rejected, version, stores, unchanged: JSON.stringify(unchanged) === JSON.stringify(entry) && JSON.stringify(unchangedSecond) === JSON.stringify(second), oldBytes: Array.from(originalFile.bytes), joined: JSON.stringify(joined.linkRequest) === JSON.stringify(entry.linkRequest), headerHasPayload: 'linkRequest' in headers[0], recoveredBytes: Array.from(recoveredFiles[0].bytes) };
  });
  expect(result).toEqual({ attempted: true, rejected: true, version: 1, stores: ['entries','files'], unchanged: true, oldBytes: [0,1,2,128,255], joined: true, headerHasPayload: false, recoveredBytes: [0,1,2,128,255] });
});

for (const failure of ['payload', 'file'] as const) test(`native confirmed compaction abort at ${failure} deletion keeps receipt and bytes atomic; cancellation needs explicit own-user removal`, async ({ control }) => {
  const result = await control.evaluate(async failure => {
    const { ArchiveDatabase } = await import(chrome.runtime.getURL('archive-database-harness.js'));
    const binding = { siteOrigin: 'https://own.example', siteId: crypto.randomUUID(), ownerId: crypto.randomUUID(), deviceId: crypto.randomUUID(), generation: crypto.randomUUID() };
    const partition = JSON.stringify([binding.siteOrigin,binding.siteId,binding.ownerId]); const db = new ArchiveDatabase(`native-compact-${crypto.randomUUID()}`);
    const entry = { id: crypto.randomUUID(), partition, kind: 'link', state: 'completed', completedBinding: binding, linkResult: { documentId: crypto.randomUUID(), jobId: null }, linkRequest: { url: 'https://own.example/confirmed', translationIntent: 'none' }, resources: [], warnings: [], attempts: 0, nextAttemptAt: 0, createdAt: 1 };
    const descriptor = { id: 'own', path: 'own.bin', role: 'image', mediaType: 'image/png', bytes: 3, sha256: 'b'.repeat(64) };
    await db.put(binding, entry); await db.putFile(binding, entry.id, descriptor, new Uint8Array([7,8,9]));
    const originalDelete = IDBObjectStore.prototype.delete; const originalCursorDelete = IDBCursor.prototype.delete;
    IDBCursor.prototype.delete = function() { if (failure === 'file') throw new DOMException('Injected file deletion failure', 'QuotaExceededError'); return originalCursorDelete.call(this); };
    IDBObjectStore.prototype.delete = function(...args) { if (failure === 'payload' && this.name === 'payloads') throw new DOMException('Injected quota failure', 'QuotaExceededError'); return originalDelete.apply(this, args); };
    let rejected = false; try { await db.compactCompletedEntry(binding, entry.id); } catch { rejected = true; } finally { IDBObjectStore.prototype.delete = originalDelete; IDBCursor.prototype.delete = originalCursorDelete; }
    const afterFailure = await db.get(binding, entry.id); const bytesAfterFailure = await db.files(binding, entry.id);
    const wrongOwner = { ...binding, ownerId: crypto.randomUUID() }; const denied = await db.compactCompletedEntry(wrongOwner, entry.id);
    const wrongGeneration = await db.compactCompletedEntry({ ...binding, generation: crypto.randomUUID() }, entry.id);
    const compacted = await db.compactCompletedEntry(binding, entry.id); const receipt = await db.get(binding, entry.id);
    const cancelled = { ...entry, id: crypto.randomUUID(), state: 'cancelled', completedBinding: undefined }; await db.put(binding, cancelled); await db.putFile(binding, cancelled.id, descriptor, new Uint8Array([7,8,9]));
    const notCompacted = await db.compactCompletedEntry(binding, cancelled.id); await db.removeLocalEntry(wrongOwner, cancelled.id); const stillPresent = (await db.files(binding, cancelled.id)).length;
    await db.removeLocalEntry(binding, cancelled.id);
    return { rejected, atomic: !!afterFailure.linkRequest && afterFailure.compactedAt === undefined, preservedBytes: Array.from(bytesAfterFailure[0].bytes), denied, wrongGeneration, compacted, receipt: receipt.linkResult, originalReceipt: entry.linkResult, payloadGone: receipt.linkRequest === undefined, filesGone: (await db.files(binding, entry.id)).length, notCompacted, stillPresent, removed: (await db.get(binding, cancelled.id)) === undefined };
  }, failure);
  expect(result.rejected).toBe(true); expect(result.atomic).toBe(true); expect(result.preservedBytes).toEqual([7,8,9]); expect(result.denied).toBe(false); expect(result.wrongGeneration).toBe(false); expect(result.compacted).toBe(true); expect(result.receipt).toEqual(result.originalReceipt); expect(result.payloadGone).toBe(true); expect(result.filesGone).toBe(0); expect(result.notCompacted).toBe(false); expect(result.stillPresent).toBe(1); expect(result.removed).toBe(true);
});

test('native long-URL PNG/two-CSS capture passes real IPC and persists the downgraded draft', async ({ control, page }) => {
  const site = faultSite(); const origin = await listen(site.server);
  try {
    await pair(control, origin); await page.goto('http://127.0.0.1:4317/archive-source.html');
    const png = ownPngUrl();
    await page.evaluate(data => {
      const prefix = `${location.origin}/archive-source.html?source=`; history.replaceState(null, '', prefix + 'x'.repeat(6030 - prefix.length));
      document.head.querySelectorAll('style,link[rel="stylesheet"]').forEach(node => node.remove());
      document.body.innerHTML = `<article><p>Own boundary original source.</p><img src="${data}"></article>`;
      for (let i = 0; i < 2; i++) { const style = document.createElement('style'); style.textContent = '/**/'; document.head.append(style); }
    }, png);
    const initial = await capture(control, page); expect(initial.ok).toBe(true);
    await expect.poll(async () => (await rpc(control, { type: 'archive:status' })).value.items.find((item: any) => item.id === initial.value.id)?.state).toBe('retry');
    const small = await control.evaluate(async id => {
      const { ArchiveDatabase } = await import(chrome.runtime.getURL('archive-database-harness.js'));
      const connection = (await chrome.storage.local.get('archiveSiteConnection')).archiveSiteConnection as { binding: unknown };
      const entry = await new ArchiveDatabase().get(connection.binding, id);
      return new TextEncoder().encode(JSON.stringify(entry.draft)).byteLength;
    }, initial.value.id);
    await page.evaluate(bytes => {
      const targetText = 16 * 1024 * 1024 - 4096 - bytes + 8;
      const styles = document.querySelectorAll('style');
      styles[0].textContent = '/*' + 'a'.repeat(8 * 1024 * 1024 - 4) + '*/';
      styles[1].textContent = '/*' + 'b'.repeat(targetText - 8 * 1024 * 1024 - 4) + '*/';
    }, small);
    const saved = await capture(control, page); expect(saved.ok, JSON.stringify(saved)).toBe(true);
    await expect.poll(async () => (await rpc(control, { type: 'archive:status' })).value.items[0]?.state).toBe('retry');
    const stored = await control.evaluate(async id => {
      const { ArchiveDatabase } = await import(chrome.runtime.getURL('archive-database-harness.js'));
      const connection = (await chrome.storage.local.get('archiveSiteConnection')).archiveSiteConnection as { binding: unknown };
      const entry = await new ArchiveDatabase().get(connection.binding, id);
      return { bytes: new TextEncoder().encode(JSON.stringify({ type: 'capture:deliver', grant: entry.grant, payload: { ok: true, value: entry.draft } })).byteLength, html: entry.draft.snapshot.html, css: entry.draft.pendingResources.filter((r: any) => r.role === 'css').map((r: any) => ({ missing: r.missingReason ?? null, text: 'text' in r })), warnings: entry.warnings };
    }, saved.value.id);
    expect(stored.bytes).toBeLessThanOrEqual(16 * 1024 * 1024); expect(stored.html).toContain('Own boundary original source'); expect(stored.css).toHaveLength(2); expect(stored.css.some((r: any) => r.missing === 'too-large')).toBe(true);
    await control.screenshot({ path: fileURLToPath(new URL('../../../../.superpowers/sdd/2026-10-28-learning-site-s4/task-5-evidence/native-boundary.png', import.meta.url)) });
  } finally { await new Promise<void>(resolve => site.server.close(() => resolve())); }
});


for (const kind of ['link', 'capture'] as const) test(`native ${kind} ACK stays completed after worker compaction failure and recovers offline without another HTTP request`, async ({ control, context, page }) => {
  const site = faultSite(); const origin = await listen(site.server); site.release();
  try {
    await pair(control, origin); await page.goto('http://127.0.0.1:4317/archive-source.html');
    if (kind === 'link') await page.evaluate(() => { document.body.innerHTML = '<article>Own first candidate.</article><article>Own second candidate.</article>'; });
    const worker = context.serviceWorkers()[0];
    await worker.evaluate(() => {
      const originalDelete = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function(...args) {
        if (this.name === 'payloads') {
          IDBObjectStore.prototype.delete = originalDelete;
          (globalThis as typeof globalThis & { task5CleanupFaults?: number }).task5CleanupFaults = 1;
          throw new DOMException('Owned worker compaction quota failure', 'QuotaExceededError');
        }
        return originalDelete.apply(this, args);
      };
    });
    const saved = await capture(control, page); expect(saved.ok, JSON.stringify(saved)).toBe(true);
    await expect.poll(() => worker.evaluate(() => (globalThis as typeof globalThis & { task5CleanupFaults?: number }).task5CleanupFaults ?? 0)).toBe(1);
    const inspect = () => control.evaluate(async id => {
      const { ArchiveDatabase } = await import(chrome.runtime.getURL('archive-database-harness.js'));
      const connection = (await chrome.storage.local.get('archiveSiteConnection')).archiveSiteConnection as { binding: unknown };
      const db = new ArchiveDatabase(); const entry = await db.get(connection.binding, id); const files = await db.files(connection.binding, id);
      return { state: entry.state, proof: JSON.stringify({ binding: entry.completedBinding, result: entry.result, linkResult: entry.linkResult }), payloadRetained: !!(entry.draft || entry.linkRequest), files: files.map((file: any) => ({ id: file.descriptor.id, sha256: file.descriptor.sha256, bytes: Array.from(file.bytes) })), error: entry.error ?? null, compacted: entry.compactedAt !== undefined };
    }, saved.value.id);
    const retained = await inspect(); expect(retained.state).toBe('completed'); expect(retained.payloadRetained).toBe(true); expect(retained.compacted).toBe(false); expect(retained.error).toBeNull();
    if (kind === 'capture') expect(retained.files.length).toBeGreaterThan(0);
    const requests = [...site.calls]; site.revoke(); await rpc(control, { type: 'archive:retry', id: saved.value.id });
    await expect.poll(async () => (await inspect()).compacted).toBe(true);
    const recovered = await inspect(); expect(recovered.state).toBe('completed'); expect(recovered.proof).toBe(retained.proof); expect(recovered.payloadRetained).toBe(false); expect(recovered.files).toEqual([]); expect(site.calls).toEqual(requests);
    expect(kind === 'link' ? site.links.size : site.count()).toBe(1);
  } finally { await new Promise<void>(resolve => site.server.close(() => resolve())); }
});
