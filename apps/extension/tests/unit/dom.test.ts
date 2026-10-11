import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractBlocks } from '../../src/dom/extractor';
import { DomRenderer, restoreFragment } from '../../src/dom/renderer';
import { protectNodes } from '../../src/dom/protect';
import { validateBatch, validateStructure } from '@pagelingo/translation-core';

function loadFixture(name: string) {
  const html = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures', `${name}.html`), 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
}

const nativeComputedStyle = window.getComputedStyle.bind(window);
beforeEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  // jsdom 29 has no MathML style declaration and throws on getComputedStyle(math).
  // Unit tests cover structure; actual MathML visibility is exercised in Chromium.
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    if (element.namespaceURI === 'http://www.w3.org/1998/Math/MathML') {
      const surrogate = document.createElement('span');
      surrogate.setAttribute('style', element.getAttribute('style') ?? '');
      return nativeComputedStyle(surrogate, pseudo);
    }
    return nativeComputedStyle(element, pseudo);
  });
});

describe('semantic block extraction', () => {
  it('exports portable blocks with section hierarchy and keeps hidden heading content out of context', async () => {
    document.body.innerHTML = '<main><h1>Paper</h1><h2>Methods<span hidden>secret</span></h2><h3>Training</h3><p>First paragraph.</p><h2>Results</h2><p>Second paragraph.</p><p><span hidden>Only hidden content</span></p></main>';
    const blocks = await extractBlocks(document);
    expect(blocks.find((block) => block.input.sourceText === 'First paragraph.')?.block.sectionPath).toEqual(['Paper', 'Methods', 'Training']);
    expect(blocks.find((block) => block.input.sourceText === 'Second paragraph.')?.block.sectionPath).toEqual(['Paper', 'Results']);
    expect(JSON.stringify(blocks.map((block) => block.block))).not.toMatch(/secret|Only hidden content/);
    expect(blocks.filter((block) => block.block.kind === 'heading')).toHaveLength(4);
  });

  it('owns nested text once while preserving parent list text around child lists', async () => {
    loadFixture('arxiv');
    const blocks = await extractBlocks(document);
    const sources = blocks.map((block) => block.input.sourceText);
    expect(sources.filter((text) => text.includes('Remove invalid records.'))).toEqual(['Remove invalid records.']);
    expect(sources).toContain('Prepare the dataset.');
    expect(sources).toContain('Then verify the sample count.');
    expect(sources.filter((text) => text.includes('Scaling does not'))).toHaveLength(1);
    expect(sources.filter((text) => text.includes('Our approach'))).toEqual(['Our approach']);
    expect(sources.join('\n')).not.toMatch(/Publisher footer|navigation should|Invisible metadata|User editing area|publisher annotation|import torch/);
    expect(blocks.find((block) => block.parent.id === 'math-paragraph')?.canHideSource).toBe(false);
    expect(blocks.find((block) => block.parent.id === 'code-paragraph')?.input.protectedText).not.toContain('torch.compile');
  });

  it('keeps natural language inside formatting and links translatable', async () => {
    document.body.innerHTML = '<main><p>A <strong>reliable <em>system</em></strong> uses <a href="https://example.com">previous work</a>.</p></main>';
    const [block] = await extractBlocks(document);
    expect(block.input.protectedText).toContain('reliable');
    expect(block.input.protectedText).toContain('previous work');
    expect(block.input.slots.filter((slot) => slot.kind === 'open')).toHaveLength(3);
    expect(validateStructure(block.input, block.input.protectedText)).toEqual([]);
  });

  it('omits zero-width heading anchors from model data while preserving their original navigation', async () => {
    document.body.innerHTML = '<main><h2 id="notice">Notice<a id="anchor" href="#notice" aria-label="Direct link">\u200b</a></h2><p>Read <a href="https://example.com">the guide</a>.</p></main>';
    const original = document.body.innerHTML;
    const anchor = document.getElementById('anchor')!;
    const parent = anchor.parentNode;
    const [heading, paragraph] = await extractBlocks(document);
    expect(heading.input.protectedText).toBe('Notice');
    expect(heading.input.slots).toHaveLength(0);
    expect(paragraph.input.slots).toHaveLength(2);
    expect(paragraph.block.sectionPath).toEqual(['Notice']);
    const renderer = new DomRenderer();
    renderer.render(heading, '注意');
    renderer.setMode('translation');
    expect(anchor.parentNode).toBe(parent);
    expect(anchor.isConnected).toBe(true);
    expect(anchor.closest('[data-pl-source]')).toBeNull();
    renderer.restore();
    expect(document.body.innerHTML).toBe(original);
  });

  it('does not translate a formula, code-only paragraph, URL or number by itself', async () => {
    document.body.innerHTML = '<article><h2>Results</h2><p><code>foo()</code></p><p><math><mi>x</mi></math></p><p>123.4</p><p>https://example.com</p></article>';
    const blocks = await extractBlocks(document);
    expect(blocks.map((block) => block.input.sourceText)).toEqual(['Results']);
  });

  it('excludes content in hidden ancestors and keeps offscreen text', async () => {
    document.body.innerHTML = '<main><div style="display:none"><p>Hidden text.</p></div><div style="margin-top:10000px"><p>Offscreen text.</p></div></main>';
    expect((await extractBlocks(document)).map((block) => block.input.sourceText)).toEqual(['Offscreen text.']);
  });

  it('does not include hidden or editable inline content in serializable input', async () => {
    document.body.innerHTML = '<p>Visible <span hidden>hidden secret</span><span contenteditable="true">private draft</span><button>internal control</button><code hidden>secret()</code> text.</p>';
    const [block] = await extractBlocks(document);
    expect(block.input.sourceText).toBe('Visible  text.');
    expect(JSON.stringify(block.input)).not.toMatch(/secret|draft|control/);
    expect(block.canHideSource).toBe(false);
  });
});

