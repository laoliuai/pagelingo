import { safeMathAstSchema, safeMathNodeSchema, type CaptureLimits, type SafeMathAst, type SafeMathNode } from '@pagelingo/document-contracts';
import { attr, byteLength, check, elements, isElement, isText, setAttr, type Element } from './tree.js';

/** Strict shared contracts are the attribute authority; never guess TeX. */
export function sanitizeMath(root: Element, prefix: string, limits: CaptureLimits, warn: (message: string) => void): SafeMathAst | null {
  const all = [root, ...elements(root)];
  if (all.length > limits.maxMathNodes) { warn('Math fragment exceeds node budget'); return null; }
  const definitions = new Map<string, string>();
  for (const node of all) {
    const id = attr(node, 'id');
    if (id && !definitions.has(id)) definitions.set(id, `${prefix}_d${definitions.size + 1}`);
    else if (id) { warn('Math fragment has ambiguous duplicate definitions'); return null; }
  }
  const nodes: SafeMathNode[] = [];
  const ids = new Map(all.map((node, index) => [node, `m_${index + 1}`]));
  for (const node of all) {
    const tag = safeMathNodeSchema.shape.tag.safeParse(node.tagName);
    if (!tag.success) { warn(`Unsupported math element: ${node.tagName}`); return null; }
    const attributes: Record<string, string> = Object.create(null);
    for (const item of node.attrs) {
      const name = item.prefix ? `${item.prefix}:${item.name}` : item.name;
      let value = item.value;
      if (name === 'id') value = definitions.get(value)!;
      if (name === 'href' || name === 'xlink:href') {
        const target = value.startsWith('#') && definitions.get(value.slice(1));
        if (!target) { warn('Removed external or unresolved math reference'); continue; }
        value = `#${target}`;
      }
      if (safeMathNodeSchema.shape.attributes.safeParse({ [name]: value }).success) attributes[name] = value;
      else warn(`Removed unsupported math attribute: ${name}`);
    }
    node.attrs = [];
    for (const [key, value] of Object.entries(attributes)) setAttr(node, key, value);
    const text = node.childNodes.filter(isText).map(child => child.value).join('');
    nodes.push({ id: ids.get(node)!, tag: tag.data, attributes, children: node.childNodes.filter(isElement).map(child => ids.get(child)!), ...(text ? { text } : {}) });
  }
  const candidate = { kind: root.tagName === 'svg' ? 'svg' as const : 'mathml' as const, roots: [ids.get(root)!], nodes };
  if (byteLength(JSON.stringify(candidate)) > limits.maxMathBytes) { warn('Math fragment exceeds byte budget'); return null; }
  const parsed = safeMathAstSchema.safeParse(candidate);
  if (!parsed.success) { warn('Unsupported or invalid math structure'); return null; }
  try { checkMathExpansion(parsed.data, limits); } catch { warn('Math expansion exceeds structure budget'); return null; }
  return parsed.data;
}

export function mathAst(root: Element, limits: CaptureLimits): SafeMathAst | null {
  // Work on a private pure-data clone. Existing final fragment IDs are preserved.
  const all = [root, ...elements(root)];
  if (all.length > limits.maxMathNodes) return null;
  const ids = new Map(all.map((node, index) => [node, `m_${index + 1}`]));
  const nodes = all.map(node => ({ id: ids.get(node)!, tag: node.tagName,
    attributes: Object.fromEntries(node.attrs.filter(a => !['data-pl-node', 'data-pl-block'].includes(a.name)).map(a => [a.prefix ? `${a.prefix}:${a.name}` : a.name, a.value])),
    children: node.childNodes.filter(isElement).map(child => ids.get(child)!),
    text: node.childNodes.filter(isText).map(child => child.value).join(''),
  }));
  const result = safeMathAstSchema.safeParse({ kind: root.tagName === 'svg' ? 'svg' : 'mathml', roots: [ids.get(root)!], nodes });
  if (!result.success || all.length > limits.maxMathNodes || byteLength(JSON.stringify(result.data)) > limits.maxMathBytes) return null;
  checkMathExpansion(result.data, limits); return result.data;
}
function checkMathExpansion(ast: SafeMathAst, limits: CaptureLimits): void {
  const nodes = new Map(ast.nodes.map(node => [node.id, node]));
  const definitions = new Map(ast.nodes.filter(node => node.attributes.id).map(node => [node.attributes.id!, node.id]));
  const stack = ast.roots.map(id => ({ id, depth: 1 })); let work = 0;
  while (stack.length) {
    const { id, depth } = stack.pop()!; check(++work <= limits.maxMathNodes && depth <= limits.maxDepth, 'Math expansion budget exceeded');
    const node = nodes.get(id)!;
    for (const child of node.children) stack.push({ id: child, depth: depth + 1 });
    const href = node.attributes.href ?? node.attributes['xlink:href'];
    if (href) stack.push({ id: definitions.get(href.slice(1))!, depth: depth + 1 });
  }
}
