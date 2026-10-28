import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import { createAcquisitionScope } from './owned-acquisition.mjs';
import { createOwnedCleanup } from './owned-cleanup.mjs';

function gate() {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), release: () => resolve() };
}

for (const kind of ['app', 'context']) {
  test(`cancellation disposes a late ${kind} before acquisition drain finishes`, async () => {
    const controller = new AbortController();
    const scope = createAcquisitionScope(controller.signal);
    const created = gate(); const returned = gate(); const disposed = gate(); const lookupFinished = gate();
    let resource, published, disposalFinished = false, drainFinished = false;
    let browser;
    if (kind === 'context') browser = await chromium.launch({ channel: 'chromium', headless: true });
    const pending = scope.acquire(async () => {
      if (kind === 'app') {
        resource = createServer((_, response) => response.end('owned'));
        resource.listen(0, '127.0.0.1'); await once(resource, 'listening');
      } else resource = await browser.newContext();
      created.release();
      await returned.promise;
      return resource;
    }, async value => {
      if (kind === 'app') await new Promise((resolve, reject) => value.close(error => error ? reject(error) : resolve()));
      else await value.close();
      await disposed.promise;
      disposalFinished = true;
    }).then(value => { published = value; return value; });
    const rejected = assert.rejects(pending, /interrupted/);
    try {
      await created.promise;
      controller.abort(new Error('interrupted'));
      const cleanup = createOwnedCleanup([
        [{ name: 'initial wait', timeoutMs: 10, run: () => scope.settle() }],
        [{ name: 'ordinary resource lookup', timeoutMs: 100, run: async () => {
          assert.equal(published, undefined); lookupFinished.release();
        } }],
        [{ name: 'late disposal drain', timeoutMs: 2000, run: () => scope.settle() }],
      ]);
      const drain = cleanup().then(results => { drainFinished = true; return results; });
      await lookupFinished.promise;
      returned.release();
      // Disposal must finish, not merely start, before the cleanup barrier settles.
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(drainFinished, false);
      disposed.release();
      await rejected; const results = await drain;
      assert.deepEqual(results.map(value => value.status), ['failed', 'passed', 'passed']);
      assert.equal(disposalFinished, true);
      if (kind === 'app') assert.equal(resource.listening, false);
      else { assert.equal(browser.contexts().length, 0); await assert.rejects(resource.newPage(), /closed/); }
    } finally {
      returned.release(); disposed.release();
      if (kind === 'app') resource?.close();
      await browser?.close();
    }
  });
}

test('failed late disposal is reported by the acquisition drain', async () => {
  const controller = new AbortController(); const scope = createAcquisitionScope(controller.signal);
  const returned = gate();
  const pending = scope.acquire(() => returned.promise, async () => { throw new Error('injected disposal failure'); });
  const rejected = assert.rejects(pending, /injected disposal failure/);
  controller.abort(new Error('interrupted')); returned.release();
  await rejected;
  await assert.rejects(scope.settle(), /injected disposal failure/);
});
