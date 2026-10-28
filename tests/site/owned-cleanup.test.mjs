import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOwnedCleanup } from './owned-cleanup.mjs';

test('cleanup is idempotent and attempts later resources after rejection or a stuck close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pgl-cleanup-regression-'));
  const sentinel = join(root, 'sentinel');
  const owned = join(root, 'owned');
  await writeFile(sentinel, 'keep'); await writeFile(owned, 'remove');
  const cleanup = createOwnedCleanup([
    [{ name: 'rejected close', timeoutMs: 50, run: async () => { throw new Error('injected close failure'); } }],
    [{ name: 'stuck close', timeoutMs: 50, run: () => new Promise(() => {}) }],
    [{ name: 'owned file', timeoutMs: 200, run: () => rm(owned) }],
  ]);
  try {
    const first = cleanup(); assert.equal(cleanup(), first);
    const results = await first;
    assert.deepEqual(results.map(({ name, status }) => ({ name, status })), [
      { name: 'rejected close', status: 'failed' }, { name: 'stuck close', status: 'failed' }, { name: 'owned file', status: 'passed' },
    ]);
    await assert.rejects(readFile(owned), { code: 'ENOENT' });
    assert.equal(await readFile(sentinel, 'utf8'), 'keep');
    assert.match(results[0].error, /injected/); assert.match(results[1].error, /deadline/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
