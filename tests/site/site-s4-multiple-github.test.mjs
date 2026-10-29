import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('two distinct GitHub jobs preserve only their own acquisition recovery proof', { timeout: 180000 }, async t => {
  const parent = process.env.PAGELINGO_TEST_OUTPUT_ROOT ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const evidence = await mkdtemp(join(parent, 's4-multiple-github-'));
  const output = join(evidence, 'acceptance');
  const log = createWriteStream(join(evidence, 'cli.log'), { flags: 'wx' });
  console.log(`Multiple-GitHub evidence: ${evidence}`);
  const child = spawn(process.execPath, ['scripts/check-site-s4.mjs', '--samples', resolve('tests/fixtures/site-s4/multiple-github/samples.json'), '--output', output], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const exited = new Promise((resolveExit, reject) => {
    child.once('error', reject); child.once('close', resolveExit);
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  });
  const code = await exited;
  log.end(); await new Promise(resolveFinish => log.once('finish', resolveFinish));
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
  assert.equal(code, 0, report.error);
  assert.equal(report.status, 'passed');
  assert.equal(report.modelRequests, 0);
  assert.equal(report.cleanupError, undefined);
  const first = report.samples.find(sample => sample.id === 'github-one');
  const second = report.samples.find(sample => sample.id === 'github-two');
  assert.equal(first.status, 'passed'); assert.equal(second.status, 'passed');
  assert.notEqual(first.documentId, second.documentId);
  assert.notEqual(first.jobId, second.jobId);
  assert.equal(first.details.current.repository.id, '2001');
  assert.equal(second.details.current.repository.id, '2002');
  const interruptions = report.interruptions.filter(item => item.kind === 'acquisition');
  assert.equal(interruptions.length, 1);
  const interrupted = interruptions[0];
  assert.equal(interrupted.sampleId, first.id);
  assert.equal(interrupted.jobId, first.jobId);
  assert(interrupted.acquired.length > 0);
  for (const retained of interrupted.acquired) {
    assert(first.acquisitions.some(row => row.id === retained.id && row.sha256 === retained.sha256 && row.bytes === retained.bytes));
    assert(!second.acquisitions.some(row => row.id === retained.id));
  }
  assert.deepEqual(first.reusedAcquisitionIds, interrupted.acquired.map(row => row.id));
  assert.deepEqual(second.reusedAcquisitionIds, []);
  assert.equal(first.repositoryReadCount, 1);
  assert.equal(second.repositoryReadCount, 1);
});
