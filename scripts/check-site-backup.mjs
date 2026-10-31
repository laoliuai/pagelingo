// Production-overlay acceptance on an isolated project: HTTPS, proxy identity, backup, loss and restore.
// Never reads .env files or a personal project; every resource it creates is removed in finally.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildPdfFixture } from '../tests/fixtures/pdf.ts';
import { capture } from '../apps/document-service/tests/helpers/web-capture.ts';
import { createCompose, databaseJson } from './site-ops.mjs';

// Caddy serves localhost from its private CA; this process only ever talks to that listener.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const verbose = process.argv.includes('--verbose');
const id = randomUUID().slice(0, 8);
const directory = await mkdtemp(join(tmpdir(), 'pgl-backup-'));
const image = `pagelingo-site:drill-${id}`;
const secret = () => randomBytes(24).toString('hex');
const freePort = () => new Promise((done, fail) => {
  const server = createServer();
  server.once('error', fail);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)); });
});
const [httpsPort, httpPort] = [await freePort(), await freePort()];
const origin = `https://localhost:${httpsPort}`;
const keyring = { drill: randomBytes(32).toString('base64') };
const environment = (name, keys = keyring) => {
  const path = join(directory, `${name}.env`);
  return writeFile(path, [
    'PAGELINGO_DOMAIN=localhost', `PAGELINGO_SITE_ORIGIN=${origin}`,
    `PAGELINGO_HTTPS_BIND=127.0.0.1:${httpsPort}`, `PAGELINGO_HTTP_BIND=127.0.0.1:${httpPort}`,
    `PAGELINGO_IMAGE=${image}`, `POSTGRES_PASSWORD=${secret()}`,
    `PAGELINGO_MASTER_KEY_ID=${Object.keys(keys)[0]}`, `PAGELINGO_MASTER_KEYS_JSON='${JSON.stringify(keys)}'`, '',
  ].join('\n'), { mode: 0o600 }).then(() => path);
};
const projects = new Map();
function project(name, envFile) {
  const value = `pgl-backup-${id}-${name}`;
  const compose = createCompose({ project: value, envFile, verbose });
  projects.set(value, compose);
  return { name: value, envFile, compose };
}
function script(path, args) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [path, ...args, ...(verbose ? ['--verbose'] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', fail);
    child.once('close', code => done({ code, stdout, stderr }));
  });
}
const operation = (name, env, extra) => script(`scripts/site-${name}.mjs`, ['--env-file', env.envFile, '--project', env.name, ...extra]);
async function request(path, { actor, method = 'GET', body, headers = {} } = {}) {
  const plain = body && !(body instanceof FormData) && !Buffer.isBuffer(body);
  return fetch(`${origin}${path}`, {
    method,
    headers: { Origin: origin, ...(actor ? { Cookie: actor.cookie, 'X-CSRF-Token': actor.csrfToken } : {}), ...(plain ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: plain ? JSON.stringify(body) : body,
    signal: AbortSignal.timeout(120_000),
  });
}
async function ready() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(2000) })).ok) return; } catch { /* Caddy or the app is still starting. */ }
    await delay(500);
  }
  throw new Error('The HTTPS site did not become ready');
}
async function login(username, password) {
  const response = await request('/api/v1/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(response.status, 200, `login ${username}`);
  const cookie = response.headers.get('set-cookie');
  return { ...await response.json(), cookie: cookie.split(';')[0], rawCookie: cookie };
}
const digest = async response => createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');

const adminPassword = secret(), readerPassword = secret(), fakeKey = `fake-${secret()}`;
try {
  const first = project('a', await environment('a'));
  await first.compose.run(['config', '--quiet']);
  await first.compose.run(['build', 'app']);
  await first.compose.run(['up', '--detach', '--wait']);
  await ready();

  // HTTPS boundary: redirect, Secure cookie and private database.
  const redirect = await fetch(`http://localhost:${httpPort}/library`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  assert.ok(redirect.status >= 300 && redirect.status < 400 && redirect.headers.get('location').startsWith('https://'), 'HTTP redirects to HTTPS');
  assert.match(await first.compose.run(['port', 'db', '5432']).catch(() => ''), /^(?::0)?$/, 'database has no host port');
  await first.compose.run(['exec', '-T', 'app', 'node', 'apps/document-service/dist/cli/bootstrap-admin.js', '--username', 'drilladmin', '--password-stdin'], { input: `${adminPassword}\n` });
  const admin = await login('drilladmin', adminPassword);
  assert.match(admin.rawCookie, /^__Host-pgl_session=/);
  assert.match(admin.rawCookie, /; Secure/i);

  // Rate limits must key on the visitor, not on the one proxy every visitor shares.
  const failedLogin = await request('/api/v1/auth/login', { method: 'POST', body: { username: 'drillunknown', password: 'wrong-password-for-drill' } });
  assert.equal(failedLogin.status, 401);
  const proxyAddress = await first.compose.run(['exec', '-T', 'caddy', 'hostname', '-i']);
  const attempts = await databaseJson(first.compose, "SELECT json_agg(host(ip)) FROM auth_attempts WHERE username='drillunknown'");
  assert.ok(attempts.length > 0 && !attempts.includes(proxyAddress.trim()), 'login attempts record the forwarded client');

  const created = await request('/api/v1/admin/users', { actor: admin, method: 'POST', body: { username: 'drillreader', password: readerPassword } });
  assert.equal(created.status, 201);
  const reader = await login('drillreader', readerPassword);
  const pdf = Buffer.from(buildPdfFixture(2));
  const form = new FormData();
  form.append('title', 'Backup drill');
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'drill.pdf');
  const upload = await request('/api/v1/documents/pdf', { actor: reader, method: 'POST', body: form, headers: { 'Idempotency-Key': randomUUID() } });
  assert.equal(upload.status, 201);
  const documentId = (await upload.json()).id;
  const sourcePath = `/api/v1/documents/${documentId}/source`;
  const pdfSha256 = createHash('sha256').update(pdf).digest('hex');
  assert.equal(await digest(await request(sourcePath, { actor: reader })), pdfSha256);

  const web = capture();
  const admitted = await request('/api/v1/captures', { actor: reader, method: 'POST', body: { manifest: web.manifest, translationIntent: 'none' }, headers: { 'Idempotency-Key': web.manifest.captureId } });
  assert.equal(admitted.status, 201);
  const webCapture = await admitted.json();
  const uploaded = await request(`/api/v1/captures/${webCapture.id}/files/html`, { actor: reader, method: 'PUT', body: Buffer.from(web.body), headers: { 'Content-Type': 'text/html' } });
  assert.equal(uploaded.status, 200);
  const committed = await request(`/api/v1/captures/${webCapture.id}/commit`, { actor: reader, method: 'POST', body: {} });
  assert.equal(committed.status, 200);
  const webBase = `/api/v1/documents/${(await committed.json()).documentId}`;
  const webReader = await (await request(`${webBase}/web-reader`, { actor: reader })).json();

  const provider = await (await request('/api/v1/settings/provider', { actor: reader })).json();
  const { revision, hasApiKey: _before, ...settings } = provider;
  const saved = await request('/api/v1/settings/provider', { actor: reader, method: 'PUT', body: { expectedRevision: revision, settings: { ...settings, baseUrl: 'https://api.example.com/v1', model: 'drill-model' }, key: { action: 'replace', value: fakeKey } } });
  assert.equal(saved.status, 200, 'provider key saved without a model request');
  const library = await (await request('/api/v1/documents', { actor: reader })).json();

  // Backup keeps the site running afterwards and never stores the key material.
  const output = join(directory, 'backup');
  const backup = await operation('backup', first, ['--output', output]);
  assert.equal(backup.code, 0, `backup failed: ${backup.stderr}`);
  await ready();
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.keyring.included, false);
  assert.ok(!JSON.stringify(manifest).includes(keyring.drill) && !JSON.stringify(manifest).includes(fakeKey), 'manifest holds no secrets');
  assert.ok(manifest.migrations.length >= 9, 'manifest records the schema version');
  assert.equal((await operation('restore', first, ['--from', output])).code, 1, 'refuses to restore over existing data');

  // Bad inputs fail on local checks before any new Docker state exists.
  const tampered = join(directory, 'tampered');
  await mkdir(tampered);
  for (const name of ['manifest.json', 'objects.tar']) await copyFile(join(output, name), join(tampered, name));
  await writeFile(join(tampered, 'database.dump'), `${randomBytes(32).toString('hex')}\n`);
  const wrongKey = project('wrong', await environment('wrong', { drill: randomBytes(32).toString('base64') }));
  const rejectedKey = await operation('restore', wrongKey, ['--from', output]);
  assert.equal(rejectedKey.code, 1);
  assert.match(rejectedKey.stderr, /master key/);
  const rejectedFile = await operation('restore', project('tampered', await environment('tampered')), ['--from', tampered]);
  assert.equal(rejectedFile.code, 1);
  assert.match(rejectedFile.stderr, /failed verification/);

  // Lose the original completely, then rebuild from the backup with a new database password.
  await first.compose.run(['down', '--volumes', '--remove-orphans']);
  const second = project('b', await environment('b'));
  const restored = await operation('restore', second, ['--from', output]);
  assert.equal(restored.code, 0, `restore failed: ${restored.stderr}`);
  const report = JSON.parse(restored.stdout.trim().split('\n').at(-1));
  assert.ok(report.assets > 0 && report.bytes > 0, 'restored objects were read');
  assert.deepEqual({ missing: report.missing, mismatched: report.mismatched, secrets: report.secrets, unreadableSecrets: report.unreadableSecrets }, { missing: 0, mismatched: 0, secrets: 1, unreadableSecrets: 0 });
  await ready();

  assert.equal((await request(sourcePath)).status, 401, 'anonymous visitors cannot read restored originals');
  const restoredReader = await login('drillreader', readerPassword);
  assert.equal(await digest(await request(sourcePath, { actor: restoredReader })), pdfSha256);
  const range = await request(sourcePath, { actor: restoredReader, headers: { Range: 'bytes=0-15' } });
  assert.equal(range.status, 206);
  assert.equal(Buffer.from(await range.arrayBuffer()).equals(pdf.subarray(0, 16)), true);
  assert.deepEqual(await (await request('/api/v1/documents', { actor: restoredReader })).json(), library);
  assert.deepEqual(await (await request(`${webBase}/web-reader`, { actor: restoredReader })).json(), webReader);
  assert.equal((await (await request('/api/v1/settings/provider', { actor: restoredReader })).json()).hasApiKey, true);
  assert.equal((await request(sourcePath, { actor: await login('drilladmin', adminPassword) })).status, 404, 'administrators still cannot read private documents');
  assert.equal((await request(sourcePath, { actor: reader })).status, 200, 'existing sessions survive a restore');
  assert.equal((await operation('restore', second, ['--from', output])).code, 1, 'refuses to overwrite the restored site');
  console.log(JSON.stringify({ passed: true, restored: report, backupBytes: manifest.files }));
} finally {
  for (const [name, compose] of projects) {
    await compose.run(['down', '--volumes', '--remove-orphans']).catch(() => {
      console.error(`Failed to clean isolated project ${name}`);
      process.exitCode ||= 1;
    });
  }
  await new Promise(done => spawn('docker', ['image', 'rm', '--force', image], { stdio: 'ignore' }).once('close', done));
  await rm(directory, { recursive: true, force: true });
}
