import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { processPdf } from '../src/index.js';
import { fixture } from './fixtures/legacy-preview/create.js';

test('projects original semantic tree, separate captions, protected math, roles and unique stable positions', async () => {
  const f = await fixture();
  const result = await processPdf(
    { ...f, p0RunDir: f.run, previewDir: f.preview },
    { inspectPdf: async () => f.inspection },
  );
  const ir = JSON.parse(
    await readFile(join(f.runDir, result.paths.ir), 'utf8'),
  );
  expect(ir.blocks.filter((b: any) => b.type === 'image')).toHaveLength(1);
  expect(
    ir.blocks.some((b: any) => b.type === 'text' && b.value.kind === 'caption'),
  ).toBe(true);
  expect(ir.nodes.some((n: any) => n.kind === 'callout')).toBe(true);
  expect(ir.nodes.some((n: any) => n.kind === 'list' && n.start === 3)).toBe(
    true,
  );
  const json = JSON.stringify(ir);
  expect(json).not.toContain('duplicate');
  expect(json).not.toContain('Discard header');
  expect(json).toContain('Retain footnote');
  expect(
    ir.blocks
      .flatMap((b: any) => b.bindings ?? [])
      .filter((b: any) => b.kind === 'protected' && b.object.type === 'math'),
  ).toHaveLength(1);
  expect(json).toContain('emphasis');
  expect(json).toContain('SYSTEM');
  const repeats = ir.blocks.filter(
    (b: any) =>
      b.type === 'text' && JSON.stringify(b.value.content).includes('Repeat'),
  );
  expect(repeats).toHaveLength(2);
  expect(repeats[0].id).not.toBe(repeats[1].id);
  const again = await processPdf(
    {
      ...f,
      runDir: join(f.root, 'again'),
      p0RunDir: f.run,
      previewDir: f.preview,
    },
    { inspectPdf: async () => f.inspection },
  );
  expect(
    JSON.parse(await readFile(join(f.root, 'again', again.paths.ir), 'utf8')),
  ).toEqual(ir);
  expect(result.translationStatus).toBe('pending');
});

test('verified manual semantic repairs change parse identity while retaining original source identity', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { manifest } = await import('./fixtures/legacy-preview/create.js');
  const f = await fixture();
  const options = { ...f, p0RunDir: f.run, previewDir: f.preview };
  const deps = { inspectPdf: async () => f.inspection };
  const a = await processPdf(options, deps);
  const html = join(f.preview, 'pages/page-0001.html');
  await writeFile(
    html,
    (await readFile(html, 'utf8')).replace(
      'Introduction',
      'Repaired Introduction',
    ),
  );
  await manifest(f.preview, 'pagelingo-static-preview-files/1');
  const b = await processPdf(
    { ...options, runDir: join(f.root, 'repair') },
    deps,
  );
  expect(a.sourceSha256).toBe(b.sourceSha256);
  expect(a.parseId).not.toBe(b.parseId);
});

test('keeps local heading links as portable block links and visibly retains unsupported tables', async () => {
  const f = await fixture(
    '<article class="docvortex-document"><h2 id="topic">Topic</h2><p><a href="#topic">Jump to topic</a></p><table><tr><td>Unsupported cell</td></tr></table></article>',
  );
  const out = await processPdf(
    { ...f, p0RunDir: f.run, previewDir: f.preview },
    { inspectPdf: async () => f.inspection },
  );
  const ir = JSON.parse(await readFile(join(f.runDir, out.paths.ir), 'utf8'));
  expect(ir.blocks[1].bindings).toEqual([
    { kind: 'block-link', id: 'i1', blockId: ir.blocks[0].id },
  ]);
  expect(ir.blocks[2].value.content[0].type).toBe('protected');
  expect(
    ir.warnings.some((w: string) =>
      w.startsWith('unsupported-visible-element:table'),
    ),
  ).toBe(true);
});

test('unsupported visible vector content remains an explicit source-only block', async () => {
  const f = await fixture(
    '<article class="docvortex-document"><svg><rect width="20" height="20"/></svg></article>',
  );
  const out = await processPdf(
    { ...f, p0RunDir: f.run, previewDir: f.preview },
    { inspectPdf: async () => f.inspection },
  );
  const ir = JSON.parse(await readFile(join(f.runDir, out.paths.ir), 'utf8'));
  expect(ir.blocks).toHaveLength(1);
  expect(ir.blocks[0].value.content[0]).toMatchObject({
    type: 'protected',
    source: '[svg in source PDF]',
  });
  expect(
    ir.warnings.some((w: string) =>
      w.includes('unsupported-visible-element:svg'),
    ),
  ).toBe(true);
});

test('keeps actual lower-alpha labels as readable source-only content while decimal lists retain start=3', async () => {
  // Matches the released LLM pages/page-0218.html marker declaration.
  const f = await fixture(`<article class="docvortex-document">
    <ol class="pl-source-list" start="1" style="list-style-type:lower-alpha">
      <li>First source step <em>with emphasis</em></li>
      <li>Second source step <span data-docvortex-latex="x^2"><math>duplicate</math><span>duplicate</span></span></li>
      <li>Third source step</li>
    </ol>
    <ol start="3"><li>Decimal third</li><li>Decimal fourth</li></ol>
  </article>`);
  const result = await processPdf(
    { ...f, p0RunDir: f.run, previewDir: f.preview },
    { inspectPdf: async () => f.inspection },
  );
  const ir = JSON.parse(
    await readFile(join(f.runDir, result.paths.ir), 'utf8'),
  );
  expect(
    ir.nodes.filter((node: { kind: string }) => node.kind === 'list'),
  ).toHaveLength(1);
  expect(
    ir.nodes.find((node: { kind: string }) => node.kind === 'list'),
  ).toMatchObject({ ordered: true, start: 3 });
  expect(
    ir.blocks
      .slice(0, 3)
      .map((block: { value: { content: unknown[] } }) => block.value.content),
  ).toEqual([
    [
      {
        type: 'protected',
        id: 'list-source',
        kind: 'literal',
        source: 'a. First source step with emphasis',
      },
    ],
    [
      {
        type: 'protected',
        id: 'list-source',
        kind: 'literal',
        source: 'b. Second source step x^2',
      },
    ],
    [
      {
        type: 'protected',
        id: 'list-source',
        kind: 'literal',
        source: 'c. Third source step',
      },
    ],
  ]);
  expect(
    ir.blocks
      .slice(0, 3)
      .every(
        (block: { language: { reason: string } }) =>
          block.language.reason === 'no-language',
      ),
  ).toBe(true);
  expect(
    ir.warnings.some((warning: string) =>
      warning.startsWith('unsupported-list-markers:lower-alpha:source-only:'),
    ),
  ).toBe(true);
  expect(JSON.stringify(ir)).not.toContain('duplicate');
});
