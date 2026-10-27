import { detectWebLanguage, naturalText, webCaptureManifestSchema, sanitizedSnapshotSchema, webReaderAssetSchema, type CaptureLimits, type ReaderBinding, type SanitizedSnapshot, type WebCaptureManifest, type WebReaderAsset, type WebReaderBlock, type WebReaderIR } from '@pagelingo/document-contracts';
import { encodeBlock, type BlockKind, type FormatKind, type InlineContent } from '@pagelingo/translation-core';
import { canonicalJson, sha256 } from './fingerprint.js';
import { mathAst } from './safe-math.js';
import { semanticProjection, type SemanticUnit } from './semantic.js';
import { attr, byteLength, check, elements, isElement, isText, limitsFor, textOf, utf8, type Node } from './tree.js';
import { validateWebGraph } from './graph.js';
export interface ProjectWebReaderOptions { manifestBytes: Uint8Array; assets: readonly WebReaderAsset[]; limits?: CaptureLimits }
export const PROJECTOR_VERSION = 'web-projector/1';
const formats = new Map<string, Exclude<FormatKind, 'style'>>([['strong', 'strong'], ['b', 'strong'], ['em', 'emphasis'], ['i', 'emphasis'], ['a', 'link'], ['sub', 'subscript'], ['sup', 'superscript'], ['del', 'deletion'], ['s', 'deletion'], ['small', 'small'], ['mark', 'mark'], ['u', 'underline']]);
export async function projectWebReader(snapshot: SanitizedSnapshot, input: WebCaptureManifest, options: ProjectWebReaderOptions): Promise<WebReaderIR> {
  const limits = limitsFor(options.limits); check(options.manifestBytes.length <= limits.maxIrBytes, 'Manifest byte budget exceeded');
  const manifestBytes = new Uint8Array(options.manifestBytes);
  snapshot = sanitizedSnapshotSchema.parse(snapshot);
  const inspectedAssets = options.assets.map(asset => webReaderAssetSchema.parse(asset));
  const manifest = webCaptureManifestSchema.parse(input);
  const supplied = webCaptureManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)));
  check(canonicalJson(manifest) === canonicalJson(supplied), 'Manifest bytes disagree with supplied manifest');
  const html = manifest.files.find(file => file.id === manifest.htmlFileId)!;
  const snapshotSha256 = await sha256(utf8(snapshot.html));
  check(html.sha256 === snapshotSha256 && html.bytes === byteLength(snapshot.html), 'Snapshot digest or byte mismatch');
  check(manifest.source.url === snapshot.sourceUrl && canonicalJson(manifest.scope) === canonicalJson(snapshot.scope), 'Manifest source or scope mismatch');
  const resourceMap = new Map(manifest.resources.map(resource => [resource.id, resource]));
  for (const resource of snapshot.resources) check(resourceMap.get(resource.id)?.url === resource.url, 'Snapshot resource manifest mismatch');
  const assets = new Map(inspectedAssets.map(asset => [asset.id, asset])); check(assets.size === inspectedAssets.length, 'Duplicate asset ID');
  for (const asset of assets.values()) {
    const file = manifest.files.find(file => file.id === asset.id);
    check(file?.role === 'image' && file.bytes === asset.bytes && file.sha256 === asset.sha256 && file.path === asset.path && file.mediaType === asset.mediaType, 'Asset metadata does not match manifest');
  }
  const usedAssets = new Set<string>(); const warnings = new Set(snapshot.warnings);
  const semantic = semanticProjection(snapshot, limits);
  const blocks: WebReaderBlock[] = [];
  for (const [index, unit] of semantic.units.entries()) {
    const quote = unit.content.map(textOf).join('');
    const sourceRefs = [{ nodeId: unit.nodeId, quote, prefix: semantic.units[index - 1]?.content.map(textOf).join('').slice(-80) ?? '', suffix: semantic.units[index + 1]?.content.map(textOf).join('').slice(0, 80) ?? '' }];
    const base = { id: unit.id, sourceRefs };
    const display = unit.content.every(isText) ? quote.trim().match(/^(?:\$\$([\s\S]+)\$\$|\\\[([\s\S]+)\\\])$/) : null;
    if (display && !(display[1] ?? '').includes('$$') && !(display[2] ?? '').includes('\\]')) { const latex = display[1] ?? display[2]; check(byteLength(latex) <= limits.maxMathBytes, 'Math source byte budget exceeded'); blocks.push({ ...base, type: 'math', latex, ast: null, displayMode: true }); continue; }
    if (unit.element.tagName === 'pre') { blocks.push({ ...base, type: 'code', code: textOf(unit.element) }); continue; }
    if (unit.element.tagName === 'hr') { blocks.push({ ...base, type: 'rule' }); continue; }
    const bindings: ReaderBinding[] = []; const safeMath: Extract<WebReaderBlock, { type: 'text' }>['safeMath'] = [];
    let inlineIndex = 0;
    const inline = (node: Node): InlineContent[] => {
      if (isText(node)) {
        const content: InlineContent[] = []; let cursor = 0;
        const math = /\$\$([\s\S]+?)\$\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g;
        for (const match of node.value.matchAll(math)) {
          if (match.index > cursor) content.push({ type: 'text', text: node.value.slice(cursor, match.index) });
          const latex = match[1] ?? match[2] ?? match[3]; check(byteLength(latex) <= limits.maxMathBytes, 'Math source byte budget exceeded');
          const id = `i_${++inlineIndex}`; bindings.push({ id, kind: 'protected', object: { type: 'math', latex } });
          content.push({ type: 'protected', id, kind: 'math', source: latex }); cursor = match.index + match[0].length;
        }
        if (cursor < node.value.length) content.push({ type: 'text', text: node.value.slice(cursor) });
        return content;
      }
      if (!isElement(node)) return [];
      const id = `i_${++inlineIndex}`;
      if (node.tagName === 'br') return [{ type: 'text', text: '\n' }];
      if (node.tagName === 'code') { const text = textOf(node); bindings.push({ id, kind: 'protected', object: { type: 'code', text } }); return [{ type: 'protected', id, kind: 'code', source: text }]; }
      if (node.tagName === 'svg' || node.tagName === 'math') {
        const annotation = elements(node).find(child => child.tagName === 'annotation' && attr(child, 'encoding') === 'application/x-tex');
        if (annotation) { const latex = textOf(annotation); check(byteLength(latex) <= limits.maxMathBytes, 'Math source byte budget exceeded'); bindings.push({ id, kind: 'protected', object: { type: 'math', latex } }); return [{ type: 'protected', id, kind: 'math', source: latex }]; }
        const ast = mathAst(node, limits);
        const source = textOf(node) || '[Formula]';
        bindings.push({ id, kind: 'protected', object: { type: 'literal', text: source } });
        if (ast) safeMath.push({ bindingId: id, ast }); else warnings.add(`Unsupported formula at ${unit.nodeId}; consult archived snapshot`);
        return [{ type: 'protected', id, kind: 'literal', source }];
      }
      if (node.tagName === 'img') {
        const resource = resourceMap.get(attr(node, 'data-pl-resource') ?? ''); const assetId = resource?.status === 'available' ? resource.fileId : null;
        const alt = attr(node, 'alt') || '[Image]';
        if (assetId && assets.has(assetId)) { usedAssets.add(assetId); bindings.push({ id, kind: 'protected', object: { type: 'asset', assetId, alt } }); }
        else { warnings.add(`Image missing at ${unit.nodeId}: ${resource?.status === 'missing' ? resource.reason : 'unvalidated resource'}`); bindings.push({ id, kind: 'protected', object: { type: 'literal', text: alt } }); }
        return [{ type: 'protected', id, kind: 'literal', source: alt }];
      }
      const children = node.childNodes.flatMap(inline); const format = formats.get(node.tagName);
      if (format === 'link') {
        const href = attr(node, 'href'); if (!href) return children;
        bindings.push({ id, kind: 'link', href });
      } else if (format) bindings.push({ id, kind: 'style', emphasis: format });
      else return children;
      return [{ type: 'format', id, kind: format, children }];
    };
    const content = unit.content.flatMap(inline);
    const value = { id: unit.id, kind: kindFor(unit), content };
    // Exercise the public SDK's source/slot validation. Adapters never duplicate
    // marker escaping or protection algorithms.
    encodeBlock(value);
    blocks.push({ ...base, type: 'text', value, bindings, safeMath, language: detectWebLanguage(naturalText(content), attr(unit.element, 'lang') ?? null) });
  }
  const manifestSha256 = await sha256(manifestBytes); const configSha256 = await sha256(utf8(canonicalJson(limits)));
  const partial = !snapshot.scope.completeWithinScope || warnings.size > 0;
  const ir: WebReaderIR = { schemaVersion: 'web-reader-ir/1', metadata: { title: manifest.metadata.title, language: detectWebLanguage(blocks.flatMap(block => block.type === 'text' ? [naturalText(block.value.content)] : []).join('\n')) },
    source: { kind: 'web', manifestSha256, snapshotSha256, bytes: manifestBytes.length },
    parse: { id: `p_${await sha256(utf8(`${manifestSha256}\n${PROJECTOR_VERSION}\n${configSha256}`))}`, inputManifestSha256: manifestSha256, projectorVersion: PROJECTOR_VERSION, configSha256, coverage: partial ? 'partial' : 'full', status: partial ? 'partial' : 'complete' },
    roots: semantic.roots, nodes: semantic.nodes, blocks, assets: [...assets.values()].filter(asset => usedAssets.has(asset.id)), warnings: [...warnings],
  };
  for (const block of blocks) check(byteLength(JSON.stringify(block)) <= limits.maxOversizedBlockBytes, 'Web block byte budget exceeded');
  check(byteLength(JSON.stringify(ir)) <= limits.maxIrBytes, 'IR byte budget exceeded'); validateWebGraph(ir); return ir;
}
function kindFor(unit: SemanticUnit): BlockKind {
  const tag = attr(unit.element, 'data-pl-run') === '1' && unit.element.parentNode && isElement(unit.element.parentNode)
    ? unit.element.parentNode.tagName : unit.element.tagName;
  return /^h[1-6]$/.test(tag) ? 'heading' : ['td', 'th'].includes(tag) ? 'table-cell' : ['caption', 'figcaption'].includes(tag) ? 'caption' : tag === 'li' ? 'list-item' : tag === 'blockquote' ? 'quote' : 'paragraph';
}