describe('reversible rendering', () => {
  for (const fixture of ['arxiv', 'github-readme', 'technical-doc']) {
    it(`preserves original nodes and restores exact markup in ${fixture}`, async () => {
      loadFixture(fixture);
      const original = document.body.innerHTML;
      const elements = Array.from(document.body.querySelectorAll('*'));
      const blocks = await extractBlocks(document);
      const renderer = new DomRenderer();
      for (const block of blocks) expect(renderer.render(block, `预览：${block.input.protectedText}`)).toBe(true);
      expect(document.querySelectorAll('tr > [data-pl-owned],ul > [data-pl-owned],ol > [data-pl-owned]')).toHaveLength(0);
      for (const mode of ['source', 'translation', 'bilingual', 'translation', 'source'] as const) renderer.setMode(mode);
      expect(elements.every((element) => element.isConnected)).toBe(true);
      renderer.restore();
      expect(document.body.innerHTML).toBe(original);
      expect(elements.every((element) => element.isConnected)).toBe(true);
    });
  }

  it('keeps original listeners, restores URLs locally, and never duplicates IDs', async () => {
    document.body.innerHTML = '<article><p id="paragraph">Read <a id="original-link" href="https://example.com/paper" target="_blank">the paper</a>.</p></article>';
    const anchor = document.getElementById('original-link')!;
    let clicks = 0;
    anchor.addEventListener('click', (event) => { event.preventDefault(); clicks++; });
    const [block] = await extractBlocks(document);
    const renderer = new DomRenderer();
    renderer.render(block, block.input.protectedText);
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(clicks).toBe(1);
    expect(document.querySelectorAll('#original-link')).toHaveLength(1);
    expect(document.querySelector<HTMLAnchorElement>('[data-pl-owned] a')?.href).toBe('https://example.com/paper');
    renderer.restore();
    expect(document.getElementById('original-link')).toBe(anchor);
  });

  it('retains complex original content in translation mode', async () => {
    document.body.innerHTML = '<article><p>Loss <math id="math"><mi>x</mi></math> decreases.</p><p><button>Action</button> has side effects.</p></article>';
    const math = document.getElementById('math')!;
    const mathParent = math.parentNode;
    const blocks = await extractBlocks(document);
    const renderer = new DomRenderer();
    for (const block of blocks) renderer.render(block, block.input.protectedText);
    renderer.setMode('translation');
    expect(renderer.fallbackCount).toBe(2);
    expect(math.parentNode).toBe(mathParent);
    expect(math.closest('[data-pl-source]')).toBeNull();
    expect(document.querySelectorAll('math')).toHaveLength(1);
  });

  it('renders HTML-looking output as text and rejects mutated source blocks', async () => {
    document.body.innerHTML = '<p>Original paragraph.</p>';
    const [block] = await extractBlocks(document);
    const fragment = restoreFragment(block, '<img src=x onerror="alert(1)">');
    expect(fragment.querySelector('img')).toBeNull();
    expect(fragment.textContent).toContain('<img');
    block.nodes[0].textContent = 'Updated by the host application.';
    expect(new DomRenderer().render(block, 'Stale output')).toBe(false);
  });

  it('preserves host-inserted children when removing a source wrapper', async () => {
    document.body.innerHTML = '<p>Original paragraph.</p>';
    const [block] = await extractBlocks(document);
    const renderer = new DomRenderer();
    renderer.render(block, block.input.protectedText);
    document.querySelector('[data-pl-source]')!.append(' Added by the host.');
    renderer.restore();
    expect(document.querySelector('p')!.textContent).toBe('Original paragraph. Added by the host.');
  });
});

