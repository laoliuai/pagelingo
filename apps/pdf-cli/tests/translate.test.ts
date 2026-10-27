import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateReaderTranslation } from '@pagelingo/document-renderer';
import { translateRun } from '../src/translate.js';
import { echo, echoProvider, english, providerConfig, readyRun } from './translation-fixture.js';

test('auto skips Chinese and preserves uncertain text for manual selection without provider requests', async () => {
  for (const body of ['<p>这是中文原文。</p>', '<p>abcdefghijklmno</p>', `<p>${'这是中文解释'.repeat(8)}${' model learning test '.repeat(6)}</p>`]) {
    const f = await readyRun(body);
    let requests = 0;
    const result = await translateRun({ runDir: f.runDir, selection: 'auto', provider: providerConfig, resume: false, newJob: false }, {
      provider: { generate: async request => { requests++; return echo(request); } }, generationKind: 'mock',
    });
    expect(requests).toBe(0);
    expect(result.snapshot.metrics.requests).toBe(0);
    expect(result.snapshot.status).toBe(f.ir.metadata.language.language === 'zh' ? 'not-required' : 'pending');
    expect(result.snapshot.blocks.every(b => b.status === 'source-only')).toBe(true);
    if (result.snapshot.status === 'pending') expect(result.warnings).toContain('MANUAL_SELECTION_REQUIRED');
    validateReaderTranslation(f.ir, result.snapshot);
  }
});
test('uses SDK protected raw results, splits long text, inherits short headings and excludes Chinese quotations', async () => {
  const f = await readyRun(`<h1>Introduction</h1><p>${english} <span data-docvortex-latex="x^2"></span></p><p>中文引语</p><p>${english.repeat(60)}</p>`);
  const before = await readFile(join(f.runDir, 'source-ir.json'));
  const result = await translateRun({ runDir: f.runDir, selection: 'auto', provider: providerConfig, resume: false, newJob: false,
    glossary: [{ source: 'model', target: '模型', policy: 'translate', domain: 'machine-learning' }],
  }, { provider: echoProvider, generationKind: 'mock' });
  expect(result.snapshot.status).toBe('completed');
  expect(result.snapshot.generationKind).toBe('mock');
  expect(result.snapshot.units.length).toBeGreaterThan(result.snapshot.selectionBlockIds.length);
  expect(result.snapshot.blocks[0].status).toBe('translated');
  expect(result.snapshot.blocks[2]).toMatchObject({ status: 'source-only', reason: 'language-not-required' });
  const validated = validateReaderTranslation(f.ir, result.snapshot);
  expect(validated.blocks.size).toBe(3);
  expect(await readFile(join(f.runDir, 'source-ir.json'))).toEqual(before);
  expect(await readFile(join(f.runDir, result.snapshotPath), 'utf8')).not.toContain('localhost');
});
test('explicit none/all and source override persist replayable outcomes without changing immutable language metadata', async () => {
  const f = await readyRun('<p>abcdefghijklmno</p>');
  const options = { runDir: f.runDir, selection: 'none' as const, provider: providerConfig, resume: false, newJob: false };
  const none = await translateRun(options, { provider: echoProvider, generationKind: 'mock' });
  expect(none.snapshot.status).toBe('pending');
  const all = await translateRun({ ...options, selection: 'all', sourceLanguage: 'en', newJob: true }, { provider: echoProvider, generationKind: 'mock' });
  expect(all.snapshot.status).toBe('completed');
  expect(all.snapshot.sourceLanguage).toBe('en');
  expect(f.ir.metadata.language.language).toBe('und');
  validateReaderTranslation(f.ir, all.snapshot);
  expect(await readFile(join(f.runDir, none.snapshotPath), 'utf8')).toContain(none.snapshot.id);
});

test('SDK zero-unit planning failure stays source-only unless a verified complete-block cache covers it', async () => {
  const f = await readyRun(`<p>${english}</p>`);
  const base = { runDir: f.runDir, selection: 'all' as const, provider: providerConfig, resume: false, newJob: false };
  const tooSmall = { maxInputTokens: 1, maxOutputTokens: 1, contextWindowTokens: 1024 };
  const failed = await translateRun({ ...base, budget: tooSmall }, { provider: echoProvider, generationKind: 'mock' });
  expect(failed.snapshot.status).toBe('failed');
  expect(failed.snapshot.units).toHaveLength(0);
  expect(failed.snapshot.blocks[0]).toMatchObject({ status: 'source-only', reason: 'failed' });
  expect(failed.snapshot.metrics.requests).toBe(0);
  await translateRun({ ...base, newJob: true }, { provider: echoProvider, generationKind: 'mock' });
  const covered = await translateRun({ ...base, newJob: true, budget: tooSmall }, { provider: { generate: async () => { throw new Error('must not request'); } }, generationKind: 'mock' });
  expect(covered.snapshot.status).toBe('completed');
  expect(covered.snapshot.units).toHaveLength(0);
  expect(covered.snapshot.metrics.requests).toBe(0);
  validateReaderTranslation(f.ir, covered.snapshot);
});

test('many unique SDK batches retain bounded full snapshots and bytes while every SDK transition stays durable', async () => {
  const { readdir, stat } = await import('node:fs/promises');
  const { atomicWrite } = await import('../src/file-checkpoints.js');
  for (const count of [24, 48]) {
    const f = await readyRun(Array.from({ length: count }, (_, index) => `<p>${english} Unique paragraph ${index}.</p>`).join(''));
    let checkpointWrites = 0;
    const result = await translateRun({ runDir: f.runDir, selection: 'all', provider: providerConfig, resume: false, newJob: false, budget: { maxBatchBlocks: 1 } }, {
      provider: echoProvider, generationKind: 'mock', checkpointWrite: async (...args) => { checkpointWrites++; await atomicWrite(...args); },
    });
    const snapshotDirectory = join(f.runDir, 'translation/jobs', result.job.jobId, 'snapshots');
    const names = await readdir(snapshotDirectory);
    const sizes = await Promise.all(names.map(async name => (await stat(join(snapshotDirectory, name))).size));
    const finalBytes = (await stat(join(f.runDir, result.snapshotPath))).size;
    expect(result.snapshot.status).toBe('completed');
    expect(result.snapshot.metrics.requests).toBe(count);
    expect(checkpointWrites).toBe(2 * count + 1);
    expect(names.length).toBeLessThanOrEqual(6);
    expect(names.length).toBeLessThan(count / 3);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(6 * finalBytes);
    validateReaderTranslation(f.ir, result.snapshot);
  }
  // The two runs perform 146 durable checkpoint writes plus cache/snapshot fsyncs.
}, 20_000);
