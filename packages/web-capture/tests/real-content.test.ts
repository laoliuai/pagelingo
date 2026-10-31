import { describe, expect, it } from 'vitest';
import { naturalText } from '@pagelingo/document-contracts';
import { projectWebReader } from '../src/index.js';
import { sanitizeNodeSnapshot } from '../src/node.js';
import { manifestFor, projectionOptions, snapshotInput } from './helpers.js';

// Each case reproduces content that real articles and arXiv HTML papers lost or failed on.
const sanitize = (html: string) => sanitizeNodeSnapshot(snapshotInput(html));
const project = async (html: string) => {
  const snapshot = sanitize(html);
  const manifest = await manifestFor(snapshot);
  return { snapshot, ir: await projectWebReader(snapshot, manifest, projectionOptions(manifest)) };
};
const textBlocks = (ir: Awaited<ReturnType<typeof project>>['ir']) => ir.blocks.flatMap(block => block.type === 'text' ? [naturalText(block.value.content)] : []);

describe('long documents', () => {
  it('budgets actual nodes rather than text tokens', () => {
    const words = Array.from({ length: 60000 }, (_, index) => `word${index}`).join(' ');
    const snapshot = sanitize(`<article><p>${words}</p></article>`);
    expect(snapshot.html).toContain('word59999');
  });
  it('still rejects documents with too many real nodes', () => {
    expect(() => sanitize(`<article>${'<i>x</i>'.repeat(30000)}</article>`)).toThrow(/budget/);
  });
});

describe('content inside elements without a dedicated rule', () => {
  it.each(['cite', 'dfn', 'ins', 'bdi', 'font', 'nobr', 'label', 'data', 'output', 'x-custom', 'd-article'])('keeps the words inside <%s>', tag => {
    const snapshot = sanitize(`<article><p>before <${tag}>KEPT</${tag}> after</p></article>`);
    expect(snapshot.html).toContain('KEPT');
    expect(snapshot.html).not.toContain(`<${tag}`);
  });
  it.each(['kbd', 'samp', 'tt', 'var'])('protects <%s> from translation as code', async tag => {
    const { ir } = await project(`<article><p>Press <${tag}>Ctrl</${tag}> now</p></article>`);
    const block = ir.blocks[0];
    if (block?.type !== 'text') throw new Error('text block expected');
    expect(naturalText(block.value.content)).toBe('Press  now');
    expect(block.bindings).toContainEqual(expect.objectContaining({ kind: 'protected', object: { type: 'code', text: 'Ctrl' } }));
  });
  it('keeps quotation marks around <q>', () => {
    expect(sanitize('<article><p>He said <q>never</q> twice</p></article>').html).toContain('“never”');
  });
  it('keeps collapsed sections as separate readable blocks', async () => {
    const { ir } = await project('<article><details><summary>Proof</summary><p>The hidden step.</p></details><center>Centered</center></article>');
    expect(textBlocks(ir)).toEqual(['Proof', 'The hidden step.', 'Centered']);
  });
  it('registers the image inside <picture>', () => {
    const snapshot = sanitize('<article><p><picture><source srcset="/wide.webp"><img src="/plain.png" alt="diagram"></picture></p></article>');
    expect(snapshot.resources.map(resource => resource.url)).toEqual(['https://e.test/plain.png']);
  });
  it('cannot bring active content in through an unknown wrapper', () => {
    const snapshot = sanitize('<article><x-frame onclick="x()"><script>x()</script><iframe src="https://evil.test"></iframe><p>Read me</p></x-frame></article>');
    expect(snapshot.html).toContain('Read me');
    expect(snapshot.html).not.toMatch(/x-frame|onclick|<script|iframe|evil/);
  });
  it('escapes raw-text elements when their content becomes ordinary text', () => {
    const snapshot = sanitize('<article><xmp><script>x()</script></xmp></article>');
    expect(snapshot.html).not.toContain('<script');
    expect(snapshot.html).toContain('&lt;script');
  });
  it('produces a stable result when sanitized again', () => {
    const once = sanitize('<article><p>a <cite>b</cite> <q>c</q> <kbd>d</kbd></p><details><summary>e</summary>f</details><x-y>g</x-y></article>');
    expect(sanitize(once.html).html).toBe(once.html);
  });
});

