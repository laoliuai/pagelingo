import type { WebReaderIR, WebReaderNode, WebReaderChunk } from '@pagelingo/document-contracts';
type Cell = Extract<WebReaderNode, { kind: 'table-cell' }>;
interface Placement { cell: Cell; rowId: string; row: number; column: number; end: number }
interface RowGroup { rows: string[]; cells: Placement[]; spans: Placement[] }
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
/** Source row groups and interval-based grid; no dense column/pixel matrix. */
export function planWebTables(ir: WebReaderIR, nodes: Map<string, WebReaderNode>, parents: Map<string, string>, nodeBlocks: (id: string) => string[]) {
  const groups = new Map<string, RowGroup>(), groupByRow = new Map<string, string>(), rowByBlock = new Map<string, string>(), rowsByBlock = new Map<string, string[]>();
  const groupHeaders = new Map<string, string[]>(), spanningBlocks = new Map<string, string[]>();
  const visit = (id: string): void => {
    const n = nodes.get(id)!;
    if (n.kind === 'table-row') {
      let ancestor = parents.get(id), groupId: string | undefined;
      while (ancestor) { const a = nodes.get(ancestor)!; if (a.kind === 'table') { groupId ??= a.id; break; } if (a.kind === 'group') groupId = a.id; ancestor = parents.get(ancestor); }
      check(groupId, 'Table row requires a source table');
      const group = groups.get(groupId) ?? { rows: [], cells: [], spans: [] }; group.rows.push(id); groups.set(groupId, group); groupByRow.set(id, groupId);
      for (const block of nodeBlocks(id)) { rowByBlock.set(block, id); const list = rowsByBlock.get(block) ?? []; list.push(id); rowsByBlock.set(block, list); }
    }
    n.children.forEach(visit);
  };
  ir.roots.forEach(visit);
  for (const [groupId, group] of groups) {
    let active: Placement[] = [];
    for (const [row, rowId] of group.rows.entries()) {
      active = active.filter(p => p.end >= row);
      const dependencies = new Set<string>();
      for (const p of active) for (const block of nodeBlocks(p.cell.id)) { dependencies.add(block); check(dependencies.size <= 128, 'Spanning table context exceeds chunk block budget'); }
      spanningBlocks.set(rowId, [...dependencies]);
      let column = 0;
      for (const cellId of nodes.get(rowId)!.children) {
        const cell = nodes.get(cellId)!; check(cell.kind === 'table-cell', 'Invalid source table cell');
        // Use the original occupied intervals, including spans from previous rows.
        let overlap: Placement | undefined;
        while ((overlap = active.find(p => p.column < column + cell.colSpan && p.column + p.cell.colSpan > column))) column = overlap.column + overlap.cell.colSpan;
        const placement = { cell, rowId, row, column, end: Math.min(group.rows.length - 1, row + cell.rowSpan - 1) };
        group.cells.push(placement); if (placement.end > row) { active.push(placement); group.spans.push(placement); }
        if (cell.header && cell.scope === 'rowgroup') {
          const list = groupHeaders.get(groupId) ?? []; list.push(...nodeBlocks(cell.id)); check(list.length <= 128, 'Rowgroup table context exceeds chunk block budget'); groupHeaders.set(groupId, list);
        }
        column += cell.colSpan;
      }
    }
  }
  const rowGroupBlocks = (rowId: string): string[] => groupHeaders.get(groupByRow.get(rowId)!) ?? [];
  const normalize = (chunk: WebReaderChunk, primary: ReadonlySet<string>, semantic: ReadonlySet<string>): void => {
    const included = new Map(chunk.nodes.map(n => [n.id, n]));
    const rows = new Set([...primary, ...semantic].flatMap(id => rowsByBlock.get(id) ?? []));
    const position = (id: string): number => { const parent = parents.get(id); return parent ? nodes.get(parent)!.children.indexOf(id) : ir.roots.indexOf(id); };
    const ensure = (id: string): WebReaderNode => {
      const old = included.get(id); if (old) return old;
      const clone = { ...nodes.get(id)!, children: [] } as WebReaderNode; included.set(id, clone);
      const parent = parents.get(id);
      if (parent) { const p = ensure(parent); p.children.push(id); p.children.sort((a, b) => position(a) - position(b)); }
      else { chunk.roots.push(id); chunk.roots.sort((a, b) => position(a) - position(b)); }
      return clone;
    };
    for (const n of chunk.nodes) if (n.kind === 'table-row') {
      n.children = [];
      if (!rows.has(n.id)) { included.delete(n.id); const parent = included.get(parents.get(n.id)!); if (parent) parent.children = parent.children.filter(id => id !== n.id); }
    }
    for (const group of groups.values()) {
      const selected = group.rows.map((id, index) => ({ id, index })).filter(r => rows.has(r.id));
      if (!selected.length) continue;
      const byRow = new Map(selected.map(r => [r.id, [] as Placement[]]));
      // Include source cells at their original columns. Incoming spans continue
      // at the first visible covered row; omitted content becomes an empty copy
      // of its original cell node, never a fabricated source block.
      for (const p of group.cells) {
        const covered = selected.filter(r => r.index >= p.row && r.index <= p.end);
        if (!covered.length) continue;
        const target = covered[0].id;
        const old = included.get(p.cell.id);
        const cell: Cell = { ...p.cell, children: old?.children ?? [], rowSpan: covered.length };
        included.set(cell.id, cell); byRow.get(target)!.push(p);
      }
      for (const row of selected) {
        const n = ensure(row.id); n.children = byRow.get(row.id)!.sort((a, b) => a.column - b.column).map(p => p.cell.id);
      }
    }
    const orderedNodes: WebReaderNode[] = [], blockIds: string[] = [], seen = new Set<string>();
    const walk = (id: string): void => {
      check(!seen.has(id), 'Repeated normalized table node'); seen.add(id);
      const n = included.get(id)!; check(n, 'Missing normalized table node'); orderedNodes.push(n);
      if (n.kind === 'block') blockIds.push(n.blockId); n.children.forEach(walk);
    };
    chunk.roots.forEach(walk);
    const entries = new Map(chunk.blocks.map(b => [b.source.id, b]));
    check(blockIds.length === entries.size && new Set(blockIds).size === entries.size && blockIds.every(id => entries.has(id)), 'Invalid normalized table block closure');
    const primaryOrder = blockIds.filter(id => primary.has(id));
    const primaryIds = [...primary];
    check(primaryOrder.every((id, index) => id === primaryIds[index]), 'Table layout changed primary reading order');
    chunk.nodes = orderedNodes; chunk.blocks = blockIds.map(id => entries.get(id)!);
  };
  return { rowByBlock, rowGroupBlocks, spanningBlocks, normalize };
}
