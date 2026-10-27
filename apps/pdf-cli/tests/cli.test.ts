import { afterEach, expect, it, vi } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { readyRun } from './translation-fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('provides bundle and verify commands with sanitized JSON identity results', async () => {
  const f = await readyRun(); roots.push(f.root);
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const errors = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const archive = join(f.root, 'cli.zip');
  expect(await main(['bundle', '--run', f.runDir, '--output', join(f.root, 'cli'), '--archive', archive])).toBe(0);
  const exported = JSON.parse(String(output.mock.calls.at(-1)![0]));
  expect(Object.keys(exported).sort()).toEqual(['manifestSha256', 'packageId']);
  expect(await main(['verify', archive])).toBe(0);
  expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toEqual(exported);
  expect(errors).not.toHaveBeenCalled();
});
it('supports translate --run alias without calling a model for selection none', async () => {
  const f = await readyRun(); roots.push(f.root);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  expect(await main(['translate', '--run', f.runDir, '--base-url', 'http://localhost:11434/v1', '--model', 'owned-fixture', '--selection', 'none'])).toBe(0);
  expect(await readFile(join(f.runDir, 'translation/current.json'), 'utf8')).toContain('jobId');
});
it('rejects malformed verify/bundle input without leaking paths or raw errors', async () => {
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const errors = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  expect(await main(['verify', '/private/missing-fixture.zip'])).toBe(1);
  expect(await main(['bundle', '--run', '/private/missing-run', '--output', '/private/new', '--archive', '/private/new.zip'])).toBe(1);
  expect(errors.mock.calls.flat().join('')).not.toMatch(/private|ENOENT|stack/i);
});