describe('completeness', () => {
  it.each([
    ['page title', '<title>Tab</title><article><p>Body</p></article>'],
    ['interactive controls', '<article><button>Copy</button><p>Body</p><input></article>'],
    ['decorative and empty hidden elements', '<article><span aria-hidden="true">#</span><div hidden></div><iframe hidden src="https://e.test/t"></iframe><p>Body</p></article>'],
    ['unwrapped elements', '<article><p><cite>Body</cite></p></article>'],
  ])('ignores %s', (_name, html) => {
    expect(sanitize(html).scope.completeWithinScope).toBe(true);
  });
  it('still reports embedded content that was not saved', () => {
    const { scope } = sanitize('<article><p>Body</p><iframe src="https://video.test/1"></iframe></article>');
    expect(scope.completeWithinScope).toBe(false);
    expect(scope.warnings.join(' ')).toContain('iframe');
  });
  it('reports text hidden inside a selected scope, but not hidden menus on a whole page', () => {
    const html = '<article><p>Body</p><div style="display:none">Collapsed answer</div><iframe src="https://ad.test/1"></iframe></article>';
    expect(sanitize(html).scope.completeWithinScope).toBe(false);
    const page = sanitizeNodeSnapshot(snapshotInput(html), undefined, undefined, { wholePage: true });
    expect(page.scope.completeWithinScope).toBe(true);
    expect(page.warnings.join(' ')).toContain('iframe');
  });
  it('still reports an image that could not be registered', () => {
    expect(sanitize('<article><p>Body<img alt="x"></p></article>').scope.completeWithinScope).toBe(false);
  });
});

describe('dollar-delimited math on pages that load a math engine', () => {
  const engine = '<script src="https://cdn.test/mathjax/tex-mml-chtml.js"></script>';
  const math = async (body: string, head = engine) => {
    const { ir } = await project(`${head}<article><p>${body}</p></article>`);
    const block = ir.blocks[0];
    if (block?.type !== 'text') throw new Error('text block expected');
    return { text: naturalText(block.value.content), latex: block.bindings.flatMap(binding => binding.kind === 'protected' && binding.object.type === 'math' ? [binding.object.latex] : []) };
  };
  it('protects inline formulas from the translator', async () => {
    expect(await math('Sample $\\mathbf{x}_0 \\sim q(\\mathbf{x})$ in $T$ steps')).toEqual({ text: 'Sample  in  steps', latex: ['\\mathbf{x}_0 \\sim q(\\mathbf{x})', 'T'] });
  });
  it.each([
    ['prices', 'It costs $5 and then $10 more'],
    ['currency codes', 'From US$5 to US$10'],
    ['escaped dollars', 'A literal \\$x\\$ stays'],
  ])('leaves %s as text', async (_name, body) => {
    expect((await math(body)).latex).toEqual([]);
  });
  it('leaves code samples alone', async () => {
    const { ir } = await project(`${engine}<article><p>Use <code>$HOME/$USER</code></p></article>`);
    const block = ir.blocks[0];
    if (block?.type !== 'text') throw new Error('text block expected');
    expect(block.bindings).toContainEqual(expect.objectContaining({ object: { type: 'code', text: '$HOME/$USER' } }));
  });
  it('does not treat dollars as math on pages with no math engine', async () => {
    expect((await math('Set $HOME/$USER first', '')).latex).toEqual([]);
  });
  it('keeps display math for the projector', async () => {
    const { ir } = await project(`${engine}<article><p>$$E=mc^2$$</p></article>`);
    expect(ir.blocks[0]).toMatchObject({ type: 'math', latex: 'E=mc^2' });
  });
  it('is stable when the sanitized page is processed again', () => {
    const once = sanitize(`${engine}<article><p>In $T$ steps</p></article>`);
    expect(sanitize(once.html).html).toBe(once.html);
  });
});

