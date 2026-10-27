import createDOMPurify, { type WindowLike } from 'dompurify';
import type { SnapshotEnvironment } from './sanitize.js';
export function domEnvironment(window: WindowLike): SnapshotEnvironment {
  const purify = createDOMPurify(window);
  return { sanitizeHtml: html => purify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    ADD_TAGS: ['use', 'semantics', 'annotation'], ADD_ATTR: ['data-pl-node', 'data-pl-run', 'data-pl-resource', 'data-pl-source-id', 'data-pl-headers', 'encoding'],
    ALLOW_DATA_ATTR: false, SANITIZE_DOM: true,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'select', 'button', 'meta', 'base', 'link'],
    FORBID_ATTR: ['src', 'srcset', 'srcdoc', 'action', 'formaction', 'poster', 'background', 'target', 'name'],
  }) };
}
