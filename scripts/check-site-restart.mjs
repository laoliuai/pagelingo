import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { buildPdfFixture } from '../tests/fixtures/pdf.ts';
const directory = await mkdtemp(join(tmpdir(), 'pgl-restart-'));
const envFile = join(directory, '.env');
const project = `pgl-restart-${randomUUID()}`;
const secret = () => randomBytes(24).toString('hex');
const adminPassword = secret();
const readerPassword = secret();
const fakeKey = `fake-${secret()}`;
let interrupted = false;
let started = false;
const children = new Set();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  for (const child of children) child.kill(signal);
});
// Strip ambient Compose/site configuration, including URLs and project overrides.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(COMPOSE_|PAGELINGO_|POSTGRES_|DATABASE_URL$)/.test(key)));
const composeArgs = ['compose', '--project-name', project, '--env-file', envFile, '-f', resolve('deploy/compose.site.yml')];
async function compose(args, input) {
  if (interrupted && args[0] !== 'down') throw new Error('Restart acceptance interrupted');
  return new Promise((resolveCommand, reject) => {
    const child = spawn('docker', [...composeArgs, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    // Never echo Docker diagnostics: env and connection strings can appear in them.
    child.stderr.resume();
    child.on('error', () => { children.delete(child); reject(new Error('Docker Compose could not start')); });
    child.on('exit', code => {
      children.delete(child);
      code === 0 ? resolveCommand(output.trim()) : reject(new Error(`Compose ${args[0]} failed (${code}); check Docker and packaging prerequisites`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
let origin;
async function ready() {
  for (let i = 0; i < 120 && !interrupted; i++) {
    try { if ((await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await delay(250);
  }
  throw new Error('Isolated site did not become ready');
}
async function request(path, { actor, method = 'GET', body, headers = {} } = {}) {
  if (interrupted) throw new Error('Restart acceptance interrupted');
  const response = await fetch(`${origin}${path}`, {
    method, headers: { Origin: origin, ...(actor ? { Cookie: actor.cookie, 'X-CSRF-Token': actor.csrfToken } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  return response;
}
async function login(username, password) {
  const response = await request('/api/v1/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(response.status, 200, 'login');
  const session = await response.json();
  return { ...session, cookie: response.headers.get('set-cookie').split(';')[0] };
}
try {
  await writeFile(envFile, `POSTGRES_PASSWORD=${secret()}\nPAGELINGO_SITE_PORT=0\nPAGELINGO_SITE_ORIGIN=http://127.0.0.1\nPAGELINGO_MASTER_KEY_ID=restart\nPAGELINGO_MASTER_KEYS_JSON='${JSON.stringify({ restart: randomBytes(32).toString('base64') })}'\n`, { mode: 0o600 });
  // Validate materials before creating resources; missing files are an explicit RED.
  await compose(['config', '--quiet']);
  started = true;
  await compose(['up', '--detach', '--build', '--wait']);
  const mapping = await compose(['port', 'app', '4320']);
  assert.match(mapping, /^127\.0\.0\.1:\d+$/);
  origin = `http://${mapping}`;
  // The allocated host port becomes the app's canonical public origin.
  await writeFile(envFile, (await readFile(envFile, 'utf8')).replace('PAGELINGO_SITE_ORIGIN=http://127.0.0.1\n', `PAGELINGO_SITE_ORIGIN=${origin}\n`).replace('PAGELINGO_SITE_PORT=0', `PAGELINGO_SITE_PORT=${mapping.split(':')[1]}`), { mode: 0o600 });
  await compose(['up', '--detach', '--wait', 'app']);
  await ready();
  const inspectImage = `import { readdir, readFile, access } from 'node:fs/promises';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const secrets=JSON.parse(input);
async function walk(path) {for (const entry of await readdir(path,{withFileTypes:true})) {
const file=path+'/'+entry.name;
if(entry.isDirectory()) await walk(file);
else { const bytes=await readFile(file); if(secrets.some(value=>bytes.includes(Buffer.from(value)))) throw new Error('Forbidden content'); }
}}
try {
for(const path of ['apps/web/dist','apps/document-service/dist','packages/document-contracts/dist','packages/translation-core/dist','packages/assistant-core/dist']) await walk(path);
for(const path of ['apps/web/tests','apps/document-service/tests','.env.local','.git','apps/web/dist/assets/pdfjs/wasm/quickjs-eval.wasm']) {let exists=true;try{await access(path);}catch{exists=false;}if(exists)throw new Error('Forbidden file');}
for(const path of ['cmaps','standard_fonts','wasm']) if(!(await readdir('apps/web/dist/assets/pdfjs/'+path)).length)throw new Error('Missing resource');
const assets=await readdir('apps/web/dist/assets');if(!assets.some(name=>/^pdf.worker.*\\.(?:m?js)$/.test(name)))throw new Error('Missing worker');
console.log('pass');
} catch(error) {console.log(error.code ? 'Image file read failed' : error.message);}`;
  const imageResult = await compose(['exec', '-T', 'app', 'node', '--input-type=module', '-e', inspectImage], JSON.stringify([adminPassword, readerPassword, fakeKey, resolve('.'), 'test-admin-password', 'reader-password-1']));
  assert.equal(imageResult, 'pass', 'image content verification: ' + imageResult);
  for (const resource of ['wasm/openjpeg_nowasm_fallback.js', 'wasm/openjpeg.wasm', 'cmaps/Adobe-Japan1-UCS2.bcmap', 'standard_fonts/FoxitSerif.pfb']) {
    const response = await request('/assets/pdfjs/' + resource);
    assert.equal(response.status, 200, 'packaged PDF resource');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    if (resource.endsWith('.js')) assert.match(response.headers.get('content-type'), /javascript/);
  }
  await compose(['exec', '-T', 'app', 'node', 'apps/document-service/dist/cli/bootstrap-admin.js', '--username', 'restartadmin', '--password-stdin'], `${adminPassword}\n`);
  const admin = await login('restartadmin', adminPassword);
  const created = await request('/api/v1/admin/users', { actor: admin, method: 'POST', body: { username: 'restartreader', password: readerPassword } });
  assert.equal(created.status, 201);
  const reader = await login('restartreader', readerPassword);
  const pdf = buildPdfFixture(2);
  const form = new FormData();
  form.set('file', new Blob([pdf], { type: 'application/pdf' }), 'restart.pdf');
  const upload = await request('/api/v1/documents/pdf', { actor: reader, method: 'POST', body: form, headers: { 'Idempotency-Key': randomUUID() } });
  assert.equal(upload.status, 201);
  const document = await upload.json();
  const profile = await (await request('/api/v1/settings/provider', { actor: reader })).json();
  const { revision, hasApiKey, ...settings } = profile;
  const save = await request('/api/v1/settings/provider', { actor: reader, method: 'PUT', body: { expectedRevision: revision, settings: { ...settings, baseUrl: 'https://api.example.com/v1', model: 'restart-fixture' }, key: { action: 'replace', value: fakeKey } } });
  assert.equal(save.status, 200);
  // Recreate both containers so persistence cannot accidentally rely on writable layers.
  // Keep only this project's named volumes until final cleanup.
  await compose(['down']);
  await compose(['up', '--detach', '--wait']);
  await ready();
  const metadata = await request(`/api/v1/documents/${document.id}`, { actor: reader });
  assert.equal(metadata.status, 200);
  assert.deepEqual((await metadata.json()).source, document.source);
  assert.equal(document.source.sha256, createHash('sha256').update(pdf).digest('hex'));
  const source = await request(`/api/v1/documents/${document.id}/source`, { actor: reader });
  assert.equal(source.status, 200);
  assert.equal(createHash('sha256').update(Buffer.from(await source.arrayBuffer())).digest('hex'), createHash('sha256').update(pdf).digest('hex'));
  assert.equal((await request(`/api/v1/documents/${document.id}/source`, { actor: admin })).status, 404);
  assert.equal((await request(`/api/v1/documents/${document.id}/source`)).status, 401);
  const restored = await (await request('/api/v1/settings/provider', { actor: reader })).json();
  assert.equal(restored.hasApiKey, true);
  assert.equal(restored.model, 'restart-fixture');
  const assertion = `import {readConfig} from './apps/document-service/dist/config.js';
import {openDatabase} from './apps/document-service/dist/db/database.js';
import {openApiKey} from './apps/document-service/dist/providers/secrets.js';
import {storedSecret} from './apps/document-service/dist/providers/repository.js';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const fixture=JSON.parse(input); const config=readConfig(process.env); const db=openDatabase(config.databaseUrl);
try { const row=(await db.pool.query('SELECT * FROM provider_profiles WHERE owner_id=$1',[fixture.owner])).rows[0];
if(openApiKey(storedSecret(row),fixture.owner,config.keyring)!==fixture.key) process.exitCode=1;
} catch {process.exitCode=1;} finally {await db.close();}`;
  await compose(['exec', '-T', 'app', 'node', '--input-type=module', '-e', assertion], JSON.stringify({ owner: reader.user.id, key: fakeKey }));
  const disabled = await request(`/api/v1/admin/users/${reader.user.id}`, { actor: admin, method: 'PATCH', body: { active: false } });
  assert.equal(disabled.status, 200);
  assert.equal((await request(`/api/v1/documents/${document.id}/source`, { actor: reader })).status, 401);
  for (const path of ['/library', `/library/${document.id}`]) assert.equal((await request(path)).status, 200);
  for (const path of ['/api/missing', '/assets/missing.js', '/missing.js']) assert.equal((await request(path)).status, 404);
  console.log('Image contents and resources passed.');
  console.log('Restart acceptance passed: PDF hash, profile decryption, sessions, ownership, revocation, SPA boundaries.');
} catch (error) {
  console.error(error instanceof assert.AssertionError ? `Restart assertion failed: ${error.message.split('\n')[0]}` : error.message);
  process.exitCode ||= 1;
} finally {
  if (started) {
    try { await compose(['down', '--volumes', '--remove-orphans', '--rmi', 'local']); }
    catch { console.error('Failed to clean isolated restart project: ' + project); process.exitCode ||= 1; }
  }
  await rm(directory, { recursive: true, force: true });
}
