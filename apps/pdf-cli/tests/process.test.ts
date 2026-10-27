import { expect, test } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { processPdf } from '../src/index.js';
import { fixture, hash, manifest } from './fixtures/legacy-preview/create.js';

test('rechecks hashes, keeps inputs read-only and writes restartable canonical stage paths', async () => {
  const f = await fixture();
  const before = await readFile(join(f.run, 'manifest.json'));
  const result = await processPdf(
    { ...f, p0RunDir: f.run, previewDir: f.preview },
    { inspectPdf: async () => f.inspection },
  );
  expect(hash(await readFile(join(f.run, 'manifest.json')))).toBe(hash(before));
  expect(
    await readFile(join(f.runDir, 'provenance/input-manifest.json')),
  ).toEqual(before);
  expect(result.paths.ir).toBe('source-ir.json');
  expect(result.status).toBe('complete');
  expect(
    JSON.parse(await readFile(join(f.runDir, 'config.json'), 'utf8'))
      .workflowId,
  ).toMatch(/^[\da-f-]{36}$/);
  expect(
    await readFile(join(f.runDir, 'provenance/parser-config.json'), 'utf8'),
  ).toContain('pagelingo-parser-config/1');
  await expect(
    processPdf({ ...f, p0RunDir: f.run, previewDir: f.preview }),
  ).rejects.toThrow();
});
test('rejects modified source or preview manifest member', async () => {
  const f = await fixture();
  await writeFile(join(f.preview, 'pages/page-0001.html'), 'tampered');
  await expect(
    processPdf(
      { ...f, p0RunDir: f.run, previewDir: f.preview },
      { inspectPdf: async () => f.inspection },
    ),
  ).rejects.toThrow(/checksum|hash/i);
});
test('retains sample and partial upstream status without claiming translation completion', async () => {
  const f = await fixture();
  const run = JSON.parse(await readFile(join(f.run, 'run.json'), 'utf8'));
  run.coverage = 'sample';
  run.status = 'partial';
  await writeFile(join(f.run, 'run.json'), JSON.stringify(run));
  await manifest(f.run, 'pagelingo-run-files/1');
  const preview = JSON.parse(
    await readFile(join(f.preview, 'preview.json'), 'utf8'),
  );
  preview.coverage = 'sample';
  preview.sourceStatus = 'partial';
  preview.sourceManifestSha256 = hash(
    await readFile(join(f.run, 'manifest.json')),
  );
  await writeFile(join(f.preview, 'preview.json'), JSON.stringify(preview));
  await manifest(f.preview, 'pagelingo-static-preview-files/1');
  const out = await processPdf(
    { ...f, p0RunDir: f.run, previewDir: f.preview },
    { inspectPdf: async () => f.inspection },
  );
  const ir = JSON.parse(await readFile(join(f.runDir, out.paths.ir), 'utf8'));
  expect(ir.parse.status).toBe('partial');
  expect(ir.parse.coverage).toBe('partial');
  expect(out.translationStatus).toBe('pending');
  expect(
    JSON.parse(await readFile(join(f.runDir, 'provenance/run.json'), 'utf8'))
      .coverage,
  ).toBe('sample');
});

