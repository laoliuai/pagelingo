import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { test } from 'node:test';
const script = resolve('scripts/create-site-secrets.mjs');
for (const scenario of ['new', 'existing', 'id-only', 'ring-only', 'invalid', 'symlink']) {
  test(`keygen ${scenario}: preserves configuration and never prints secrets`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pgl-keygen-'));
    const path = join(directory, '.env.local');
    const key = Buffer.alloc(32, 19).toString('base64');
    const ring = `PAGELINGO_MASTER_KEYS_JSON='${JSON.stringify({ retained: key })}'\n`;
    let before = '# unrelated\nOTHER_SECRET=do-not-print-me\n';
    if (['existing', 'id-only', 'invalid'].includes(scenario)) before += 'PAGELINGO_MASTER_KEY_ID=retained\n';
    if (['existing', 'ring-only'].includes(scenario)) before += ring;
    if (scenario === 'invalid') before += 'PAGELINGO_MASTER_KEYS_JSON=invalid\n';
    try {
      if (scenario !== 'new') await writeFile(path, before, { mode: 0o644 });
      if (scenario === 'symlink') { await rm(path); await writeFile(join(directory, 'target'), before); await symlink('target', path); }
      const result = spawnSync(process.execPath, [script, '--file', path], { encoding: 'utf8' });
      assert.equal(result.status, ['invalid', 'symlink'].includes(scenario) ? 1 : 0, result.stderr);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(key));
      assert.ok(!`${result.stdout}${result.stderr}`.includes('do-not-print-me'));
      const after = await readFile(path, 'utf8');
      if (['invalid', 'symlink'].includes(scenario)) { assert.equal(after, before); return; }
      if (scenario !== 'new') assert.ok(after.startsWith(before));
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      const env = parseEnv(after);
      const keys = JSON.parse(env.PAGELINGO_MASTER_KEYS_JSON);
      for (const value of Object.values(keys)) assert.ok(!`${result.stdout}${result.stderr}`.includes(value));
      assert.equal(Buffer.from(keys[env.PAGELINGO_MASTER_KEY_ID], 'base64').length, 32);
      if (['existing', 'ring-only'].includes(scenario)) assert.equal(keys.retained, key);
      const repeat = spawnSync(process.execPath, [script, '--file', path], { encoding: 'utf8' });
      assert.equal(repeat.status, 0);
      assert.equal(await readFile(path, 'utf8'), after);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
