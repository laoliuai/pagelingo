/** Local style bindings. CSS never enters a provider request or model response. */
export interface InlineAppearance {
  color?: string;
  backgroundColor?: string;
  fontWeight?: string;
  fontStyle?: string;
  textDecorationLine?: string;
}

export function captureAppearance(element: Element): InlineAppearance {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!style) return {};
  const result: InlineAppearance = {};
  if (/^rgba?\([\d.,%\s]+\)$/.test(style.color)) result.color = style.color;
  if (/^rgba?\([\d.,%\s]+\)$/.test(style.backgroundColor)) result.backgroundColor = style.backgroundColor;
  if (/^(normal|bold|[1-9]\d{0,3})$/.test(style.fontWeight)) result.fontWeight = style.fontWeight;
  if (/^(normal|italic|oblique)$/.test(style.fontStyle)) result.fontStyle = style.fontStyle;
  if (/^(none|(?:underline|overline|line-through)(?: (?:underline|overline|line-through))*)$/.test(style.textDecorationLine)) {
    result.textDecorationLine = style.textDecorationLine;
  }
  return result;
}

export function restoreVisualLiteral(original: Element, document: Document): HTMLElement {
  const element = document.createElement('span');
  element.textContent = original.textContent;
  const appearance = captureAppearance(original);
  if (appearance.backgroundColor) element.style.backgroundColor = appearance.backgroundColor;
  if (original.matches('.pl-completion-slot')) {
    element.className = 'pl-completion-slot';
    element.dataset.plPreserve = 'blank';
    element.setAttribute('aria-label', '待补全文本');
    const width = (original as HTMLElement).style.getPropertyValue('--pl-slot-width').trim();
    if (/^\d+(?:\.\d+)?em$/.test(width) && Number.parseFloat(width) > 0 && Number.parseFloat(width) <= 64) {
      element.style.setProperty('--pl-slot-width', width);
    }
  } else {
    element.className = 'pl-prompt-placeholder';
    element.dataset.plPreserve = 'placeholder';
  }
  return element;
}
