export const BLOCK_SELECTOR = 'p,li,blockquote,figcaption,td,th,h1,h2,h3,h4,h5,h6,dt,dd';
export const EXCLUDED_SELECTOR = [
  'script', 'style', 'noscript', 'template', 'textarea', 'input', 'select', 'option',
  'button', 'canvas', 'svg', 'video', 'audio', 'iframe', 'pre', 'nav', 'aside', 'footer',
  '[contenteditable]:not([contenteditable="false"])', '[translate="no"]', '.notranslate',
  '[role="navigation"]', '[role="menu"]', '[role="button"]', '[hidden]', '[inert]',
  '[aria-hidden="true"]', '[data-pl-owned]',
  '[data-testid="markdown-code-block"]',
].join(',');
export const MATH_SELECTOR = 'math,mjx-container,.katex,.katex-display,.MathJax,.MathJax_Display';
export const CODE_SELECTOR = 'code,kbd,samp';

export function isExcluded(element: Element): boolean {
  return Boolean(element.closest(EXCLUDED_SELECTOR));
}

export function isVisible(element: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
    if (current.hasAttribute('hidden')) return false;
  }
  // Offscreen blocks are still part of a full-page translation.
  return true;
}

export function findContentRoot(document: Document): HTMLElement {
  for (const selector of ['.ltx_document', 'article.markdown-body', '.markdown-body', 'main article', 'article', 'main', '[role="main"]']) {
    const roots = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(isVisible);
    roots.sort((a, b) => (b.textContent?.length ?? 0) - (a.textContent?.length ?? 0));
    if (roots[0]) return roots[0];
  }
  return document.body;
}
