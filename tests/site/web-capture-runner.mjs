// Acceptance-only harness. Real extension, HTTP routes, private store, PostgreSQL and worker;
// only source delivery and the translation provider are controlled test inputs.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { defaultCaptureLimits, defaultBundleLimits } from '@pagelingo/document-contracts';
import { openDatabase } from '../../apps/document-service/dist/db/database.js';
import { migrateDatabase } from '../../apps/document-service/dist/db/migrate.js';
import { bootstrapAdmin } from '../../apps/document-service/dist/cli/bootstrap-admin.js';
import { createApp } from '../../apps/document-service/dist/app.js';
const [samplePath, output] = process.argv.slice(2);
const declaration = JSON.parse(await readFile(samplePath, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = await mkdtemp(join(tmpdir(), 'pgl-web-acceptance-'));
const schema = `pgl_accept_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = process.env.PAGELINGO_TEST_DATABASE_URL;
assert(databaseUrl, 'Disposable database URL required');
const admin = openDatabase(databaseUrl);
let db, app, context, worker, origin, owner, other, control, reader;
const modelRequests = [];
let lostAck = false;
const runtimeKey = randomBytes(32);
const password = randomBytes(24).toString('hex');
const report = { schemaVersion: 'pagelingo-web-acceptance/1', startedAt: new Date().toISOString(), status: 'running', samples: [], checks: [], provider: 'independent mock echo; no linguistic quality claim', liveAuthenticatedSources: 'UNVERIFIED: X, Zhihu, WeChat', sourceDelivery: 'declared immutable HTML; page requests routed; production extension HTTPS acquisition omits credentials and may fetch resources from explicitly granted source origins; actual archived hashes recorded' };
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const config = { mode: 'test', host: '127.0.0.1', port: 0, publicOrigin: 'http://127.0.0.1', databaseUrl, dataDir: join(root, 'objects'), webDir: resolve('apps/web/dist'), maxPdfBytes: 1024 * 1024, bundleLimits: { ...defaultBundleLimits }, captureLimits: { ...defaultCaptureLimits }, keyring: { activeKeyId: 'test', keys: { test: runtimeKey } } };
async function request(path, { actor = owner, method = 'GET', body, headers = {} } = {}) {
  return fetch(origin + path, { method, headers: { Origin: origin, ...(actor ? { Cookie: actor.cookie, 'X-CSRF-Token': actor.csrfToken } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
}
async function json(path, options, status = 200) {
  const response = await request(path, options); const body = await response.json();
  assert.equal(response.status, status, `${path}: ${JSON.stringify(body)}`); return body;
}
async function login(username) {
  const response = await request('/api/v1/auth/login', { actor: null, method: 'POST', body: { username, password } });
  assert.equal(response.status, 200); return { ...await response.json(), cookie: response.headers.get('set-cookie').split(';')[0] };
}
async function until(read, accepts, label, timeout = 45_000) {
  const end = Date.now() + timeout; let value;
  do { value = await read(); if (accepts(value)) return value; await delay(150); } while (Date.now() < end);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}
async function rpc(command) { const response = await control.evaluate(value => chrome.runtime.sendMessage(value), command); assert(response.ok, response.error); return response.value; }
async function pair() { const { code } = await json('/api/v1/devices/pairing-codes', { method: 'POST', body: {} }, 201); return rpc({ type: 'archive:pair', origin, code }); }
async function stopWorker(signal = 'SIGTERM') {
  if (worker && worker.exitCode === null && worker.signalCode === null) { const done = once(worker, 'exit'); worker.kill(signal); await done; }
}
function startWorker() {
  worker = spawn(process.execPath, ['--import', 'tsx', 'apps/document-service/tests/helpers/mock-worker-process.ts', schema], {
    env: { PATH: process.env.PATH, PAGELINGO_SITE_MODE: 'test', PAGELINGO_SITE_ORIGIN: origin, PAGELINGO_DATA_DIR: config.dataDir, DATABASE_URL: databaseUrl, PAGELINGO_MASTER_KEY_ID: 'test', PAGELINGO_MASTER_KEYS_JSON: JSON.stringify({ test: runtimeKey.toString('base64') }) },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  worker.on('message', value => { if (value.type === 'request') modelRequests.push(value); });
}
async function launchApp(port = 0) {
  app = await createApp({ db, config, outboundFetch: async () => { throw new Error('Acceptance must not contact providers'); } });
  // Lose an acknowledgement AFTER the actual transaction and object publication.
  app.addHook('onSend', async (req, reply, payload) => {
    if (!lostAck && req.method === 'POST' && req.url.endsWith('/commit') && reply.statusCode === 200) {
      lostAck = true; reply.code(503); return JSON.stringify({ error: { code: 'ACCEPTANCE_LOST_ACK', message: 'Test-only dropped acknowledgement' } });
    }
    return payload;
  });
  origin = await app.listen({ host: '127.0.0.1', port }); config.publicOrigin = origin;
}
try {
  await save(); await admin.pool.query(`CREATE SCHEMA "${schema}"`); db = openDatabase(databaseUrl, schema); await migrateDatabase(db);
  await bootstrapAdmin(db, { username: 'acceptance', password });
  await launchApp(); owner = await login('acceptance');
  await json('/api/v1/admin/users', { method: 'POST', body: { username: 'otherowner', password } }, 201);
  other = await login('otherowner'); startWorker();
  const extension = join(root, 'extension'); await cp('apps/extension/dist', extension, { recursive: true });
  const manifestPath = join(extension, 'manifest.json'); const extensionManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  extensionManifest.host_permissions = ['http://127.0.0.1/*', ...new Set(declaration.samples.map(sample => new URL(sample.url).origin + '/*'))];
  await writeFile(manifestPath, JSON.stringify(extensionManifest));
  context = await chromium.launchPersistentContext(join(root, 'profile'), { channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const nativeWorker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(nativeWorker.url()).host;
  control = await context.newPage(); await control.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  await expect(control.getByRole('button', { name: '保存设置' })).toBeEnabled();
  await pair(); await control.screenshot({ path: join(output, 'extension-connected.png'), fullPage: true });
  const profile = await json('/api/v1/settings/provider'); const { revision, hasApiKey, ...settings } = profile;
  await json('/api/v1/settings/provider', { method: 'PUT', body: { expectedRevision: revision, settings: { ...settings, baseUrl: 'https://provider.example/v1', model: 'acceptance-echo' }, key: { action: 'replace', value: 'test-only-' + randomUUID() } } });
  await json('/api/v1/settings/glossary', { method: 'PUT', body: { expectedRevision: 0, entries: [{ source: 'software', target: '软件', policy: 'translate', domain: 'all' }] } });
  const resourceMap = new Map(); const htmlMap = new Map();
  for (const sample of declaration.samples) {
    const bytes = await readFile(resolve(dirname(samplePath), sample.htmlFile)); assert.equal(hash(bytes), sample.sha256, sample.id + ' input hash');
    htmlMap.set(sample.url, bytes);
    for (const resource of sample.resources ?? []) { const bytes = await readFile(resolve(dirname(samplePath), resource.file)); assert.equal(hash(bytes), resource.sha256); resourceMap.set(resource.url, { ...resource, bytes }); }
  }
  let sourceAvailable = true;
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(origin + '/') || url.startsWith('chrome-extension:')) return route.continue();
    if (sourceAvailable && htmlMap.has(url)) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: htmlMap.get(url), headers: { 'Content-Security-Policy': "default-src 'none'; img-src data: https:; connect-src data: blob:; style-src 'unsafe-inline'" } });
    if (sourceAvailable && resourceMap.has(url)) { const resource = resourceMap.get(url); return route.fulfill({ status: 200, contentType: resource.mediaType, body: resource.bytes }); }
    return route.abort();
  });
  reader = await context.newPage(); await reader.goto(origin + '/login');
  await reader.getByLabel('用户名', { exact: true }).fill('acceptance'); await reader.getByLabel('密码', { exact: true }).fill(password); await reader.getByRole('button', { name: '登录', exact: true }).click(); await expect(reader).toHaveURL(origin + '/library');
  for (const sample of declaration.samples) {
    const evidence = { id: sample.id, kind: sample.kind, url: sample.url, collectedAt: sample.capturedAt, checkedAt: new Date().toISOString(), inputSha256Before: hash(await readFile(resolve(dirname(samplePath), sample.htmlFile))), status: 'running', unverified: sample.unverified };
    report.samples.push(evidence); await save();
    const page = await context.newPage();
    try {
      const requestsBeforeSave = modelRequests.length;
      await page.goto(sample.url, { waitUntil: 'domcontentloaded' });
      const tabId = await control.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, sample.url);
      const accepted = await rpc({ type: 'archive:capture', tabId });
      evidence.captureId = accepted.id;
      let item = await until(async () => (await rpc({ type: 'archive:status' })).items.find(item => item.id === accepted.id), item => item && ['completed', 'retry', 'permission', 'manual'].includes(item.state), 'capture state');
      if (item.state === 'permission') {
        // Explicitly decline undeclared external resources; original remains honest partial.
        const popup = await context.newPage(); await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
        await popup.getByRole('button', { name: '不授权，继续保存' }).click(); await popup.close();
      }
      if (!report.checks.includes('native-worker-stop/lost-ack')) {
        await until(async () => (await db.pool.query('SELECT status FROM web_captures WHERE capture_id=$1', [accepted.id])).rows[0]?.status, value => value === 'completed', 'durable capture before browser-worker stop');
        await page.close();
        const cdp = await context.newCDPSession(control); await cdp.send('ServiceWorker.enable'); await cdp.send('ServiceWorker.stopAllWorkers'); await cdp.detach();
        await rpc({ type: 'archive:retry', id: accepted.id }); report.checks.push('native-worker-stop/lost-ack');
      }
      item = await until(async () => (await rpc({ type: 'archive:status' })).items.find(item => item.id === accepted.id), item => item?.state === 'completed', 'extension durable completion');
      const rows = (await db.pool.query('SELECT id, document_id FROM web_captures WHERE capture_id=$1', [accepted.id])).rows;
      assert.equal(rows.length, 1); const documentId = rows[0].document_id; evidence.documentId = documentId; evidence.saveStatus = item.saveStatus;
      const base = `/api/v1/documents/${documentId}`;
      let descriptor = await json(base + '/web-reader');
      const manifest = await json(`${base}/web-snapshots/${descriptor.source.sourceVersionId}/manifest`);
      assert.equal(manifest.scope.kind, sample.expected.scope);
      if (sample.kind === 'synthetic') {
        assert(manifest.resources.some(resource => resource.status === 'available'), sample.id + ' must retain actual image bytes');
        for (const resource of sample.resources) assert(manifest.files.some(file => file.role === 'image' && file.sha256 === resource.sha256), sample.id + ' image hash');
      }
      evidence.scope = manifest.scope; evidence.resources = manifest.resources;
      const htmlResponse = await request(`${base}/web-snapshots/${descriptor.source.sourceVersionId}/files/${manifest.htmlFileId}`); assert.equal(htmlResponse.status, 200); const html = await htmlResponse.text();
      for (const text of sample.expected.contains) assert(html.includes(text), sample.id + ' missing expected source');
      for (const text of sample.expected.excludes ?? []) assert(!html.includes(text), sample.id + ' leaked excluded scope');
      for (const file of manifest.files) {
        const path = `${base}/web-snapshots/${descriptor.source.sourceVersionId}/files/${file.id}`;
        const response = await request(path); assert.equal(response.status, 200); assert.equal(hash(Buffer.from(await response.arrayBuffer())), file.sha256);
        assert.equal((await request(path, { actor: null })).status, 401); assert.equal((await request(path, { actor: other })).status, 404);
      }
      evidence.files = manifest.files.map(({ id, role, sha256, bytes }) => ({ id, role, sha256, bytes })); evidence.language = descriptor.index.language;
      assert.equal((await json(base + '/web-jobs')).items.length, 0, 'auto preference is off');
      if (sample.expected.language === 'zh') { assert.equal(descriptor.translationStatus, 'not-required'); assert.equal(modelRequests.length, requestsBeforeSave, 'Chinese capture makes no model request'); }
      else {
        const currentProfile = await json('/api/v1/settings/provider'); const glossary = await json('/api/v1/settings/glossary');
        const job = await json(base + '/web-jobs', { method: 'POST', body: { sourceVersionId: descriptor.source.sourceVersionId, parseId: descriptor.parseId, profileRevision: currentProfile.revision, glossaryRevision: glossary.revision, sourceLanguage: 'en' } }, 201);
        const final = await until(() => json('/api/v1/web-jobs/' + job.id), value => value.status === 'completed' && value.readerVersionId, 'independent mock worker completed', 90_000);
        descriptor = await json(base + '/web-reader?versionId=' + final.readerVersionId); assert.equal(descriptor.index.generationKind, 'mock'); evidence.jobId = job.id;
      }
      for (const file of manifest.files.filter(file => file.role === 'image')) {
        const path = `${base}/web-reader/versions/${descriptor.versionId}/assets/${descriptor.assetMap[file.id]}`;
        const response = await request(path); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(hash(Buffer.from(await response.arrayBuffer())), file.sha256);
        assert.equal((await request(path, { actor: null })).status, 401); assert.equal((await request(path, { actor: other })).status, 404);
      }
      evidence.readerVersionId = descriptor.versionId;
      await reader.goto(origin + `/library/${documentId}?versionId=${descriptor.versionId}`); await expect(reader.getByRole('region', { name: '网页阅读器' })).toBeVisible();
      await expect(reader.locator('.reader-content')).toContainText(sample.expected.contains[0]);
      if (sample.kind === 'synthetic') {
        await expect(reader.locator('.reader-content code')).toContainText('const saved = 1;');
        await expect(reader.locator('.reader-content math')).toHaveCount(1);
        await reader.locator('.reader-content img').first().scrollIntoViewIfNeeded();
        await expect.poll(() => reader.locator('.reader-content img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0) && images.length > 0)).toBe(true);
      }
      await reader.locator('.reader-content').evaluate(element => { element.scrollTop = 0; });
      await reader.screenshot({ path: join(output, sample.id + '-reader.png'), fullPage: true });
      evidence.status = 'passed';
    } catch (error) { evidence.status = 'failed'; evidence.error = error.message; throw error; }
    finally { if (!page.isClosed()) await page.close(); evidence.inputSha256After = hash(await readFile(resolve(dirname(samplePath), sample.htmlFile))); assert.equal(evidence.inputSha256After, evidence.inputSha256Before); await save(); }
  }
  sourceAvailable = false;
  const selected = report.samples[0];
  await reader.goto(origin + `/library/${selected.documentId}?versionId=${selected.readerVersionId}`);
  await expect(reader.locator('.reader-content')).toContainText(declaration.samples[0].expected.contains[0]);
  const beforeCalls = modelRequests.length;
  await reader.reload(); await expect(reader.getByRole('region', { name: '网页阅读器' })).toBeVisible(); assert.equal(modelRequests.length, beforeCalls);
  await reader.screenshot({ path: join(output, 'source-offline-reader.png'), fullPage: true });
  report.checks.push('source-unavailable-reader/no-new-model-call', 'private-file-hashes/anonymous401/other-owner404');
  const descriptor = await json(`/api/v1/documents/${selected.documentId}/web-reader?versionId=${selected.readerVersionId}`);
  const position = { readerVersionId: descriptor.versionId, sourceVersionId: descriptor.source.sourceVersionId, parseId: descriptor.parseId, blockId: Object.keys(descriptor.index.blockLocations)[0], blockOffset: 0.3, view: 'content', contentMode: 'bilingual' };
  const priorProgress = await json(`/api/v1/documents/${selected.documentId}/web-progress`);
  const progress = await json(`/api/v1/documents/${selected.documentId}/web-progress`, { method: 'PUT', body: { expectedRevision: priorProgress?.revision ?? 0, position } });
  const port = Number(new URL(origin).port);
  await stopWorker('SIGKILL'); await app.close(); await db.close(); db = openDatabase(databaseUrl, schema); await launchApp(port); startWorker();
  assert.deepEqual(await json(`/api/v1/documents/${selected.documentId}/web-progress`), progress);
  assert.equal((await json('/api/v1/settings/glossary')).entries[0].target, '软件');
  assert.equal((await json(`/api/v1/documents/${selected.documentId}/web-reader?versionId=${selected.readerVersionId}`)).versionId, selected.readerVersionId);
  report.checks.push('owned-api/db-connection/worker-restart-with-retained-store');
  const connected = await rpc({ type: 'archive:status' });
  assert.equal((await request(`/api/v1/devices/${connected.binding.deviceId}/revoke`, { method: 'POST', body: {} })).status, 204);
  await rpc({ type: 'archive:disconnect' }); await pair();
  assert.equal((await rpc({ type: 'archive:status' })).items.length, report.samples.length);
  report.checks.push('device-revoke/same-owner-reconnect');
  assert(modelRequests.length > 0); report.mockRequests = modelRequests.length; report.workerPids = [...new Set(modelRequests.map(value => value.pid))];
  report.status = 'passed'; report.finishedAt = new Date().toISOString(); await save();
  console.log(`Web capture acceptance passed: ${report.samples.length} declared samples; mock structure/lifecycle only.`);
} catch (error) {
  report.status = 'failed'; report.error = error.message; await save();
  if (reader) await reader.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error.stack); process.exitCode = 1;
} finally {
  await context?.tracing.stop({ path: join(output, 'trace.zip') }).catch(() => {});
  await context?.close(); await stopWorker(); await app?.close(); await db?.close();
  await admin.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.close(); await rm(root, { recursive: true, force: true });
}