describe('placeholder contract', () => {
  it('protects placeholder-like literal source text without collisions', () => {
    document.body.innerHTML = '<p>A literal ⟦<span>A0</span>⟧ and <code>foo()</code>.</p>';
    const parent = document.querySelector('p')!;
    const block = protectNodes(parent, Array.from(parent.childNodes), 'b0');
    expect(validateStructure(block.input, block.input.protectedText)).toEqual([]);
    expect(restoreFragment(block, block.input.protectedText).textContent).toBe('A literal ⟦A0⟧ and foo().');
  });

  it('rejects missing, duplicate, unknown and misnested markers', async () => {
    document.body.innerHTML = '<p><strong>A <em>nested</em> term</strong> with <code>code()</code>.</p>';
    const [block] = await extractBlocks(document);
    const text = block.input.protectedText;
    const first = block.input.slots[0].token;
    expect(validateStructure(block.input, text.replace(first, ''))).not.toHaveLength(0);
    expect(validateStructure(block.input, text + first)).not.toHaveLength(0);
    expect(validateStructure(block.input, text + '⟦A999⟧')).not.toHaveLength(0);
    expect(validateStructure(block.input, text + '⟦UNKNOWN⟧')).not.toHaveLength(0);
    expect(validateStructure(block.input, text.replace('⟦E1⟧', '⟦E0⟧').replace(/⟦E0⟧([^⟦]*)with/, '⟦E1⟧$1with'))).not.toHaveLength(0);
  });

  it('rejects missing, duplicate, unknown IDs and malformed JSON shapes', async () => {
    document.body.innerHTML = '<p>First paragraph.</p><p>Second paragraph.</p>';
    const inputs = (await extractBlocks(document)).map((block) => block.input);
    expect(() => validateBatch(inputs, { translations: [{ id: 'b0', text: 'First' }] })).toThrow();
    expect(() => validateBatch(inputs, { translations: [{ id: 'b0', text: 'First' }, { id: 'b0', text: 'Again' }] })).toThrow();
    expect(() => validateBatch(inputs, { translations: [{ id: 'unknown', text: 'First' }] })).toThrow();
    expect(() => validateBatch(inputs, { translations: 'wrong' })).toThrow();
  });
});
