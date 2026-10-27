import type { CaptureLimits, SanitizedSnapshot, WebReaderNode } from '@pagelingo/document-contracts';
import { attr, check, elements, isElement, isText, readSnapshot, textOf, type Element, type Node, type Parent } from './tree.js';
import { mathAst } from './safe-math.js';
export interface SemanticUnit { id: string; nodeId: string; element: Element; content: Node[] }
export interface SemanticProjection { root: Parent; units: SemanticUnit[]; nodes: WebReaderNode[]; roots: string[] }
const containers = new Set('article section main div blockquote aside header footer nav ul ol li dl dt dd table thead tbody tfoot tr th td figure'.split(' '));
const structural = new Set([...containers, ...'p h1 h2 h3 h4 h5 h6 pre caption figcaption hr'.split(' ')]);
/** One source-order pass shared by IR and previews. IDs depend on snapshot order,
 * never on the manifest (which itself contains the preview block IDs). */
export function semanticProjection(snapshot: SanitizedSnapshot, limits: CaptureLimits): SemanticProjection {
  const root = readSnapshot(snapshot, limits); const sourceNodes = new Map<string, WebReaderNode>(); const headerReferences = new Map<string, string[]>(); const units: SemanticUnit[] = [], nodes: WebReaderNode[] = [];
  for (const node of elements(root)) if (node.tagName === 'svg' || node.tagName === 'math') check(mathAst(node, limits), 'Invalid math snapshot structure');
  const nodeId = () => `n_${(nodes.length + 1).toString(16).padStart(32, '0')}`;
  const unit = (element: Element, content: Node[]): string | null => {
    if (!content.some(node => isElement(node) || (isText(node) && node.value.trim()))) return null;
    check(units.length < limits.maxBlocks, 'Semantic block budget exceeded');
    const id = `b_${(units.length + 1).toString(16).padStart(32, '0')}`;
    const sourceId = attr(element, 'data-pl-node'); check(sourceId, 'Semantic block missing source node');
    units.push({ id, nodeId: sourceId, element, content });
    const idNode = nodeId(); nodes.push({ id: idNode, kind: 'block', blockId: id, children: [] }); return idNode;
  };
  const visit = (element: Element): string | null => {
    const tag = element.tagName;
    if (!containers.has(tag)) return unit(element, structural.has(tag) && !['hr', 'pre'].includes(tag) ? element.childNodes : [element]);
    const id = nodeId(); let node: WebReaderNode;
    if (tag === 'table') node = { id, kind: 'table', children: [], captionBlockId: null };
    else if (tag === 'tr') node = { id, kind: 'table-row', children: [] };
    else if (tag === 'td' || tag === 'th') node = { id, kind: 'table-cell', children: [], header: tag === 'th', rowSpan: Number(attr(element, 'rowspan') ?? 1), colSpan: Number(attr(element, 'colspan') ?? 1), scope: ['row', 'col', 'rowgroup', 'colgroup'].includes(attr(element, 'scope') ?? '') ? attr(element, 'scope') as 'row' | 'col' | 'rowgroup' | 'colgroup' : null, headerNodeIds: [] };
    else if (tag === 'ul' || tag === 'ol') node = { id, kind: 'list', ordered: tag === 'ol', children: [], ...(tag === 'ol' && attr(element, 'start') ? { start: Number(attr(element, 'start')) } : {}) };
    else if (tag === 'li') node = { id, kind: 'list-item', children: [] };
    else if (tag === 'section') node = { id, kind: 'section', children: [] };
    else node = { id, kind: 'group', children: [] };
    nodes.push(node);
    const sourceId = attr(element, 'data-pl-node'); if (sourceId) sourceNodes.set(sourceId, node);
    if (node.kind === 'table-cell') headerReferences.set(node.id, (attr(element, 'data-pl-headers') ?? '').split(/\s+/).filter(Boolean));
    let pending: Node[] = [];
    const flush = () => { const child = unit(element, pending); if (child) node.children.push(child); pending = []; };
    for (const child of element.childNodes) {
      if (isElement(child) && structural.has(child.tagName)) {
        flush(); const childId = visit(child); if (childId) node.children.push(childId);
      } else pending.push(child);
    }
    flush();
    if (node.kind === 'table') node.captionBlockId = units.find(item => item.element.tagName === 'caption' && item.element.parentNode === element)?.id ?? null;
    return id;
  };
  const roots: string[] = [];
  for (const child of root.childNodes) {
    if (isElement(child)) { const id = visit(child); if (id) roots.push(id); }
    else check(!isText(child) || !textOf(child).trim(), 'Top-level text requires a snapshot element');
  }
  for (const node of nodes) if (node.kind === 'table-cell') node.headerNodeIds = (headerReferences.get(node.id) ?? []).map(id => { const target = sourceNodes.get(id); check(target?.kind === 'table-cell' && target.header, 'Invalid table header mapping'); return target.id; });
  return { root, units, nodes, roots };
}
