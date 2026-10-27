import { expect, test } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { processPdf } from '../src/index.js';
import { fixture, manifest } from './fixtures/legacy-preview/create.js';
import type { ReaderIR } from '@pagelingo/document-contracts';
async function project(
  change?: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
  const f = await fixture();
  await change?.(f);
  const out = await processPdf(
    { ...f, p0RunDir: f.run, previewDir: f.preview },
    { inspectPdf: async () => f.inspection },
  );
  return {
    f,
    ir: JSON.parse(
      await readFile(join(f.runDir, out.paths.ir), 'utf8'),
    ) as ReaderIR,
  };
}
test('uses already normalized displayed-crop evidence once and records actual raw pointers', async () => {
  const { f, ir } = await project();
  expect(ir.blocks[0].sourceRefs).toEqual([
    { pageIndex: 0, precision: 'bbox', bbox: [0.1, 0.2, 0.8, 0.3] },
  ]);
  const ledger = JSON.parse(
    await readFile(join(f.runDir, 'provenance/source-bindings.json'), 'utf8'),
  );
  expect(ledger.bindings[0].rawRef).toBe('#/pages/0/blocks/0');
  expect(ledger.bindings[0].evidencePointer).toBe('#/pages/0/blocks/0');
});
test.each(['uncalibrated', 'ambiguous', 'conflicting-id'])(
  'falls back to page for %s evidence',
  async (mode) => {
    const { ir } = await project(async (f) => {
      const p = join(f.preview, 'source-layout.json');
      const layout = JSON.parse(await readFile(p, 'utf8'));
      if (mode === 'uncalibrated') layout.pages[0].width = 400;
      if (mode === 'ambiguous')
        layout.pages[0].blocks[0].ambiguousCharacterRanges = [[0, 2]];
      if (mode === 'conflicting-id') {
        const h = join(f.preview, 'pages/page-0001.html');
        await writeFile(
          h,
          (await readFile(h, 'utf8')).replace(
            'data-source-id="fixture-run/p0/b0"',
            'data-source-id="fixture-run/p0/b1"',
          ),
        );
      }
      await writeFile(p, JSON.stringify(layout));
      await manifest(f.preview, 'pagelingo-static-preview-files/1');
    });
    expect(ir.blocks[0].sourceRefs).toEqual([
      { pageIndex: 0, precision: 'page' },
    ]);
    expect(ir.warnings.some((w) => w.startsWith('source-'))).toBe(true);
  },
);

test('conflicting duplicate evidence identities never pick an arbitrary bounding box', async () => {
  const { ir } = await project(async (f) => {
    const p = join(f.preview, 'source-layout.json');
    const layout = JSON.parse(await readFile(p, 'utf8'));
    layout.pages[0].blocks.push({
      ...layout.pages[0].blocks[0],
      bbox: [0.2, 0.2, 0.9, 0.9],
    });
    await writeFile(p, JSON.stringify(layout));
    await manifest(f.preview, 'pagelingo-static-preview-files/1');
  });
  expect(ir.blocks[0].sourceRefs).toEqual([
    { pageIndex: 0, precision: 'page' },
  ]);
});

test.each([
  ['missing width', 'width', undefined],
  ['nonnumeric height', 'height', 'unknown'],
  ['numeric-string width', 'width', '360'],
  ['nonfinite width', 'width', Infinity],
  ['NaN height', 'height', NaN],
  ['missing crop box', 'cropBox', undefined],
  ['null crop box', 'cropBox', null],
  ['non-array crop box', 'cropBox', { length: 4 }],
  ['short crop box', 'cropBox', [20, 40, 380]],
  ['nonnumeric crop coordinate', 'cropBox', [20, 'unknown', 380, 460]],
  ['numeric-string crop coordinate', 'cropBox', [20, '40', 380, 460]],
  ['nonfinite crop coordinate', 'cropBox', [20, 40, Infinity, 460]],
])('does not claim bbox precision for %s', async (_label, field, value) => {
  const { verifyP0Run, verifyPreview } = await import('../src/index.js');
  const { mapSource } = await import('../src/source-map.js');
  const f = await fixture();
  const run = await verifyP0Run(f.run, f.inspection.sourceSha256);
  const preview = await verifyPreview(f.preview, run);
  Object.assign(preview.layout.pages[0], { [field]: value });
  const result = mapSource(run, preview, f.inspection.pages[0], {
    pageIndex: 0,
    parsedPageIndex: 0,
    blockIndex: 0,
    sourceId: 'fixture-run/p0/b0',
  });
  expect(result.ref).toEqual({ pageIndex: 0, precision: 'page' });
  expect(result.lineage.warning).toBe('source-coordinate-uncalibrated');
  expect(result.lineage.rawRef).toBe('#/pages/0/blocks/0');
});

test.each([undefined, null, '0', 1, NaN, Infinity])(
  'falls back for contradictory or invalid evidence blockIndex %s',
  async (blockIndex) => {
    const { verifyP0Run, verifyPreview } = await import('../src/index.js');
    const { mapSource } = await import('../src/source-map.js');
    const f = await fixture();
    const run = await verifyP0Run(f.run, f.inspection.sourceSha256);
    const preview = await verifyPreview(f.preview, run);
    Object.assign(preview.layout.pages[0].blocks[0], { blockIndex });
    const result = mapSource(run, preview, f.inspection.pages[0], {
      pageIndex: 0,
      parsedPageIndex: 0,
      blockIndex: 0,
      sourceId: 'fixture-run/p0/b0',
    });
    expect(result.ref).toEqual({ pageIndex: 0, precision: 'page' });
    expect(result.lineage.warning).toBe('source-identity-conflict');
  },
);
