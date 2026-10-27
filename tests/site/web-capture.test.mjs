import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const run = args => spawnSync(process.execPath, ['scripts/check-web-capture.mjs', ...args], { encoding: 'utf8' });
test('requires declared samples and refuses existing output before provisioning a database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pgl-capture-cli-'));
  try {
    const samples = join(root, 'samples.json');
    await writeFile(samples, JSON.stringify({ schemaVersion: 'pagelingo-web-samples/1', samples: [] }));
    const missing = run([]); assert.equal(missing.status, 1); assert.match(missing.stderr, /--samples/);
    const empty = run(['--samples', samples, '--output', join(root, 'new')]);
    assert.equal(empty.status, 1); assert.match(empty.stderr, /at least one sample/);
    const existing = join(root, 'existing'); await mkdir(existing); await writeFile(join(existing, 'sentinel'), 'keep');
    await writeFile(samples, JSON.stringify({ schemaVersion: 'pagelingo-web-samples/1', samples: [{ id: 'one' }] }));
    const result = run(['--samples', samples, '--output', existing]);
    assert.equal(result.status, 1); assert.match(result.stderr, /new directory/);
    assert.equal(await readFile(join(existing, 'sentinel'), 'utf8'), 'keep');
  } finally { await rm(root, { recursive: true, force: true }); }
});
