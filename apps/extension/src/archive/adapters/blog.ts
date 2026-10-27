import { isVisible } from '../../dom/selectors';

export interface ArchiveSource {
  roots: HTMLElement[];
  kind: 'article' | 'x-post' | 'answer';
  title: string;
  author: string | null;
  publishedAt: string | null;
  warnings: string[];
  externalLinks?: Array<{ url: string; text: string }>;
}
export function sourceMetadata(document: Document): Omit<ArchiveSource, 'roots' | 'kind'> {
  const time = document.querySelector<HTMLMetaElement>('meta[property="article:published_time"]')?.content;
  return {
    title: document.title.trim().slice(0, 2000) || 'Untitled article',
    author: document.querySelector<HTMLMetaElement>('meta[name="author"]')?.content.slice(0, 2000) || null,
    publishedAt: parseSourceTime(time), warnings: [],
  };
}
export function parseSourceTime(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d\d-\d\dT/.test(value)) return null;
  const date = new Date(value); return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}
export function blogSource(document: Document): ArchiveSource {
  const metadata = sourceMetadata(document);
  for (const selector of ['article.markdown-body', '.ltx_document', '.markdown-body', 'main article', 'article', 'main', '[role="main"]']) {
    const roots = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(isVisible);
    if (roots.length === 1 && roots[0]!.textContent?.trim()) return { ...metadata, roots, kind: 'article' };
    if (roots.length > 1) break;
  }
  return { ...metadata, roots: [], kind: 'article', warnings: ['Article root is unavailable or ambiguous; save the link and open the standalone article.'] };
}

/** Metadata text also follows original wrappers and excludes extension output. */
export function originalSourceText(element: Element | null | undefined): string {
  if (!element) return '';
  const pending: Node[] = [element];
  let text = '';
  while (pending.length && text.length < 2000) {
    const node = pending.pop()!;
    if (node.nodeType === 3) text += node.textContent ?? '';
    else if (node.nodeType === 1 && !(node as Element).matches('[data-pl-owned],button,[role="button"],input,textarea,select')) pending.push(...Array.from(node.childNodes).reverse());
  }
  return text.trim().slice(0, 2000);
}
