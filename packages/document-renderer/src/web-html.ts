import { webReaderChunkSchema, type WebReaderChunk, type WebReaderChunkBlock } from '@pagelingo/document-contracts';
import type { InlineContent, TranslationBlock } from '@pagelingo/translation-core';
import { escapeHtml as esc, renderMath, htmlBytes, elementCount, maxRenderedBytes, maxRenderedElements } from './math.js';
import { emphasisTags, naturalText, safeAssetUrl, renderSafeMath } from './semantic-html.js';
import type { TrustedReaderHtml } from './html.js';
export interface WebRenderOptions { mode: 'source' | 'translation' | 'bilingual'; resolveAsset: (id: string) => string }
const labels = { 'language-not-required': '保留原文', 'manual-choice': '未选择翻译', pending: '待翻译，保留原文', failed: '翻译失败，保留原文', cancelled: '已取消，保留原文' };
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
export function renderWebChunk(input: WebReaderChunk, options: WebRenderOptions): TrustedReaderHtml {
  const chunk = webReaderChunkSchema.parse(input);
  const nodes = new Map(chunk.nodes.map(n => [n.id, n])), blocks = new Map(chunk.blocks.map(b => [b.source.id, b]));
  check(nodes.size === chunk.nodes.length && blocks.size === chunk.blocks.length, 'Duplicate chunk identity');
  const assets = new Set(chunk.assets.map(a => a.id)); check(assets.size === chunk.assets.length, 'Duplicate asset');
  const warnings: string[] = [];
  let bytes = 0, elements = 0;
  // Formulas in the current block; the finished block's HTML, which contains them, is what gets counted.
  let blockBytes = 0, blockElements = 0;
  const math = (latex: string, display: boolean): string => {
    const html = renderMath(latex, display, warnings, { bytes: Math.max(0, maxRenderedBytes - bytes - blockBytes - 512 * 1024), elements: Math.max(0, maxRenderedElements - elements - blockElements - 4096) });
    blockBytes += htmlBytes(html); blockElements += elementCount(html); return html;
  };
  const asset = (id: string, alt: string): string => {
    check(assets.has(id), 'Missing chunk asset'); const url = options.resolveAsset(id); check(safeAssetUrl(url), 'Unsafe asset URL');
    return `<img src="${esc(url)}" alt="${esc(alt)}" loading="lazy">`;
  };
  const headingLevels = new Map<string, number>();
  const markHeadings = (id: string, level: number, seen: Set<string>): void => {
    check(!seen.has(id) && level <= 64, 'Chunk tree depth/cycle'); seen.add(id);
    const node = nodes.get(id); check(node, 'Missing chunk node');
    let next = level;
    if (node.kind === 'section' && node.headingBlockId) { headingLevels.set(node.headingBlockId, Math.min(6, level)); next++; }
    for (const child of node.children) markHeadings(child, next, seen);
  };
  const marked = new Set<string>(); for (const id of chunk.roots) markHeadings(id, 1, marked);
  check(marked.size === nodes.size, 'Unreachable chunk node');
  function text(entry: WebReaderChunkBlock, value: TranslationBlock, instance: string): string {
    const source = entry.source; check(source.type === 'text', 'Expected text block');
    check(value.id === source.id && value.kind === source.value.kind, 'Translation block identity mismatch');
    const bindings = new Map(source.bindings.map(b => [b.id, b]));
    const originals = new Map<string, Exclude<InlineContent, { type: 'text' }>>();
    const collect = (items: InlineContent[]): void => { for (const inline of items) if (inline.type !== 'text') { check(!originals.has(inline.id), 'Duplicate source inline'); originals.set(inline.id, inline); if (inline.type === 'format') collect(inline.children); } };
    collect(source.value.content); check(bindings.size === source.bindings.length && bindings.size === originals.size, 'Invalid source binding closure');
    const used = new Set<string>();
    const inlines = (items: InlineContent[], depth = 1): string => {
      check(depth <= 32, 'Inline depth limit');
      return items.map(inline => {
        if (inline.type === 'text') return esc(inline.text);
        const original = originals.get(inline.id), binding = bindings.get(inline.id);
        check(original && binding && !used.has(inline.id) && original.type === inline.type && original.kind === inline.kind, 'Missing or changed source inline binding'); used.add(inline.id);
        if (inline.type === 'protected') {
          check(original.type === 'protected' && original.source === inline.source && binding.kind === 'protected', 'Changed protected object');
          const safeIndex = source.safeMath.findIndex(m => m.bindingId === inline.id);
          if (safeIndex >= 0) return renderSafeMath(source.safeMath[safeIndex].ast, `${instance}-math-${safeIndex}`);
          const obj = binding.object;
          if (obj.type === 'asset') return asset(obj.assetId, obj.alt);
          if (obj.type === 'math') return math(obj.latex, false);
          return obj.type === 'code' ? `<code>${esc(obj.text)}</code>` : esc(obj.text);
        }
        const inner = inlines(inline.children, depth + 1);
        if (inline.kind === 'link') {
          if (binding.kind === 'block-link') return `<a href="#${esc(binding.blockId)}" data-block-link="${esc(binding.blockId)}">${inner}</a>`;
          check(binding.kind === 'link', 'Link binding mismatch'); const url = new URL(binding.href);
          check(['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password, 'Unsafe Web link');
          return `<a href="${esc(binding.href)}" rel="noopener noreferrer">${inner}</a>`;
        }
        check(binding.kind === 'style', 'Style binding mismatch');
        const tag = binding.emphasis ? emphasisTags[binding.emphasis] : 'span';
        // Reader colors come from the site theme, never source foreground/background.
        return `<${tag}${binding.monospace ? ' style="font-family:monospace"' : ''}>${inner}</${tag}>`;
      }).join('');
    };
    const tag = value.kind === 'heading' ? `h${source.headingLevel ?? headingLevels.get(source.id) ?? 2}` : value.kind === 'quote' ? 'blockquote' : 'p';
    let inner = inlines(value.content); check(used.size === originals.size, 'Missing translated protected/format object');
    if (htmlBytes(inner) > maxRenderedBytes - bytes - blockBytes - 65536 || elementCount(inner) > maxRenderedElements - elements - blockElements - 128) {
      warnings.push('文本格式超出显示预算，已保留可读文本。'); inner = esc(naturalText(value.content));
    }
    return `<${tag}>${inner}</${tag}>`;
  }
  const context = new Set(chunk.contextBlockIds);
  check(context.size === chunk.contextBlockIds.length && [...context].every(id => blocks.has(id)), 'Invalid chunk context IDs');
  const renderBlock = (entry: WebReaderChunkBlock): string => {
    const b = entry.source;
    const contextCopy = context.has(b.id);
    const instanceId = contextCopy ? `${chunk.id}-context-${b.id}` : b.id; let html: string;
    if (b.type === 'text') {
      const source = () => text(entry, b.value, `${instanceId}-source`);
      const translated = () => text(entry, entry.translation!, `${instanceId}-translation`);
      // Numbers, formulas and text already in Chinese were never meant to change, so saying so is only noise.
      const reason = entry.sourceOnlyReason && entry.sourceOnlyReason !== 'language-not-required' ? `<span class="source-only">${labels[entry.sourceOnlyReason]}</span>` : '';
      if (options.mode === 'source') html = source();
      else if (options.mode === 'translation') html = entry.translation ? translated() : reason + source();
      else html = entry.translation ? `<div class="reader-source">${source()}</div><div class="reader-translation">${translated()}</div>` : reason + source();
    } else if (b.type === 'code') html = `<pre style="overflow-x:auto"><code>${esc(b.code)}</code></pre>`;
    else if (b.type === 'rule') html = '<hr>';
    else if (b.type === 'image') html = `<figure data-image-role="${b.role}">${asset(b.assetId, b.alt)}</figure>`;
    else html = b.ast ? renderSafeMath(b.ast, `${instanceId}-formula`) : math(b.latex!, b.displayMode);
    const result = `<div class="${contextCopy ? 'reader-context' : 'reader-block'}" id="${instanceId}"${contextCopy ? '' : ` data-block-id="${b.id}" data-source-node="${esc(b.sourceRefs[0].nodeId)}"`}>${html}</div>`;
    bytes += htmlBytes(result); elements += elementCount(result); blockBytes = 0; blockElements = 0; return result;
  };
  const visited = new Set<string>(), rendered: string[] = [];
  const cellId = (id: string): string => `${chunk.id}-${id}`;
  function visit(id: string, depth: number, parentKind?: string): string {
    check(depth <= 64 && !visited.has(id), 'Chunk depth/cycle'); visited.add(id);
    const n = nodes.get(id)!;
    if (n.kind === 'block') { const entry = blocks.get(n.blockId); check(entry && !n.children.length, 'Invalid block node'); rendered.push(n.blockId); const html = renderBlock(entry); return parentKind === 'table' && entry.source.type === 'text' && entry.source.value.kind === 'caption' ? `<caption>${html}</caption>` : html; }
    let tag: string = 'div', extra = '';
    if (n.kind === 'table') tag = 'table';
    else if (n.kind === 'group' && parentKind === 'table') tag = 'tbody';
    else if (n.kind === 'table-row') { tag = 'tr'; check(n.children.every(id => nodes.get(id)?.kind === 'table-cell'), 'Invalid table row'); }
    else if (n.kind === 'table-cell') {
      tag = n.header ? 'th' : 'td';
      extra = `${n.children.length ? '' : ' aria-hidden="true"'} id="${cellId(n.id)}" rowspan="${n.rowSpan}" colspan="${n.colSpan}"${n.scope ? ` scope="${n.scope}"` : ''}`;
      const headers = n.headerNodeIds.filter(id => { const h = nodes.get(id); return h?.kind === 'table-cell' && h.header; });
      if (headers.length) extra += ` headers="${headers.map(cellId).join(' ')}"`;
    } else if (n.kind === 'list') { tag = n.ordered ? 'ol' : 'ul'; if (n.ordered) extra = ` start="${n.start ?? 1}"`; }
    else if (n.kind === 'list-item') tag = 'li';
    else if (n.kind === 'section') tag = 'section';
    else if (n.kind === 'callout') { tag = 'aside'; extra = ` data-callout="${n.semantic}" role="note"`; }
    if (n.presentation?.align) extra += ` style="text-align:${n.presentation.align}"`;
    const html = `<${tag}${extra}>${n.children.map(child => visit(child, depth + 1, n.kind)).join('')}</${tag}>`;
    return n.kind === 'table' ? `<div class="reader-table" style="overflow-x:auto" tabindex="0">${html}</div>` : html;
  }
  const body = chunk.roots.map(root => visit(root, 1)).join('');
  check(visited.size === nodes.size && rendered.length === chunk.blocks.length && rendered.every((id, i) => id === chunk.blocks[i].source.id), 'Invalid chunk reading order');
  const html = body + warnings.map(w => `<p class="reader-warning">${esc(w)}</p>`).join('');
  check(htmlBytes(html) <= maxRenderedBytes && elementCount(html) <= maxRenderedElements, 'Rendered chunk budget exceeded');
  return html as TrustedReaderHtml;
}
