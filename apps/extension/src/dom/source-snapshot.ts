import { EXCLUDED_SELECTOR, MATH_SELECTOR } from './selectors';

// These attributes affect extraction, inline restoration or source visibility.
// Layout styles, generated class names and tracking attributes do not.
const SOURCE_ATTRIBUTES = new Set([
  'href', 'target', 'lang', 'dir', 'role', 'aria-level', 'aria-hidden', 'hidden', 'inert',
  'translate', 'contenteditable', 'data-block', 'data-testid', 'encoding',
  'mathvariant', 'mathsize', 'mathcolor', 'mathbackground', 'display', 'displaystyle',
  'scriptlevel', 'linethickness', 'stretchy', 'fence', 'separator', 'accent', 'accentunder',
]);
const SOURCE_CLASSES = /^(?:notranslate|katex(?:-display)?|MathJax(?:_Display)?|longform-unstyled|public-DraftStyleDefault-block|markdown-body|ltx_document)$/;
const TRACKING_ATTRIBUTE = /^data-(?:render-revision|layout-revision|tracking(?:-.*)?|analytics(?:-.*)?|telemetry(?:-.*)?)$/;

function snapshot(node: Node, protectedMath = false): unknown {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const element = node as Element;
  if (element.hasAttribute('data-pl-owned')) return null;
  if (element.hasAttribute('data-pl-source')) return children(element, protectedMath);
  protectedMath ||= element.matches(MATH_SELECTOR);
  const attributes = Array.from(element.attributes)
    .filter(attribute => protectedMath ? !['style', 'class'].includes(attribute.name) && !TRACKING_ATTRIBUTE.test(attribute.name)
      : SOURCE_ATTRIBUTES.has(attribute.name) || attribute.name.startsWith('on'))
    .map(attribute => [attribute.name, attribute.value]).sort(([a], [b]) => a!.localeCompare(b!));
  const classes = Array.from(element.classList).filter(name => SOURCE_CLASSES.test(name)).sort();
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const hidden = style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse';
  // SVG is page UI outside mathematics, but its glyphs/references/geometry are
  // part of a protected MathJax formula and must participate in every guard.
  const excluded = !protectedMath && (element.matches(EXCLUDED_SELECTOR) || element.matches('img,picture,object,embed'));
  return [element.tagName, attributes, classes, hidden, excluded ? null : children(element, protectedMath)];
}

function children(element: Element, protectedMath: boolean): unknown[] {
  return Array.from(element.childNodes).flatMap(node => {
    const value = snapshot(node, protectedMath);
    // Source wrappers are transparent, and extension output is absent.
    return value === null ? [] : node.nodeType === Node.ELEMENT_NODE && (node as Element).hasAttribute('data-pl-source')
      ? value as unknown[] : [value];
  });
}

export function snapshotSourceNodes(nodes: readonly Node[]): string {
  return JSON.stringify(nodes.flatMap(node => {
    const value = snapshot(node);
    return value === null ? [] : node.nodeType === Node.ELEMENT_NODE && (node as Element).hasAttribute('data-pl-source')
      ? value as unknown[] : [value];
  }));
}
