import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultBundleLimits } from '@pagelingo/document-contracts';
import { validateInWorker } from '../../src/bundle-imports/worker-client.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const close of cleanup.splice(0)) await close(); });
const entry = new URL('../fixtures/busy-bundle-worker.mjs', import.meta.url);
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'pgl-worker-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'ready.json');
}
async function ready(path: string) {
  for (let i = 0; i < 100; i++) {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  throw new Error('worker never started');
}
it('terminates synchronous CPU at a parent-owned deadline with a positive key-free environment', async () => {
  vi.stubEnv('USER_API_KEY', 'owned-test-sentinel'); vi.stubEnv('PAGELINGO_MASTER_KEYS_JSON', 'owned-master-sentinel');
  const path = await setup(); const started = Date.now(); let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 10);
  try {
    const work = validateInWorker(path, defaultBundleLimits, new AbortController().signal, { entry, deadlineMs: 500 });
    const rejected = expect(work).rejects.toMatchObject({ code: 'BUNDLE_VALIDATION_TIMEOUT' });
    const evidence = await ready(path); expect(evidence).toEqual({ env: { LANG: 'C.UTF-8', TZ: 'UTC' }, inputs: ['limits', 'path'] });
    await rejected; expect(Date.now() - started).toBeLessThan(2000); expect(ticks).toBeGreaterThan(5);
  } finally { clearInterval(timer); }
});
it('terminates a running synchronous worker on cancellation before its deadline', async () => {
  const path = await setup(); const controller = new AbortController();
  const work = validateInWorker(path, defaultBundleLimits, controller.signal, { entry, deadlineMs: 5000 });
  const reason = new Error('owned cancel'); const rejected = expect(work).rejects.toBe(reason);
  await ready(path); const started = Date.now(); controller.abort(reason); await rejected;
  expect(Date.now() - started).toBeLessThan(1000);
});
