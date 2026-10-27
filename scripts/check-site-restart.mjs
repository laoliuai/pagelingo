import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultBundleLimits } from '@pagelingo/document-contracts';
import { createArchiveFileSource, validateBundle } from '@pagelingo/document-bundle';
import { fixture, english } from '../apps/pdf-cli/tests/fixtures/legacy-preview/create.ts';
import { processPdf, translateRun, exportBundle } from '../apps/pdf-cli/dist/index.js';
import { withCandidates } from '../apps/document-service/tests/helpers/web-capture.ts';
import { buildPdfFixture } from '../tests/fixtures/pdf.ts';
const archivePaths = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] !== '--bundle' || !process.argv[i + 1]) throw new Error('Usage: test:site:restart -- [--bundle <current.zip>]...');
  archivePaths.push(resolve(process.argv[++i]));
}
const archiveHashes = new Map();
for (const path of archivePaths) archiveHashes.set(path, createHash('sha256').update(await readFile(path)).digest('hex'));
let ownedFixture;
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
    method, headers: { Origin: origin, ...(actor ? { Cookie: actor.cookie, 'X-CSRF-Token': actor.csrfToken } : {}), ...(body && !(body instanceof FormData) && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body instanceof FormData || Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(300_000),
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
  await compose(['build', 'app']);
  await compose(['up', '--detach', '--wait', 'db']);
  // Start from a populated S2 schema in this project's fresh database. The normal
  // S3 entrypoint must subsequently apply 006 without replacing its account/PDF.
  const s2Bootstrap = `import {readFile,readdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {openDatabase} from './apps/document-service/dist/db/database.js';
import {hashPassword} from './apps/document-service/dist/auth/passwords.js';
import {createLocalObjectStore} from './apps/document-service/dist/storage/local-object-store.js';
let input='';for await(const chunk of process.stdin)input+=chunk;const f=JSON.parse(input);
const db=openDatabase(process.env.DATABASE_URL);try {
await db.transaction(async c=>{
await c.query('CREATE TABLE schema_migrations(id text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
for(const name of (await readdir('apps/document-service/migrations')).filter(n=>/^00[1-5]-.*\\.sql$/.test(n)).sort()) {
const sql=await readFile('apps/document-service/migrations/'+name,'utf8');await c.query(sql);await c.query('INSERT INTO schema_migrations(id,checksum) VALUES($1,$2)',[name.slice(0,-4),createHash('sha256').update(sql).digest('hex')]);
}
const owner=randomUUID(),document=randomUUID(),asset=randomUUID(),source=randomUUID(),key=randomUUID();
await c.query('INSERT INTO users(id,username,password_hash) VALUES($1,$2,$3)',[owner,'restartreader',await hashPassword(f.password)]);
const bytes=Buffer.from(f.pdf,'base64');const store=createLocalObjectStore(process.env.PAGELINGO_DATA_DIR);const stored=await store.putImmutable(key,(async function*(){yield bytes;})(),bytes.length);
await c.query('INSERT INTO documents(id,owner_id,title,original_filename) VALUES($1,$2,$3,$4)',[document,owner,'S2 retained PDF','restart.pdf']);
await c.query('INSERT INTO assets(id,owner_id,document_id,object_key,sha256,bytes,media_type) VALUES($1,$2,$3,$4,$5,$6,$7)',[asset,owner,document,key,stored.sha256,stored.bytes,'application/pdf']);
await c.query('INSERT INTO source_versions(id,owner_id,document_id,asset_id,sha256,bytes) VALUES($1,$2,$3,$4,$5,$6)',[source,owner,document,asset,stored.sha256,stored.bytes]);
await c.query('UPDATE documents SET current_source_version_id=$1 WHERE id=$2',[source,document]);
console.log(JSON.stringify({id:document,migrations:5}));
});}finally{await db.close();}`;
  const pdf = buildPdfFixture(2);
  const seeded = JSON.parse(await compose(['run', '--rm', '--no-deps', '-T', 'app', 'node', '--input-type=module', '-e', s2Bootstrap], JSON.stringify({ password: readerPassword, pdf: Buffer.from(pdf).toString('base64') })));
  assert.equal(seeded.migrations, 5);
  await compose(['up', '--detach', '--wait', 'app']);
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
for(const path of ['apps/web/dist','apps/document-service/dist','packages/document-contracts/dist','packages/translation-core/dist','packages/assistant-core/dist','packages/document-renderer/dist','packages/document-renderer/static','packages/document-bundle/dist']) await walk(path);
for(const path of ['apps/web/tests','apps/document-service/tests','.env.local','.git','apps/pdf-cli','services/document-parser','/usr/bin/python3','/usr/local/bin/python3','apps/web/dist/assets/pdfjs/wasm/quickjs-eval.wasm']) {let exists=true;try{await access(path);}catch{exists=false;}if(exists)throw new Error('Forbidden file');}
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
  const reader = await login('restartreader', readerPassword);
  const documentResponse = await request(`/api/v1/documents/${seeded.id}`, { actor: reader });
  assert.equal(documentResponse.status, 200, 'S2 document survived 006');
  const document = await documentResponse.json();
  if (!archivePaths.length) {
    ownedFixture = await fixture(`<article class="docvortex-document"><h1>Restart reader</h1><p>${english}</p></article>`, buildPdfFixture(1), {
      pageIndex: 0, mediaBox: [0,0,300,400], cropBox: [0,0,300,400], displayCropBox: [0,0,300,400], rotation: 0, displayWidth: 300, displayHeight: 400, pdfToDisplay: [1,0,0,-1,0,400],
    });
    await processPdf({ ...ownedFixture, p0RunDir: ownedFixture.run, previewDir: ownedFixture.preview }, { inspectPdf: async () => ownedFixture.inspection });
    await translateRun({ runDir: ownedFixture.runDir, selection: 'auto', provider: { baseUrl: 'http://localhost:1/v1', model: 'restart-echo-mock' }, resume: false, newJob: false }, {
      generationKind: 'mock', provider: { generate: async request => ({ translations: request.data.blocks.map(block => ({ id: block.id, text: block.protectedText })) }) },
    });
    const archivePath = join(directory, 'reader.zip');
    await exportBundle({ runDir: ownedFixture.runDir, outputDir: join(directory, 'bundle'), archivePath });
    archivePaths.push(archivePath);
  }
  const imported = [];
  for (const archivePath of archivePaths) {
    const validated = await validateBundle(createArchiveFileSource(archivePath, defaultBundleLimits), { limits: defaultBundleLimits });
    let documentId;
    const bytes = await readFile(archivePath);
    async function importSame() {
      const create = await request('/api/v1/bundle-imports', { actor: reader, method: 'POST', body: documentId ? { targetDocumentId: documentId } : {}, headers: { 'Idempotency-Key': randomUUID() } });
      assert.equal(create.status, 201, `bundle create HTTP ${create.status}`); const pending = await create.json();
      const receive = await request(`/api/v1/bundle-imports/${pending.id}/content`, { actor: reader, method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/zip' } });
      assert.equal(receive.status, 200, `bundle receive HTTP ${receive.status}`); const result = await receive.json(); assert.equal(result.status, 'completed'); if (documentId) assert.equal(result.documentId, documentId); else documentId = result.documentId; return result;
    }
    const accepted = await importSame(); const duplicate = await importSame();
    assert.equal(duplicate.readerVersionId, accepted.readerVersionId, 'same entry and package are idempotent');
    const base = `/api/v1/documents/${documentId}`;
    const descriptor = await (await request(`${base}/reader`, { actor: reader })).json();
    const blockId = Object.keys(descriptor.index.blockLocations).at(-1);
    const position = { readerVersionId: descriptor.versionId, sourceVersionId: descriptor.source.sourceVersionId, parseId: descriptor.parseId, blockId, blockOffset: 0.3, pdfPageIndex: descriptor.pages.length - 1, view: 'split', contentMode: 'translation' };
    const saved = await request(`${base}/progress`, { actor: reader, method: 'PUT', body: { expectedRevision: 0, position } });
    assert.equal(saved.status, 200); const progress = await saved.json();
    imported.push({ base, validated, descriptor, progress, archivePath, archiveSha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const profile = await (await request('/api/v1/settings/provider', { actor: reader })).json();
  const { revision, hasApiKey, ...settings } = profile;
  const save = await request('/api/v1/settings/provider', { actor: reader, method: 'PUT', body: { expectedRevision: revision, settings: { ...settings, baseUrl: 'https://api.example.com/v1', model: 'restart-fixture' }, key: { action: 'replace', value: fakeKey } } });
  assert.equal(save.status, 200);
  // Capture a real Web original with one supported imported block, leaving other text partial.
  // Echo candidates prove retained structure, never translation quality.
  const web = await withCandidates('<article><h1>Retained web source</h1><p>The software system preserves the first original paragraph for later reading.</p><p>The second original paragraph remains untranslated after the partial import.</p><img src="https://resource.example/chart.png"></article>');
  const candidate = JSON.parse(web.translation.toString()); candidate.blocks = candidate.blocks.slice(0, 1);
  web.translation = Buffer.from(JSON.stringify(candidate));
  const translationFile = web.manifest.files.find(file => file.id === 'translation');
  translationFile.bytes = web.translation.length; translationFile.sha256 = createHash('sha256').update(web.translation).digest('hex');
  const captureCreate = await request('/api/v1/captures', { actor: reader, method: 'POST', body: { manifest: web.manifest, translationIntent: 'none' }, headers: { 'Idempotency-Key': web.manifest.captureId } });
  assert.equal(captureCreate.status, 201); const capture = await captureCreate.json();
  for (const file of web.manifest.files) {
    const response = await request(`/api/v1/captures/${capture.id}/files/${file.id}`, { actor: reader, method: 'PUT', body: file.id === 'html' ? web.body : web.translation, headers: { 'Content-Type': file.mediaType } });
    assert.equal(response.status, 200);
  }
  const committed = await request(`/api/v1/captures/${capture.id}/commit`, { actor: reader, method: 'POST', body: {} });
  assert.equal(committed.status, 200); const webResult = await committed.json();
  const webBase = `/api/v1/documents/${webResult.documentId}`;
  const webDescriptor = await (await request(webBase + '/web-reader', { actor: reader })).json();
  assert.equal(webDescriptor.index.generationKind, 'import'); assert.equal(webDescriptor.translationStatus, 'partial');
  const webManifest = await (await request(`${webBase}/web-snapshots/${webDescriptor.source.sourceVersionId}/manifest`, { actor: reader })).json();
  const webPosition = { readerVersionId: webDescriptor.versionId, sourceVersionId: webDescriptor.source.sourceVersionId, parseId: webDescriptor.parseId, blockId: Object.keys(webDescriptor.index.blockLocations)[0], blockOffset: 0.4, view: 'content', contentMode: 'bilingual' };
  const webProgressResponse = await request(webBase + '/web-progress', { actor: reader, method: 'PUT', body: { expectedRevision: 0, position: webPosition } });
  assert.equal(webProgressResponse.status, 200); const webProgress = await webProgressResponse.json();
  const glossaryResponse = await request('/api/v1/settings/glossary', { actor: reader, method: 'PUT', body: { expectedRevision: 0, entries: [{ source: 'software', target: '软件', policy: 'translate', domain: 'all' }] } });
  assert.equal(glossaryResponse.status, 200); const glossary = await glossaryResponse.json();
  await compose(['up', '--detach', '--wait', 'worker']);
  assert.match(await compose(['top', 'worker']), /worker\/main.js/);
  // Recreate API, worker and database containers so persistence cannot accidentally rely on writable layers.
  // Keep only this project's named volumes until final cleanup.
  await compose(['down']);
  await compose(['up', '--detach', '--build', '--wait']);
  await ready();
  await login('restartreader', readerPassword);
  assert.match(await compose(['top', 'worker']), /worker\/main.js/);
  assert.deepEqual(await (await request(webBase + '/web-reader', { actor: reader })).json(), { ...webDescriptor, progress: webProgress });
  assert.deepEqual(await (await request(webBase + '/web-progress', { actor: reader })).json(), webProgress);
  assert.deepEqual(await (await request('/api/v1/settings/glossary', { actor: reader })).json(), glossary);
  for (const file of webManifest.files) {
    const path = `${webBase}/web-snapshots/${webDescriptor.source.sourceVersionId}/files/${file.id}`;
    const response = await request(path, { actor: reader }); assert.equal(response.status, 200);
    assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), file.sha256);
    assert.equal((await request(path)).status, 401); assert.equal((await request(path, { actor: admin })).status, 404);
  }
  console.log('Web original, partial imported translation, glossary, progress and private files survived API/worker/database retained-volume recreation.');
  for (const entry of imported) {
    const { base, validated, descriptor, progress, archiveSha256 } = entry;
    const restoredDescriptor = await (await request(`${base}/reader`, { actor: reader })).json();
    assert.equal(restoredDescriptor.versionId, descriptor.versionId);
    assert.deepEqual(await (await request(`${base}/progress`, { actor: reader })).json(), progress);
    assert.equal(restoredDescriptor.index.generationKind, validated.translation.generationKind);
    for (const chunk of validated.readerBuild.chunks) {
      const response = await request(`${base}/readers/${descriptor.versionId}/chunks/${chunk.id}`, { actor: reader });
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), chunk);
    }
    const sourceResponse = await request(`${base}/source`, { actor: reader });
    assert.equal(sourceResponse.status, 200);
    assert.equal(createHash('sha256').update(Buffer.from(await sourceResponse.arrayBuffer())).digest('hex'), validated.ir.source.sha256);
    const bundleRoute = `${base}/readers/${descriptor.versionId}/bundle`;
    const download = await request(bundleRoute, { actor: reader }); assert.equal(download.status, 200);
    const bytes = Buffer.from(await download.arrayBuffer()); assert.equal(createHash('sha256').update(bytes).digest('hex'), archiveSha256);
    const downloaded = join(directory, randomUUID() + '.zip'); await writeFile(downloaded, bytes);
    const revalidated = await validateBundle(createArchiveFileSource(downloaded, defaultBundleLimits), { limits: defaultBundleLimits });
    assert.equal(revalidated.manifestSha256, validated.manifestSha256);
    const privateRoutes = [`${base}/source`, `${base}/reader`, `${base}/progress`, bundleRoute, `${base}/readers/${descriptor.versionId}/chunks/${validated.readerBuild.chunks[0].id}`];
    for (const asset of validated.ir.assets) {
      const path = `${base}/readers/${descriptor.versionId}/assets/${descriptor.assetMap[asset.id]}`;
      const response = await request(path, { actor: reader }); assert.equal(response.status, 200);
      assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), asset.sha256);
      privateRoutes.push(path);
    }
    for (const path of privateRoutes) { assert.equal((await request(path)).status, 401); assert.equal((await request(path, { actor: admin })).status, 404); }
    console.log(`Reader persisted: ${validated.ir.pages.length} pages, ${validated.readerBuild.chunks.length} chunks, ${validated.ir.assets.length} images; archive revalidated; progress and ownership passed.`);
  }
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
  console.log('Restart acceptance passed: S2→006, same-entry/idempotent bundle import, reader chunks/translation/assets/download/progress, PDF hash, profile decryption, sessions, ownership, revocation, SPA boundaries.');
} catch (error) {
  console.error(error instanceof assert.AssertionError ? `Restart assertion failed: ${error.message.split('\n')[0]}` : error.message);
  if (error instanceof assert.AssertionError) console.error(error.stack.split('\n').find(line => line.includes('check-site-restart.mjs:')) ?? 'No assertion location');
  process.exitCode ||= 1;
} finally {
  for (const [path, before] of archiveHashes) {
    const after = createHash('sha256').update(await readFile(path)).digest('hex');
    console.log(JSON.stringify({ archive: path, before, after, unchanged: before === after }));
    if (before !== after) process.exitCode = 1;
  }
  if (started) {
    try { await compose(['down', '--volumes', '--remove-orphans', '--rmi', 'local']); }
    catch { console.error('Failed to clean isolated restart project: ' + project); process.exitCode ||= 1; }
  }
  if (ownedFixture) await rm(ownedFixture.root, { recursive: true, force: true });
  await rm(directory, { recursive: true, force: true });
}
