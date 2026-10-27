import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('corpus acceptance requires explicit inputs without starting processing', () => {
  const result = spawnSync(process.execPath, ['scripts/check-pdf-reader.mjs'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Required: --corpus .*--runs-root .*--output/);
  assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND/);
});
test('corpus acceptance rejects empty scope before creating output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pgl-corpus-'));
  try {
    const corpus = join(root, 'corpus.json');
    await writeFile(corpus, JSON.stringify({ samples: [] }));
    const result = spawnSync(process.execPath, ['scripts/check-pdf-reader.mjs', '--corpus', corpus, '--runs-root', root, '--output', join(root, 'output')], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Corpus must select at least one sample/);
    assert.deepEqual(await readdir(root), ['corpus.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('Docker runtime ships both shared reader packages, excludes local CLI, and builds all workspace manifests', async () => {
  const { readFile } = await import('node:fs/promises');
  const docker = await readFile('apps/document-service/Dockerfile', 'utf8');
  for (const name of ['document-renderer', 'document-bundle']) {
    assert(docker.includes(`COPY packages/${name}/package.json packages/${name}/package.json`));
    assert(docker.includes(`/app/packages/${name}/dist ./packages/${name}/dist`));
  }
  assert(docker.includes('/app/packages/document-renderer/static ./packages/document-renderer/static'));
  assert(docker.includes('COPY apps/pdf-cli/package.json apps/pdf-cli/package.json'));
  assert(!docker.includes('/app/apps/pdf-cli/dist'));
});
test('output aliases cannot create acceptance artifacts inside a read-only input', async () => {
  const { mkdir, symlink } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const root = await mkdtemp(join(tmpdir(), 'pgl-corpus-alias-'));
  try {
    const input = join(root, 'input'); await mkdir(input);
    const alias = join(root, 'alias'); await symlink(input, alias);
    const pdf = Buffer.from('%PDF-1.7\nowned fixture');
    await writeFile(join(input, 'source.pdf'), pdf);
    const corpus = join(root, 'corpus.json');
    await writeFile(corpus, JSON.stringify({ samples: [{ id: 'owned', path: join(input, 'source.pdf'), pageCount: 1, sha256: createHash('sha256').update(pdf).digest('hex'), reader: { p0Run: input, preview: input, python: process.execPath } }] }));
    const result = spawnSync(process.execPath, ['scripts/check-pdf-reader.mjs', '--corpus', corpus, '--runs-root', root, '--output', join(alias, 'output')], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Output must be outside original inputs/);
    assert.deepEqual(await readdir(input), ['source.pdf']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
