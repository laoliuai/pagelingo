import { webReaderIrSchema, webReaderChunkSchema, type WebReaderIR, type WebTranslation, type WebReaderChunk, type WebReaderIndex, type WebReaderNode } from '@pagelingo/document-contracts';
import { validateWebGraph } from '@pagelingo/web-capture';
import { validateWebTranslation } from './web-translation.js';
import { jsonBytes } from './chunking.js';
import { naturalText } from './semantic-html.js';
export interface WebReaderBuild { index: WebReaderIndex; chunks: WebReaderChunk[] }

export function buildWebReader(input: WebReaderIR, translation: WebTranslation): WebReaderBuild {
  const ir = webReaderIrSchema.parse(input); validateWebGraph(ir);
  const valid = validateWebTranslation(ir, translation);
  const nodes = new Map(ir.nodes.map(n => [n.id, n])), parents = new Map<string, string>(), leaves = new Map<string, string>();
  const positions = new Map<string, number>();
  for (const n of ir.nodes) {
    n.children.forEach((id, i) => { parents.set(id, n.id); positions.set(id, i); });
    if (n.kind === 'block') leaves.set(n.blockId, n.id);
  }
  const assets = new Map(ir.assets.map(a => [a.id, a]));
  const chunks: WebReaderChunk[] = [];
  const sourceBlocks = new Map(ir.blocks.map(b => [b.id, b]));
  const order = new Map(ir.blocks.map((b, i) => [b.id, i]));
  const descendants = new Map<string, string[]>();
  const nodeBlocks = (id: string): string[] => {
    const cached = descendants.get(id); if (cached) return cached;
    const n = nodes.get(id)!;
    const result = n.kind === 'block' ? [n.blockId] : n.children.flatMap(nodeBlocks);
    descendants.set(id, result); return result;
  };
  const firstRows = new Map<string, string | null>();
  const firstRow = (id: string): string | null => {
    if (firstRows.has(id)) return firstRows.get(id)!;
    const n = nodes.get(id)!;
    const row = n.kind === 'table-row' ? id : n.children.reduce<string | null>((found, child) => found ?? (nodes.get(child)?.kind === 'group' || nodes.get(child)?.kind === 'table-row' ? firstRow(child) : null), null);
    firstRows.set(id, row); return row;
  };
  const tableHeaders = new Map<string, string[]>(), rowHeaders = new Map<string, string[]>();
  for (const node of ir.nodes) if (node.kind === 'table-cell' && node.header) {
    let ancestor = parents.get(node.id), row: string | undefined, table: string | undefined;
    while (ancestor) { const n = nodes.get(ancestor)!; if (n.kind === 'table-row' && !row) row = n.id; if (n.kind === 'table') { table = n.id; break; } ancestor = parents.get(ancestor); }
    if (table && (node.scope === 'col' || node.scope === 'colgroup' || (!node.scope && row === firstRow(table)))) {
      const list = tableHeaders.get(table) ?? []; list.push(...nodeBlocks(node.id)); if (list.length > 128) throw new Error('Table context exceeds chunk block budget'); tableHeaders.set(table, list);
    }
    if (row) { const list = rowHeaders.get(row) ?? []; list.push(...nodeBlocks(node.id)); if (list.length > 128) throw new Error('Table context exceeds chunk block budget'); rowHeaders.set(row, list); }
  }
  const chains = new Map<string, string[]>(), dependencies = new Map<string, string[]>();
  for (const block of ir.blocks) {
    const chain: string[] = []; let next = leaves.get(block.id);
    while (next) { chain.unshift(next); next = parents.get(next); }
    chains.set(block.id, chain);
    const context = new Set<string>();
    const addContext = (id: string): void => { context.add(id); if (context.size > 128) throw new Error('Table context exceeds chunk block budget'); };
    for (const id of chain) {
      const n = nodes.get(id)!;
      if (n.kind === 'table') { if (n.captionBlockId) addContext(n.captionBlockId); for (const ref of tableHeaders.get(n.id) ?? []) addContext(ref); }
      if (n.kind === 'table-row') for (const ref of rowHeaders.get(n.id) ?? []) addContext(ref);
      if (n.kind === 'table-cell') for (const header of n.headerNodeIds) for (const ref of nodeBlocks(header)) addContext(ref);
    }
    dependencies.set(block.id, [...context]);
  }
  const makeChunk = (primary: string[]): WebReaderChunk => {
    const all = new Set(primary), pending = [...primary];
    while (pending.length) for (const dependency of dependencies.get(pending.pop()!) ?? []) if (!all.has(dependency)) {
      all.add(dependency); pending.push(dependency);
      if (all.size > 128) throw new Error('Table context exceeds chunk block budget');
    }
    const ordered = [...all].sort((a, b) => order.get(a)! - order.get(b)!);
    const primarySet = new Set(primary);
    const chunk: WebReaderChunk = { id: `c_${String(chunks.length + 1).padStart(6, '0')}`, parseId: ir.parse.id, sourceSha256: ir.source.manifestSha256, contextBlockIds: ordered.filter(id => !primarySet.has(id)), blocks: [], nodes: [], roots: [], assets: [] };
    const included = new Map<string, WebReaderNode>(), usedAssets = new Set<string>();
    for (const id of ordered) {
      const block = sourceBlocks.get(id)!;
      const chain = chains.get(id)!;
      for (const [depth, nodeId] of chain.entries()) if (!included.has(nodeId)) {
        const clone = { ...nodes.get(nodeId)!, children: [] } as WebReaderNode;
        if (clone.kind === 'list' && clone.ordered) clone.start = (clone.start ?? 1) + (positions.get(chain[depth + 1]) ?? 0);
        if (clone.kind === 'section' && clone.headingBlockId && !all.has(clone.headingBlockId)) delete clone.headingBlockId;
        included.set(nodeId, clone); chunk.nodes.push(clone);
        if (depth) included.get(chain[depth - 1])!.children.push(nodeId); else chunk.roots.push(nodeId);
      }
      const refs = block.type === 'image' ? [block.assetId] : block.type === 'math' ? block.fallbackAssetId ? [block.fallbackAssetId] : [] : block.type === 'text' ? block.bindings.flatMap(b => b.kind === 'protected' && b.object.type === 'asset' ? [b.object.assetId] : []) : [];
      for (const ref of refs) if (!usedAssets.has(ref)) { usedAssets.add(ref); chunk.assets.push(assets.get(ref)!); }
      chunk.blocks.push({ source: block, translation: valid.blocks.get(id) ?? null, sourceOnlyReason: valid.sourceOnlyReasons.get(id) ?? null });
    }
    return chunk;
  };
  const fits = (chunk: WebReaderChunk): boolean => chunk.blocks.length <= 128 && jsonBytes(chunk) <= (chunk.blocks.length === 1 ? 512 * 1024 : 256 * 1024);
  let primary: string[] = [], chunk: WebReaderChunk | undefined;
  for (const block of ir.blocks) {
    let candidate: WebReaderChunk | undefined;
    try { candidate = makeChunk([...primary, block.id]); } catch (error) { if (!primary.length) throw error; }
    if (candidate && fits(candidate)) { primary.push(block.id); chunk = candidate; continue; }
    if (chunk) { webReaderChunkSchema.parse(chunk); chunks.push(chunk); }
    primary = [block.id]; chunk = makeChunk(primary);
    if (!fits(chunk)) throw new Error('Web block and required table context exceed chunk byte budget');
  }
  if (chunk) { webReaderChunkSchema.parse(chunk); chunks.push(chunk); }
  const blockLocations: WebReaderIndex['blockLocations'] = Object.create(null);
  const summaries = chunks.map(c => {
    for (const entry of c.blocks.filter(b => !c.contextBlockIds.includes(b.source.id))) blockLocations[entry.source.id] = { chunkId: c.id, nodeId: entry.source.sourceRefs[0].nodeId, previewId: null };
    return { id: c.id, blockIds: c.blocks.filter(b => !c.contextBlockIds.includes(b.source.id)).map(b => b.source.id), bytes: jsonBytes(c) };
  });
  const toc: WebReaderIndex['toc'] = [];
  const sectionHeadings = new Map(ir.nodes.flatMap(n => n.kind === 'section' && n.headingBlockId ? [[n.headingBlockId, n.id] as const] : []));
  const headingStack: Array<{ nodeId: string; level: number }> = [];
  for (const block of ir.blocks) if (block.type === 'text' && block.value.kind === 'heading') {
    const chain = chains.get(block.id)!;
    const depth = block.headingLevel ?? Math.max(1, chain.filter(id => { const n = nodes.get(id)!; return n.kind === 'section' && n.headingBlockId; }).length);
    while (headingStack.length && headingStack.at(-1)!.level >= depth) headingStack.pop();
    const nodeId = sectionHeadings.get(block.id) ?? leaves.get(block.id)!;
    toc.push({ nodeId, parentId: headingStack.at(-1)?.nodeId ?? null, blockId: block.id, title: naturalText(block.value.content), depth });
    headingStack.push({ nodeId, level: depth });
  }
  return { chunks, index: { parseId: ir.parse.id, sourceSha256: ir.source.manifestSha256, chunks: summaries, toc, blockLocations, language: ir.metadata.language, translationStatus: translation.status, generationKind: translation.generationKind, assetIds: ir.assets.map(a => a.id), warnings: [...ir.warnings] } };
}
