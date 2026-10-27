import { readerChunkSchema, type ReaderChunk, type ReaderChunkBlock, type ReaderBinding } from '@pagelingo/document-contracts';
import type { InlineContent } from '@pagelingo/translation-core';
import { escapeHtml as esc, renderMath, htmlBytes, elementCount, maxRenderedBytes, maxRenderedElements } from './math.js';
import { bindingStyle, nodeStyle } from './styles.js';
declare const trustedReaderHtml: unique symbol;
export type TrustedReaderHtml = string & { readonly [trustedReaderHtml]: true };
export interface RenderedChunk { html: TrustedReaderHtml; blockIds: string[]; warnings: string[] }
export interface RenderOptions { mode: 'source' | 'translation'; resolveAsset: (id: string) => string }
const emphasisTags = { strong: 'strong', emphasis: 'em', subscript: 'sub', superscript: 'sup', deletion: 'del', small: 'small', mark: 'mark', underline: 'u' } as const;

export function renderChunk(input: ReaderChunk, options: RenderOptions): RenderedChunk {
  const chunk = readerChunkSchema.parse(input);
  const nodes = new Map(chunk.nodes.map(node => [node.id, node]));
  const blocks = new Map(chunk.blocks.map(block => [block.source.id, block]));
  if (nodes.size !== chunk.nodes.length || blocks.size !== chunk.blocks.length || chunk.blockIds.length !== blocks.size || chunk.blockIds.some((id, i) => id !== chunk.blocks[i].source.id)) throw new Error('Invalid chunk closure');
  const assets = new Set(chunk.assets.map(asset => asset.id));
  const warnings: string[] = [];
  let usedBytes = 0; let usedElements = 0;
  let formulaBytes = 0; let formulaElements = 0;
  const asset = (id: string, alt: string): string => {
    if (!assets.has(id)) throw new Error('Missing chunk asset');
    const url = options.resolveAsset(id);
    if (!url || /[\x00-\x20\\]/.test(url) || url.startsWith('//') || (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^(?:https?:|blob:)/i.test(url))) throw new Error('Unsafe asset URL');
    return `<img src="${esc(url)}" alt="${esc(alt)}" loading="lazy">`;
  };
  const math = (latex: string, display: boolean): string => {
    // Reserve space for the bounded chunk tree; track formulas within a single block too.
    const html = renderMath(latex, display, warnings, { bytes: Math.max(0, maxRenderedBytes - usedBytes - formulaBytes - 512 * 1024), elements: Math.max(0, maxRenderedElements - usedElements - formulaElements - 4096) });
    formulaBytes += htmlBytes(html); formulaElements += elementCount(html);
    return html;
  };
  function inlines(content: InlineContent[], bindings: Map<string, ReaderBinding>, depth = 1): string {
    if (depth > 32) throw new Error('Inline depth limit');
    return content.map(inline => {
      if (inline.type === 'text') return esc(inline.text);
      const binding = bindings.get(inline.id);
      if (!binding) throw new Error('Missing source binding');
      if (inline.type === 'protected') {
        if (binding.kind !== 'protected') throw new Error('Protected binding mismatch');
        const object = binding.object;
        if (object.type === 'asset') return asset(object.assetId, object.alt);
        if (object.type === 'math') return math(object.latex, false);
        return object.type === 'code' ? `<code>${esc(object.text)}</code>` : esc(object.text);
      }
      const inner = inlines(inline.children, bindings, depth + 1);
      if (inline.kind === 'link') {
        if (binding.kind === 'block-link') return `<a href="#${esc(binding.blockId)}" data-block-link="${esc(binding.blockId)}">${inner}</a>`;
        if (binding.kind !== 'link') throw new Error('Link binding mismatch');
        const url = new URL(binding.href);
        if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) throw new Error('Unsafe link');
        return `<a href="${esc(binding.href)}" rel="noopener noreferrer">${inner}</a>`;
      }
      if (binding.kind !== 'style') throw new Error('Style binding mismatch');
      const tag = binding.emphasis ? emphasisTags[binding.emphasis] : 'span';
      return `<${tag}${bindingStyle(binding)}>${inner}</${tag}>`;
    }).join('');
  }
  const plain = (content: InlineContent[]): string => content.map(inline => inline.type === 'text' ? inline.text : inline.type === 'protected' ? inline.source : plain(inline.children)).join('');
  function blockHtml(entry: ReaderChunkBlock): string {
    const source = entry.source;
    formulaBytes = 0; formulaElements = 0;
    let html: string;
    if (source.type === 'code') html = `<pre><code>${esc(source.code)}</code></pre>`;
    else if (source.type === 'rule') html = '<hr>';
    else if (source.type === 'image') html = `<figure data-image-role="${source.role}">${asset(source.assetId, source.alt)}${source.role === 'original-region' ? '<figcaption>原件区域</figcaption>' : ''}</figure>`;
    else if (source.type === 'math') html = math(source.latex, source.displayMode);
    else {
      const value = options.mode === 'translation' && entry.translation ? entry.translation : source.value;
      const tag = value.kind === 'heading' ? 'h2' : value.kind === 'quote' ? 'blockquote' : value.kind === 'caption' ? 'figcaption' : 'p';
      html = `<${tag}>${inlines(value.content, new Map(source.bindings.map(b => [b.id, b])))}</${tag}>`;
      if (htmlBytes(html) + usedBytes + 65536 > maxRenderedBytes || elementCount(html) + usedElements + 128 > maxRenderedElements) {
        warnings.push('文本格式超出显示预算，已保留可读文本。');
        html = `<${tag}>${esc(plain(value.content))}</${tag}>`;
      }
    }
    const labels = { 'language-not-required': '保留原文', 'manual-choice': '未选择翻译', pending: '待翻译，保留原文', failed: '翻译失败，保留原文', cancelled: '已取消，保留原文' };
    const reason = options.mode === 'translation' && entry.sourceOnlyReason ? `<span class="source-only">${labels[entry.sourceOnlyReason]}</span>` : '';
    return `<div class="reader-block" id="${source.id}" data-block-id="${source.id}">${reason}${html}</div>`;
  }
  const visited = new Set<string>(); const renderedBlocks: string[] = [];
  function visit(id: string, depth: number): string {
    if (depth > 32 || visited.has(id)) throw new Error('Chunk tree depth/cycle');
    visited.add(id);
    const node = nodes.get(id); if (!node) throw new Error('Missing chunk node');
    if (node.kind === 'block') {
      const entry = blocks.get(node.blockId); if (!entry) throw new Error('Missing chunk block');
      renderedBlocks.push(node.blockId);
      const html = blockHtml(entry); usedBytes += htmlBytes(html); usedElements += elementCount(html); return html;
    }
    const tag = node.kind === 'list' ? node.ordered ? 'ol' : 'ul' : node.kind === 'list-item' ? 'li' : node.kind === 'section' ? 'section' : node.kind === 'callout' ? 'aside' : 'div';
    const extra = node.kind === 'list' && node.ordered ? ` start="${node.start ?? 1}"` : node.kind === 'callout' ? ` data-callout="${node.semantic}" role="note"` : '';
    const open = `<${tag}${extra}${nodeStyle(node)}>`; usedBytes += htmlBytes(open) + tag.length + 3; usedElements++;
    return open + node.children.map(child => visit(child, depth + 1)).join('') + `</${tag}>`;
  }
  const html = chunk.roots.map(root => visit(root, 1)).join('');
  if (visited.size !== nodes.size || renderedBlocks.length !== chunk.blockIds.length || renderedBlocks.some((id, index) => id !== chunk.blockIds[index])) throw new Error('Invalid chunk reading order');
  if (htmlBytes(html) > maxRenderedBytes || elementCount(html) > maxRenderedElements) throw new Error('Rendered chunk budget exceeded');
  return { html: html as TrustedReaderHtml, blockIds: [...chunk.blockIds], warnings };
}
