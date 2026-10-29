import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { isMainThread } from 'node:worker_threads';
import type { PendingCaptureResource, CaptureLimits, SanitizedSnapshot, SnapshotInput } from '@pagelingo/document-contracts';
import { domEnvironment } from './purify.js';
import { attr, elements, limitsFor, parseBounded, serialize, setAttr, textOf } from './tree.js';
import { sanitizeSnapshot } from './sanitize.js';
export function sanitizeNodeSnapshot(input: SnapshotInput, limits?: CaptureLimits, resources?: readonly PendingCaptureResource[]): SanitizedSnapshot {
  const dom = new JSDOM('');
  try { return sanitizeSnapshot(input, { ...domEnvironment(dom.window), limits, resources }); } finally { dom.window.close(); }
}
/** Call only inside a terminable worker. No scripts, resources, or network are enabled. */
export interface ArticleSourceMetadata { title: string | null; author: string | null; publishedAt: string | null }
export interface ExtractedPublicArticle { snapshot: SanitizedSnapshot; metadata: ArticleSourceMetadata | null }
/** Existing snapshot-only API stays compatible with strict snapshot consumers. */
export function extractPublicArticle(html: string, url: string, limits?: CaptureLimits): SanitizedSnapshot {
  return extractPublicArticleWithMetadata(html, url, limits).snapshot;
}
export function extractPublicArticleWithMetadata(html: string, url: string, limits?: CaptureLimits): ExtractedPublicArticle {
  if (isMainThread) throw new Error('Article extraction requires a terminable worker');
  const scope = { kind: 'article' as const, rootNodeId: 'root', completeWithinScope: true, warnings: [] };
  const safe = sanitizeNodeSnapshot({ html, url, scope }, limits);
  const dom = new JSDOM(safe.html, { url });
  try {
    // Preserve only inert, bounded metadata for the very same Readability parse.
    // Raw HTML is preflighted with parse5; it never enters the native DOM.
    const raw = parseBounded(html, limitsFor(limits));
    for (const node of elements(raw)) {
      if (node.tagName === 'title' && !dom.window.document.title) dom.window.document.title = textOf(node).trim().slice(0, 2000);
      if (node.tagName !== 'meta') continue;
      const name = attr(node, 'name') ?? attr(node, 'property');
      if (!name || !/^(?:author|dc.creator|og:title|og:description|article:author|article:published_time|date|datepublished)$/i.test(name)) continue;
      const meta = dom.window.document.createElement('meta');
      meta.setAttribute(attr(node, 'property') ? 'property' : 'name', name);
      meta.setAttribute('content', (attr(node, 'content') ?? '').trim().slice(0, 2000));
      dom.window.document.head.appendChild(meta);
    }
    const clone = dom.window.document.cloneNode(true) as Document;
    for (const image of clone.querySelectorAll('img[data-pl-resource]')) image.setAttribute('src', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==');
    const article = new Readability(clone, { maxElemsToParse: limits?.maxDomNodes ?? 50000 }).parse();
    if (!article?.content) return { snapshot: { ...safe, scope: { ...safe.scope, completeWithinScope: false, warnings: [...safe.scope.warnings, 'Readability could not identify an article'] }, warnings: [...safe.warnings, 'Readability could not identify an article'] }, metadata: null };
    // Rehydrate only the known resource placeholders in pure data, then run the
    // shared preflight again. Raw URLs never enter a native DOM before stripping.
    const extracted = parseBounded(article.content, limitsFor(limits));
    const resources = new Map(safe.resources.map(resource => [resource.id, resource]));
    for (const node of elements(extracted)) {
      const resource = resources.get(attr(node, 'data-pl-resource') ?? '');
      if (node.tagName === 'img' && resource?.role === 'image') setAttr(node, 'src', resource.url);
    }
    const snapshot = sanitizeNodeSnapshot({ html: serialize(extracted), url, scope: safe.scope }, limits);
    const bounded = (value: string | null | undefined) => value?.trim().slice(0, 2000) || null;
    const time = bounded(article.publishedTime);
    const calendar = time?.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|$)/);
    const calendarDate = calendar ? new Date(`${calendar[1]}-${calendar[2]}-${calendar[3]}T00:00:00Z`) : null;
    const validCalendar = calendarDate && Number.isFinite(calendarDate.getTime()) && calendarDate.toISOString().slice(0, 10) === time!.slice(0, 10);
    const publishedAt = validCalendar && Number.isFinite(Date.parse(time!)) ? new Date(time!).toISOString() : null;
    return { snapshot: { ...snapshot, warnings: [...new Set([...safe.warnings, ...snapshot.warnings])] }, metadata: { title: bounded(article.title), author: bounded(article.byline), publishedAt } };
  } finally { dom.window.close(); }
}
export * from './index.js';
