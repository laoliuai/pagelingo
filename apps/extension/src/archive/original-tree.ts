import { defaultCaptureLimits } from '@pagelingo/document-contracts';
import { blogSource, type ArchiveSource } from './adapters/blog';
import { xSource } from './adapters/x';
import { zhihuSource } from './adapters/zhihu';
import { wechatSource } from './adapters/wechat';
import { collectOriginalStylesheets } from './stylesheets';
import { normalizeCaptureUrl } from '@pagelingo/web-capture';

export function selectArchiveSource(document: Document): ArchiveSource {
  const hostname = new URL(document.URL).hostname;
  if (/(^|\.)(x\.com|twitter\.com)$/.test(hostname)) return xSource(document);
  if (/(^|\.)zhihu\.com$/.test(hostname)) return zhihuSource(document);
  if (hostname === 'mp.weixin.qq.com') return wechatSource(document);
  return blogSource(document);
}
/** Clone directly from source wrappers; no live translation-mode changes. */
export function originalTree(document: Document, source: ArchiveSource): HTMLElement {
  // A separate document has no page custom-element registry or browsing context.
  // Native cloneNode in the live document can invoke page constructors.
  const inert = document.implementation.createHTMLDocument('');
  const container = inert.createElement('article');
  let count = 0;
  const clone = (node: Node, depth: number): Node | null => {
    if (++count > defaultCaptureLimits.maxDomNodes || depth > defaultCaptureLimits.maxDepth) throw new Error('Capture DOM budget exceeded');
    if (node.nodeType === 3) return inert.createTextNode(node.textContent ?? '');
    if (node.nodeType !== 1) return null;
    const element = node as HTMLElement;
    if (element.hasAttribute('data-pl-owned')) return null;
    if (element.hasAttribute('data-pl-source')) {
      const fragment = inert.createDocumentFragment();
      for (const child of element.childNodes) { const copied = clone(child, depth); if (copied) fragment.append(copied); }
      return fragment;
    }
    const style = document.defaultView?.getComputedStyle(element);
    if (element.hidden || element.getAttribute('aria-hidden') === 'true' || style?.display === 'none' || ['hidden', 'collapse'].includes(style?.visibility ?? '')) return null;
    if (element.matches('script:not([type^="math/tex"]),style,noscript,template,form,input,textarea,select,button,[contenteditable]:not([contenteditable="false"]),[data-testid="quoteTweet"],[data-testid="quotedTweet"],[data-testid="simpleTweet"]')) return null;
    // X cards are represented separately by selected safe link evidence, not copied UI.
    if (source.kind === 'x-post' && element.matches('[data-testid="card.wrapper"]')) return null;
    const copied = inert.createElementNS(element.namespaceURI, element.localName) as HTMLElement;
    for (const attribute of element.attributes) copied.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
    // Lazy sources are evidence already present in this document; never fetch here.
    if (copied.tagName === 'IMG') {
      const image = element as HTMLImageElement;
      const src = image.getAttribute('data-src') || image.currentSrc || image.getAttribute('src');
      if (src) copied.setAttribute('src', src);
    }
    for (const attribute of ['href', 'src']) {
      const value = copied.getAttribute(attribute);
      if (value) { try { copied.setAttribute(attribute, new URL(value, document.baseURI).href); } catch { /* Shared sanitizer removes invalid URLs. */ } }
    }
    for (const child of element.childNodes) { const value = clone(child, depth + 1); if (value) copied.append(value); }
    return copied;
  };
  for (const root of source.roots) { const copied = clone(root, 1); if (copied) container.append(copied); }
  for (const link of source.externalLinks ?? []) {
    const paragraph = inert.createElement('p');
    const anchor = inert.createElement('a'); anchor.setAttribute('href', link.url); anchor.textContent = link.text;
    paragraph.append(anchor); container.append(paragraph);
  }
  if (container.querySelector('iframe,object,embed')) source.warnings.push('Embedded or framed content is unavailable to this capture.');
  if (container.querySelector('[aria-expanded="false"],.RichContent--unescapable')) source.warnings.push('Collapsed content was not expanded; only loaded source is captured.');
  return container;
}

export function originalSourceSignature(document: Document, source: ArchiveSource, tree: HTMLElement): string {
  return JSON.stringify({ url: document.URL, language: document.documentElement.lang,
    canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? null,
    title: source.title, author: source.author, publishedAt: source.publishedAt, warnings: source.warnings, html: tree.outerHTML,
    stylesheets: collectOriginalStylesheets(document, normalizeCaptureUrl(document.URL)) });
}
