import { encodeBlock, type BlockKind, type FormatKind, type InlineContent, type TranslationBlock, type TranslationInput } from '@pagelingo/translation-core';
import { CODE_SELECTOR, EXCLUDED_SELECTOR, MATH_SELECTOR } from './selectors';
import { headingLevel } from './content-scope';
import { snapshotSourceNodes } from './source-snapshot';
import { captureAppearance, type InlineAppearance } from './inline-appearance';

export type DomSlot =
  | { kind: 'atom'; node: Node; category: 'code' | 'math' | 'literal' | 'visual-literal' }
  | { kind: 'open'; element: Element; appearance?: InlineAppearance }
  | { kind: 'close' };

export interface ProtectedBlock {
  block: TranslationBlock;
  input: TranslationInput;
  parent: HTMLElement;
  nodes: Node[];
  domSlots: Map<string, DomSlot>;
  canHideSource: boolean;
  renderAfter?: HTMLElement;
  snapshot: string;
}

const FORMAT_TAGS: Record<string, FormatKind | undefined> = {
  A: 'link', STRONG: 'strong', B: 'strong', EM: 'emphasis', I: 'emphasis', S: 'deletion', DEL: 'deletion',
  SUB: 'subscript', SUP: 'superscript', SMALL: 'small', MARK: 'mark',
  U: 'underline',
};

function hasVisibleContent(content: InlineContent[]): boolean {
  return content.some((inline) => inline.type === 'protected' || (inline.type === 'format'
    ? hasVisibleContent(inline.children)
    : Boolean(inline.text.replace(/[\s\u200B\u200C\u200D\u2060\uFEFF]/g, ''))));
}

function blockKind(element: HTMLElement): BlockKind {
  if (headingLevel(element) !== undefined) return 'heading';
  if (['LI', 'DT', 'DD'].includes(element.tagName)) return 'list-item';
  if (['TD', 'TH'].includes(element.tagName)) return 'table-cell';
  if (element.tagName === 'FIGCAPTION') return 'caption';
  if (element.tagName === 'BLOCKQUOTE') return 'quote';
  return 'paragraph';
}

export function snapshotNodes(nodes: Node[]): string {
  return snapshotSourceNodes(nodes);
}

export function protectNodes(parent: HTMLElement, nodes: Node[], id: string, sectionPath: string[] = []): ProtectedBlock {
  const sourceMap = new Map<string, DomSlot>();
  const domSlots = new Map<string, DomSlot>();
  let counter = 0;
  let canHideSource = true;

  function atom(node: Node, category: 'code' | 'math' | 'visual-literal'): InlineContent[] {
    const id = `i${counter++}`;
    sourceMap.set(id, { kind: 'atom', node, category });
    return [{ type: 'protected', id, kind: category === 'visual-literal' ? 'literal' : category, source: node.textContent ?? '' }];
  }

  function visit(node: Node): InlineContent[] {
    if (node.nodeType === Node.TEXT_NODE) {
      return [{ type: 'text', text: node.textContent ?? '' }];
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return [];
    const element = node as Element;
    if (element.hasAttribute('data-pl-owned')) return [];
    if (element.hasAttribute('data-pl-source')) return Array.from(element.childNodes).flatMap(visit);
    if (element.matches(EXCLUDED_SELECTOR)) {
      canHideSource = false;
      return [];
    }
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') {
      canHideSource = false;
      return [];
    }
    if (element.matches(MATH_SELECTOR)) {
      // Math renderers can carry custom elements, IDs and interactive menus.
      canHideSource = false;
      return atom(element, 'math');
    }
    if (element.matches('span.pl-completion-slot,span[data-pl-preserve="placeholder"]')) {
      return atom(element, 'visual-literal');
    }
    if (element.matches(CODE_SELECTOR)) {
      return atom(element, 'code');
    }
    if (element.matches('img,picture,object,embed') || element.tagName.includes('-')) {
      canHideSource = false;
      return [];
    }
    if (element.matches('br')) return [{ type: 'text', text: '\n' }];
    if (Array.from(element.attributes).some((attribute) => attribute.name.startsWith('on'))) canHideSource = false;
    if (element.tagName === 'A') {
      const href = element.getAttribute('href');
      try {
        const url = href ? new URL(href, element.ownerDocument.baseURI) : null;
        if (!url || !['https:', 'http:', 'mailto:'].includes(url.protocol)) canHideSource = false;
      } catch {
        canHideSource = false;
      }
    }
    const styled = element.tagName === 'SPAN' && (
      element.matches('.pl-source-color,.pl-source-highlight,[data-pl-format="style"]')
      || Boolean((element as HTMLElement).style.color || (element as HTMLElement).style.backgroundColor)
    );
    const kind = styled ? 'style' : FORMAT_TAGS[element.tagName];
    if (!kind) return Array.from(element.childNodes).flatMap(visit);
    const reserved = counter;
    const id = `i${counter++}`;
    const children = Array.from(element.childNodes).flatMap(visit);
    if (!hasVisibleContent(children)) {
      // Docusaurus and similar sites have zero-width heading anchors or icon-only links.
      // Keep these in the original DOM, without asking the model to translate empty pairs.
      canHideSource = false;
      counter = reserved;
      return [];
    }
    sourceMap.set(id, { kind: 'open', element, ...(styled ? { appearance: captureAppearance(element) } : {}) });
    return [{ type: 'format', id, kind, children }];
  }

  const block: TranslationBlock = { id, kind: blockKind(parent), ...(sectionPath.length ? { sectionPath } : {}), content: nodes.flatMap(visit) };
  const input = encodeBlock(block);
  for (const slot of input.slots) {
    if (slot.kind === 'close') domSlots.set(slot.token, { kind: 'close' });
    else if (slot.inline.type === 'text') {
      domSlots.set(slot.token, { kind: 'atom', category: 'literal', node: parent.ownerDocument.createTextNode(slot.inline.text) });
    } else domSlots.set(slot.token, sourceMap.get(slot.inline.id)!);
  }
  return {
    block,
    input,
    parent,
    nodes,
    domSlots,
    canHideSource,
    snapshot: snapshotNodes(nodes),
  };
}
