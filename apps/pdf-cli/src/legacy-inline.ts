import type { DefaultTreeAdapterMap } from 'parse5';
import type { InlineContent, FormatKind } from '@pagelingo/translation-core';
import type { ReaderBinding } from '@pagelingo/document-contracts';
export type HtmlNode = DefaultTreeAdapterMap['node'];
export type HtmlElement = DefaultTreeAdapterMap['element'];
export const element = (n: HtmlNode): n is HtmlElement => 'tagName' in n;
export const attr = (n: HtmlNode, name: string): string | undefined =>
  element(n) ? n.attrs.find((a) => a.name === name)?.value : undefined;
export const children = (n: HtmlNode): HtmlNode[] =>
  'childNodes' in n ? n.childNodes : [];
export const classes = (n: HtmlNode): string[] =>
  (attr(n, 'class') ?? '').split(/\s+/);
export const hasClass = (n: HtmlNode, name: string): boolean =>
  classes(n).includes(name);
export function textContent(n: HtmlNode): string {
  return 'value' in n ? n.value : children(n).map(textContent).join('');
}
export function findElements(
  n: HtmlNode,
  predicate: (n: HtmlElement) => boolean,
): HtmlElement[] {
  return [
    ...(element(n) && predicate(n) ? [n] : []),
    ...children(n).flatMap((c) => findElements(c, predicate)),
  ];
}
const formats: Record<string, FormatKind> = {
  strong: 'strong',
  b: 'strong',
  em: 'emphasis',
  i: 'emphasis',
  sub: 'subscript',
  sup: 'superscript',
  s: 'deletion',
  del: 'deletion',
  small: 'small',
  mark: 'mark',
  u: 'underline',
};
export function projectInline(
  nodes: HtmlNode[],
  warnings: string[],
): {
  content: InlineContent[];
  bindings: ReaderBinding[];
  links: { id: string; href: string }[];
} {
  const bindings: ReaderBinding[] = [];
  const links: { id: string; href: string }[] = [];
  let sequence = 0;
  const id = (): string => `i${++sequence}`;
  const protect = (
    kind: 'math' | 'code' | 'literal',
    source: string,
  ): InlineContent => {
    const key = id();
    bindings.push({
      kind: 'protected',
      id: key,
      object:
        kind === 'math'
          ? { type: 'math', latex: source }
          : { type: kind, text: source },
    });
    return { type: 'protected', id: key, kind, source };
  };
  const walk = (n: HtmlNode): InlineContent[] => {
    if ('value' in n)
      return [{ type: 'text', text: n.value.replace(/\s+/g, ' ') }];
    if (!element(n)) return [];
    if (['script', 'style', 'template'].includes(n.tagName)) {
      warnings.push(`ignored-active-element:${n.tagName}`);
      return [];
    }
    const latex = attr(n, 'data-docvortex-latex');
    if (latex !== undefined) return [protect('math', latex)];
    if (n.tagName === 'code') return [protect('code', textContent(n))];
    if (attr(n, 'translate') === 'no' || hasClass(n, 'pl-prompt-role'))
      return [protect('literal', textContent(n))];
    if (n.tagName === 'br') return [{ type: 'text', text: '\n' }];
    if (
      hasClass(n, 'pl-completion-slot') ||
      hasClass(n, 'pl-prompt-placeholder')
    )
      return [protect('literal', textContent(n) || '____')];
    if (n.tagName === 'img') {
      warnings.push('unsupported-inline-image:source-only');
      return [protect('literal', attr(n, 'alt') || '[image in source PDF]')];
    }
    if (['math', 'svg', 'iframe', 'object', 'canvas'].includes(n.tagName)) {
      warnings.push(`unsupported-visible-element:${n.tagName}:source-only`);
      return [
        protect('literal', textContent(n) || `[${n.tagName} in source PDF]`),
      ];
    }
    const content = children(n).flatMap(walk);
    const href = attr(n, 'href');
    if (n.tagName === 'a' && href) {
      if (/^(?:[^:/?#]*\/)*[^:/?#]*#[^\s]+$/.test(href)) {
        const key = id();
        links.push({ id: key, href });
        bindings.push({
          kind: 'block-link',
          id: key,
          blockId: 'b_' + '0'.repeat(32),
        });
        return [{ type: 'format', id: key, kind: 'link', children: content }];
      }
      try {
        const url = new URL(href);
        if (
          ['https:', 'http:', 'mailto:'].includes(url.protocol) &&
          !/[\s\x00-\x1f\x7f]/.test(href)
        ) {
          const key = id();
          bindings.push({ kind: 'link', id: key, href });
          return [{ type: 'format', id: key, kind: 'link', children: content }];
        }
      } catch {
        /* local links are resolved by the document projector or retained as source text */
      }
      warnings.push('unresolved-or-unsafe-link:source-text');
    }
    const format = formats[n.tagName];
    if (format) {
      const key = id();
      bindings.push({
        kind: 'style',
        id: key,
        emphasis: format as Extract<
          ReaderBinding,
          { kind: 'style' }
        >['emphasis'],
      });
      return [{ type: 'format', id: key, kind: format, children: content }];
    }
    const style = attr(n, 'style') ?? '';
    const color = style
      .match(/(?:^|;)\s*color:\s*(#[0-9a-fA-F]{6})(?:;|$)/)?.[1]
      .toLowerCase();
    const backgroundColor = style
      .match(/(?:^|;)\s*background-color:\s*(#[0-9a-fA-F]{6})(?:;|$)/)?.[1]
      .toLowerCase();
    if (color || backgroundColor) {
      const key = id();
      bindings.push({
        kind: 'style',
        id: key,
        ...(color ? { color } : {}),
        ...(backgroundColor ? { backgroundColor } : {}),
      });
      return [{ type: 'format', id: key, kind: 'style', children: content }];
    }
    return content;
  };
  return { content: nodes.flatMap(walk), bindings, links };
}
