import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const args = process.argv.slice(2);
try {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    assert(['--samples', '--output'].includes(args[i]) && args[i + 1] && !options[args[i]], 'Usage: npm run check:web-capture -- --samples <samples.json> --output <new-dir>');
    options[args[i]] = args[i + 1];
  }
  assert(options['--samples'] && options['--output'], 'Usage: npm run check:web-capture -- --samples <samples.json> --output <new-dir>');
  const samples = await realpath(resolve(options['--samples']));
  const output = resolve(options['--output']);
  const declaration = JSON.parse(await readFile(samples, 'utf8'));
  assert(declaration.schemaVersion === 'pagelingo-web-samples/1' && Array.isArray(declaration.samples) && declaration.samples.length, 'Declare at least one sample using pagelingo-web-samples/1');
  assert(!await stat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; }), 'Output must be a new directory');
  await realpath(dirname(output));
  const ids = new Set();
  for (const sample of declaration.samples) {
    assert(/^[a-z0-9-]{1,80}$/.test(sample.id) && !ids.has(sample.id), 'Unique sample id required'); ids.add(sample.id);
    assert(['synthetic', 'cached-public'].includes(sample.kind), 'Explicit sample kind required');
    assert(/^https?:$/.test(new URL(sample.url).protocol) && !new URL(sample.url).username && !new URL(sample.url).password, 'Public HTTP(S) source URL required');
    assert(sample.htmlFile && /^[a-f0-9]{64}$/.test(sample.sha256) && Number.isFinite(Date.parse(sample.capturedAt)), 'Input path, SHA256 and collection time required');
    assert(Array.isArray(sample.unverified) && sample.expected?.scope && Array.isArray(sample.expected.contains), 'Declare scope, expected content and unverified boundaries');
  }
  await mkdir(output, { mode: 0o700 });
  // No dotenv, provider keys, or user DATABASE_URL. The disposable runner owns its resources.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|TMPDIR|LANG|TZ|DISPLAY|XDG_RUNTIME_DIR|PLAYWRIGHT_BROWSERS_PATH|PAGELINGO_TEST_DATABASE_URL)$/.test(key)));
  const child = spawn(process.execPath, ['scripts/with-test-postgres.mjs', '--', process.execPath, '--import', 'tsx', 'tests/site/web-capture-runner.mjs', samples, output], { env, stdio: 'inherit' });
  let interrupted;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted ??= signal; child.kill(signal); });
  process.exitCode = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolveExit(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1))); });
  if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
} catch (error) { console.error(error.message); process.exitCode = 1; }
