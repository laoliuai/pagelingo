import type { WebReaderIR, WebModelTranslation } from '@pagelingo/document-contracts';
import { planUnits } from '@pagelingo/translation-core';
import { snapshot, fixture, id } from './fixtures.js';
import { toWebTranslationDocument } from '../src/index.js';
export { id };
export function webBook(count = 2): WebReaderIR {
  const hash = 'a'.repeat(64);
  const ir: WebReaderIR = {
    schemaVersion: 'web-reader-ir/1', metadata: { title: 'Archived article', language: { language: 'en', sourceLanguage: 'en', reason: 'english-heuristic' } },
    source: { kind: 'web', manifestSha256: hash, snapshotSha256: 'b'.repeat(64), bytes: 100 },
    parse: { id: `p_${hash}`, inputManifestSha256: hash, projectorVersion: 'test/1', configSha256: hash, coverage: 'full', status: 'complete' },
    roots: [], nodes: [], blocks: [], assets: [], warnings: [],
  };
  for (let i = 1; i <= count; i++) {
    const blockId = id('b', i), nodeId = id('n', i);
    ir.roots.push(nodeId); ir.nodes.push({ id: nodeId, kind: 'block', blockId, children: [] });
    ir.blocks.push({ id: blockId, type: 'text', sourceRefs: [{ nodeId: `snapshot-${i}`, quote: 'Repeated paragraph', prefix: '', suffix: '' }], value: { id: blockId, kind: 'paragraph', content: [{ type: 'text', text: 'Repeated paragraph' }] }, bindings: [], safeMath: [], language: ir.metadata.language });
  }
  return ir;
}
export function webSnapshot(ir: WebReaderIR, completed = false): WebModelTranslation {
  const base = snapshot(fixture());
  const t: WebModelTranslation = { ...base, schemaVersion: 'web-reader-translation/1', parseId: ir.parse.id, sourceSha256: ir.source.manifestSha256, selectionBlockIds: ir.blocks.filter(b => b.type === 'text').map(b => b.id) };
  const plan = planUnits(toWebTranslationDocument(ir, t.selectionBlockIds), t.targetLanguage, t.profile, t.budget, t);
  t.units = plan.units.map(u => ({ id: u.id, blockId: plan.inputs[u.blockIndex].id, part: u.part, status: completed ? 'covered-by-block' : 'pending' }));
  t.blocks = plan.inputs.map(input => completed ? { blockId: input.id, status: 'translated', rawText: input.protectedText } : { blockId: input.id, status: 'source-only', reason: 'pending' });
  t.status = plan.inputs.length ? completed ? 'completed' : 'pending' : 'not-required'; t.generationKind = completed ? 'mock' : 'none';
  return t;
}
export function webTable(rows: number, columns: number, headers = true): WebReaderIR {
  const ir = webBook(rows * columns), leaves = [...ir.nodes];
  const tableId = id('n', 100000), groupId = id('n', 100001);
  ir.roots = [tableId]; ir.nodes = [{ id: tableId, kind: 'table', captionBlockId: null, children: [groupId] }, { id: groupId, kind: 'group', children: [] }];
  for (let row = 0; row < rows; row++) {
    const rowId = id('n', 200000 + row); ir.nodes[1].children.push(rowId);
    const rowNode = { id: rowId, kind: 'table-row' as const, children: [] as string[] }; ir.nodes.push(rowNode);
    for (let col = 0; col < columns; col++) {
      const index = row * columns + col, cellId = id('n', 300000 + index);
      rowNode.children.push(cellId);
      ir.nodes.push({ id: cellId, kind: 'table-cell', header: headers && row === 0, scope: headers && row === 0 ? 'col' : null, rowSpan: 1, colSpan: 1, headerNodeIds: [], children: [leaves[index].id] }, leaves[index]);
      const block = ir.blocks[index]; if (block.type === 'text') block.value.content = [{ type: 'text', text: `Row${row}Col${col}` }];
    }
  }
  return ir;
}
/** A sparse valid grid: only the first row authors all columns; selected cells
 * span the group while later rows author only their leading ordinary cells. */
export function webContinuedGaps(widths: number[], continued: number[], bodyCells = 1): WebReaderIR {
  const ir = webTable(140, widths.length, false), removed = new Set<string>(), keptBlocks = new Set<string>();
  const nodeMap = new Map(ir.nodes.map(n => [n.id, n]));
  for (const [rowIndex, row] of ir.nodes.filter(n => n.kind === 'table-row').entries()) {
    for (const [column, cellId] of [...row.children].entries()) {
      const cell = nodeMap.get(cellId)!; if (cell.kind !== 'table-cell') throw Error('fixture');
      if (rowIndex > 0 && column >= bodyCells) {
        removed.add(cell.id); cell.children.forEach(id => removed.add(id)); continue;
      }
      if (rowIndex === 0) { cell.colSpan = widths[column]; if (continued.includes(column)) cell.rowSpan = 140; }
      for (const leafId of cell.children) { const leaf = nodeMap.get(leafId)!; if (leaf.kind === 'block') keptBlocks.add(leaf.blockId); }
    }
    row.children = row.children.filter(id => !removed.has(id));
  }
  ir.nodes = ir.nodes.filter(n => !removed.has(n.id)); ir.blocks = ir.blocks.filter(b => keptBlocks.has(b.id));
  return ir;
}
