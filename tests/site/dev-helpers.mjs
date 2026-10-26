import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
export async function port() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const result = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return result;
}
async function publicObjects(pool) {
  return (await pool.query(`SELECT c.oid::text, c.relname, c.relkind,
    a.attname, a.atttypid::text, a.attnum, a.attnotnull,
    pg_get_expr(d.adbin, d.adrelid) AS default_expression
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname='public' ORDER BY c.oid,a.attnum`)).rows;
}
export async function withDev(overrides, run) {
  const admin = new pg.Pool({ connectionString: process.env.PAGELINGO_TEST_DATABASE_URL, connectionTimeoutMillis: 5000 });
  const before = await publicObjects(admin);
  const schema = `pgl_test_${randomUUID().replaceAll('-', '')}`;
  const directory = await mkdtemp(join(tmpdir(), 'pgl-dev-'));
  const apiPort = overrides.apiPort ?? await port();
  const vitePort = await port();
  const file = join(directory, '.env');
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const scopedUrl = new URL(process.env.PAGELINGO_TEST_DATABASE_URL);
  scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
  const databaseUrl = scopedUrl.toString();
  let child;
  let exited;
  let output = '';
  const runtime = {
    apiPort, vitePort, directory, file,
    env: { PAGELINGO_SITE_MODE: 'local', PAGELINGO_SITE_ORIGIN: `http://127.0.0.1:${vitePort}`, PAGELINGO_SERVICE_PORT: String(apiPort), PAGELINGO_VITE_PORT: String(vitePort), PAGELINGO_DATA_DIR: `${directory}/objects`, DATABASE_URL: databaseUrl, PAGELINGO_MASTER_KEY_ID: 'test', PAGELINGO_MASTER_KEYS_JSON: JSON.stringify({ test: Buffer.alloc(32, 5).toString('base64') }), ...overrides.env },
    async start() {
      await writeFile(file, Object.entries(runtime.env).map(([key, value]) => `${key}='${value}'`).join('\n') + '\n', { mode: 0o600 });
      child = spawn(process.execPath, [resolve('scripts/dev-site.mjs'), '--file', file], { stdio: ['ignore', 'pipe', 'pipe'] });
      output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    },
    async ready() {
      for (let i = 0; i < 160; i++) {
        if (child.exitCode !== null) break;
        try {
          if ((await fetch(`http://127.0.0.1:${apiPort}/health/ready`)).ok && (await fetch(`http://127.0.0.1:${vitePort}/api/v1/auth/session`)).ok) return;
        } catch {}
        await delay(100);
      }
      assert.fail(`dev startup failed: ${output}`);
    },
    async stop(signal = 'SIGTERM') {
      if (child?.exitCode === null) child.kill(signal);
      return exited;
    },
    async expectFailure() {
      const result = await Promise.race([exited, delay(6000).then(() => null)]);
      assert.ok(result, 'launcher must exit when API startup fails');
      assert.notEqual(result.code, 0);
      await assert.rejects(fetch(`http://127.0.0.1:${vitePort}/`));
    },
  };
  try { await run(runtime); }
  finally {
    try {
      try { await runtime.stop(); }
      finally {
        try { await rm(directory, { recursive: true, force: true }); }
        finally { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
      }
      assert.deepEqual(await publicObjects(admin), before, 'external public objects must remain unchanged');
      assert.equal((await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0, 'owned schema must be removed');
    } finally { await admin.end(); }
  }
}
