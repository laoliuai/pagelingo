import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { isMainThread } from 'node:worker_threads';
import type { PendingCaptureResource, CaptureLimits, SanitizedSnapshot, SnapshotInput } from '@pagelingo/document-contracts';
import { domEnvironment } from './purify.js';
import { attr, elements, htmlOf, isElement, isText, limitsFor, parseBounded, serialize, setAttr, textOf, type ChildNode, type Element, type Parent } from './tree.js';
import { sanitizeSnapshot } from './sanitize.js';
export function sanitizeNodeSnapshot(input: SnapshotInput, limits?: CaptureLimits, resources?: readonly PendingCaptureResource[], options?: { wholePage?: boolean }): SanitizedSnapshot {
  const dom = new JSDOM('');
  try { return sanitizeSnapshot(input, { ...domEnvironment(dom.window), limits, resources, ...options }); } finally { dom.window.close(); }
}
/** Call only inside a terminable worker. No scripts, resources, or network are enabled. */
export interface ArticleSourceMetadata { title: string | null; author: string | null; publishedAt: string | null }
export interface ExtractedPublicArticle { snapshot: SanitizedSnapshot; metadata: ArticleSourceMetadata | null }
/** Existing snapshot-only API stays compatible with strict snapshot consumers. */
export function extractPublicArticle(html: string, url: string, limits?: CaptureLimits): SanitizedSnapshot {
  return extractPublicArticleWithMetadata(html, url, limits).snapshot;
}
const XHTML = 'http://www.w3.org/1999/xhtml' as Element['namespaceURI'];
const classesOf = (node: Element) => (attr(node, 'class') ?? '').split(/\s+/);
const hasClass = (node: ChildNode, name: string): boolean => isElement(node) && classesOf(node).includes(name);
/**
 * LaTeXML writes a footnote's whole text at its reference and relies on the site stylesheet to pop it out.
 * Left inline it would interrupt the sentence for the reader and the translator, so only the mark stays.
 */
function moveNotesOutOfSentences(body: Element): void {
  for (const note of elements(body).filter(node => hasClass(node, 'ltx_note'))) {
    if (!note.parentNode) continue;
    const mark = note.childNodes.find((child): child is Element => hasClass(child, 'ltx_note_mark'));
    const content = elements(note).find(node => hasClass(node, 'ltx_note_content'));
    note.childNodes = mark ? [mark] : [];
    if (!content || hasClass(note, 'ltx_role_footnotemark')) continue;
    const words = content.childNodes.filter(child => !hasClass(child, 'ltx_note_mark') && !hasClass(child, 'ltx_note_type') && !hasClass(child, 'ltx_tag_note'));
    let host: Parent = note.parentNode;
    while (isElement(host) && !/^(?:p|h[1-6]|li|td|th|figcaption|div|article)$/.test(host.tagName)) host = host.parentNode!;
    const paragraph: Element = { tagName: 'p', nodeName: 'p', namespaceURI: XHTML, attrs: [], childNodes: [], parentNode: host };
    const label: ChildNode[] = mark ? [{ nodeName: '#text', value: `${textOf(mark).trim()} `, parentNode: paragraph }] : [];
    paragraph.childNodes = [...label, ...words];
    for (const child of words) child.parentNode = paragraph;
    if (isElement(host) && /^(?:p|h[1-6]|figcaption)$/.test(host.tagName) && host.parentNode) {
      const parent: Parent = host.parentNode;
      paragraph.parentNode = parent;
      parent.childNodes.splice(parent.childNodes.indexOf(host as ChildNode) + 1, 0, paragraph);
    } else host.childNodes.push(paragraph);
  }
}
/** LaTeXML lays each equation out in a padding table. As a table it wraps in narrow cells; as a paragraph it reads like the paper. */
function flattenEquationTables(body: Element): void {
  for (const math of elements(body).filter(node => node.tagName === 'math' && attr(node, 'display') === 'block')) {
    const tex = elements(math).find(node => node.tagName === 'annotation' && attr(node, 'encoding') === 'application/x-tex')?.childNodes[0];
    if (tex && isText(tex) && !tex.value.startsWith('\\displaystyle')) tex.value = `\\displaystyle ${tex.value}`;
  }
  for (const table of elements(body).filter(node => node.tagName === 'table' && hasClass(node, 'ltx_eqn_table'))) {
    const parent = table.parentNode;
    if (!parent) continue;
    const rows = elements(table).filter(node => node.tagName === 'tr').flatMap(row => {
      const paragraph: Element = { tagName: 'p', nodeName: 'p', namespaceURI: XHTML, attrs: [], childNodes: [], parentNode: parent };
      for (const cell of row.childNodes) {
        if (!isElement(cell) || !cell.childNodes.some(child => isElement(child) || textOf(child).trim())) continue;
        for (const child of [...cell.childNodes, { nodeName: '#text', value: ' ', parentNode: paragraph } as ChildNode]) { child.parentNode = paragraph; paragraph.childNodes.push(child); }
      }
      return paragraph.childNodes.length ? [paragraph] : [];
    });
    parent.childNodes.splice(parent.childNodes.indexOf(table), 1, ...rows);
  }
}
/** A list already draws its own marker; LaTeXML's typed "•" or "1." would show a second one. */
function dropRepeatedListMarkers(body: Element): void {
  for (const tag of elements(body).filter(node => hasClass(node, 'ltx_tag_item'))) {
    const item = tag.parentNode; const list = item && isElement(item) ? item.parentNode : null;
    if (!item || !list || !isElement(list)) continue;
    const label = textOf(tag).trim();
    if (list.tagName === 'ul' ? label.length <= 1 : list.tagName === 'ol' && /^\d+[.)]?$/.test(label)) item.childNodes.splice(item.childNodes.indexOf(tag), 1);
  }
}
/** LaTeXML (arXiv HTML, ar5iv) marks the exact paper body, so heuristic extraction could only lose tables, equations and references. */
function latexmlDocument(html: string, limits?: CaptureLimits): { html: string; title: string | null; author: string | null } | null {
  const body = elements(parseBounded(html, limitsFor(limits))).find(node => node.tagName === 'article' && hasClass(node, 'ltx_document'));
  if (!body) return null;
  const inside = elements(body);
  const nameOf = (node: Element): string => node.childNodes.map(child => isElement(child) ? (hasClass(child, 'ltx_note') || child.tagName === 'sup' ? '' : nameOf(child)) : textOf(child)).join('');
  const clean = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 2000);
  const title = inside.find(node => hasClass(node, 'ltx_title_document'));
  const authors = inside.filter(node => hasClass(node, 'ltx_personname')).map(node => clean(nameOf(node))).filter(Boolean);
  const metadata = { title: title ? clean(nameOf(title)) || null : null, author: authors.join(', ').slice(0, 2000) || null };
  moveNotesOutOfSentences(body);
  flattenEquationTables(body);
  dropRepeatedListMarkers(body);
  return { html: htmlOf(body), ...metadata };
}
export function extractPublicArticleWithMetadata(html: string, url: string, limits?: CaptureLimits): ExtractedPublicArticle {
  if (isMainThread) throw new Error('Article extraction requires a terminable worker');
  const scope = { kind: 'article' as const, rootNodeId: 'root', completeWithinScope: true, warnings: [] };
  const paper = latexmlDocument(html, limits);
  if (paper) return { snapshot: sanitizeNodeSnapshot({ html: paper.html, url, scope }, limits), metadata: { title: paper.title, author: paper.author, publishedAt: null } };
  const safe = sanitizeNodeSnapshot({ html, url, scope }, limits, undefined, { wholePage: true });
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
