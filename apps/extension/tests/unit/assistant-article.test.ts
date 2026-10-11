import { beforeEach, expect, it } from 'vitest';
import { readArticle } from '../../src/assistant/article';
beforeEach(() => {
  document.body.innerHTML =
    '<main><article><h1>NumPy Guide</h1><p id="p">Use <code>np.reshape</code> to reshape arrays.</p><pre id="code"><code>x = np.reshape(a, (2, 3))\n    print(x)</code></pre><p>Another paragraph.</p></article></main>';
  document.getSelection()?.removeAllRanges();
});
it('extracts original prose and complete code blocks with section metadata', () => {
  const data = readArticle(document).document;
  expect(data.blocks).toHaveLength(4);
  expect(data.blocks[2].kind).toBe('code');
  expect(data.blocks[2].text).toContain('\n    print(x)');
  expect(data.blocks[2].sectionPath).toEqual(['NumPy Guide']);
});
it('excludes generated translations even when original source wrappers are hidden', () => {
  const p = document.querySelector('#p')!;
  const original = p.innerHTML;
  p.innerHTML = `<span data-pl-source="b1" style="display:none">${original}</span><span data-pl-owned="translation" data-pl-block="b1">中文测试译文</span>`;
  const data = readArticle(document).document;
  expect(data.blocks[1].text).toContain('np.reshape');
  expect(JSON.stringify(data)).not.toContain('中文测试译文');
});
it('captures code selection as a quote without rewriting whitespace', () => {
  const node = document.querySelector('#code code')!.firstChild!;
  const range = document.createRange();
  range.selectNodeContents(node);
  document.getSelection()!.addRange(range);
  const data = readArticle(document);
  expect(data.quote?.kind).toBe('code');
  expect(data.quote?.text).toContain('\n    print');
  expect(data.quote?.blockIds).toEqual(['r2']);
});
it('prefers the matching native code range when context-menu text collapses whitespace', () => {
  const code = '    np.reshape(x, (2, 3))\n        print(x)\n';
  const pre = document.querySelector('#code')!;
  pre.textContent = code;
  const range = document.createRange();
  range.selectNodeContents(pre);
  document.getSelection()!.addRange(range);
  const result = readArticle(document, code.replace(/\s+/g, ' ').trim());
  expect(result.quote?.text).toBe(code);
  expect(result.quote?.kind).toBe('code');
});
it('maps selected Chinese back to the source paragraph when a binding exists', () => {
  const p = document.querySelector('#p')!;
  p.innerHTML =
    '<span data-pl-source="b1">Use np.reshape to reshape arrays.</span><span data-pl-owned="translation">使用 np.reshape 改变数组形状。</span>';
  const range = document.createRange();
  range.selectNodeContents(p.lastChild!);
  document.getSelection()!.addRange(range);
  const data = readArticle(document);
  expect(data.quote?.text).toContain('使用');
  expect(data.quote?.originalText).toContain('Use np.reshape');
});
it('retains a context-menu selection if focus has cleared the browser range', () => {
  const data = readArticle(document, 'selected reference');
  expect(data.quote?.text).toBe('selected reference');
  expect(data.quote?.blockIds).toEqual([]);
});
it('preserves indentation on the first code line and trailing newlines', () => {
  const code = '    result = np.reshape(x, (2, 3))\n        print(result)\n';
  document.querySelector('#code')!.textContent = code;
  expect(readArticle(document, '').document.blocks.find((b) => b.kind === 'code')?.text).toBe(code);
});
it('includes standalone image descriptions and warns when their contents cannot be read', () => {
  document
    .querySelector('article')!
    .insertAdjacentHTML(
      'beforeend',
      '<figure><img alt="Architecture overview"><figcaption>The pipeline</figcaption></figure><figure><img src="diagram.png"></figure>',
    );
  const data = readArticle(document, '').document;
  expect(JSON.stringify(data.blocks)).toContain('Architecture overview');
  expect(data.warnings).toHaveLength(1);
});
