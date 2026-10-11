import { SLOT_PATTERN } from '@pagelingo/translation-core';
import { isExcluded, isVisible } from './selectors';
import { findContentScope, headingLevel } from './content-scope';
import { protectNodes, type ProtectedBlock } from './protect';

/** A text run belongs to exactly one block, including text around nested lists. */
function* collectBlocks(document: Document, signal?: AbortSignal): Generator<void, ProtectedBlock[]> {
  const scope = findContentScope(document);
  const blocks: ProtectedBlock[] = [];
  const sections: { level: number; title: string }[] = [];
  let visited = 0;

  function append(parent: HTMLElement, nodes: Node[]): void {
    const source = nodes.map((node) => node.textContent ?? '').join('').trim();
    if (!/[\p{L}]/u.test(source) || /^https?:\/\/\S+$/.test(source)) return;
    const block = protectNodes(parent, [...nodes], `b${blocks.length}`, sections.map((section) => section.title));
    const natural = block.input.protectedText.replace(SLOT_PATTERN, '').trim();
    if (!/[\p{L}]/u.test(natural)) return;
    if (scope.keepSource) {
      // React retains ownership of every original node. Place leaf translations
      // outside text containers, where X's line clamp cannot conceal them.
      block.canHideSource = false;
      if (nodes.length === parent.childNodes.length && !parent.parentElement?.matches('ul,ol,table,thead,tbody,tfoot,tr')) {
        block.renderAfter = parent;
      }
    }
    blocks.push(block);
  }

  function* walk(element: HTMLElement): Generator<void> {
    signal?.throwIfAborted();
    if (++visited % 80 === 0) yield;
    if (visited > 50_000) throw new Error('页面内容过多，请先选择较小的正文范围。');
    if (isExcluded(element) || !isVisible(element)) return;
    const level = headingLevel(element);
    if (level !== undefined) {
      const title = protectNodes(element, Array.from(element.childNodes), 'section').input.sourceText.trim();
      while (sections.length && sections.at(-1)!.level >= level) sections.pop();
      if (title) sections.push({ level, title });
    }

    if (!element.matches(scope.blockSelector)) {
      for (const child of Array.from(element.children)) yield* walk(child as HTMLElement);
      return;
    }

    let run: Node[] = [];
    for (const child of Array.from(element.childNodes)) {
      const childElement = child.nodeType === Node.ELEMENT_NODE ? child as HTMLElement : null;
      const containsBlocks = childElement && (childElement.matches(scope.blockSelector) || childElement.querySelector(scope.blockSelector));
      if (containsBlocks) {
        append(element, run);
        run = [];
        yield* walk(childElement);
      } else {
        run.push(child);
      }
    }
    append(element, run);
  }

  for (const root of scope.roots) yield* walk(root);
  return blocks;
}

/** Yield during initial extraction so large pages can be stopped. */
export async function extractBlocks(document: Document, signal?: AbortSignal): Promise<ProtectedBlock[]> {
  const iterator = collectBlocks(document, signal);
  let result = iterator.next();
  while (!result.done) {
    await new Promise(resolve => setTimeout(resolve, 0));
    result = iterator.next();
  }
  return result.value;
}

/** Used only to reconcile source bindings after a meaningful DOM update. */
export function extractBlocksSync(document: Document): ProtectedBlock[] {
  const iterator = collectBlocks(document);
  let result = iterator.next();
  while (!result.done) result = iterator.next();
  return result.value;
}
