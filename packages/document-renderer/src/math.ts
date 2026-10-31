import katex from 'katex';
export const maxRenderedBytes = 4 * 1024 * 1024;
export const maxRenderedElements = 16000;
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
export const elementCount = (html: string): number => (html.match(/<[a-z][^>]*>/gi) ?? []).length;
export const htmlBytes = (html: string): number => new TextEncoder().encode(html).byteLength;
export function renderMath(latex: string, displayMode: boolean, warnings: string[], budget: {bytes:number;elements:number}): string {
  try {
    // Bound work before KaTeX allocates a DOM tree / HTML string. Macro definitions
    // can amplify even short input; preserve those formulas as readable source.
    if (latex.length > 2048 || /\\(?:def|gdef|edef|xdef|let|futurelet|newcommand|renewcommand|providecommand|global|expandafter|noexpand|csname|catcode)\b/.test(latex)) throw new Error('complexity');
    let depth = 0;
    for (const char of latex) {
      if (char === '{' && ++depth > 32) throw new Error('complexity');
      if (char === '}') depth--;
    }
    const html = katex.renderToString(latex, { displayMode, trust: false, maxExpand: 1000, maxSize: 20, throwOnError: true, strict: 'error', macros: { ...paperMacros } });
    if (htmlBytes(html) > budget.bytes || elementCount(html) > budget.elements) throw new Error('budget');
    return html;
  } catch {
    warnings.push('公式无法在显示预算内排版，已保留原始 LaTeX。');
    return `<code class="math-fallback">${escapeHtml(latex)}</code>`;
  }
}
// Text commands that papers use inside formulas and KaTeX lacks.
const paperMacros = { '\\textsc': '\\text{#1}', '\\mbox': '\\text{#1}' };
const unlimited = { bytes: maxRenderedBytes, elements: maxRenderedElements };
/** What a formula adds to a chunk once rendered, which its short source does not reveal. */
export function mathRenderCost(latex: string, displayMode: boolean): { bytes: number; elements: number } {
  const html = renderMath(latex, displayMode, [], unlimited);
  return { bytes: htmlBytes(html), elements: elementCount(html) };
}
