import { it, expect } from 'vitest';
import { webReaderChunkSchema } from '@pagelingo/document-contracts';
import { buildWebReader, renderWebChunk } from '../src/index.js';
import { webBook, webSnapshot, id } from './web-fixtures.js';
const options = { mode: 'bilingual' as const, resolveAsset: (id: string) => `/assets/${id}` };
it('renders bilingual cells without duplicate IDs and retains explicit heading levels', () => {
  const ir = webBook(3);
  const h = ir.blocks[0]; if (h.type !== 'text') throw Error('fixture'); h.value.kind = 'heading';
  ir.roots = [id('n', 10)];
  ir.nodes = [
    { id: id('n', 10), kind: 'section', headingBlockId: h.id, children: [id('n', 1), id('n', 11)] }, ir.nodes[0],
    { id: id('n', 11), kind: 'table', captionBlockId: null, children: [id('n', 12)] },
    { id: id('n', 12), kind: 'table-row', children: [id('n', 13), id('n', 14)] },
    { id: id('n', 13), kind: 'table-cell', header: true, scope: 'col', rowSpan: 1, colSpan: 1, headerNodeIds: [], children: [id('n', 2)] }, ir.nodes[1],
    { id: id('n', 14), kind: 'table-cell', header: false, scope: null, rowSpan: 1, colSpan: 2, headerNodeIds: [id('n', 13)], children: [id('n', 3)] }, ir.nodes[2],
  ];
  const build = buildWebReader(ir, webSnapshot(ir, true));
  const html = renderWebChunk(build.chunks[0], options);
  expect(html).toContain('<h1>'); expect(html).toContain('<table'); expect(html).toContain('<th'); expect(html).toContain('colspan="2"'); expect(html).toContain('headers="');
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(m => m[1]); expect(new Set(ids).size).toBe(ids.length);
  for (const block of ir.blocks) expect(html.match(new RegExp(` id="${block.id}"`, 'g'))).toHaveLength(1);
  expect(build.index.blockLocations[ir.blocks[1].id]).toEqual({ chunkId: 'c_000001', nodeId: 'snapshot-2', previewId: null });
});
it('chunks a nonempty 20k-block source with complete unique coverage', () => {
  const ir = webBook(20000);
  // No translation units are necessary for non-text blocks.
  ir.blocks = ir.blocks.map(b => ({ id: b.id, type: 'code', code: 'line', sourceRefs: b.sourceRefs }));
  const build = buildWebReader(ir, webSnapshot(ir));
  expect(Math.max(...build.chunks.map(c => c.blocks.length))).toBeLessThanOrEqual(128);
  const ids = build.chunks.flatMap(c => c.blocks.map(b => b.source.id));
  expect(ids).toEqual(ir.blocks.map(b => b.id)); expect(new Set(ids).size).toBe(20000);
  expect(build.chunks.every(c => webReaderChunkSchema.safeParse(c).success)).toBe(true);
}, 20000);
it('keeps an oversized single block alone within 512KiB and rejects larger source', () => {
  const ir = webBook(2); const b = ir.blocks[0];
  ir.blocks[0] = { id: b.id, sourceRefs: b.sourceRefs, type: 'code', code: 'x'.repeat(510 * 1024) };
  const t = webSnapshot(ir); const build = buildWebReader(ir, t);
  expect(build.chunks[0].blocks).toHaveLength(1); expect(webReaderChunkSchema.safeParse(build.chunks[0]).success).toBe(true);
  if (ir.blocks[0].type === 'code') ir.blocks[0].code += 'x'.repeat(3 * 1024);
  expect(() => buildWebReader(ir, t)).toThrow();
});
it('rejects disconnected or forged chunk content rather than branding it trusted', () => {
  const ir = webBook(), build = buildWebReader(ir, webSnapshot(ir));
  const chunk = structuredClone(build.chunks[0]); chunk.roots.pop();
  expect(() => renderWebChunk(chunk, options)).toThrow();
  const forged = structuredClone(build.chunks[0]); forged.blocks[0].translation = { id: forged.blocks[0].source.id, kind: 'paragraph', content: [{ type: 'format', id: 'evil', kind: 'link', children: [{ type: 'text', text: 'click' }] }] };
  expect(() => renderWebChunk(forged, options)).toThrow();
});
it('rewrites repeated SVG references per inline and bilingual instance and escapes MathML text', () => {
  const ir = webBook(2);
  const ast = { kind: 'svg' as const, roots: ['svg'], nodes: [
    { id: 'svg', tag: 'svg' as const, attributes: {}, children: ['defs', 'use'] },
    { id: 'defs', tag: 'defs' as const, attributes: {}, children: ['path'] },
    { id: 'path', tag: 'path' as const, attributes: { id: 'shape', d: 'M0 0L1 1' }, children: [] },
    { id: 'use', tag: 'use' as const, attributes: { href: '#shape' }, children: [] },
  ] };
  for (const block of ir.blocks) if (block.type === 'text') {
    block.value.content = ['constructor', '__proto__', 'toString'].map(bindingId => ({ type: 'protected', id: bindingId, kind: 'literal', source: 'formula' }));
    block.bindings = ['constructor', '__proto__', 'toString'].map(bindingId => ({ id: bindingId, kind: 'protected', object: { type: 'literal', text: 'formula' } }));
    block.safeMath = ['constructor', '__proto__', 'toString'].map(bindingId => ({ bindingId, ast }));
  }
  const build = buildWebReader(ir, webSnapshot(ir, true));
  const html = renderWebChunk(build.chunks[0], options);
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(m => m[1]);
  expect(new Set(ids).size).toBe(ids.length); expect(ids).toHaveLength(14);
  const hrefs = [...html.matchAll(/ href="#([^"]+)"/g)].map(m => m[1]);
  expect(hrefs).toHaveLength(12); expect(hrefs.every(h => ids.includes(h))).toBe(true);
  const first = ir.blocks[0]; if (first.type !== 'text') throw Error('fixture');
  first.safeMath[0].ast = { kind: 'mathml', roots: ['m'], nodes: [{ id: 'm', tag: 'math', attributes: {}, children: ['t'] }, { id: 't', tag: 'mtext', attributes: {}, children: [], text: '<script>alert(1)</script>' }] };
  expect(renderWebChunk(buildWebReader(ir, webSnapshot(ir, true)).chunks[0], options)).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
});
it('retains semantic formatting and safe links while using the Reader theme', () => {
  const ir = webBook(1), b = ir.blocks[0]; if (b.type !== 'text') throw Error('fixture');
  b.value.content = [{ type: 'format', id: 'link', kind: 'link', children: [{ type: 'format', id: 'strong', kind: 'strong', children: [{ type: 'text', text: '<hello>' }] }] }];
  b.bindings = [{ id: 'link', kind: 'link', href: 'https://example.test/?a=1&b=2' }, { id: 'strong', kind: 'style', emphasis: 'strong', color: '#000000', backgroundColor: '#ffffff' }];
  const html = renderWebChunk(buildWebReader(ir, webSnapshot(ir, true)).chunks[0], options);
  expect(html).toContain('<strong>&lt;hello&gt;</strong>'); expect(html).toContain('https://example.test/?a=1&amp;b=2'); expect(html).not.toContain('background-color');
});
it('keeps source-only notices honest in translation and bilingual views', () => {
  const ir = webBook(1), chunk = buildWebReader(ir, webSnapshot(ir)).chunks[0];
  expect(renderWebChunk(chunk, { ...options, mode: 'source' })).not.toContain('待翻译');
  expect(renderWebChunk(chunk, { ...options, mode: 'translation' })).toContain('待翻译，保留原文');
  expect(renderWebChunk(chunk, options)).toContain('待翻译，保留原文');
});
it('uses archived h3 metadata rather than guessing h2 from a flat section', () => {
  const ir = webBook(1), b = ir.blocks[0]; if (b.type !== 'text') throw Error('fixture');
  b.value.kind = 'heading'; b.headingLevel = 3;
  const build = buildWebReader(ir, webSnapshot(ir, true));
  expect(renderWebChunk(build.chunks[0], options)).toContain('<h3>');
  expect(build.index.toc).toEqual([{ nodeId: ir.nodes[0].id, parentId: null, blockId: b.id, title: 'Repeated paragraph', depth: 3 }]);
});
it('repeats flagged table header context within budgets without duplicate primary ownership or DOM IDs', () => {
  const ir = webBook(140), originalLeaves = [...ir.nodes];
  const table = id('n', 1000), headerCell = id('n', 1001);
  ir.roots = [table]; ir.nodes = [{ id: table, kind: 'table', captionBlockId: null, children: [id('n', 1005)] }, { id: id('n', 1005), kind: 'group', children: [] }];
  for (let i = 0; i < ir.blocks.length; i++) {
    const rowId = id('n', 2000 + i), cellId = i === 0 ? headerCell : id('n', 3000 + i);
    ir.nodes[1].children.push(rowId);
    ir.nodes.push({ id: rowId, kind: 'table-row', children: [cellId] }, { id: cellId, kind: 'table-cell', header: i === 0, scope: null, rowSpan: 1, colSpan: 1, headerNodeIds: [], children: [originalLeaves[i].id] }, originalLeaves[i]);
  }
  const build = buildWebReader(ir, webSnapshot(ir, true));
  expect(build.chunks.length).toBe(2); expect(build.chunks[1].contextBlockIds).toEqual([ir.blocks[0].id]);
  const primary = build.chunks.flatMap(c => c.blocks.filter(b => !c.contextBlockIds.includes(b.source.id)).map(b => b.source.id));
  expect(primary).toEqual(ir.blocks.map(b => b.id)); expect(new Set(primary).size).toBe(140);
  expect(build.chunks.every(c => c.blocks.length <= 128)).toBe(true);
  const html = build.chunks.map(c => renderWebChunk(c, options)).join('');
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(m => m[1]); expect(new Set(ids).size).toBe(ids.length);
  expect(html).toContain('reader-context');
  expect(build.index.chunks[1].blockIds).not.toContain(ir.blocks[0].id);
});
it('rejects impossible table header context before publishing a chunk', () => {
  const ir = webBook(130), leaves = [...ir.nodes];
  const table = id('n', 1000), header = id('n', 1001), row = id('n', 1002), cell = id('n', 1003), row2 = id('n', 1004);
  ir.roots = [table]; ir.nodes = [
    { id: table, kind: 'table', captionBlockId: null, children: [row, row2] },
    { id: row, kind: 'table-row', children: [header] },
    { id: header, kind: 'table-cell', header: true, scope: 'col', rowSpan: 1, colSpan: 1, headerNodeIds: [], children: leaves.slice(0, 129).map(n => n.id) }, ...leaves.slice(0, 129),
    { id: row2, kind: 'table-row', children: [cell] },
    { id: cell, kind: 'table-cell', header: false, scope: null, rowSpan: 1, colSpan: 1, headerNodeIds: [header], children: [leaves[129].id] }, leaves[129],
  ];
  expect(() => buildWebReader(ir, webSnapshot(ir, true))).toThrow(/context.*budget/);
});
it('keeps math ID namespaces unambiguous when inline and definition IDs contain separators', () => {
  const ir = webBook(1), b = ir.blocks[0]; if (b.type !== 'text') throw Error('fixture');
  b.value.content = ['a-b', 'a'].map(bindingId => ({ type: 'protected', id: bindingId, kind: 'literal', source: 'formula' }));
  b.bindings = ['a-b', 'a'].map(bindingId => ({ id: bindingId, kind: 'protected', object: { type: 'literal', text: 'formula' } }));
  b.safeMath = ['a-b', 'a'].map((bindingId, i) => ({ bindingId, ast: { kind: 'svg', roots: ['svg'], nodes: [{ id: 'svg', tag: 'svg', attributes: { id: i ? 'b-c' : 'c' }, children: [] }] } }));
  const html = renderWebChunk(buildWebReader(ir, webSnapshot(ir, true)).chunks[0], options);
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(m => m[1]); expect(new Set(ids).size).toBe(ids.length);
});
it('renders table captions and captured row groups as valid table children', () => {
  const ir = webBook(2), leaves = [...ir.nodes], caption = ir.blocks[0]; if (caption.type !== 'text') throw Error('fixture'); caption.value.kind = 'caption';
  ir.roots = [id('n', 10)]; ir.nodes = [
    { id: id('n', 10), kind: 'table', captionBlockId: caption.id, children: [leaves[0].id, id('n', 11)] }, leaves[0],
    { id: id('n', 11), kind: 'group', children: [id('n', 12)] },
    { id: id('n', 12), kind: 'table-row', children: [id('n', 13)] },
    { id: id('n', 13), kind: 'table-cell', header: false, scope: null, rowSpan: 1, colSpan: 1, headerNodeIds: [], children: [leaves[1].id] }, leaves[1],
  ];
  const html = renderWebChunk(buildWebReader(ir, webSnapshot(ir, true)).chunks[0], options);
  expect(html).toContain('<table><caption>'); expect(html).toContain('</caption><tbody><tr>');
  expect(html).toContain('overflow-x:auto');
});
it.each([
  { language: 'zh' as const, sourceLanguage: 'zh', reason: 'han-only' as const, status: 'not-required', reasonLabel: 'language-not-required', original: '中文原文' },
  { language: 'foreign' as const, sourceLanguage: 'fr', reason: 'user-specified' as const, status: 'pending', reasonLabel: 'pending', original: 'Texte français original' },
  { language: 'mixed' as const, sourceLanguage: null, reason: 'mixed-script' as const, status: 'pending', reasonLabel: 'pending', original: '中文 and original English' },
])('publishes $language originals before any translation artifact exists', decision => {
  const ir = webBook(1), block = ir.blocks[0]; if (block.type !== 'text') throw Error('fixture');
  ir.metadata.language = { language: decision.language, sourceLanguage: decision.sourceLanguage, reason: decision.reason } as typeof ir.metadata.language;
  block.language = ir.metadata.language; block.value.content = [{ type: 'text', text: decision.original }];
  for (const build of [buildWebReader(ir), buildWebReader(ir, null)]) {
    expect(build.index.translationStatus).toBe(decision.status); expect(build.index.generationKind).toBe('none');
    expect(build.chunks[0].blocks[0].translation).toBeNull(); expect(build.chunks[0].blocks[0].sourceOnlyReason).toBe(decision.reasonLabel);
    expect(renderWebChunk(build.chunks[0], { ...options, mode: 'source' })).toContain(decision.original);
    expect(JSON.stringify(build)).not.toMatch(/"(?:jobId|provider|profile|budget|glossary|readerIrSha256)":/);
  }
});
it('renders untranslated original table and math without fabricating a translation run', () => {
  const ir = webBook(3), leaves = [...ir.nodes], first = ir.blocks[0], second = ir.blocks[1];
  if (first.type !== 'text' || second.type !== 'text') throw Error('fixture');
  first.value.content = [{ type: 'format', id: 'strong', kind: 'strong', children: [{ type: 'text', text: 'Original header' }] }];
  first.bindings = [{ id: 'strong', kind: 'style', emphasis: 'strong' }]; second.value.content = [{ type: 'text', text: 'Original cell' }];
  ir.blocks[2] = { id: ir.blocks[2].id, sourceRefs: ir.blocks[2].sourceRefs, type: 'math', latex: null, ast: { kind: 'mathml', roots: ['m'], nodes: [{ id: 'm', tag: 'math', attributes: {}, children: ['x'] }, { id: 'x', tag: 'mi', attributes: {}, children: [], text: 'x' }] }, displayMode: true };
  ir.roots = [id('n', 10), leaves[2].id]; ir.nodes = [
    { id: id('n', 10), kind: 'table', captionBlockId: null, children: [id('n', 11)] },
    { id: id('n', 11), kind: 'table-row', children: [id('n', 12), id('n', 13)] },
    { id: id('n', 12), kind: 'table-cell', header: true, scope: 'col', rowSpan: 1, colSpan: 1, headerNodeIds: [], children: [leaves[0].id] }, leaves[0],
    { id: id('n', 13), kind: 'table-cell', header: false, scope: null, rowSpan: 1, colSpan: 1, headerNodeIds: [id('n', 12)], children: [leaves[1].id] }, leaves[1], leaves[2],
  ];
  const build = buildWebReader(ir, null), html = renderWebChunk(build.chunks[0], { ...options, mode: 'source' });
  expect(html).toContain('<strong>Original header</strong>'); expect(html).toContain('Original cell'); expect(html).toContain('<th'); expect(html).toContain('<math><mi>x</mi></math>');
  expect(build.chunks[0].blocks.every(b => b.translation === null)).toBe(true); expect(build.index.translationStatus).toBe('pending');
});
it('marks documents without translatable natural text not-required without a translation artifact', () => {
  const ir = webBook(2), first = ir.blocks[0]; if (first.type !== 'text') throw Error('fixture');
  first.language = { language: 'und', sourceLanguage: null, reason: 'no-language' };
  first.value.content = [{ type: 'protected', id: 'formula', kind: 'math', source: 'x^2' }];
  first.bindings = [{ id: 'formula', kind: 'protected', object: { type: 'math', latex: 'x^2' } }];
  ir.blocks[1] = { id: ir.blocks[1].id, type: 'code', code: 'const original = 1;', sourceRefs: ir.blocks[1].sourceRefs };
  const build = buildWebReader(ir);
  expect(build.index.translationStatus).toBe('not-required'); expect(build.index.generationKind).toBe('none');
  expect(build.chunks[0].blocks.map(b => b.sourceOnlyReason)).toEqual(['language-not-required', null]);
  const html = renderWebChunk(build.chunks[0], { ...options, mode: 'source' });
  expect(html).toContain('katex'); expect(html).toContain('const original = 1;');
});
