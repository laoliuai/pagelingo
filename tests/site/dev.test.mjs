import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { withDev } from './dev-helpers.mjs';
import { buildPdfFixture } from '../fixtures/pdf.ts';
const options = { skip: !process.env.PAGELINGO_TEST_DATABASE_URL, timeout: 90_000 };
for (const signal of ['SIGTERM', 'SIGINT']) test(`dev owns its schema, serves decoder JavaScript and forwards ${signal}`, options, () => withDev({}, async runtime => {
  await runtime.start();
  await runtime.ready();
  const response = await fetch(`http://127.0.0.1:${runtime.vitePort}/assets/pdfjs/wasm/openjpeg_nowasm_fallback.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.equal((await runtime.stop(signal)).code, signal === 'SIGTERM' ? 143 : 130);
  for (const port of [runtime.apiPort, runtime.vitePort]) await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
}));
test('invalid API configuration terminates both owned development processes', options, () => withDev({ env: { PAGELINGO_SITE_MODE: 'invalid' } }, async runtime => {
  await runtime.start();
  await runtime.expectFailure();
  await assert.rejects(fetch(`http://127.0.0.1:${runtime.apiPort}/`));
}));
test('occupied API port fails without accepting or stopping the preexisting server', options, async () => {
  const sentinel = createServer((_request, response) => response.end('preexisting'));
  await new Promise(resolve => sentinel.listen(0, '127.0.0.1', resolve));
  const apiPort = sentinel.address().port;
  try {
    await withDev({ apiPort }, async runtime => {
      await runtime.start();
      await runtime.expectFailure();
      assert.equal(await (await fetch(`http://127.0.0.1:${apiPort}/health/ready`)).text(), 'preexisting');
    });
  } finally { await new Promise(resolve => sentinel.close(resolve)); }
});
test('development database project differs from preview and native PDFs survive dev restart', options, () => withDev({}, async runtime => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.match(pkg.scripts['site:db'], /--project-name pagelingo-site-dev /);
  assert.match(pkg.scripts['site:db'], /--env-file \.env\.site-dev\.local /);
  await runtime.start();
  await runtime.ready();
  const command = pkg.scripts['site:db'].split(' ');
  const devArgs = command.slice(1, command.indexOf('up'));
  devArgs[devArgs.indexOf('--env-file') + 1] = runtime.file;
  const composeEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(COMPOSE_|PAGELINGO_|POSTGRES_|DATABASE_URL$)/.test(key))), POSTGRES_PASSWORD: randomUUID() };
  function configured(args) {
    const result = spawnSync('docker', [...args, 'config', '--format', 'json'], { env: composeEnv, encoding: 'utf8' });
    assert.equal(result.status, 0, 'isolated Compose config must resolve');
    return JSON.parse(result.stdout);
  }
  const dev = configured(devArgs);
  const preview = configured(['compose', '--project-name', 'pagelingo-site', '--env-file', runtime.file, '-f', 'deploy/compose.site.yml']);
  assert.equal(dev.name, 'pagelingo-site-dev');
  assert.notEqual(dev.volumes.database.name, preview.volumes.database.name);
  assert.equal(dev.services.db.ports[0].host_ip, '127.0.0.1');
  assert.equal(dev.services.db.ports[0].published, '54330');
  assert.equal(preview.services.db.ports, undefined);
  const bootstrap = spawnSync(process.execPath, ['--import', 'tsx', 'apps/document-service/src/cli/bootstrap-admin.ts', '--username', 'devreader', '--password-stdin'], { env: { ...process.env, ...runtime.env }, input: 'dev-only-password-42\n', encoding: 'utf8' });
  assert.equal(bootstrap.status, 0, 'owned dev bootstrap');
  const origin = `http://127.0.0.1:${runtime.vitePort}`;
  const login = await fetch(`${origin}/api/v1/auth/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'devreader', password: 'dev-only-password-42' }) });
  assert.equal(login.status, 200);
  const session = await login.json();
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: origin, 'X-CSRF-Token': session.csrfToken };
  const pdf = buildPdfFixture(2);
  const body = new FormData();
  body.set('file', new Blob([pdf], { type: 'application/pdf' }), 'native-dev.pdf');
  const upload = await fetch(`${origin}/api/v1/documents/pdf`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': randomUUID() }, body });
  assert.equal(upload.status, 201);
  const document = await upload.json();
  assert.equal(document.source.sha256, createHash('sha256').update(pdf).digest('hex'));
  await runtime.stop();
  await runtime.start();
  await runtime.ready();
  const source = await fetch(`${origin}/api/v1/documents/${document.id}/source`, { headers });
  assert.equal(source.status, 200);
  assert.equal(createHash('sha256').update(Buffer.from(await source.arrayBuffer())).digest('hex'), document.source.sha256);
}));
