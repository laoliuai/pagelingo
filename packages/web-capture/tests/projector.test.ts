import { expect, it } from 'vitest';
import { encodeBlock, decodeTranslation } from '@pagelingo/translation-core';
import { naturalText } from '@pagelingo/document-contracts';
import { projectWebReader, validateWebGraph, sha256 } from '../src/index.js';
import { sanitizeNodeSnapshot } from '../src/node.js';
import { manifestFor, projectionOptions, snapshotInput } from './helpers.js';
it('projects ordered table structure, links, semantic emphasis and protected math through the SDK', async () => {
  const snapshot = sanitizeNodeSnapshot(snapshotInput('<article><h1>Title</h1><p>repeat <a href="/target"><strong>bold</strong></a><code>x()</code><math><mi>x</mi></math></p><p>repeat</p><table><caption>Caption</caption><tr><th scope="col">Head</th><td colspan="2">Cell</td></tr></table></article>'));
  const manifest = await manifestFor(snapshot);
  const ir = await projectWebReader(snapshot, manifest, projectionOptions(manifest));
  expect(() => validateWebGraph(ir)).not.toThrow();
  expect(ir.nodes.filter(node => node.kind === 'table-cell')).toHaveLength(2);
  expect(ir.blocks.filter(block => block.type === 'text').map(block => naturalText(block.value.content))).toEqual(['Title', 'repeat bold', 'repeat', 'Caption', 'Head', 'Cell']);
  const paragraph = ir.blocks[1]; expect(paragraph.type).toBe('text');
  if (paragraph.type !== 'text') throw new Error('paragraph missing');
  expect(paragraph.bindings).toContainEqual(expect.objectContaining({ kind: 'link', href: 'https://e.test/target' }));
  expect(paragraph.safeMath).toHaveLength(1);
  const encoded = encodeBlock(paragraph.value);
  expect(decodeTranslation(encoded, encoded.protectedText)).toEqual(paragraph.value.content);
  expect(ir.source.manifestSha256).toBe(await sha256(projectionOptions(manifest).manifestBytes));
  expect(ir.parse.id).toMatch(/^p_[a-f0-9]{64}$/);
  expect(new Set(ir.blocks.map(block => block.id)).size).toBe(ir.blocks.length);
});
it('hashes exact manifest bytes, rejects mismatches and marks missing resources partial', async () => {
  const snapshot = sanitizeNodeSnapshot(snapshotInput('<article><p>Text<img src="/x.png" alt="missing figure"></p></article>'));
  const manifest = await manifestFor(snapshot); const bytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  const ir = await projectWebReader(snapshot, manifest, { manifestBytes: bytes, assets: [] });
  expect(ir.source.manifestSha256).toBe(await sha256(bytes));
  expect(ir.parse.status).toBe('partial'); expect(ir.warnings.join(' ')).toMatch(/missing|unavailable/i);
  await expect(projectWebReader(snapshot, { ...manifest, metadata: { ...manifest.metadata, title: 'forged' } }, { manifestBytes: bytes, assets: [] })).rejects.toThrow(/manifest/i);
  const broken = structuredClone(ir); broken.nodes[0].children.push(broken.nodes[0].id);
  expect(() => validateWebGraph(broken)).toThrow(/cycle|shared/i);
});
it('protects explicit TeX sources and retains display math without inventing LaTeX', async () => {
  const snapshot = sanitizeNodeSnapshot(snapshotInput('<article><p>Before \\(x^2\\) after.</p><p>$$\\frac{a}{b}$$</p><p><math><semantics><mi>x</mi><annotation encoding="application/x-tex">x+1</annotation></semantics></math></p><script type="math/tex">z=2</script></article>'));
  const manifest = await manifestFor(snapshot); const ir = await projectWebReader(snapshot, manifest, projectionOptions(manifest));
  expect(ir.blocks[1]).toMatchObject({ type: 'math', latex: '\\frac{a}{b}', ast: null, displayMode: true });
  const bindings = ir.blocks.flatMap(block => block.type === 'text' ? block.bindings : []);
  expect(bindings).toEqual(expect.arrayContaining([
    expect.objectContaining({ object: { type: 'math', latex: 'x^2' } }),
    expect.objectContaining({ object: { type: 'math', latex: 'x+1' } }),
    expect.objectContaining({ object: { type: 'math', latex: 'z=2' } }),
  ]));
});
it('preserves explicit table header relationships after source IDs are rewritten', async () => {
  const snapshot = sanitizeNodeSnapshot(snapshotInput('<table><tr><th id="__proto__" scope="col">Header</th></tr><tr><td headers="__proto__">Value</td></tr></table>'));
  const manifest = await manifestFor(snapshot); const ir = await projectWebReader(snapshot, manifest, projectionOptions(manifest));
  const cells = ir.nodes.filter(node => node.kind === 'table-cell');
  expect(cells[1].headerNodeIds).toEqual([cells[0].id]);
});
it('preserves standalone inline formatting and separate display delimiters', async () => {
  const snapshot = sanitizeNodeSnapshot(snapshotInput('<strong>Bold</strong><code>x()</code><a href="/target">Link</a><p>$$a$$ and $$b$$</p>'));
  const manifest = await manifestFor(snapshot); const ir = await projectWebReader(snapshot, manifest, projectionOptions(manifest));
  const blocks = ir.blocks.filter(block => block.type === 'text');
  expect(blocks).toHaveLength(4);
  expect(blocks[0].value.content[0]).toMatchObject({ type: 'format', kind: 'strong' });
  expect(blocks[1].value.content[0]).toMatchObject({ type: 'protected', kind: 'code' });
  expect(blocks[2].bindings[0]).toMatchObject({ kind: 'link', href: 'https://e.test/target' });
  expect(blocks[3].bindings.map(binding => binding.kind === 'protected' ? binding.object : null)).toEqual([{ type: 'math', latex: 'a' }, { type: 'math', latex: 'b' }]);
});
it('snapshots manifest bytes before awaiting hashes', async () => {
  const snapshot = sanitizeNodeSnapshot(snapshotInput('<p>Source</p>')); const manifest = await manifestFor(snapshot);
  const options = projectionOptions(manifest); const original = options.manifestBytes.slice();
  const result = projectWebReader(snapshot, manifest, options); options.manifestBytes.fill(0);
  expect((await result).source.manifestSha256).toBe(await sha256(original));
});
