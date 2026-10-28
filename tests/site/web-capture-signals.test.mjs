import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const databaseUrl = process.env.PAGELINGO_TEST_DATABASE_URL;
const exists = path => stat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function eventually(read, accepts, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  do { const result = await read(); if (accepts(result)) return result; await delay(25); } while (Date.now() < end);
  throw new Error(`Timed out: ${label}`);
}
async function descendants(pid) {
  const children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => '')).trim().split(/\s+/).filter(Boolean).map(Number);
  return [...children, ...(await Promise.all(children.map(descendants))).flat()];
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`native CLI ${signal} retains evidence and removes only its owned resources`, { skip: !databaseUrl, timeout: 45_000 }, async () => {
    const evidenceParent = process.env.PAGELINGO_CAPTURE_SIGNAL_EVIDENCE_DIR;
    if (evidenceParent) await mkdir(evidenceParent, { recursive: true });
    const evidence = await mkdtemp(join(evidenceParent || tmpdir(), `capture-${signal}-`));
    const temporary = await mkdtemp(join(tmpdir(), 'pgl-signal-test-'));
    const output = join(evidence, 'output');
    const sentinelSchema = `pgl_sentinel_${randomUUID().replaceAll('-', '')}`;
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    let child, childDone, ownedSchema, ownedRoot;
    let ownedPids = [];
    let log = '';
    try {
      await pool.query(`CREATE SCHEMA "${sentinelSchema}"`);
      await writeFile(join(temporary, 'sentinel'), 'keep');
      child = spawn(process.execPath, ['scripts/check-web-capture.mjs', '--samples', 'tests/fixtures/web-s3/samples.json', '--output', output], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: temporary, PAGELINGO_TEST_DATABASE_URL: databaseUrl },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      childDone = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', (code, exitSignal) => resolveExit({ code, signal: exitSignal })); });
      child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
      await eventually(() => exists(join(output, 'extension-connected.png')), Boolean, 'real browser, worker and app acquired');
      ownedRoot = join(temporary, (await readdir(temporary)).find(name => name.startsWith('pgl-web-acceptance-')));
      const processes = await Promise.all((await descendants(child.pid)).map(async pid => ({ pid, command: (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).replaceAll('\0', ' ') })));
      const worker = processes.find(value => value.command.includes('mock-worker-process.ts'));
      const browser = processes.find(value => value.command.includes(`--user-data-dir=${ownedRoot}/profile`));
      assert(worker, 'actual independent worker running'); assert(browser, 'actual Chromium profile running');
      ownedSchema = worker.command.match(/mock-worker-process\.ts (pgl_accept_[a-f0-9]{32})(?: |$)/)?.[1];
      assert(ownedSchema, 'schema comes from this CLI owned worker, never another run');
      ownedPids = [worker.pid, browser.pid];
      await eventually(() => exists(join(ownedRoot, 'objects')), Boolean, 'actual private store written');
      assert(await exists(join(ownedRoot, 'profile')));
      const start = Date.now(); child.kill(signal);
      let deadline;
      let result;
      try { result = await Promise.race([childDone, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('CLI did not finish within wrapper shutdown bound')), 8_000); })]); }
      finally { clearTimeout(deadline); }
      const observed = {
        result, elapsedMs: Date.now() - start, workerPid: worker.pid, browserPid: browser.pid,
        workerAlive: alive(worker.pid), browserAlive: alive(browser.pid), rootExists: await exists(ownedRoot),
        ownedSchemaExists: (await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [ownedSchema])).rowCount > 0,
        sentinelSchemaExists: (await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [sentinelSchema])).rowCount > 0,
        sentinelFile: await readFile(join(temporary, 'sentinel'), 'utf8'), unrelatedAlive: alive(unrelated.pid),
        report: JSON.parse(await readFile(join(output, 'report.json'), 'utf8')),
        traceExists: await exists(join(output, 'trace.zip')),
      };
      await writeFile(join(evidence, 'observed.json'), JSON.stringify(observed, null, 2));
      assert.equal(result.code, signal === 'SIGINT' ? 130 : 143); assert.equal(result.signal, null);
      assert.equal(observed.rootExists, false, 'owned private store/profile root removed');
      assert.equal(observed.ownedSchemaExists, false, 'only owned schema dropped');
      assert.equal(observed.workerAlive, false); assert.equal(observed.browserAlive, false);
      assert.equal(observed.sentinelSchemaExists, true); assert.equal(observed.sentinelFile, 'keep'); assert.equal(observed.unrelatedAlive, true);
      assert.equal(observed.report.status, 'interrupted'); assert.equal(observed.report.signal, signal); assert(observed.report.finishedAt);
      assert.equal(observed.traceExists, true, 'interrupted trace retained');
      const trace = await readFile(join(output, 'trace.zip'));
      assert.equal(trace.subarray(0, 2).toString(), 'PK'); assert(trace.length > 100);
      assert(observed.report.cleanup.every(step => step.status === 'passed'), JSON.stringify(observed.report.cleanup));
    } finally {
      await writeFile(join(evidence, 'cli.log'), log);
      if (child?.exitCode === null && child?.signalCode === null) { child.kill('SIGTERM'); await Promise.race([childDone, delay(6000)]); }
      // RED probes may leak resources: reclaim only the exact processes/schema acquired above.
      for (const pid of ownedPids) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      unrelated.kill(); await once(unrelated, 'exit');
      if (ownedSchema) await pool.query(`DROP SCHEMA IF EXISTS "${ownedSchema}" CASCADE`);
      await pool.query(`DROP SCHEMA IF EXISTS "${sentinelSchema}" CASCADE`); await pool.end();
      await rm(temporary, { recursive: true, force: true });
      console.log(`Signal evidence: ${resolve(evidence)}`);
    }
  });
}