test('new parse/export subprocesses receive explicit arguments and a nonsecret environment; nonzero valid run is retained', async () => {
  const { cp, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const f = await fixture();
  const katex = join(f.root, 'katex/package');
  await mkdir(katex, { recursive: true });
  await writeFile(
    join(katex, 'package.json'),
    JSON.stringify({ name: 'katex', version: '0.19.0' }),
  );
  await writeFile(
    join(katex, '../integrity.json'),
    JSON.stringify({
      package: 'katex',
      version: '0.19.0',
      integrity: 'sha512-fixture',
    }),
  );
  process.env.PAGELINGO_TEST_SECRET = 'not-in-child';
  try {
    const result = await processPdf(
      {
        sourcePath: f.sourcePath,
        runDir: f.runDir,
        modelDir: join(f.root, 'models'),
        pythonPath: '/owned/python',
        katexDir: katex,
        pages: '1',
      },
      {
        inspectPdf: async () => f.inspection,
        runPython: async (request) => {
          expect(request.env).not.toHaveProperty('PAGELINGO_TEST_SECRET');
          expect(request.env.PATH.split(':')).toContain(
            dirname(process.execPath),
          );
          if (request.args[0] === '-m') {
            expect(request.args.slice(0, 3)).toEqual([
              '-m',
              'pagelingo_parser',
              'parse',
            ]);
            expect(request.args).toContain('mineru');
            expect(request.args.at(-1)).toBe('1');
            await cp(f.run, join(f.runDir, 'parser'), { recursive: true });
            return { exitCode: 7, stdout: '' };
          }
          expect(request.args[0]).toMatch(/export-mineru-preview.py$/);
          await cp(f.preview, join(f.runDir, 'preview'), { recursive: true });
          return { exitCode: 0, stdout: '' };
        },
      },
    );
    expect(result.status).toBe('complete');
    expect(result.paths.parser).toBe('parser');
  } finally {
    delete process.env.PAGELINGO_TEST_SECRET;
  }
});
test('cancellation checkpoints stage and preserves generated parser results', async () => {
  const { cp } = await import('node:fs/promises');
  const f = await fixture();
  const controller = new AbortController();
  await expect(
    processPdf(
      {
        sourcePath: f.sourcePath,
        runDir: f.runDir,
        modelDir: join(f.root, 'models'),
      },
      {
        signal: controller.signal,
        runPython: async () => {
          await cp(f.run, join(f.runDir, 'parser'), { recursive: true });
          controller.abort();
          return { exitCode: 130, stdout: '' };
        },
      },
    ),
  ).rejects.toThrow();
  const state = JSON.parse(
    await readFile(join(f.runDir, 'config.json'), 'utf8'),
  );
  expect(state.status).toBe('cancelled');
  expect(state.stage).toBe('parser');
  expect(await readFile(join(f.runDir, 'parser/run.json'), 'utf8')).toContain(
    'fixture-run',
  );
});
test('missing legacy renderer gives explicit preparation command without attempting a download', async () => {
  const f = await fixture();
  await expect(
    processPdf(
      { ...f, p0RunDir: f.run, katexDir: join(f.root, 'absent') },
      {
        runPython: async () => {
          throw new Error('Unexpected subprocess');
        },
      },
    ),
  ).rejects.toThrow(/prepare-preview-renderer.py --output/);
});
test('input mutation during inspection fails final revalidation', async () => {
  const f = await fixture();
  await expect(
    processPdf(
      { ...f, p0RunDir: f.run, previewDir: f.preview },
      {
        inspectPdf: async () => {
          await writeFile(join(f.run, 'raw.json'), '{}');
          return f.inspection;
        },
      },
    ),
  ).rejects.toThrow(/checksum/);
});
test('unknown runtime path fields block export and never rewrite body path examples', async () => {
  const f = await fixture(
    '<article class="docvortex-document"><p>Run /usr/bin/python for this example.</p></article>',
  );
  const metadata = JSON.parse(await readFile(join(f.run, 'run.json'), 'utf8'));
  metadata.worker.config.cachePath = '/private/cache';
  await writeFile(join(f.run, 'run.json'), JSON.stringify(metadata));
  await manifest(f.run, 'pagelingo-run-files/1');
  const preview = JSON.parse(
    await readFile(join(f.preview, 'preview.json'), 'utf8'),
  );
  preview.sourceManifestSha256 = hash(
    await readFile(join(f.run, 'manifest.json')),
  );
  await writeFile(join(f.preview, 'preview.json'), JSON.stringify(preview));
  await manifest(f.preview, 'pagelingo-static-preview-files/1');
  const result = await processPdf(
    { ...f, p0RunDir: f.run, previewDir: f.preview },
    { inspectPdf: async () => f.inspection },
  );
  expect(result.exportReady).toBe(false);
  expect(result.exportBlockers).toContain(
    'unknown-run-path-field:/worker/config/cachePath',
  );
  expect(await readFile(join(f.runDir, 'source-ir.json'), 'utf8')).toContain(
    '/usr/bin/python',
  );
  const { readdir } = await import('node:fs/promises');
  expect(await readdir(join(f.runDir, 'provenance'))).not.toContain(
    'worker.log',
  );
});
test('unknown sensitive runtime configuration is excluded from export provenance', async () => {
  const f = await fixture();
  const metadata = JSON.parse(await readFile(join(f.run, 'run.json'), 'utf8'));
  metadata.worker.config.apiKey = 'owned-test-secret';
  await writeFile(join(f.run, 'run.json'), JSON.stringify(metadata));
  await manifest(f.run, 'pagelingo-run-files/1');
  const preview = JSON.parse(
    await readFile(join(f.preview, 'preview.json'), 'utf8'),
  );
  preview.sourceManifestSha256 = hash(
    await readFile(join(f.run, 'manifest.json')),
  );
  await writeFile(join(f.preview, 'preview.json'), JSON.stringify(preview));
  await manifest(f.preview, 'pagelingo-static-preview-files/1');
  const out = await processPdf(
    { ...f, p0RunDir: f.run, previewDir: f.preview },
    { inspectPdf: async () => f.inspection },
  );
  expect(out.exportReady).toBe(false);
  const { readdir } = await import('node:fs/promises');
  for (const path of await readdir(join(f.runDir, 'provenance')))
    if (path.endsWith('.json'))
      expect(
        await readFile(join(f.runDir, 'provenance', path), 'utf8'),
      ).not.toContain('owned-test-secret');
});

test('rechecks original manifest bytes, even when changed manifest is still valid JSON', async () => {
  const f = await fixture();
  await expect(
    processPdf(
      { ...f, p0RunDir: f.run, previewDir: f.preview },
      {
        inspectPdf: async () => {
          const path = join(f.run, 'manifest.json');
          await writeFile(path, (await readFile(path, 'utf8')) + '\n');
          return f.inspection;
        },
      },
    ),
  ).rejects.toThrow(/manifest.*changed/i);
});
test('maps noncanonical raw asset filenames with field pointers and preserves original raw content', async () => {
  const { mkdir } = await import('node:fs/promises');
  const f = await fixture();
  await mkdir(join(f.run, 'native/images'), { recursive: true });
  const asset = await readFile(join(f.preview, 'assets/picture.png'));
  await writeFile(join(f.run, 'native/images/示例 图.png'), asset);
  const raw = JSON.parse(await readFile(join(f.run, 'raw.json'), 'utf8'));
  raw.pages[0].blocks[0].content = [
    {
      type: 'image_body',
      image_path: 'images/示例 图.png',
      content: 'Run /usr/bin/python',
    },
  ];
  await writeFile(join(f.run, 'raw.json'), JSON.stringify(raw));
  const original = await readFile(join(f.run, 'raw.json'));
  await manifest(f.run, 'pagelingo-run-files/1');
  const preview = JSON.parse(
    await readFile(join(f.preview, 'preview.json'), 'utf8'),
  );
  preview.sourceManifestSha256 = hash(
    await readFile(join(f.run, 'manifest.json')),
  );
  await writeFile(join(f.preview, 'preview.json'), JSON.stringify(preview));
  await manifest(f.preview, 'pagelingo-static-preview-files/1');
  await processPdf(
    { ...f, p0RunDir: f.run, previewDir: f.preview },
    { inspectPdf: async () => f.inspection },
  );
  const projected = JSON.parse(
    await readFile(join(f.runDir, 'provenance/raw.json'), 'utf8'),
  );
  expect(projected.pages[0].blocks[0].content[0].image_path).toMatch(
    /^provenance\/raw-assets\/[a-f0-9]{64}\.bin$/,
  );
  expect(projected.pages[0].blocks[0].content[0].content).toBe(
    'Run /usr/bin/python',
  );
  expect(await readFile(join(f.run, 'raw.json'))).toEqual(original);
  const ledger = JSON.parse(
    await readFile(join(f.runDir, 'provenance/copy-ledger.json'), 'utf8'),
  );
  const record = ledger.records.find(
    (r: { path: string }) => r.path === 'provenance/raw.json',
  );
  expect(record.mode).toBe('sanitized-copy');
  expect(record.originalSha256).toBe(hash(original));
  expect(record.fields[0].pointer).toBe(
    '/pages/0/blocks/0/content/0/image_path',
  );
});

test('CLI uses the same process pipeline with a mock Python executable and returns a failing exit for invalid arguments', async () => {
  const { main } = await import('../src/cli.js');
  const { chmod } = await import('node:fs/promises');
  const { vi } = await import('vitest');
  const f = await fixture();
  const executable = join(f.root, 'mock-python');
  await writeFile(
    executable,
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(f.inspection))});\n`,
  );
  await chmod(executable, 0o700);
  const stdout = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(() => true);
  const stderr = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(() => true);
  try {
    expect(
      await main([
        '--source',
        f.sourcePath,
        '--run-dir',
        f.runDir,
        '--p0-run',
        f.run,
        '--preview',
        f.preview,
        '--python',
        executable,
      ]),
    ).toBe(0);
    expect(
      JSON.parse(await readFile(join(f.runDir, 'config.json'), 'utf8')).stage,
    ).toBe('ready');
    expect(await main(['--source', f.sourcePath])).toBe(1);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
});
test('process runner terminates its own child on abort without persisting arbitrary worker output', async () => {
  const { runPython, pythonEnvironment } = await import(
    '../src/python-runner.js'
  );
  const controller = new AbortController();
  const running = runPython({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(),
    env: pythonEnvironment(process.execPath, process.cwd()),
    signal: controller.signal,
  });
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    await expect(running).rejects.toThrow(/cancelled/);
  } finally {
    clearTimeout(timer);
  }
});
