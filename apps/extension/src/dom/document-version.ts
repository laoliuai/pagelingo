import { findContentScope } from './content-scope';
import type { ProtectedBlock } from './protect';
import { snapshotSourceNodes } from './source-snapshot';

/** X tab metadata is independent of its article. Only filtered model input
 * supplies title context; actual heading changes are guarded by block versions. */
export function translationTitle(document: Document, blocks: ProtectedBlock[] = []): string {
  const scope = findContentScope(document);
  return scope.keepSource ? blocks[0]?.input.sourceText.trim().slice(0, 200) ?? '' : document.title;
}

/** Compare the entire source, including additions and order, in every display mode. */
export function sourceDocumentVersion(document: Document): string {
  const source = snapshotSourceNodes(findContentScope(document).roots);
  return JSON.stringify({ title: translationTitle(document), language: document.documentElement.lang, source });
}

function assets(block: ProtectedBlock): unknown[] {
  return Array.from(block.domSlots.values()).flatMap<unknown>(slot => {
    if (slot.kind === 'open') return [[slot.element.tagName, slot.element.getAttribute('href'), slot.element.getAttribute('target')]];
    if (slot.kind === 'atom') return [[slot.category, slot.category === 'code'
      ? [(slot.node as Element).tagName, slot.node.textContent]
      : snapshotSourceNodes([slot.node])]];
    return [];
  });
}

/** Ordered translation input plus the local assets needed to restore it safely. */
export function blockDocumentVersion(blocks: ProtectedBlock[]): string {
  // encodeBlock merges adjacent text and represents semantic formats without
  // incidental DOM wrappers, so equivalent React text segmentation compares equal.
  return JSON.stringify(blocks.map(block => ({ input: block.input, sourceText: block.input.sourceText, assets: assets(block) })));
}

export function sourceChangeReason(previousVersion: string, currentVersion: string): string {
  // Read the frozen asset snapshots: the site's edits may already have mutated
  // the original DOM nodes held by an older ProtectedBlock.
  const previous = JSON.parse(previousVersion) as { sourceText: string; assets: unknown[] }[];
  const current = JSON.parse(currentVersion) as typeof previous;
  if (previous.length !== current.length) return '正文段落数量已变化';
  const before = previous.map(block => block.sourceText);
  const after = current.map(block => block.sourceText);
  if (JSON.stringify(before) !== JSON.stringify(after) && JSON.stringify([...before].sort()) === JSON.stringify([...after].sort())) return '正文段落顺序已变化';
  if (JSON.stringify(previous.map(block => block.assets)) !== JSON.stringify(current.map(block => block.assets))) return '正文链接、代码、公式或结构已变化';
  if (JSON.stringify(before) !== JSON.stringify(after)) return '原文文字已变化';
  return '正文段落结构已变化';
}
