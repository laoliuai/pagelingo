import type { DisplayMode } from '../shared/types';
import { SLOT_PATTERN, validateStructure } from '@pagelingo/translation-core';
import { snapshotNodes, type ProtectedBlock } from './protect';
import { headingLevel } from './content-scope';
import { restoreVisualLiteral } from './inline-appearance';

interface RenderedBlock {
  block: ProtectedBlock;
  source?: HTMLSpanElement;
  translation: HTMLSpanElement;
}

function createFormatElement(original: Element, document: Document): HTMLElement {
  if (original.tagName !== 'A') return document.createElement(original.tagName.toLowerCase());
  const element = document.createElement('a');
  const href = original.getAttribute('href');
  try {
    const url = href ? new URL(href, original.ownerDocument.baseURI) : null;
    if (url && ['https:', 'http:', 'mailto:'].includes(url.protocol)) element.href = url.href;
  } catch { /* Unsafe or malformed URLs are never copied. */ }
  if (!element.hasAttribute('href')) return document.createElement('span');
  const target = original.getAttribute('target');
  if (target) element.target = target;
  element.rel = 'noopener noreferrer';
  return element;
}

/** Construct only known local tags and text nodes. Model text is never HTML. */
export function restoreFragment(block: ProtectedBlock, text: string): DocumentFragment {
  const errors = validateStructure(block.input, text);
  if (errors.length) throw new Error(errors.join(' '));
  const document = block.parent.ownerDocument;
  const fragment = document.createDocumentFragment();
  const stack: (DocumentFragment | HTMLElement)[] = [fragment];
  let offset = 0;

  for (const match of text.matchAll(SLOT_PATTERN)) {
    const parent = stack.at(-1)!;
    parent.append(document.createTextNode(text.slice(offset, match.index)));
    const slot = block.domSlots.get(match[0])!;
    if (slot.kind === 'atom') {
      if (slot.category === 'literal') {
        parent.append(document.createTextNode(slot.node.textContent ?? ''));
      } else if (slot.category === 'visual-literal') {
        parent.append(restoreVisualLiteral(slot.node as Element, document));
      } else if (slot.category === 'math') {
        const marker = document.createElement('span');
        marker.textContent = '〔公式见原文〕';
        marker.title = '保留原公式及其交互；该段落继续显示原文。';
        parent.append(marker);
      } else {
        const code = document.createElement((slot.node as Element).tagName.toLowerCase());
        code.textContent = slot.node.textContent;
        parent.append(code);
      }
    } else if (slot.kind === 'open') {
      const element = createFormatElement(slot.element, document);
      if (slot.appearance) Object.assign(element.style, slot.appearance);
      parent.append(element);
      stack.push(element);
    } else {
      stack.pop();
    }
    offset = match.index + match[0].length;
  }
  stack.at(-1)!.append(document.createTextNode(text.slice(offset)));
  return fragment;
}

export class DomRenderer {
  private rendered = new Map<string, RenderedBlock>();
  private mode: DisplayMode = 'bilingual';

  get fallbackCount(): number {
    return Array.from(this.rendered.values()).filter((entry) => !entry.source).length;
  }

  hasCurrentBindings(block: ProtectedBlock): boolean {
    const entry = this.rendered.get(block.input.id);
    const expectedParent = entry?.source ?? block.parent;
    const outputParent = block.renderAfter?.parentNode ?? block.parent;
    const outputAnchor = block.renderAfter ?? entry?.source ?? block.nodes.at(-1);
    return (!entry || entry.translation.isConnected && entry.translation.parentNode === outputParent &&
      entry.translation.previousSibling === outputAnchor &&
      (!entry.source || entry.source.parentNode === block.parent)) &&
      block.parent.isConnected && block.nodes.every((node) => node.isConnected && node.parentNode === expectedParent);
  }

  isCurrent(block: ProtectedBlock): boolean {
    return this.hasCurrentBindings(block) && snapshotNodes(block.nodes) === block.snapshot;
  }

