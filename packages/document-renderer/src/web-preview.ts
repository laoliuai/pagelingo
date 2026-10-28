import { defaultTreeAdapter, parseFragment, type DefaultTreeAdapterTypes as T } from 'parse5';
import { defaultCaptureLimits, safeMathAstSchema, type WebCaptureManifest, type SafeMathAst } from '@pagelingo/document-contracts';
import { escapeHtml as esc } from './math.js';
import { renderSafeMath } from './semantic-html.js';

const tags = new Set('article section main div p span h1 h2 h3 h4 h5 h6 blockquote aside header footer nav ul ol li dl dt dd table caption colgroup col thead tbody tfoot tr th td figure figcaption pre code strong b em i a sub sup del s small mark u br hr img abbr time'.split(' '));
const forbidden = new Set('script style iframe frame frameset object embed form input textarea select option button meta base link template noscript canvas audio video source track'.split(' '));
const empty = new Set(['br', 'hr', 'img', 'col']);
const check = (ok: unknown, message: string): void => { if (!ok) throw Error(message); };
/** Inert parse5 parsing, strict tag/attribute allowlist, and no source CSS or navigation. */
export function renderOfflinePreview(html: string, preview: WebCaptureManifest['snapshots']['previews'][number], capture: WebCaptureManifest, images: ReadonlyMap<string, { url: string; bytes: number }>): string {
  let allocated = 0;
  const allocate = () => check(++allocated <= defaultCaptureLimits.maxDomNodes, 'Preview DOM node budget exceeded');
  const depth = (parent: T.ParentNode) => {
    let current: T.Node | null = parent, count = 0;
    while (current) { check(++count <= defaultCaptureLimits.maxDepth + 2, 'Preview DOM depth budget exceeded'); current = 'parentNode' in current ? current.parentNode : null; }
  };
  const root = parseFragment(html, { treeAdapter: {
    ...defaultTreeAdapter,
    createElement(...args: Parameters<typeof defaultTreeAdapter.createElement>) { allocate(); return defaultTreeAdapter.createElement(...args); },
    createCommentNode(...args: Parameters<typeof defaultTreeAdapter.createCommentNode>) { allocate(); return defaultTreeAdapter.createCommentNode(...args); },
    insertText(...args: Parameters<typeof defaultTreeAdapter.insertText>) { allocate(); defaultTreeAdapter.insertText(...args); },
    insertTextBefore(...args: Parameters<typeof defaultTreeAdapter.insertTextBefore>) { allocate(); defaultTreeAdapter.insertTextBefore(...args); },
    appendChild(...args: Parameters<typeof defaultTreeAdapter.appendChild>) { depth(args[0]); defaultTreeAdapter.appendChild(...args); },
    insertBefore(...args: Parameters<typeof defaultTreeAdapter.insertBefore>) { depth(args[0]); defaultTreeAdapter.insertBefore(...args); },
  } });
  const resources = new Map(capture.resources.map(resource => [resource.id, resource]));
  const allowedImages = new Set(preview.resourceFileIds), allowedNodes = new Set(preview.nodeIds), seenNodes = new Set<string>();
  let count = 0, embeddedBytes = 0, embeddedCharacters = 0;
  const render = (node: T.Node, level: number): string => {
    check(++count <= defaultCaptureLimits.maxDomNodes && level <= defaultCaptureLimits.maxDepth, 'Preview structure budget exceeded');
    if ('value' in node) return esc(node.value);
    if (!('tagName' in node)) return '';
    const tag = node.tagName;
    if (forbidden.has(tag)) return '';
    const inner = () => node.childNodes.map(child => render(child, level + 1)).join('');
    const attr = (key: string) => node.attrs.find(a => a.name === key && !a.prefix)?.value;
    const nodeId = attr('data-pl-node'); let attributes = '';
    if (nodeId && allowedNodes.has(nodeId)) {
      check(!seenNodes.has(nodeId), 'Duplicate preview source node'); seenNodes.add(nodeId);
      attributes += ` id="pl_${esc(nodeId)}" data-pl-node="${esc(nodeId)}"`;
    }
    if (tag === 'math' || tag === 'svg') {
      const nodes: SafeMathAst['nodes'] = [];
      const collect = (element: T.Element): string => {
        check(nodes.length < defaultCaptureLimits.maxMathNodes, 'Preview formula node budget exceeded');
        const id = `m_${nodes.length}`;
        const entry = { id, tag: element.tagName, attributes: Object.fromEntries(element.attrs.filter(a => !a.name.startsWith('data-') && !(element === node && a.name === 'id' && a.value === `pl_${nodeId}`)).map(a => [a.prefix ? `${a.prefix}:${a.name}` : a.name, a.value])), children: [] as string[], text: element.childNodes.filter((n): n is T.TextNode => 'value' in n).map(n => n.value).join('') };
        nodes.push(entry as SafeMathAst['nodes'][number]);
        entry.children = element.childNodes.filter((n): n is T.Element => 'tagName' in n).map(collect);
        return id;
      };
      const rootId = collect(node), ast = safeMathAstSchema.safeParse({ kind: tag === 'svg' ? 'svg' : 'mathml', roots: [rootId], nodes });
      return `<span${attributes}>${ast.success ? renderSafeMath(ast.data, `preview-math-${count}`) : '［公式快照无法安全显示，请返回原文阅读］'}</span>`;
    }
    if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !tags.has(tag)) return `<span${attributes}>${inner()}</span>`;
    for (const key of ['title', 'alt', 'lang', 'dir', 'colspan', 'rowspan', 'scope', 'start']) {
      const value = attr(key); if (value === undefined) continue;
      if (['colspan', 'rowspan', 'start'].includes(key) && !/^[1-9][0-9]{0,3}$/.test(value)) continue;
      attributes += ` ${key}="${esc(value)}"`;
    }
    if (tag === 'img') {
      const resource = resources.get(attr('data-pl-resource') ?? '');
      const image = resource?.status === 'available' && allowedImages.has(resource.fileId) ? images.get(resource.fileId) : undefined;
      if (!image) return `<span${attributes}>［归档图片预览字节不可用］</span>`;
      // Count repeated embedded images too: duplicates cannot amplify a small manifest into an unbounded HTML file.
      if (embeddedBytes + image.bytes > defaultCaptureLimits.maxPreviewResourceBytes) return `<span${attributes}>［图片预览资源超出预算］</span>`;
      embeddedBytes += image.bytes; embeddedCharacters += image.url.length;
      attributes += ` src="${image.url}" loading="lazy"`;
      return `<img${attributes}><span class="image-note">图片无法显示时表示归档图片缺失或无法解码。</span>`;
    }
    return `<${tag}${attributes}>${empty.has(tag) ? '' : inner() + `</${tag}>`}`;
  };
  const body = root.childNodes.map(node => render(node, 1)).join('');
  check([...allowedNodes].every(id => seenNodes.has(id)), 'Preview missing fixed source node');
  check(new TextEncoder().encode(body).length - embeddedCharacters <= defaultCaptureLimits.maxPreviewHtmlBytes, 'Sanitized preview exceeds HTML budget');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>body{font:16px/1.8 system-ui;margin:20px;overflow-wrap:anywhere;color:#343a38;background:#f3f0e9}img{max-width:100%;height:auto}pre,table{display:block;max-width:100%;overflow:auto}.image-note{display:block;font-size:12px}:target{outline:2px solid #35796c}@media(prefers-color-scheme:dark){body{color:#dfdfd5;background:#222522}}</style></head><body>${body}</body></html>`;
}
