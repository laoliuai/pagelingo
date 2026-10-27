import { expect, it } from 'vitest';
import { defaultCaptureLimits, webCaptureManifestSchema } from '@pagelingo/document-contracts';
import { buildSnapshotPreviews, projectWebReader, resolveSnapshotAnchor, sha256 } from '../src/index.js';
import { sanitizeNodeSnapshot } from '../src/node.js';
import { manifestFor, projectionOptions, snapshotInput } from './helpers.js';
it('splits by semantic blocks, preserves table ancestors and binds actual HTML bytes and stable block IDs', async () => {
  const snapshot = sanitizeNodeSnapshot(snapshotInput('<article><table><tr><td>One</td><td>Two</td></tr></table><p>Three</p></article>'));
  const draft = await manifestFor(snapshot);
  const built = await buildSnapshotPreviews(snapshot, draft, { ...defaultCaptureLimits, maxPreviewBlocks: 1 });
  expect(built.files).toHaveLength(3);
  expect(built.files[0].html).toMatch(/<table[^>]*><tbody[^>]*><tr[^>]*><td[^>]*>One<\/td>/);
  expect(built.files[0].html).not.toContain('Two');
  for (const file of built.files) {
    expect(file.descriptor.bytes).toBe(new TextEncoder().encode(file.html).length);
    expect(file.descriptor.sha256).toBe(await sha256(new TextEncoder().encode(file.html)));
  }
  const manifest = { ...draft, files: [...draft.files, ...built.files.map(file => file.descriptor)], snapshots: built.index };
  expect(webCaptureManifestSchema.safeParse(manifest).success).toBe(true);
  const ir = await projectWebReader(snapshot, manifest, projectionOptions(manifest));
  expect(built.index.previews.flatMap(preview => preview.blockIds)).toEqual(ir.blocks.map(block => block.id));
  const nodeId = ir.blocks[0].sourceRefs[0].nodeId;
  expect(resolveSnapshotAnchor(built.index, nodeId)?.anchorId).toBe(`pl_${nodeId}`);
  for (const key of ['__proto__', 'constructor', 'toString']) expect(resolveSnapshotAnchor(built.index, key)).toBeNull();
});
it('omits oversized units explicitly and charges unique referenced resource bytes', async () => {
  const snapshot = sanitizeNodeSnapshot(snapshotInput('<p>' + 'x'.repeat(2000) + '</p><p>Small</p>'));
  const draft = await manifestFor(snapshot);
  const built = await buildSnapshotPreviews(snapshot, draft, { ...defaultCaptureLimits, maxPreviewHtmlBytes: 500 });
  expect(built.files).toHaveLength(1);
  expect(built.warnings.join(' ')).toMatch(/oversized|budget/i);
  expect(built.files[0].html).toContain('Small');
});
it('charges shared images once per preview and splits resource closures at their real byte budget', async () => {
  const snapshot = sanitizeNodeSnapshot(snapshotInput('<p>A<img src="/one.png"><img src="/one.png"></p><p>B<img src="/two.png"></p>'));
  const draft = await manifestFor(snapshot);
  draft.files.push(...[1, 2].map(i => ({ id: `image${i}`, path: `images/${i}.png`, bytes: 600, sha256: 'a'.repeat(64), mediaType: 'image/png', role: 'image' as const })));
  draft.resources = snapshot.resources.map((resource, i) => ({ id: resource.id, role: resource.role, url: resource.url, status: 'available', fileId: `image${i + 1}` }));
  const built = await buildSnapshotPreviews(snapshot, draft, { ...defaultCaptureLimits, maxPreviewResourceBytes: 1000 });
  expect(built.index.previews.map(preview => preview.resourceBytes)).toEqual([600, 600]);
  expect(built.index.previews.map(preview => preview.resourceFileIds)).toEqual([['image1'], ['image2']]);
});
it('rejects forged sanitized HTML instead of publishing active preview bytes', async () => {
  const snapshot = sanitizeNodeSnapshot(snapshotInput('<p>Safe</p>'));
  snapshot.html = snapshot.html.replace('Safe', '<script>evil()</script><img src="https://evil.test">');
  const draft = await manifestFor(snapshot);
  await expect(buildSnapshotPreviews(snapshot, draft)).rejects.toThrow(/active|unsafe|inert/i);
});
it('keeps the referenced header in a cell preview and charges its semantic block', async () => {
  const snapshot = sanitizeNodeSnapshot(snapshotInput('<table><tr><th id="name">Name</th></tr><tr><td headers="name">Value</td></tr></table>'));
  const draft = await manifestFor(snapshot);
  const tooSmall = await buildSnapshotPreviews(snapshot, draft, { ...defaultCaptureLimits, maxPreviewBlocks: 1 });
  expect(tooSmall.warnings.join(' ')).toMatch(/oversized|budget/i);
  expect(tooSmall.files.some(file => file.html.includes('Value'))).toBe(false);
  const enough = await buildSnapshotPreviews(snapshot, draft, { ...defaultCaptureLimits, maxPreviewBlocks: 2 });
  const file = enough.files.find(file => file.html.includes('Value'))!;
  expect(file.html).toContain('Name');
  expect(enough.index.previews.find(preview => preview.fileId === file.descriptor.id)?.blockIds).toHaveLength(2);
});
it('rejects forged math reference expansion before emitting active SVG previews', async () => {
  const snapshot = sanitizeNodeSnapshot(snapshotInput('<p>Safe</p>'));
  snapshot.html = '<svg data-pl-node="s_1" id="pl_s_1"><defs><g id="a"><path d="M0 0"></path></g><g id="b"><use href="#a"></use><use href="#a"></use></g><g id="c"><use href="#b"></use><use href="#b"></use></g></defs><use href="#c"></use><use href="#c"></use></svg>';
  const draft = await manifestFor(snapshot);
  await expect(buildSnapshotPreviews(snapshot, draft, { ...defaultCaptureLimits, maxMathNodes: 15 })).rejects.toThrow(/math|expansion/i);
});
it('resolves every mixed-content block to the preview containing its own source material', async () => {
  const snapshot = sanitizeNodeSnapshot(snapshotInput('<div>Before<p>Middle</p>After</div>'));
  const draft = await manifestFor(snapshot);
  const built = await buildSnapshotPreviews(snapshot, draft, { ...defaultCaptureLimits, maxPreviewBlocks: 1 });
  const manifest = { ...draft, files: [...draft.files, ...built.files.map(file => file.descriptor)], snapshots: built.index };
  const ir = await projectWebReader(snapshot, manifest, projectionOptions(manifest));
  expect(built.files).toHaveLength(3);
  for (const block of ir.blocks) {
    const ref = block.sourceRefs[0];
    const location = resolveSnapshotAnchor(built.index, ref.nodeId)!;
    const preview = built.index.previews.find(item => item.id === location.previewId)!;
    const html = built.files.find(file => file.descriptor.id === preview.fileId)!.html;
    expect(html).toContain(ref.quote);
    expect(html).toContain(`id="${location.anchorId}"`);
    expect(preview.blockIds).toContain(block.id);
  }
});
it('bounds examined header-context work before rebuilding oversized closures', async () => {
  const snapshot = sanitizeNodeSnapshot(snapshotInput(`<table><thead><tr>${Array.from({ length: 40 }, (_, i) => `<th>Header ${i}</th>`).join('')}</tr></thead><tbody><tr><td>Value</td></tr></tbody></table>`));
  const draft = await manifestFor(snapshot);
  const original = Set.prototype.has; let calls = 0;
  Set.prototype.has = function (value: unknown) { calls++; return original.call(this, value); };
  try {
    const built = await buildSnapshotPreviews(snapshot, draft, { ...defaultCaptureLimits, maxPreviewBlocks: 1 });
    expect(built.files).toEqual([]);
    expect(built.warnings).toHaveLength(41);
  } finally { Set.prototype.has = original; }
  // Includes shared schemas/parsing; the old forty-header probe exceeded 150k.
  expect(calls).toBeLessThan(15000);
});
