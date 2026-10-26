import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
async function port() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const result = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return result;
}
// Explicit database lifecycle provided by with-test-postgres; default node tests stay Docker-free.
for (const signal of ['SIGTERM', 'SIGINT']) test(`dev starts API/Vite, serves decoder JavaScript and forwards ${signal}`, { skip: !process.env.PAGELINGO_TEST_DATABASE_URL, timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pgl-dev-'));
  const apiPort = await port();
  const vitePort = await port();
  const file = join(directory, '.env');
  await writeFile(file, `PAGELINGO_SITE_MODE=local\nPAGELINGO_SITE_ORIGIN=http://127.0.0.1:${vitePort}\nPAGELINGO_SERVICE_PORT=${apiPort}\nPAGELINGO_VITE_PORT=${vitePort}\nPAGELINGO_DATA_DIR=${directory}/objects\nDATABASE_URL=${process.env.PAGELINGO_TEST_DATABASE_URL}\nPAGELINGO_MASTER_KEY_ID=test\nPAGELINGO_MASTER_KEYS_JSON='${JSON.stringify({ test: Buffer.alloc(32, 5).toString('base64') })}'\n`, { mode: 0o600 });
  const child = spawn(process.execPath, [resolve('scripts/dev-site.mjs'), '--file', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  try {
    let ready = false;
    for (let i = 0; i < 160; i++) {
      if (child.exitCode !== null) break;
      try {
        if ((await fetch(`http://127.0.0.1:${apiPort}/health/ready`)).ok && (await fetch(`http://127.0.0.1:${vitePort}/api/v1/auth/session`)).ok) { ready = true; break; }
      } catch {}
      await delay(250);
    }
    assert.ok(ready, `dev startup failed: ${output}`);
    const response = await fetch(`http://127.0.0.1:${vitePort}/assets/pdfjs/wasm/openjpeg_nowasm_fallback.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
    child.kill(signal);
    assert.equal((await exited).code, signal === 'SIGTERM' ? 143 : 130);
    for (const value of [apiPort, vitePort]) await assert.rejects(fetch(`http://127.0.0.1:${value}/`));
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
});
