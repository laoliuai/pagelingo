import type { PdfPageMetadata } from '@pagelingo/document-contracts';
import type { PdfInspection } from '../../../src/local-run.js';
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export const hash = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');
export const page: PdfPageMetadata = {
  pageIndex: 0,
  mediaBox: [0, 0, 400, 500],
  cropBox: [20, 40, 380, 460],
  displayCropBox: [20, 40, 380, 460],
  rotation: 0,
  displayWidth: 360,
  displayHeight: 420,
  pdfToDisplay: [1, 0, 0, -1, -20, 460],
};
export const english =
  'The model is used for learning and the results are compared with those from our experiments.';
export async function manifest(
  dir: string,
  schemaVersion: string,
): Promise<void> {
  const files = [];
  for (const path of await readdir(dir, { recursive: true })) {
    if (path === 'manifest.json') continue;
    try {
      const data = await readFile(join(dir, path));
      files.push({ path, bytes: data.length, sha256: hash(data) });
    } catch {
      /* directories */
    }
  }
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({ schemaVersion, files }),
  );
}
export async function fixture(html?: string) {
  const root = await mkdtemp(join(tmpdir(), 'pagelingo-cli-'));
  const run = join(root, 'p0');
  const preview = join(root, 'preview');
  await mkdir(run);
  await mkdir(join(preview, 'pages'), { recursive: true });
  await mkdir(join(preview, 'assets'));
  const source = Buffer.from('%PDF-1.7\nowned mock PDF');
  const meta = {
    schemaVersion: 'pagelingo-benchmark-run/1',
    runId: 'fixture-run',
    parser: 'mineru',
    input: 'fixture.pdf',
    sourceSha256: hash(source),
    sourcePageCount: 1,
    requestedPageIndices: [0],
    coverage: 'full',
    status: 'complete',
    modelLockSha256: null,
    pythonLockSha256: null,
    worker: {
      config: { tier: 'basic', pageRange: 'all' },
      versions: { mineru: '4.0.10' },
    },
    debug: 'debug.html',
  };
  const raw = {
    pages: [
      {
        page_idx: 0,
        blocks: [0, 1, 2].map((index) => ({
          index,
          type: 'text',
          bbox: [0.1, 0.2, 0.8, 0.3],
          content: [],
        })),
      },
    ],
  };
  await writeFile(join(run, 'source.pdf'), source);
  await writeFile(join(run, 'run.json'), JSON.stringify(meta));
  await writeFile(join(run, 'raw.json'), JSON.stringify(raw));
  await writeFile(
    join(run, 'normalized.json'),
    JSON.stringify({
      sourceSha256: hash(source),
      parsedPageIndices: [0],
      blocks: [],
    }),
  );
  await writeFile(join(run, 'worker.log'), 'not for export');
  await manifest(run, 'pagelingo-run-files/1');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',
    'base64',
  );
  // Test-owned image with valid CRCs, no image encoder dependency.
  const { crc32 } = await import('node:zlib');
  for (let p = 8; p < png.length; ) {
    const n = png.readUInt32BE(p);
    png.writeUInt32BE(crc32(png.subarray(p + 4, p + 8 + n)), p + 8 + n);
    p += 12 + n;
  }
  await writeFile(join(preview, 'assets', 'picture.png'), png);
  await writeFile(join(preview, 'source.pdf'), source);
  const body =
    html ??
    `<article class="docvortex-document"><section class="docvortex-page" data-page-idx="0">
    <div data-block-index="0" data-source-id="fixture-run/p0/b0"><h1>Introduction</h1><p>${english} <em>original emphasis</em> <span data-docvortex-latex="x^2"><math>duplicate</math><span>duplicate</span></span></p></div>
    <div class="pl-callout"><div class="pl-prompt"><div data-block-index="1"><p><span class="pl-prompt-role" translate="no">SYSTEM</span> Keep roles.</p><ol start="3"><li>First<ul><li>Nested</li></ul></li><li>Second</li></ol></div></div></div>
    <div data-block-index="2"><figure><div class="docvortex-visual-body"><a class="pl-original-link" href="../assets/picture.png"><img src="../assets/picture.png" alt="Diagram"></a></div><figcaption>Separate caption</figcaption></figure><p>Repeat</p><p>Repeat</p></div>
    <div data-block-type="page_header">Discard header</div><p class="docvortex-page-footnote">Retain footnote</p>
  </section></article>`;
  await writeFile(join(preview, 'pages/page-0001.html'), body);
  await writeFile(
    join(preview, 'source-layout.json'),
    JSON.stringify({
      schemaVersion: 'pagelingo-pdf-source-layout/1',
      sourceRunId: meta.runId,
      sourceSha256: meta.sourceSha256,
      coordinateSpace: 'normalized-displayed-crop-box-top-left',
      pages: [
        {
          sourcePageIndex: 0,
          parsedPageIndex: 0,
          width: 360,
          height: 420,
          cropBox: page.cropBox,
          rotation: 0,
          blocks: [0, 1, 2].map((blockIndex) => ({
            id: `fixture-run/p0/b${blockIndex}`,
            blockIndex,
            bbox: [0.1, 0.2, 0.8, 0.3],
            ambiguousCharacterRanges: [],
          })),
        },
      ],
    }),
  );
  await writeFile(
    join(preview, 'preview.json'),
    JSON.stringify({
      schemaVersion: 'pagelingo-static-preview/0.6',
      sourceRunId: meta.runId,
      sourceSha256: meta.sourceSha256,
      sourceManifestSha256: hash(await readFile(join(run, 'manifest.json'))),
      sourceStatus: meta.status,
      coverage: meta.coverage,
      sourcePageCount: 1,
      requestedPageIndices: [0],
      translated: false,
      pages: [
        {
          parsedPageIndex: 0,
          sourcePageIndex: 0,
          path: 'pages/page-0001.html',
        },
      ],
      originalVisuals: [],
      sourceEvidence: { path: 'source-layout.json' },
    }),
  );
  await manifest(preview, 'pagelingo-static-preview-files/1');
  return {
    root,
    run,
    preview,
    sourcePath: join(run, 'source.pdf'),
    runDir: join(root, 'output'),
    inspection: {
      schemaVersion: 'pagelingo-pdf-inspection/1',
      sourceSha256: hash(source),
      pages: [page],
      warnings: [],
    } satisfies PdfInspection,
  };
}