  render(block: ProtectedBlock, text: string): boolean {
    if (!this.isCurrent(block)) return false;
    const fragment = restoreFragment(block, text);
    const previous = this.rendered.get(block.input.id);
    if (previous) {
      previous.translation.replaceChildren(fragment);
      return true;
    }

    const document = block.parent.ownerDocument;
    const translation = document.createElement('span');
    translation.dataset.plOwned = 'translation';
    translation.dataset.plBlock = block.input.id;
    translation.lang = 'zh-CN';
    translation.style.cssText = 'display:block;margin:0.35em 0;line-height:inherit;color:inherit;white-space:pre-wrap;overflow-wrap:anywhere;';
    translation.append(fragment);

    let source: HTMLSpanElement | undefined;
    if (block.renderAfter) {
      const style = document.defaultView?.getComputedStyle(block.parent);
      if (style) {
        // Siblings do not inherit typography declared on the source container.
        translation.style.fontFamily = style.fontFamily;
        translation.style.fontSize = style.fontSize;
        translation.style.fontWeight = style.fontWeight;
        translation.style.fontStyle = style.fontStyle;
        translation.style.lineHeight = style.lineHeight;
      }
      const level = headingLevel(block.parent);
      if (level !== undefined) {
        translation.setAttribute('role', 'heading');
        translation.setAttribute('aria-level', String(level));
      }
      block.renderAfter.after(translation);
      translation.dataset.plFallback = 'true';
    } else if (block.canHideSource) {
      source = document.createElement('span');
      source.dataset.plSource = block.input.id;
      source.style.display = 'contents';
      block.parent.insertBefore(source, block.nodes[0]);
      for (const node of block.nodes) source.append(node);
      source.after(translation);
    } else {
      // Keep complex content in its exact original parent, even in Chinese mode.
      block.parent.insertBefore(translation, block.nodes.at(-1)!.nextSibling);
      translation.dataset.plFallback = 'true';
    }

    const entry = { block, source, translation };
    this.rendered.set(block.input.id, entry);
    this.applyMode(entry);
    return true;
  }

  setMode(mode: DisplayMode): void {
    const entries = Array.from(this.rendered.values());
    const anchor = entries.find(({ block }) => block.parent.getBoundingClientRect().bottom > 0)?.block.parent;
    const before = anchor?.getBoundingClientRect().top;
    this.mode = mode;
    for (const entry of entries) this.applyMode(entry);
    if (anchor && before !== undefined) {
      const difference = anchor.getBoundingClientRect().top - before;
      if (difference) anchor.ownerDocument.defaultView?.scrollBy(0, difference);
    }
  }

  private applyMode(entry: RenderedBlock): void {
    if (entry.source) entry.source.style.display = this.mode === 'translation' ? 'none' : 'contents';
    entry.translation.style.display = this.mode === 'source' ? 'none' : 'block';
  }

  restore(): void {
    const ids = new Set(this.rendered.keys());
    const documents = new Set(Array.from(this.rendered.values(), entry => entry.block.parent.ownerDocument));
    for (const { source, translation } of Array.from(this.rendered.values()).reverse()) {
      translation.remove();
      // Preserve even new children inserted by the page while translation was active.
      if (source?.parentNode) {
        while (source.firstChild) source.parentNode.insertBefore(source.firstChild, source);
        source.remove();
      }
    }
    // Host DOM cloning can copy extension output as well as the originals.
    // Remove only markup for our rendered block IDs, preserving host children.
    for (const document of documents) {
      for (const output of document.querySelectorAll<HTMLElement>('[data-pl-owned="translation"][data-pl-block]')) {
        if (ids.has(output.dataset.plBlock!)) output.remove();
      }
      for (const wrapper of Array.from(document.querySelectorAll<HTMLElement>('[data-pl-source]')).reverse()) {
        if (ids.has(wrapper.dataset.plSource!)) wrapper.replaceWith(...wrapper.childNodes);
      }
    }
    this.rendered.clear();
  }
}
