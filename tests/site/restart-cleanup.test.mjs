import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { cleanupRestartAcceptance } from '../../scripts/restart-cleanup.mjs';

test('unreadable final input does not skip remaining hashes or owned cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restart-cleanup-test-'));
  const directory = join(root, 'owned-temp');
  const owned = join(root, 'owned-fixture');
  const sentinel = join(root, 'unrelated');
  const remaining = join(root, 'remaining.zip');
  const { mkdir } = await import('node:fs/promises');
  await Promise.all([mkdir(directory), mkdir(owned), writeFile(sentinel, 'keep'), writeFile(remaining, 'original')]);
  const originalExit = process.exitCode;
  const log = console.log, error = console.error;
  const reports = [], errors = [], commands = [];
  console.log = value => reports.push(JSON.parse(value));
  console.error = value => errors.push(value);
  process.exitCode = 7; // Preserve a prior acceptance failure.
  try {
    await assert.doesNotReject(cleanupRestartAcceptance({
      archiveHashes: new Map([[join(root, 'missing.zip'), 'before'], [remaining, createHash('sha256').update('original').digest('hex')]]),
      started: true, project: 'owned-project', directory, ownedFixture: { root: owned },
      compose: async args => { commands.push(args); throw Error('cleanup command failed'); },
    }));
    assert.equal(reports.length, 2);
    assert.equal(reports[0].unchanged, false);
    assert.equal(reports[0].after, null);
    assert.equal(reports[1].unchanged, true);
    assert.deepEqual(commands, [['down', '--volumes', '--remove-orphans', '--rmi', 'local']]);
    assert.equal(process.exitCode, 7);
    assert.ok(errors.length >= 2);
    await assert.rejects(access(directory));
    await assert.rejects(access(owned));
    await access(sentinel);
    await access(remaining);
  } finally {
    console.log = log; console.error = error; process.exitCode = originalExit;
    await rm(root, { recursive: true, force: true });
  }
});