describe('formulas and figures from LaTeXML papers', () => {
  it('keeps the TeX when rendered MathML uses an element outside the allow-list', async () => {
    const { ir, snapshot } = await project('<article><p>Let <math><semantics><mstyle><mi>x</mi></mstyle><annotation encoding="application/x-tex">x^2</annotation></semantics></math> hold</p></article>');
    expect(snapshot.scope.completeWithinScope).toBe(true);
    expect(snapshot.html).not.toContain('Unsupported formula');
    const block = ir.blocks[0];
    if (block?.type !== 'text') throw new Error('text block expected');
    expect(block.bindings).toContainEqual(expect.objectContaining({ object: { type: 'math', latex: 'x^2' } }));
  });
  it('still reports a formula with no usable source', () => {
    const snapshot = sanitize('<article><p><math><mstyle><mi>x</mi></mstyle></math></p></article>');
    expect(snapshot.html).toContain('Unsupported formula');
    expect(snapshot.scope.completeWithinScope).toBe(false);
  });
  it('saves a figure published through <object> as an image', () => {
    const snapshot = sanitize('<article><figure><object type="image/svg+xml" data="fig/a.svg" onload="x()">fallback text</object></figure></article>');
    expect(snapshot.resources).toEqual([{ id: 'r_1', url: 'https://e.test/fig/a.svg', role: 'image' }]);
    expect(snapshot.html).toMatch(/<img[^>]*data-pl-resource="r_1"/);
    expect(snapshot.html).not.toMatch(/onload|fallback|<object/);
    expect(snapshot.scope.completeWithinScope).toBe(true);
  });
  it('still omits objects that are not images', () => {
    const snapshot = sanitize('<article><p>Body</p><object type="application/pdf" data="a.pdf"></object></article>');
    expect(snapshot.resources).toEqual([]);
    expect(snapshot.scope.completeWithinScope).toBe(false);
  });
  it('drops styling inside an inline SVG instead of the whole drawing', () => {
    const snapshot = sanitize('<article><p><svg viewBox="0 0 1 1"><style>.a{fill:red}</style><title>t</title><path d="M0 0L1 1"></path></svg></p></article>');
    expect(snapshot.html).toContain('<path');
    expect(snapshot.html).not.toMatch(/<style|Unsupported/);
  });
  it('labels an SVG it cannot keep as a figure, not a formula', () => {
    expect(sanitize('<article><p><svg><foreignObject>x</foreignObject></svg></p></article>').html).toContain('[Unsupported figure');
  });
});

describe('links and images in real pages', () => {
  it.each(['mailto:', 'mailto:a b@c.test'])('keeps the text of the unusable link %s without failing the page', async href => {
    const { ir } = await project(`<article><p>Contact <a href="${href}">the author</a> now</p></article>`);
    expect(textBlocks(ir)).toEqual(['Contact the author now']);
  });
  it.each([
    ['data-src', '<img src="data:image/gif;base64,R0lGOD" data-src="/real.png">'],
    ['data-original', '<img data-original="/real.png">'],
    ['srcset without src', '<img srcset="/small.png 320w, /real.png 1024w">'],
    ['srcset with commas in its addresses', '<img srcset="/w_320,h_1/small.png 320w, /real.png 1024w">'],
  ])('finds the real image behind lazy loading through %s', (_name, image) => {
    expect(sanitize(`<article><p>${image}</p></article>`).resources.map(resource => resource.url)).toEqual(['https://e.test/real.png']);
  });
  it('prefers an ordinary src', () => {
    expect(sanitize('<article><p><img src="/real.png" data-src="/other.png"></p></article>').resources.map(resource => resource.url)).toEqual(['https://e.test/real.png']);
  });
});
