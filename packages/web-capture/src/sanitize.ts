import { snapshotInputSchema, sanitizedSnapshotSchema, pendingCaptureResourceSchema, type CaptureLimits, type PendingCaptureResource, type SanitizedSnapshot, type SnapshotInput } from '@pagelingo/document-contracts';
import { normalizeCaptureUrl, normalizeCaptureResourceUrl } from './fingerprint.js';
import { sanitizeMath } from './safe-math.js';
import { htmlTags, forbidden, containerTags, structuralTags, renamedTags, droppedTags, embeddedContentTags, literalTextTags, decorativeSvgTags } from './policy.js';
import { sanitizeStyle } from './styles.js';
import { attr, byteLength, check, detach, elements, isElement, isText, limitsFor, parseBounded, serialize, setAttr, textOf, unwrap, type ChildNode, type Element, type Parent, type Node } from './tree.js';

/** The runtime entry supplies DOMPurify; the root entry never imports a DOM. */
export interface SnapshotEnvironment {
  sanitizeHtml(html: string): string; limits?: CaptureLimits; resources?: readonly PendingCaptureResource[];
  /** The input is an entire page before article extraction, so its hidden menus and embeds say nothing about the article. */
  wholePage?: boolean;
}
const generalAttrs = new Set(['title', 'alt', 'lang', 'dir', 'colspan', 'rowspan', 'scope', 'start']);
const XHTML = 'http://www.w3.org/1999/xhtml' as Element['namespaceURI'];
const textNode = (value: string, parentNode: Parent): ChildNode => ({ nodeName: '#text', value, parentNode });
// Opening and closing rules follow Pandoc, so prices such as "$5 and $10" and "US$5-US$10" stay text.
const inlineDollarMath = /(?<![\\$\w])\$(?![\s$])((?:\\.|[^$\\])+?)(?<!\s)\$(?![\d$])/g;
/** Pages that render formulas in the browser ship raw TeX. Only those pages have dollar delimiters to interpret. */
function loadsMathEngine(root: Parent): boolean {
  return elements(root).some(node => (node.tagName === 'script' || node.tagName === 'link')
    && /mathjax|katex/i.test(`${attr(node, 'src') ?? ''} ${attr(node, 'href') ?? ''} ${node.tagName === 'script' ? textOf(node) : ''}`));
}
/** Rewrites each $...$ to the math/tex form the sanitizer already turns into a protected formula. */
function markDollarMath(root: Parent, limits: CaptureLimits): void {
  const pending: Parent[] = [root];
  while (pending.length) {
    const parent = pending.pop()!; const children: ChildNode[] = []; let changed = false;
    for (const child of parent.childNodes) {
      if (isElement(child) && !literalTextTags.has(child.tagName)) pending.push(child);
      if (!isText(child) || !child.value.includes('$')) { children.push(child); continue; }
      let cursor = 0;
      for (const match of child.value.matchAll(inlineDollarMath)) {
        if (byteLength(match[1]!) > limits.maxMathBytes) continue;
        if (match.index > cursor) children.push(textNode(child.value.slice(cursor, match.index), parent));
        const script: Element = { tagName: 'script', nodeName: 'script', namespaceURI: XHTML, attrs: [{ name: 'type', value: 'math/tex' }], childNodes: [], parentNode: parent };
        script.childNodes = [textNode(match[1]!, script)];
        children.push(script); cursor = match.index + match[0].length; changed = true;
      }
      if (cursor < child.value.length) children.push(cursor ? textNode(child.value.slice(cursor), parent) : child);
    }
    if (changed) parent.childNodes = children;
  }
}
const embeddedImage = /^image\/(?:svg\+xml|png|jpeg|gif|webp)$/i;
const texAnnotation = (math: Element) => elements(math).find(child => child.tagName === 'annotation' && attr(child, 'encoding') === 'application/x-tex' && textOf(child).trim());
/** Lazy-loading pages keep the real address beside a placeholder, or only in srcset. */
function imageSource(attrs: Element['attrs']): string | undefined {
  const value = (name: string) => attrs.find(item => item.name === name)?.value.trim() || undefined;
  const src = value('src');
  if (src && !src.startsWith('data:')) return src;
  const srcset = value('data-srcset') ?? value('srcset');
  return value('data-src') ?? value('data-original') ?? value('data-lazy-src') ?? srcset?.split(/,\s+/).at(-1)?.trim().split(/\s+/)[0] ?? src;
}
export function sanitizeSnapshot(value: SnapshotInput, environment: SnapshotEnvironment): SanitizedSnapshot {
  const limits = limitsFor(environment.limits);
  // Budget the raw string before any schema duplication or DOM parser work.
  check(byteLength(value.html) <= limits.maxHtmlBytes, 'HTML byte budget exceeded');
  const input = snapshotInputSchema.parse(value);
  const root = parseBounded(input.html, limits);
  if (loadsMathEngine(root)) markDollarMath(root, limits);
  const warnings = new Set(input.scope.warnings); const warn = (message: string) => { warnings.add(message); };
  // Warnings explain what changed. Only a loss the reader would notice makes the capture incomplete.
  let incomplete = false; const loss = (message: string) => { warn(message); incomplete = true; };
  check((environment.resources?.length ?? 0) <= limits.maxFiles, 'Replay resource budget exceeded');
  const registry = new Map((environment.resources ?? []).map(resource => { const parsed = pendingCaptureResourceSchema.parse(resource); return [parsed.id, parsed] as const; }));
  check(registry.size === (environment.resources?.length ?? 0), 'Duplicate replay resource ID');
  const resources: PendingCaptureResource[] = []; const resourceUrls = new Map<string, string>(); const origins = new Set<string>();
  // Descendants of a formula or a removed element need no separate decision.
  const settled = new Set<Element>(); let mathIndex = 0;
  for (const node of elements(root)) {
    if (!node.parentNode || settled.has(node)) continue;
    // The extension hides this wrapper in translation-only mode. Its children
    // are the original source, so unwrap it before ordinary hidden-state removal.
    if (node.tagName === 'span' && node.namespaceURI === 'http://www.w3.org/1999/xhtml'
      && attr(node, 'data-pl-source') !== undefined && attr(node, 'data-pl-owned') === undefined) {
      const parent = node.parentNode;
      const index = parent.childNodes.indexOf(node);
      parent.childNodes.splice(index, 1, ...node.childNodes);
      for (const child of node.childNodes) child.parentNode = parent;
      node.childNodes = [];
      node.parentNode = null;
      continue;
    }
    if (node.tagName === 'script' && /^math\/tex(?:;\s*mode=display)?$/i.test(attr(node, 'type') ?? '')) {
      const latex = textOf(node);
      check(byteLength(latex) <= limits.maxMathBytes, 'Math source byte budget exceeded');
      node.tagName = 'math'; node.nodeName = 'math'; node.namespaceURI = 'http://www.w3.org/1998/Math/MathML' as Element['namespaceURI']; node.attrs = [];
      const annotation: Element = { tagName: 'annotation', nodeName: 'annotation', namespaceURI: node.namespaceURI, attrs: [{ name: 'encoding', value: 'application/x-tex' }], childNodes: [], parentNode: node };
      annotation.childNodes = [{ nodeName: '#text', value: latex, parentNode: annotation }]; node.childNodes = [annotation];
    }
    // LaTeXML publishes figures as <object type="image/svg+xml">: an image, not an embedded document.
    const embeddedSource = ['object', 'embed'].includes(node.tagName) && embeddedImage.test(attr(node, 'type') ?? '') ? attr(node, node.tagName === 'object' ? 'data' : 'src') : undefined;
    if (embeddedSource) {
      for (const member of elements(node)) settled.add(member);
      const alt = attr(node, 'alt');
      node.tagName = 'img'; node.nodeName = 'img'; node.childNodes = [];
      node.attrs = [{ name: 'src', value: embeddedSource }, ...(alt ? [{ name: 'alt', value: alt }] : [])];
    }
    let tag = node.tagName;
    const hiddenByPage = attr(node, 'hidden') !== undefined || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(attr(node, 'style') ?? '');
    const concealed = hiddenByPage || attr(node, 'aria-hidden') === 'true' || attr(node, 'data-pl-owned') !== undefined;
    if (forbidden.has(tag) || concealed) {
      if (!['script', 'style', 'meta', 'base', 'link', 'noscript'].includes(tag) && attr(node, 'data-pl-owned') === undefined) {
        const hiddenReading = hiddenByPage && (!!textOf(node).trim() || elements(node).some(member => member.tagName === 'img'));
        (!environment.wholePage && (hiddenReading || embeddedContentTags.has(tag) && !concealed) ? loss : warn)(`Omitted unavailable or interactive content: ${tag}`);
      }
      for (const member of elements(node)) settled.add(member);
      detach(node); continue;
    }
    if (tag === 'svg' || tag === 'math') {
      for (const member of elements(node)) settled.add(member);
      const anchor = attr(node, 'data-pl-node');
      if (anchor && attr(node, 'id') === `pl_${anchor}`) node.attrs = node.attrs.filter(item => item.name !== 'id');
      node.attrs = node.attrs.filter(item => item.name !== 'data-pl-node');
      if (tag === 'svg') for (const member of elements(node)) if (decorativeSvgTags.has(member.tagName)) detach(member);
      const prefix = `pl_math${++mathIndex}`; let notes: string[] = [];
      let safe = sanitizeMath(node, prefix, limits, message => notes.push(message));
      const tex = !safe && tag === 'math' ? texAnnotation(node) : undefined;
      if (tex) {
        // The author's TeX is the authority: keep it when the rendered MathML uses elements outside the allow-list.
        node.attrs = []; node.childNodes = [tex]; tex.parentNode = node; tex.attrs = [{ name: 'encoding', value: 'application/x-tex' }];
        notes = []; safe = sanitizeMath(node, prefix, limits, message => notes.push(message));
      }
      notes.forEach(warn);
      if (!safe) {
        incomplete = true;
        // Keep readable evidence, never retain active unknown foreign markup.
        const label = `[Unsupported ${tag === 'svg' ? 'figure' : 'formula'}: see original source]`;
        node.tagName = 'span'; node.nodeName = 'span'; node.namespaceURI = 'http://www.w3.org/1999/xhtml' as Element['namespaceURI']; node.attrs = [];
        node.childNodes = [{ nodeName: '#text', value: label, parentNode: node }];
      }
      continue;
    }
    if (node.namespaceURI !== XHTML || droppedTags.has(tag)) { for (const member of elements(node)) settled.add(member); detach(node); continue; }
    if (!htmlTags.has(tag)) {
      const renamed = renamedTags.get(tag);
      if (!renamed) {
        const quote = tag === 'q' && node.parentNode;
        unwrap(node, quote ? [textNode('“', quote)] : [], quote ? [textNode('”', quote)] : []);
        continue;
      }
      node.tagName = renamed; node.nodeName = renamed; tag = renamed;
    }
    const original = [...node.attrs]; node.attrs = [];
    if (tag === 'span' && original.some(item => item.name === 'data-pl-run' && item.value === '1')) setAttr(node, 'data-pl-run', '1');
    const sourceId = original.find(item => item.name === 'id')?.value;
    if (sourceId) setAttr(node, 'data-pl-source-id', sourceId);
    if (tag === 'th' || tag === 'td') {
      const headers = original.find(item => item.name === 'headers')?.value;
      const replayHeaders = original.find(item => item.name === 'data-pl-headers')?.value;
      if (headers) setAttr(node, 'headers', headers);
      else if (replayHeaders) setAttr(node, 'headers', replayHeaders.split(/\s+/).map(id => `pl_${id}`).join(' '));
    }
    for (const item of original) {
      if (generalAttrs.has(item.name)) {
        if (['rowspan', 'colspan', 'start'].includes(item.name) && !/^[1-9][0-9]{0,2}$/.test(item.value)) continue;
        setAttr(node, item.name, item.value);
      } else if (item.name === 'style') {
        const safe = sanitizeStyle(item.value); if (safe) setAttr(node, 'style', safe);
      } else if (item.name === 'href' && tag === 'a') {
        try { const url = new URL(item.value, input.url); if (['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password) setAttr(node, 'href', url.href); } catch { warn('Removed invalid source link'); }
      }
    }
    if (tag === 'img') {
      const placeholder = original.find(a => a.name === 'data-pl-resource')?.value;
      const registered = placeholder ? registry.get(placeholder) : undefined;
      const raw = imageSource(original) ?? registered?.url;
      try {
        check(raw, 'not-loaded'); const url = normalizeCaptureResourceUrl(new URL(raw, input.url).href, input.url);
        if (!url.startsWith('data:')) origins.add(new URL(url).origin); check(origins.size <= limits.maxResourceOrigins, 'Resource origin budget exceeded');
        let id = resourceUrls.get(url);
        if (!id) { check(resources.length < limits.maxFiles - 1, 'Resource file budget exceeded'); if (registered) { check(registered.url === url && registered.role === 'image', 'Replay resource URL mismatch'); id = registered.id; }
          else { let counter = resources.length + 1; do { id = `r_${counter++}`; } while (registry.has(id) || resources.some(resource => resource.id === id)); }
          resourceUrls.set(url, id); resources.push({ id, url, role: 'image' }); }
        setAttr(node, 'data-pl-resource', id);
      } catch (error) {
        if (error instanceof Error && /budget/.test(error.message)) throw error;
        loss(`Image unavailable: ${raw ? 'unsupported or invalid URL' : 'not-loaded'}`);
      }
    }
  }
  if (root.childNodes.some(node => isText(node) && node.value.trim())) {
    const wrapper: Element = { tagName: 'div', nodeName: 'div', namespaceURI: 'http://www.w3.org/1999/xhtml' as Element['namespaceURI'], attrs: [], childNodes: root.childNodes, parentNode: root };
    for (const child of wrapper.childNodes) child.parentNode = wrapper; root.childNodes = [wrapper];
  }
  // Network-bearing attributes are gone before DOMPurify gets a native document.
  const first = environment.sanitizeHtml(serialize(root));
  const normalized = parseBounded(first, limits);
  anchorMixedRuns(normalized);
  let sequence = 0; const sourceIds = new Map<string, Element | null>();
  for (const node of elements(normalized)) {
    // Formula descendants retain only fragment IDs, not reader anchors.
    let parent = node.parentNode; let inMath = false;
    while (parent && isElement(parent)) { if (parent.tagName === 'svg' || parent.tagName === 'math') { inMath = true; break; } parent = parent.parentNode; }
    if (inMath) continue;
    const sourceId = attr(node, 'data-pl-source-id');
    if (sourceId) sourceIds.set(sourceId, sourceIds.has(sourceId) ? null : node);
    node.attrs = node.attrs.filter(item => item.name !== 'data-pl-source-id');
    const id = `s_${++sequence}`; setAttr(node, 'data-pl-node', id); setAttr(node, 'id', `pl_${id}`);
  }
  const tableAncestor = (element: Element): Element | null => {
    let parent = element.parentNode;
    while (parent && isElement(parent)) { if (parent.tagName === 'table') return parent; parent = parent.parentNode; } return null;
  };
  for (const node of elements(normalized)) {
    const headers = attr(node, 'headers'); if (!headers) continue;
    const targets = headers.trim().split(/\s+/).flatMap(id => {
      const target = sourceIds.get(id);
      if (!target || target.tagName !== 'th' || tableAncestor(target) !== tableAncestor(node)) { warn('Unresolved or ambiguous table header reference'); return []; }
      return [attr(target, 'data-pl-node')!];
    });
    node.attrs = node.attrs.filter(item => item.name !== 'headers');
    if (targets.length) setAttr(node, 'data-pl-headers', [...new Set(targets)].join(' '));
  }
  const finalHtml = environment.sanitizeHtml(serialize(normalized));
  const final = parseBounded(finalHtml, limits);
  const nodeIds: string[] = []; const seenNodeIds = new Set<string>(); const used = new Set<string>();
  for (const node of elements(final)) {
    check(!forbidden.has(node.tagName), 'Final sanitizer retained active content');
    for (const item of node.attrs) {
      check(!/^on/i.test(item.name) && !['src', 'srcset', 'srcdoc', 'action', 'poster', 'background'].includes(item.name), 'Final sanitizer retained network or event attribute');
      if (item.name === 'style') check(sanitizeStyle(item.value) === item.value, 'Final sanitizer changed validated CSS');
      if (item.name === 'href' && node.tagName !== 'a') check(item.value.startsWith('#'), 'Final math reference is external');
    }
    const id = attr(node, 'data-pl-node');
    if (id) { check(attr(node, 'id') === `pl_${id}` && !seenNodeIds.has(id), 'Final sanitizer changed node anchors'); nodeIds.push(id); seenNodeIds.add(id); }
    const resource = attr(node, 'data-pl-resource'); if (resource) { check(resources.some(r => r.id === resource), 'Unregistered snapshot resource'); used.add(resource); }
  }
  const complete = input.scope.completeWithinScope && !incomplete;
  return sanitizedSnapshotSchema.parse({ html: serialize(final), sourceUrl: normalizeCaptureUrl(input.url),
    scope: { ...input.scope, rootNodeId: nodeIds[0] ?? input.scope.rootNodeId, completeWithinScope: complete, warnings: [...warnings] },
    nodeIds, resources: resources.filter(resource => used.has(resource.id)), warnings: [...warnings],
  });
}

/** A container may produce several independently previewed text runs. Give each
 * run its own final source element before IDs are assigned; replay keeps it. */
function anchorMixedRuns(root: Parent): void {
  const isStructural = (node: Node): boolean => isElement(node)
    && (structuralTags.has(node.tagName) || attr(node, 'data-pl-run') === '1');
  for (const element of elements(root)) {
    if (!containerTags.has(element.tagName) || !element.childNodes.some(isStructural)) continue;
    const children: Element['childNodes'] = [];
    let pending: Element['childNodes'] = [];
    const flush = () => {
      if (!pending.length) return;
      if (pending.some(node => isElement(node) || (isText(node) && node.value.trim()))) {
        const run: Element = {
          tagName: 'span', nodeName: 'span', namespaceURI: element.namespaceURI,
          attrs: [{ name: 'data-pl-run', value: '1' }], childNodes: pending, parentNode: element,
        };
        for (const child of pending) child.parentNode = run;
        children.push(run);
      } else children.push(...pending);
      pending = [];
    };
    for (const child of element.childNodes) {
      if (isStructural(child)) { flush(); children.push(child); }
      else pending.push(child);
    }
    flush();
    element.childNodes = children;
  }
}
