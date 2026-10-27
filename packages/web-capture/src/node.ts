import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { isMainThread } from 'node:worker_threads';
import type { PendingCaptureResource, CaptureLimits, SanitizedSnapshot, SnapshotInput } from '@pagelingo/document-contracts';
import { domEnvironment } from './purify.js';
import { attr, elements, limitsFor, parseBounded, serialize, setAttr } from './tree.js';
import { sanitizeSnapshot } from './sanitize.js';
export function sanitizeNodeSnapshot(input: SnapshotInput, limits?: CaptureLimits, resources?: readonly PendingCaptureResource[]): SanitizedSnapshot {
  const dom = new JSDOM('');
  try { return sanitizeSnapshot(input, { ...domEnvironment(dom.window), limits, resources }); } finally { dom.window.close(); }
}
/** Call only inside a terminable worker. No scripts, resources, or network are enabled. */
export function extractPublicArticle(html: string, url: string, limits?: CaptureLimits): SanitizedSnapshot {
  if (isMainThread) throw new Error('Article extraction requires a terminable worker');
  const scope = { kind: 'article' as const, rootNodeId: 'root', completeWithinScope: true, warnings: [] };
  const safe = sanitizeNodeSnapshot({ html, url, scope }, limits);
  const dom = new JSDOM(safe.html, { url });
  try {
    const clone = dom.window.document.cloneNode(true) as Document;
    for (const image of clone.querySelectorAll('img[data-pl-resource]')) image.setAttribute('src', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==');
    const article = new Readability(clone, { maxElemsToParse: limits?.maxDomNodes ?? 50000 }).parse();
    if (!article?.content) return { ...safe, scope: { ...safe.scope, completeWithinScope: false, warnings: [...safe.scope.warnings, 'Readability could not identify an article'] }, warnings: [...safe.warnings, 'Readability could not identify an article'] };
    // Rehydrate only the known resource placeholders in pure data, then run the
    // shared preflight again. Raw URLs never enter a native DOM before stripping.
    const extracted = parseBounded(article.content, limitsFor(limits));
    const resources = new Map(safe.resources.map(resource => [resource.id, resource]));
    for (const node of elements(extracted)) {
      const resource = resources.get(attr(node, 'data-pl-resource') ?? '');
      if (node.tagName === 'img' && resource) setAttr(node, 'src', resource.url);
    }
    const snapshot = sanitizeNodeSnapshot({ html: serialize(extracted), url, scope: safe.scope }, limits);
    return { ...snapshot, warnings: [...new Set([...safe.warnings, ...snapshot.warnings])] };
  } finally { dom.window.close(); }
}
export * from './index.js';
