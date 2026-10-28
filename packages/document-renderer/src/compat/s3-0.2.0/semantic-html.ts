import type { InlineContent } from '@pagelingo/translation-core';
import type { SafeMathAst } from '@pagelingo/document-contracts';
import { escapeHtml as esc } from './math.js';
export const emphasisTags = { strong: 'strong', emphasis: 'em', subscript: 'sub', superscript: 'sup', deletion: 'del', small: 'small', mark: 'mark', underline: 'u' } as const;
export const naturalText = (content: InlineContent[]): string => content.map(inline => inline.type === 'text' ? inline.text : inline.type === 'protected' ? inline.source : naturalText(inline.children)).join('');
export function safeAssetUrl(url: string): boolean {
  return !!url && !/[\x00-\x20\\]/.test(url) && !url.startsWith('//') && (!/^[a-z][a-z0-9+.-]*:/i.test(url) || /^(?:https?:|blob:)/i.test(url));
}
/** AST has already passed the contracts' namespace, local-reference and complexity checks. */
export function renderSafeMath(ast: SafeMathAst, instance: string): string {
  const nodes = new Map(ast.nodes.map(n => [n.id, n]));
  const ids = new Map(ast.nodes.flatMap(n => n.attributes.id ? [[n.attributes.id, `${instance}-${n.attributes.id}`] as const] : []));
  const visit = (id: string): string => {
    const n = nodes.get(id)!;
    const attrs = Object.entries(n.attributes).map(([key, value]) => {
      if (value === undefined) return '';
      const output = key === 'id' ? ids.get(value)! : key === 'href' || key === 'xlink:href' ? `#${ids.get(value.slice(1))!}` : value;
      return ` ${key}="${esc(output)}"`;
    }).join('');
    return `<${n.tag}${attrs}>${esc(n.text ?? '')}${n.children.map(visit).join('')}</${n.tag}>`;
  };
  return ast.roots.map(visit).join('');
}
