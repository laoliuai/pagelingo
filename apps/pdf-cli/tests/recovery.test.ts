import { expect, test, vi } from 'vitest';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CheckpointConflictError, ProviderError } from '@pagelingo/translation-core';
import { translateRun, loadTranslationRun } from '../src/translate.js';
import { acquireRunLock } from '../src/run-lock.js';
import { atomicWrite } from '../src/file-checkpoints.js';
import { echo, echoProvider, english, providerConfig, readyRun } from './translation-fixture.js';
const opts = (runDir: string) => ({ runDir, selection: 'all' as const, provider: providerConfig, resume: false, newJob: false, budget: { maxBatchBlocks: 1 } });

test('interruption on second request retains first verified block; resume requests only unfinished units and old snapshots remain immutable', async () => {
  const f = await readyRun(`<p>${english}</p><p>${english} Second.</p><p>${english} Third.</p>`);
  const controller = new AbortController(); let calls = 0;
  const interrupted = await translateRun(opts(f.runDir), { generationKind: 'mock', signal: controller.signal, provider: { generate: async request => {
    if (++calls === 2) { controller.abort(); return echo(request); } return echo(request);
  } } });
  expect(interrupted.snapshot.status).toBe('partial');
  expect(interrupted.snapshot.blocks.filter(b => b.status === 'translated')).toHaveLength(1);
  const resumedIds: string[] = [];
  const resumed = await translateRun({ ...opts(f.runDir), resume: true }, { generationKind: 'mock', provider: { generate: async request => {
    resumedIds.push(...request.data.blocks.map(b => b.id)); return echo(request);
  } } });
  expect(resumed.snapshot.status).toBe('completed');
  expect(resumedIds).toEqual(['u1:0', 'u2:0']);
  expect(await readFile(join(f.runDir, interrupted.snapshotPath), 'utf8')).toContain('partial');
  expect((await loadTranslationRun(f.runDir)).snapshot.id).toBe(resumed.snapshot.id);
  await expect(translateRun({ ...opts(f.runDir), provider: { ...providerConfig, model: 'changed' }, resume: true }, { provider: echoProvider, generationKind: 'mock' })).rejects.toThrow('TRANSLATION_CONFIG_CHANGED');
});
test('SDK retries/cooldown persist across cancellation and resume without adapter retry loops', async () => {
  vi.useFakeTimers();
  try {
    const f = await readyRun(`<p>${english}</p>`); const controller = new AbortController();
    let requests = 0;
    const running = translateRun(opts(f.runDir), { generationKind: 'mock', signal: controller.signal, provider: { generate: async () => {
      requests++; setTimeout(() => controller.abort(), 10); throw new ProviderError('http', 'untrusted upstream detail', 429, 5000);
    } } });
    // Let filesystem operations complete, then advance only the cancellation timer.
    await vi.waitFor(async () => expect(requests).toBe(1), { interval: 1 });
    await vi.advanceTimersByTimeAsync(10);
    const stopped = await running;
    const checkpoint = JSON.parse(await readFile(join(f.runDir, stopped.checkpointPath), 'utf8'));
    expect(checkpoint.nextRequestAt).toBeGreaterThan(Date.now());
    let resumedRequests = 0;
    const resumed = translateRun({ ...opts(f.runDir), resume: true }, { provider: { generate: async request => { resumedRequests++; return echo(request); } }, generationKind: 'mock' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(resumedRequests).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.runAllTimersAsync();
    const complete = await resumed;
    expect(complete.snapshot.status).toBe('completed');
    expect(complete.snapshot.metrics.retries).toBe(1);
  } finally { vi.useRealTimers(); }
});
test('disk checkpoint failure stops SDK before another request and keeps last durable state readable', async () => {
  const f = await readyRun(`<p>${english}</p><p>${english}</p>`); let requests = 0;
  await expect(translateRun(opts(f.runDir), { generationKind: 'mock', provider: { generate: async request => { requests++; return echo(request); } },
    checkpointWrite: async (path, bytes) => {
      if (requests === 1) throw new Error('ENOSPC secret details');
      await atomicWrite(path, bytes);
    },
  })).rejects.toBeInstanceOf(CheckpointConflictError);
  expect(requests).toBe(1);
  const state = await loadTranslationRun(f.runDir);
  expect(state.snapshot.status).toBe('pending');
  expect((await stat(join(f.runDir, state.checkpointPath))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(f.runDir, 'source.pdf'), 'utf8')).toContain('PDF');
});
test('exclusive lock rejects double writers and changed epoch fences persistence', async () => {
  const f = await readyRun(); const lock = await acquireRunLock(f.runDir);
  try {
    await expect(acquireRunLock(f.runDir)).rejects.toThrow('TRANSLATION_BUSY');
    await writeFile(join(f.runDir, 'translation/epoch.json'), '"different-epoch"');
    await expect(lock.assertCurrent()).rejects.toBeInstanceOf(CheckpointConflictError);
  } finally { await lock.release(); }
});
test('completed new jobs use verified cache; malformed cache is discarded and retry exhaustion preserves partial success', async () => {
  const f = await readyRun(`<p>${english}</p><p>${english} Extra.</p>`);
  const initial = await translateRun(opts(f.runDir), { provider: echoProvider, generationKind: 'mock' });
  const cached = await translateRun({ ...opts(f.runDir), newJob: true }, { provider: { generate: async () => { throw new Error('cache miss'); } }, generationKind: 'mock' });
  expect(cached.snapshot.metrics.requests).toBe(0);
  expect(cached.snapshot.metrics.cacheHits).toBe(2);
  for (const name of await readdir(join(f.runDir, 'translation/cache'))) await writeFile(join(f.runDir, 'translation/cache', name), '{broken');
  vi.useFakeTimers();
  try {
    let calls = 0;
    const running = translateRun({ ...opts(f.runDir), newJob: true, backoffMs: 0 }, { generationKind: 'mock', provider: { generate: async request => {
      if (++calls > 1) throw new ProviderError('network', 'secret exception'); return echo(request);
    } } });
    const result = await running;
    expect(result.snapshot.status).toBe('partial');
    expect(result.snapshot.metrics.requests).toBe(4);
    expect(result.snapshot.metrics.retries).toBe(2);
    expect(result.snapshot.blocks[0].status).toBe('translated');
    expect(initial.snapshot.id).not.toBe(result.snapshot.id);
  } finally { vi.useRealTimers(); }
});

test('actual child process holds exclusive lock after flock exits and SIGKILL releases it without stale-lock cleanup', async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const f = await readyRun();
  const moduleUrl = new URL('../dist/run-lock.js', import.meta.url).href;
  process.env.PAGELINGO_TASK5_PROCESS_MARKER = 'FAKE_PAGELINGO_TASK5_NEVER_PERSIST_7832';
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { acquireRunLock } = await import(${JSON.stringify(moduleUrl)});
    const lock = await acquireRunLock(${JSON.stringify(f.runDir)});
    process.stdout.write(JSON.stringify({held:true, env:Object.keys(process.env)})+'\\n');
    process.stdin.resume();
  `], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const [output] = await once(child.stdout, 'data');
    expect(JSON.parse(String(output))).toEqual({ held: true, env: [] });
    await expect(acquireRunLock(f.runDir)).rejects.toThrow('TRANSLATION_BUSY');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const recovered = await acquireRunLock(f.runDir); await recovered.release();
  } finally { child.kill('SIGKILL'); delete process.env.PAGELINGO_TASK5_PROCESS_MARKER; }
});
test('late provider response after cancellation cannot enter a subsequent job snapshot or cache', async () => {
  const f = await readyRun(`<p>${english}</p>`); const controller = new AbortController();
  let release!: (value: unknown) => void;
  const stopped = await translateRun(opts(f.runDir), { generationKind: 'mock', signal: controller.signal, provider: { generate: async _request => {
    const pending = new Promise(resolve => { release = resolve; });
    queueMicrotask(() => controller.abort()); return pending;
  } } });
  expect(stopped.snapshot.status).toBe('cancelled');
  const complete = await translateRun({ ...opts(f.runDir), newJob: true }, { generationKind: 'mock', provider: echoProvider });
  const before = await readFile(join(f.runDir, complete.snapshotPath));
  release({ translations: [{ id: 'u0:0', text: 'STALE_RESPONSE_MUST_NOT_BE_COMMITTED' }] });
  await new Promise(resolve => setImmediate(resolve));
  expect((await loadTranslationRun(f.runDir)).snapshot.id).toBe(complete.snapshot.id);
  expect(await readFile(join(f.runDir, complete.snapshotPath))).toEqual(before);
  for (const name of await readdir(join(f.runDir, 'translation/cache'))) expect(await readFile(join(f.runDir, 'translation/cache', name), 'utf8')).not.toContain('STALE_RESPONSE');
});
test('epoch loss during a provider call stops checkpoint writes without discarding earlier verified blocks', async () => {
  const f = await readyRun(`<p>${english}</p><p>${english} Second.</p>`); let calls = 0;
  await expect(translateRun(opts(f.runDir), { generationKind: 'mock', provider: { generate: async request => {
    if (++calls === 2) await writeFile(join(f.runDir, 'translation/epoch.json'), '"obsolete"');
    return echo(request);
  } } })).rejects.toThrow('TRANSLATION_EPOCH_CONFLICT');
  const saved = await loadTranslationRun(f.runDir);
  expect(saved.snapshot.blocks.filter(b => b.status === 'translated')).toHaveLength(1);
  expect(saved.snapshot.status).toBe('partial');
});

test('atomic publication rechecks fencing after temporary-file fsync and preserves previous bytes when fencing fails', async () => {
  const f = await readyRun();
  const path = join(f.root, 'durable-checkpoint.json');
  await atomicWrite(path, Buffer.from('previous checkpoint'));
  await expect(atomicWrite(path, Buffer.from('obsolete checkpoint'), false, async () => {
    throw new CheckpointConflictError('TRANSLATION_EPOCH_CONFLICT');
  })).rejects.toThrow('TRANSLATION_EPOCH_CONFLICT');
  expect(await readFile(path, 'utf8')).toBe('previous checkpoint');
  expect((await readdir(f.root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
});
