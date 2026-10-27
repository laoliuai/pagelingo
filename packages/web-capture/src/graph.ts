import { defaultCaptureLimits, webReaderIrSchema, type WebReaderIR } from '@pagelingo/document-contracts';
import { encodeBlock, type InlineContent } from '@pagelingo/translation-core';
import { byteLength, check } from './tree.js';
export function validateWebGraph(input: WebReaderIR): void {
  const ir = webReaderIrSchema.parse(input);
  const nodes = new Map(ir.nodes.map(node => [node.id, node])); const blocks = new Map(ir.blocks.map(block => [block.id, block])); const assets = new Map(ir.assets.map(asset => [asset.id, asset]));
  const seen = new Set<string>(); const usedBlocks: string[] = []; const usedAssets = new Set<string>();
  const stack = [...ir.roots].reverse().map(id => ({ id, depth: 1, parent: '' }));
  while (stack.length) {
    const current = stack.pop()!; check(!seen.has(current.id), 'Cycle or shared Web node'); seen.add(current.id);
    const node = nodes.get(current.id); check(node, 'Unknown Web node'); check(current.depth <= defaultCaptureLimits.maxDepth, 'Web graph depth budget exceeded');
    if (node.kind === 'list-item') check(current.parent === 'list', 'List item requires list parent');
    if (node.kind === 'list') check(node.children.every(id => nodes.get(id)?.kind === 'list-item'), 'List children must be list items');
    if (node.kind === 'table-cell') {
      check(current.parent === 'table-row', 'Table cell requires row parent');
      for (const id of node.headerNodeIds) check(nodes.get(id)?.kind === 'table-cell' && (nodes.get(id) as Extract<typeof node, { kind: 'table-cell' }>).header, 'Unknown table header');
    }
    if (node.kind === 'table-row') check(node.children.every(id => nodes.get(id)?.kind === 'table-cell'), 'Table row requires cell children');
    if (node.kind === 'table' && node.captionBlockId) check(blocks.get(node.captionBlockId)?.type === 'text', 'Unknown table caption');
    if (node.kind === 'section' && node.headingBlockId) { const heading = blocks.get(node.headingBlockId); check(heading?.type === 'text' && heading.value.kind === 'heading', 'Invalid section heading'); }
    if (node.kind === 'block') { check(blocks.has(node.blockId), 'Unknown Web block'); usedBlocks.push(node.blockId); }
    stack.push(...[...node.children].reverse().map(id => ({ id, depth: current.depth + 1, parent: node.kind })));
  }
  check(seen.size === nodes.size, 'Unreachable Web nodes');
  check(usedBlocks.length === blocks.size && new Set(usedBlocks).size === blocks.size && usedBlocks.every((id, index) => ir.blocks[index].id === id), 'Web blocks must be unique and follow reading order');
  check(ir.source.manifestSha256 === ir.parse.inputManifestSha256, 'Web parse/source mismatch');
  check((ir.parse.coverage === 'full') === (ir.parse.status === 'complete'), 'Web coverage/status mismatch');
  check(ir.parse.status !== 'partial' || ir.warnings.length > 0, 'Partial Web IR requires warning');
  const useAsset = (id: string) => { check(assets.has(id), 'Unknown Web asset'); usedAssets.add(id); };
  for (const block of ir.blocks) {
    check(byteLength(JSON.stringify(block)) <= defaultCaptureLimits.maxOversizedBlockBytes, 'Web block byte budget exceeded');
    if (block.type === 'image') useAsset(block.assetId);
    if (block.type === 'math' && block.fallbackAssetId) useAsset(block.fallbackAssetId);
    if (block.type !== 'text') continue;
    check(block.value.id === block.id, 'SDK/Web block ID mismatch'); encodeBlock(block.value);
    const bindings = new Map(block.bindings.map(binding => [binding.id, binding])); check(bindings.size === block.bindings.length, 'Duplicate Web binding');
    const used = new Set<string>(); const pending: InlineContent[] = [...block.value.content];
    while (pending.length) {
      const inline = pending.pop()!; if (inline.type === 'text') continue;
      check(!used.has(inline.id), 'Repeated Web binding'); used.add(inline.id); const binding = bindings.get(inline.id); check(binding, 'Missing Web binding');
      if (inline.type === 'format') {
        if (inline.kind === 'link') {
          check(binding.kind === 'link' || binding.kind === 'block-link', 'Link binding mismatch');
          if (binding.kind === 'block-link') check(blocks.has(binding.blockId), 'Unknown Web block link');
          else { const url = new URL(binding.href); check(['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password, 'Unsafe Web link'); }
        } else check(binding.kind === 'style' && (inline.kind === 'style' ? Object.keys(binding).length > 2 : binding.emphasis === inline.kind), 'Style binding mismatch');
        pending.push(...inline.children);
      } else {
        check(binding.kind === 'protected', 'Protected binding mismatch'); const object = binding.object;
        if (object.type === 'asset') { check(inline.kind === 'literal' && inline.source === object.alt, 'Asset source binding mismatch'); useAsset(object.assetId); }
        else if (object.type === 'math') check(inline.kind === 'math' && inline.source === object.latex, 'Math source binding mismatch');
        else check(inline.source === object.text && (object.type === 'code' ? inline.kind === 'code' : !['code', 'math'].includes(inline.kind)), 'Protected source binding mismatch');
      }
    }
    check(used.size === bindings.size, 'Unreferenced Web binding');
  }
  check(usedAssets.size === assets.size, 'Unreferenced Web assets');
  const paths = new Set<string>();
  for (const asset of assets.values()) { const path = asset.path.toLowerCase(); check(!paths.has(path), 'Asset path alias'); paths.add(path); }
  for (const path of paths) { const parts = path.split('/'); for (let i = 1; i < parts.length; i++) check(!paths.has(parts.slice(0, i).join('/')), 'Asset path prefix conflict'); }
}
