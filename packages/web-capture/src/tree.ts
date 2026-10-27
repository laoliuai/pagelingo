import { defaultTreeAdapter, parseFragment, serialize, serializeOuter, type DefaultTreeAdapterTypes as T } from 'parse5';
import { captureLimitsSchema, defaultCaptureLimits, safeMathNodeSchema, type CaptureLimits, type SanitizedSnapshot } from '@pagelingo/document-contracts';
import { htmlTags } from './policy.js';
import { sanitizeStyle } from './styles.js';
export type Element = T.Element;
export type Node = T.Node;
export type Parent = T.ParentNode;
export const utf8 = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
export const byteLength = (value: string): number => utf8(value).length;
export const limitsFor = (limits?: CaptureLimits): CaptureLimits => captureLimitsSchema.parse(limits ?? defaultCaptureLimits);
export function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export const isText = (node: Node): node is T.TextNode => node.nodeName === '#text' && 'value' in node;
export const isElement = (node: Node): node is Element => 'tagName' in node;
export const attr = (node: Element, name: string): string | undefined => node.attrs.find(a => (a.prefix ? `${a.prefix}:${a.name}` : a.name) === name)?.value;
export function setAttr(node: Element, name: string, value: string): void {
  node.attrs = node.attrs.filter(a => a.name !== name); node.attrs.push({ name, value });
}
export function elements(root: Parent): Element[] {
  const result: Element[] = []; const stack: Node[] = [...root.childNodes].reverse();
  while (stack.length) { const node = stack.pop()!; if (isElement(node)) { result.push(node); stack.push(...[...node.childNodes].reverse()); } }
  return result;
}
/** parse5 never performs DOM side effects. Stop allocation/attachment during parsing,
 * before a native DOM or recursive AST validator sees the hostile input. */
export function parseBounded(html: string, limits: CaptureLimits): T.DocumentFragment {
  check(byteLength(html) <= limits.maxHtmlBytes, 'HTML byte budget exceeded');
  let allocated = 0;
  const allocate = () => check(++allocated <= limits.maxDomNodes, 'DOM node budget exceeded');
  const depth = (parent: Parent) => {
    let current: Node | null = parent; let count = 0;
    while (current) { check(++count <= limits.maxDepth + 2, 'DOM depth budget exceeded'); current = 'parentNode' in current ? current.parentNode : null; }
  };
  const treeAdapter = {
    ...defaultTreeAdapter,
    createElement(...args: Parameters<typeof defaultTreeAdapter.createElement>) { allocate(); return defaultTreeAdapter.createElement(...args); },
    createCommentNode(...args: Parameters<typeof defaultTreeAdapter.createCommentNode>) { allocate(); return defaultTreeAdapter.createCommentNode(...args); },
    insertText(...args: Parameters<typeof defaultTreeAdapter.insertText>) { allocate(); defaultTreeAdapter.insertText(...args); },
    insertTextBefore(...args: Parameters<typeof defaultTreeAdapter.insertTextBefore>) { allocate(); defaultTreeAdapter.insertTextBefore(...args); },
    appendChild(...args: Parameters<typeof defaultTreeAdapter.appendChild>) { depth(args[0]); defaultTreeAdapter.appendChild(...args); },
    insertBefore(...args: Parameters<typeof defaultTreeAdapter.insertBefore>) { depth(args[0]); defaultTreeAdapter.insertBefore(...args); },
  };
  const root = parseFragment(html, { treeAdapter });
  const stack = root.childNodes.map(node => ({ node, depth: 1 })); let count = 0;
  while (stack.length) { const item = stack.pop()!; check(++count <= limits.maxDomNodes && item.depth <= limits.maxDepth, 'DOM structure budget exceeded'); if (isElement(item.node)) stack.push(...item.node.childNodes.map(node => ({ node, depth: item.depth + 1 }))); }
  return root;
}
export const htmlOf = (node: Node): string => isElement(node) ? serializeOuter(node) : 'childNodes' in node ? serialize(node) : isText(node) ? node.value : '';
export function textOf(node: Node): string {
  if (isText(node)) return node.value;
  return 'childNodes' in node ? node.childNodes.map(textOf).join('') : '';
}
export function detach(node: Element): void { defaultTreeAdapter.detachNode(node); }
export function readSnapshot(snapshot: SanitizedSnapshot, limits: CaptureLimits): T.DocumentFragment {
  const root = parseBounded(snapshot.html, limits);
  const resourceIds = new Set(snapshot.resources.map(resource => resource.id));
  for (const node of elements(root)) {
    if (node.namespaceURI === 'http://www.w3.org/1999/xhtml') {
      check(htmlTags.has(node.tagName), 'Active or unsafe snapshot element');
      for (const item of node.attrs) {
        check(['id', 'data-pl-node', 'data-pl-resource', 'data-pl-headers', 'title', 'alt', 'lang', 'dir', 'colspan', 'rowspan', 'scope', 'start', 'style', 'href'].includes(item.name), 'Unsafe snapshot attribute');
        if (item.name === 'href') { const url = new URL(item.value); check(node.tagName === 'a' && ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password, 'Unsafe snapshot link'); }
        if (item.name === 'style') check(sanitizeStyle(item.value) === item.value, 'Unsafe snapshot style');
      }
      const resource = attr(node, 'data-pl-resource'); if (resource) check(node.tagName === 'img' && resourceIds.has(resource), 'Unsafe unregistered snapshot resource');
    } else {
      check(safeMathNodeSchema.shape.tag.safeParse(node.tagName).success, 'Unsafe foreign snapshot element');
      const attributes = Object.fromEntries(node.attrs.filter(item => item.name !== 'data-pl-node').map(item => [item.prefix ? `${item.prefix}:${item.name}` : item.name, item.value]));
      check(safeMathNodeSchema.shape.attributes.safeParse(attributes).success, 'Unsafe foreign snapshot attribute');
    }
    const id = attr(node, 'data-pl-node'); if (id) check(attr(node, 'id') === `pl_${id}`, 'Unsafe snapshot anchor');
  }
  const ids = elements(root).map(node => attr(node, 'data-pl-node')).filter((id): id is string => id !== undefined);
  check(ids.length === snapshot.nodeIds.length && ids.every((id, i) => id === snapshot.nodeIds[i]) && new Set(ids).size === ids.length, 'Final snapshot node mapping mismatch');
  return root;
}
export { serialize, serializeOuter };
