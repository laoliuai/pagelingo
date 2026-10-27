import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { hash } from './fixtures.js';
const script = fileURLToPath(new URL('../../../scripts/check-s2-compat.mjs', import.meta.url));
const fixture = new URL('./fixtures/s2-final/reader.zip', import.meta.url);
const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 's2-compat-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const run = (input: string, output: string) => spawnSync(process.execPath, [script, '--input', input, '--output', output], { encoding: 'utf8' });

it('checks the fixed old ZIP without rebuilding it and records before/after hashes in a new directory', async () => {
  const output = join(await temp(), 'checked');
  const result = run(fileURLToPath(fixture), output);
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
  expect(report.status).toBe('passed');
  expect(report.samples).toHaveLength(1);
  expect(report.samples[0]).toMatchObject({
    packageId: '00000000-0000-4000-8000-000000000003',
    archiveSha256Before: '4bb9c04d33dd57a43e64b21f2921b916fb2c451ced57a73f75cacf9e9712c136',
    archiveSha256After: '4bb9c04d33dd57a43e64b21f2921b916fb2c451ced57a73f75cacf9e9712c136',
  });
});

it('finds nested ZIPs and preserves each original archive byte', async () => {
  const dir = await temp();
  const input = join(dir, 'inputs');
  await mkdir(join(input, 'nested'), { recursive: true });
  await copyFile(fixture, join(input, 'one.zip'));
  await copyFile(fixture, join(input, 'nested/two.ZIP'));
  const result = run(input, join(dir, 'checked'));
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(await readFile(join(dir, 'checked/report.json'), 'utf8'));
  expect(report.samples).toHaveLength(2);
  for (const name of ['one.zip', 'nested/two.ZIP']) expect(hash(await readFile(join(input, name)))).toBe('4bb9c04d33dd57a43e64b21f2921b916fb2c451ced57a73f75cacf9e9712c136');
});

it('refuses output inside the original tree and refuses an existing destination', async () => {
  const dir = await temp();
  const input = join(dir, 'inputs');
  await mkdir(input);
  await copyFile(fixture, join(input, 'reader.zip'));
  const result = run(input, join(input, 'new'));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('outside');
  const existing = join(dir, 'existing');
  await mkdir(existing);
  await writeFile(join(existing, 'sentinel'), 'keep');
  expect(run(input, existing).status).toBe(1);
  expect(await readFile(join(existing, 'sentinel'), 'utf8')).toBe('keep');
});

it('reports a rejected archive as failed without changing its bytes', async () => {
  const dir = await temp();
  const input = join(dir, 'bad.zip');
  await writeFile(input, 'not a zip');
  const output = join(dir, 'checked');
  expect(run(input, output).status).toBe(1);
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
  expect(report.status).toBe('failed');
  expect(report.samples).toHaveLength(1);
  expect(report.samples[0]).toMatchObject({ input, status: 'failed', archiveBytes: 9, archiveSha256Before: hash(Buffer.from('not a zip')), archiveSha256After: hash(Buffer.from('not a zip')) });
  expect(report.samples[0].error).toEqual(expect.any(String));
  expect(await readFile(input, 'utf8')).toBe('not a zip');
});