test('SIGTERM during delayed schema acquisition cannot leave a late owned schema', { skip: !databaseUrl, timeout: 30_000 }, async () => {
  const evidenceParent = process.env.PAGELINGO_CAPTURE_SIGNAL_EVIDENCE_DIR;
  if (evidenceParent) await mkdir(evidenceParent, { recursive: true });
  const evidence = await mkdtemp(join(evidenceParent || tmpdir(), 'capture-delayed-schema-'));
  const temporary = await mkdtemp(join(tmpdir(), 'pgl-delayed-acquisition-'));
  const output = join(evidence, 'output');
  const databaseName = `pgl_late_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const isolatedUrl = new URL(databaseUrl); isolatedUrl.pathname = '/' + databaseName;
  let pool, child, done, log = '';
  try {
    // Fault injection belongs only to this new disposable database, not the
    // caller's database or another concurrently running acceptance harness.
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    pool = new pg.Pool({ connectionString: isolatedUrl.href });
    await pool.query('CREATE SCHEMA sentinel');
    await pool.query(`CREATE FUNCTION public.delay_owned_schema() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN IF current_query() ~ '^CREATE SCHEMA "pgl_accept_' THEN PERFORM pg_sleep(1.15); END IF; END $$`);
    await pool.query("CREATE EVENT TRIGGER delay_owned_schema ON ddl_command_start WHEN TAG IN ('CREATE SCHEMA') EXECUTE FUNCTION public.delay_owned_schema()");
    child = spawn(process.execPath, ['scripts/check-web-capture.mjs', '--samples', 'tests/fixtures/web-s3/samples.json', '--output', output], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: temporary, PAGELINGO_TEST_DATABASE_URL: isolatedUrl.href },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    done = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolveExit({ code, signal })); });
    child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
    const acquisition = await eventually(async () => (await pool.query("SELECT query FROM pg_stat_activity WHERE datname=$1 AND wait_event='PgSleep'", [databaseName])).rows.find(row => /^CREATE SCHEMA "pgl_accept_/.test(row.query)), Boolean, 'owned CREATE SCHEMA delayed inside PostgreSQL');
    const schema = acquisition.query.match(/^CREATE SCHEMA "(pgl_accept_[a-f0-9]{32})"/)?.[1]; assert(schema);
    const ownedRoot = join(temporary, (await readdir(temporary)).find(name => name.startsWith('pgl-web-acceptance-')));
    const start = Date.now(); child.kill('SIGTERM');
    const result = await done;
    const observed = {
      result, elapsedMs: Date.now() - start, schema,
      ownedSchemaExists: (await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount > 0,
      sentinelSchemaExists: (await pool.query("SELECT 1 FROM pg_namespace WHERE nspname='sentinel'")).rowCount > 0,
      rootExists: await exists(ownedRoot), report: JSON.parse(await readFile(join(output, 'report.json'), 'utf8')),
    };
    await writeFile(join(evidence, 'observed.json'), JSON.stringify(observed, null, 2));
    assert.equal(result.code, 143); assert.equal(result.signal, null);
    assert.equal(observed.ownedSchemaExists, false, 'late CREATE must not survive the only DROP attempt');
    assert.equal(observed.sentinelSchemaExists, true); assert.equal(observed.rootExists, false);
    assert.equal(observed.report.status, 'interrupted'); assert.equal(observed.report.signal, 'SIGTERM');
    assert(observed.elapsedMs < 5000, 'runner completes within unchanged wrapper escalation');
  } finally {
    await writeFile(join(evidence, 'cli.log'), log);
    if (child?.exitCode === null && child?.signalCode === null) { child.kill('SIGTERM'); await done; }
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); await admin.end();
    await rm(temporary, { recursive: true, force: true });
    console.log(`Delayed-acquisition evidence: ${resolve(evidence)}`);
  }
});
