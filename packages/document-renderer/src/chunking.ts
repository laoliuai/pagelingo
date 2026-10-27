import { readerIrSchema, validateReaderGraph, type ReaderIR, type ReaderChunk, type ReaderIndex, type ReaderNode, type ReaderAsset } from '@pagelingo/document-contracts';
import type { ReaderTranslation } from '@pagelingo/document-contracts';
import { validateReaderTranslation } from './translation.js';
export interface ReaderBuild { index: ReaderIndex; chunks: ReaderChunk[] }
export const jsonBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export function buildReader(irInput: ReaderIR, translation: ReaderTranslation): ReaderBuild {
  const ir = readerIrSchema.parse(irInput);
  validateReaderGraph(ir);
  const valid = validateReaderTranslation(ir, translation);
  const nodes = new Map(ir.nodes.map(node => [node.id, node]));
  const parents = new Map<string, string>();
  for (const node of ir.nodes) for (const child of node.children) parents.set(child, node.id);
  const leaves = new Map(ir.nodes.filter(node => node.kind === 'block').map(node => [node.blockId, node.id]));
  const childPositions = new Map<string, number>();
  for (const node of ir.nodes) node.children.forEach((id, index) => childPositions.set(id, index));
  const assets = new Map(ir.assets.map(asset => [asset.id, asset]));
  const chunks: ReaderChunk[] = [];
  let chunk!: ReaderChunk;
  let included!: Map<string, ReaderNode>;
  let includedAssets!: Set<string>;
  let page: number | undefined;
  const reset = (): void => {
    chunk = { id: `c_${String(chunks.length + 1).padStart(6, '0')}`, parseId: ir.parse.id, sourceSha256: ir.source.sha256, blockIds: [], blocks: [], nodes: [], roots: [], assets: [] };
    included = new Map(); includedAssets = new Set(); page = undefined;
  };
  reset();
  const blockAssets = (block: ReaderIR['blocks'][number]): string[] => {
    if (block.type === 'image') return [block.assetId];
    if (block.type === 'math') return block.fallbackAssetId ? [block.fallbackAssetId] : [];
    if (block.type === 'text') return block.bindings.flatMap(binding => binding.kind === 'protected' && binding.object.type === 'asset' ? [binding.object.assetId] : []);
    return [];
  };
  for (const block of ir.blocks) {
    const blockPage = block.sourceRefs[0].pageIndex;
    const entry = { source: block, translation: valid.blocks.get(block.id) ?? null, sourceOnlyReason: valid.sourceOnlyReasons.get(block.id) ?? null };
    const chain: string[] = [];
    let leaf: string | undefined = leaves.get(block.id)!;
    while (leaf) { chain.unshift(leaf); leaf = parents.get(leaf); }
    // Candidate additions only; avoid rescanning all IR nodes for each bounded chunk.
    const additions: ReaderNode[] = [];
    for (const [depth, id] of chain.entries()) if (!included.has(id)) {
      const original = nodes.get(id)!;
      const clone = { ...original, children: [] };
      if (clone.kind === 'list' && clone.ordered) clone.start = (clone.start ?? 1) + (childPositions.get(chain[depth + 1]) ?? 0);
      if (clone.kind === 'section' && clone.headingBlockId && !chunk.blockIds.includes(clone.headingBlockId) && clone.headingBlockId !== block.id) delete clone.headingBlockId;
      additions.push(clone);
    }
    const newAssets = blockAssets(block).filter(id => !includedAssets.has(id)).map(id => assets.get(id)!);
    const estimate = jsonBytes(chunk) + jsonBytes(entry) + jsonBytes(additions) + jsonBytes(newAssets) + chain.length * 40 + 48;
    if (chunk.blockIds.length && (chunk.blockIds.length >= 128 || page !== blockPage || estimate > 256 * 1024)) {
      chunks.push(chunk); reset();
      // Retry the same block against the empty chunk; continuation offsets are recomputed.
      add(block, entry, chain, blockAssets(block).map(id => assets.get(id)!));
    } else add(block, entry, chain, newAssets);
    page = blockPage;
  }
  if (chunk!.blockIds.length) chunks.push(chunk!);
  const blockLocations: ReaderIndex['blockLocations'] = {};
  const summaries = chunks.map(part => {
    const pageIndices = [...new Set(part.blocks.flatMap(block => block.source.sourceRefs.map(ref => ref.pageIndex)))].sort((a, b) => a - b);
    for (const block of part.blocks) blockLocations[block.source.id] = { chunkId: part.id, pageIndices: [...new Set(block.source.sourceRefs.map(ref => ref.pageIndex))].sort((a, b) => a - b) };
    return { id: part.id, blockIds: [...part.blockIds], pageIndices, bytes: jsonBytes(part) };
  });
  const textBlocks = new Map(ir.blocks.filter(b => b.type === 'text').map(b => [b.id, b]));
  const toc: ReaderIndex['toc'] = [];
  function headings(id: string, parentId: string | null, depth: number): void {
    const node = nodes.get(id)!;
    let nextParent = parentId; let nextDepth = depth;
    if (node.kind === 'section' && node.headingBlockId) {
      const text = textBlocks.get(node.headingBlockId)!;
      const plain = (content: typeof text.value.content): string => content.map(inline => inline.type === 'text' ? inline.text : inline.type === 'protected' ? inline.source : plain(inline.children)).join('');
      toc.push({ nodeId: id, parentId, blockId: text.id, title: plain(text.value.content), depth });
      nextParent = id; nextDepth++;
    }
    for (const child of node.children) headings(child, nextParent, nextDepth);
  }
  for (const root of ir.roots) headings(root, null, 1);
  return { chunks, index: { parseId: ir.parse.id, sourceSha256: ir.source.sha256, chunks: summaries, toc, blockLocations, language: ir.metadata.language, translationStatus: translation.status, generationKind: translation.generationKind, parseCoverage: ir.parse.coverage, assetIds: ir.assets.map(asset => asset.id), warnings: [...ir.warnings] } };

  function add(block: ReaderIR['blocks'][number], entry: ReaderChunk['blocks'][number], chain: string[], newAssets: ReaderAsset[]): void {
    for (const [depth, id] of chain.entries()) {
      if (!included.has(id)) {
        const clone = { ...nodes.get(id)!, children: [] };
        if (clone.kind === 'list' && clone.ordered) clone.start = (clone.start ?? 1) + (childPositions.get(chain[depth + 1]) ?? 0);
        if (clone.kind === 'section' && clone.headingBlockId && !chunk.blockIds.includes(clone.headingBlockId) && clone.headingBlockId !== block.id) delete clone.headingBlockId;
        included.set(id, clone); chunk.nodes.push(clone);
        if (depth === 0) chunk.roots.push(id);
        else included.get(chain[depth - 1])!.children.push(id);
      }
    }
    for (const asset of newAssets) if (!includedAssets.has(asset.id)) { includedAssets.add(asset.id); chunk.assets.push(asset); }
    chunk.blockIds.push(block.id); chunk.blocks.push(entry);
  }
}
