import {
  readingDocumentSchema,
  webDocumentKey,
  type Quote,
  type ReadingBlock,
  type ReadingDocument,
} from '@pagelingo/assistant-core';
import { findContentScope, headingLevel } from '../dom/content-scope';
import { MATH_SELECTOR } from '../dom/selectors';

const excluded =
  'script,style,noscript,template,textarea,input,select,option,button,nav,aside,footer,iframe,[contenteditable]:not([contenteditable="false"]),[data-pl-owned],[hidden],[inert],[aria-hidden="true"]';
const blockSelector = 'p,li,blockquote,figcaption,td,th,h1,h2,h3,h4,h5,h6,dt,dd,pre';
type Binding = { block: ReadingBlock; parent: Element; nodes: Node[] };
const lastBindings = new WeakMap<Document, { revision: string; bindings: Binding[] }>();
const revision = (value: string) => {
  let hash = 0xcbf29ce484222325n;
  for (const char of value) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0)!)) * 0x100000001b3n);
  }
  return hash.toString(16);
};

/** Original DOM is the source; translation wrappers are transparent and generated output is absent. */
export function readArticle(
  document: Document,
  fallbackSelection?: string,
): { document: ReadingDocument; quote?: Quote } {
  const scope = findContentScope(document);
  const bindings: Binding[] = [];
  const sections: { level: number; title: string }[] = [];
  let visited = 0;
  let imageWithoutText = false;
  function hidden(element: Element): boolean {
    if (element.hasAttribute('data-pl-source')) return false;
    const style = document.defaultView?.getComputedStyle(element);
    return style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse';
  }
  function text(node: Node, code = false): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const element = node as Element;
    if (element.matches(excluded) || hidden(element)) return '';
    if (element.matches(MATH_SELECTOR))
      return (
        element.querySelector('annotation[encoding="application/x-tex"]')?.textContent ??
        element.getAttribute('alttext') ??
        element.textContent ??
        ''
      );
    if (element.matches('img')) {
      const alt = element.getAttribute('alt')?.trim();
      if (!alt) imageWithoutText = true;
      return alt ? `〔图片说明：${alt}〕` : '〔图片：未提供文字内容〕';
    }
    if (element.matches('svg,canvas,video,audio')) return '';
    if (element.tagName === 'BR') return '\n';
    const value = Array.from(element.childNodes)
      .map((n) => text(n, code))
      .join('');
    return element.tagName === 'CODE' && !code ? `\`${value}\`` : value;
  }
  function append(parent: Element, nodes: Node[]) {
    const level = headingLevel(parent as HTMLElement);
    const kind: ReadingBlock['kind'] =
      parent.tagName === 'PRE'
        ? 'code'
        : parent.matches(MATH_SELECTOR)
          ? 'math'
          : level
            ? 'heading'
            : parent.matches('figcaption,img')
              ? 'caption'
              : parent.matches('td,th')
                ? 'table'
                : 'paragraph';
    const raw = parent.matches(MATH_SELECTOR)
      ? text(parent)
      : nodes.map((n) => text(n, kind === 'code')).join('');
    const value = kind === 'code' ? raw : raw.trim();
    if (!value.trim()) return;
    if (level) {
      while (sections.length && sections.at(-1)!.level >= level) sections.pop();
      sections.push({ level, title: value.slice(0, 300) });
    }
    const block: ReadingBlock = {
      id: `r${bindings.length}`,
      kind,
      text: value,
      sectionPath: sections.map((s) => s.title),
    };
    bindings.push({ block, parent, nodes });
  }
  function walk(element: Element) {
    if (++visited > 50_000) throw new Error('文章结构过大，请选择较小的正文范围。');
    if (element.matches(excluded) || hidden(element)) return;
    if (element.matches('img')) {
      append(element, [element]);
      return;
    }
    if (element.matches(`pre,${MATH_SELECTOR}`)) {
      append(element, Array.from(element.childNodes));
      return;
    }
    const selector = `${blockSelector},${scope.blockSelector}`;
    if (!element.matches(selector)) {
      for (const child of Array.from(element.children)) walk(child);
      return;
    }
    let run: Node[] = [];
    for (const node of Array.from(element.childNodes)) {
      const child = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : undefined;
      if (child?.hasAttribute('data-pl-owned')) continue;
      // Source spans preserve the original paragraph even in Chinese-only mode.
      if (
        child &&
        !child.hasAttribute('data-pl-source') &&
        (child.matches(selector) || child.querySelector(selector))
      ) {
        append(element, run);
        run = [];
        walk(child);
      } else run.push(node);
    }
    append(element, run);
  }
  scope.roots.forEach(walk);
  const blocks = bindings.map((b) => b.block);
  const title = (blocks.find((b) => b.kind === 'heading')?.text ?? document.title).slice(0, 1000);
  const result = readingDocumentSchema.parse({
    key: webDocumentKey(document.URL),
    revision: revision(JSON.stringify({ title, blocks })),
    title,
    url: document.URL,
    language: document.documentElement.lang,
    blocks,
    warnings: imageWithoutText ? ['文章含有无文字内容的图片；模型只能读取提供的文本。'] : [],
  });
  lastBindings.set(document, { revision: result.revision, bindings });
  const selection = document.getSelection();
  const normalized = (value: string) => value.replace(/\s+/g, ' ').trim();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
  const visibleSelection = selection?.toString();
  const rangeText = range?.toString();
  // Selection.toString() can omit a final newline; Range.toString() retains it.
  // Keep the visible selection if hidden source nodes make the raw range differ.
  const nativeSelection =
    rangeText && visibleSelection && normalized(rangeText) === normalized(visibleSelection)
      ? rangeText
      : visibleSelection;
  // Context-menu text may collapse whitespace. Prefer the live DOM range when
  // it represents that same selection, retaining code indentation and newlines.
  const selected =
    fallbackSelection === undefined
      ? nativeSelection
      : nativeSelection?.trim() && normalized(nativeSelection) === normalized(fallbackSelection)
        ? nativeSelection
        : fallbackSelection;
  if (!selected?.trim()) return { document: result };
  if (selected.length > 50_000) throw new Error('选区超过 50000 字符，请缩小范围后添加。');
  const translated =
    range && nativeSelection === selected
      ? (range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
          ? (range.commonAncestorContainer as Element)
          : range.commonAncestorContainer.parentElement
        )?.closest<HTMLElement>('[data-pl-owned="translation"]')
      : undefined;
  let matched: Binding[] = [];
  if (translated) {
    const previous = translated.previousSibling;
    matched = bindings.filter(
      (b) =>
        b.nodes.some(
          (n) => n === previous || (n.nodeType === Node.ELEMENT_NODE && (n as Element).contains(previous)),
        ) || b.parent === previous,
    );
  } else if (range && nativeSelection === selected) {
    matched = bindings.filter((b) =>
      b.nodes.some((n) => {
        try {
          return range.intersectsNode(n);
        } catch {
          return false;
        }
      }),
    );
  }
  if (!matched.length) {
    const unique = bindings.filter((b) => b.block.text.includes(selected));
    if (unique.length === 1) matched = unique;
  }
  const originalText =
    translated && matched.length ? matched.map((b) => b.block.text).join('\n\n') : undefined;
  const quote: Quote = {
    id: crypto.randomUUID(),
    documentKey: result.key,
    revision: result.revision,
    label: matched[0]?.block.sectionPath.at(-1)?.slice(0, 300) ?? '选中内容',
    text: selected,
    originalText: originalText?.slice(0, 50_000),
    kind: matched.some((b) => b.block.kind === 'code') ? 'code' : 'text',
    blockIds: matched.slice(0, 100).map((b) => b.block.id),
  };
  return { document: result, quote };
}
export function revealArticleBlock(document: Document, blockId: string, expectedRevision: string) {
  readArticle(document, '');
  const current = lastBindings.get(document)!;
  if (current.revision !== expectedRevision) throw new Error('文章内容已更新，历史引用仍保留原始文字。');
  const binding = current.bindings.find((b) => b.block.id === blockId);
  if (!binding) throw new Error('未找到对应原文段落。');
  binding.parent.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const animation = binding.parent.animate?.(
    [{ outline: '2px solid #55ad86' }, { outline: '2px solid transparent' }],
    { duration: 1800 },
  );
  void animation?.finished.catch(() => {});
}
