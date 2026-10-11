import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, expect, it } from 'vitest';
import { extractBlocks } from '../../src/dom/extractor';
import { DomRenderer } from '../../src/dom/renderer';
import { sourceDocumentVersion } from '../../src/dom/document-version';

function load(name: string): void {
  const parsed = new DOMParser().parseFromString(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures', `${name}.html`), 'utf8'), 'text/html');
  document.head.innerHTML = parsed.head.innerHTML; document.body.innerHTML = parsed.body.innerHTML;
}
beforeEach(() => { document.head.replaceChildren(); document.body.replaceChildren(); document.body.removeAttribute('style'); history.replaceState({}, '', '/goyal__pramod/status/2106244243727507733'); });

it('extracts the requested X post div rather than the longest reply or navigation', async () => {
  load('x-post');
  const blocks = await extractBlocks(document);
  expect(blocks).toHaveLength(1);
  expect(blocks[0].parent.id).toBe('post-text');
  expect(blocks[0].input.sourceText).toContain('Language models can use tools');
  expect(blocks[0].input.slots.filter(slot => slot.kind === 'open')).toHaveLength(1);
  expect(JSON.stringify(blocks.map(block => block.block))).not.toMatch(/Another author|unrelated reply|Trending|Recommended|October 6/);
});

it('extracts X rich text once and preserves its heading hierarchy and code', async () => {
  load('x-article');
  const blocks = await extractBlocks(document);
  expect(blocks.map(block => block.parent.id)).toEqual(['x-title', 'x-section', 'x-paragraph-1', 'x-paragraph-2', 'x-item-1', 'x-item-2']);
  expect(blocks.slice(0, 2).map(block => block.block.kind)).toEqual(['heading', 'heading']);
  expect(blocks[2].block.sectionPath).toEqual(['Building reliable agents', 'Training and evaluation']);
  expect(blocks[3].input.protectedText).not.toContain('agent.step()');
  expect(JSON.stringify(blocks.map(block => block.block))).not.toMatch(/Sidebar|Do not translate|reply outside|Pramod Goyal/);
});

it('ignores X engagement and reply updates while still detecting main post edits', async () => {
  load('x-post');
  const blocks = await extractBlocks(document);
  expect(blocks[0].parent.id).toBe('post-text');
  const source = sourceDocumentVersion(document);
  const renderer = new DomRenderer(); renderer.render(blocks[0], `译文：${blocks[0].input.protectedText}`);
  expect(sourceDocumentVersion(document)).toBe(source);
  document.getElementById('like-count')!.textContent = '13';
  document.querySelector('#long-reply p')!.textContent = 'This reply has been updated.';
  expect(sourceDocumentVersion(document)).toBe(source);
  document.querySelector('#post-text span')!.textContent = 'A changed original post.';
  expect(sourceDocumentVersion(document)).not.toBe(source);
  renderer.restore();
});

it('does not translate unrelated X replies when the requested post is not loaded', async () => {
  load('x-post'); document.getElementById('main-post')!.remove();
  expect(await extractBlocks(document)).toHaveLength(0);
});

it('detects X article additions while ignoring surrounding engagement changes', () => {
  load('x-article');
  const source = sourceDocumentVersion(document);
  document.getElementById('article-engagement')!.textContent = '13 likes';
  expect(sourceDocumentVersion(document)).toBe(source);
  document.getElementById('x-rich-body')!.append(document.createElement('div'));
  expect(sourceDocumentVersion(document)).not.toBe(source);
});

it('keeps X source nodes in their original parents and restores the exact markup', async () => {
  load('x-article'); const original = document.body.innerHTML;
  const blocks = await extractBlocks(document); expect(blocks).toHaveLength(6);
  const nodes = blocks.flatMap(block => block.nodes.map(node => ({ node, parent: node.parentNode })));
  const renderer = new DomRenderer();
  for (const block of blocks) expect(renderer.render(block, `译文：${block.input.protectedText}`)).toBe(true);
  expect(nodes.every(({ node, parent }) => node.parentNode === parent)).toBe(true);
  for (const mode of ['source', 'translation', 'bilingual'] as const) renderer.setMode(mode);
  expect(document.querySelector('ul > [data-pl-owned]')).toBeNull();
  renderer.restore(); expect(document.body.innerHTML).toBe(original);
});

it('does not treat arbitrary layout divs on other pages as paragraphs', async () => {
  document.body.innerHTML = '<main><div>Arbitrary page shell text.</div><p>A real paragraph.</p></main>';
  expect((await extractBlocks(document)).map(block => block.input.sourceText)).toEqual(['A real paragraph.']);
});

it('ignores rich text in other replies when choosing and versioning the requested post', async () => {
  load('x-post');
  const version = sourceDocumentVersion(document);
  const richText = document.createElement('div');
  richText.dataset.testid = 'longformRichTextComponent';
  richText.innerHTML = '<div class="longform-unstyled">An unrelated rich text reply.</div>';
  document.getElementById('long-reply')!.append(richText);
  expect(sourceDocumentVersion(document)).toBe(version);
  expect((await extractBlocks(document)).map(block => block.parent.id)).toEqual(['post-text']);
});

it('does not identify a reply by a quoted permalink or extract quoted text as the post body', async () => {
  load('x-post');
  const post = document.getElementById('main-post')!;
  const quote = document.createElement('div');
  quote.dataset.testid = 'quoteTweet';
  quote.innerHTML = '<a href="/goyal__pramod/status/2106244243727507733"><time>Quoted date</time></a><div data-testid="tweetText">An unrelated quoted post.</div>';
  document.getElementById('long-reply')!.prepend(quote);
  post.remove();
  expect(await extractBlocks(document)).toHaveLength(0);
  document.querySelector('[data-testid="primaryColumn"]')!.append(post);
  expect((await extractBlocks(document)).map(block => block.parent.id)).toEqual(['post-text']);
  document.getElementById('post-text')!.remove();
  post.append(quote);
  expect(await extractBlocks(document)).toHaveLength(0);
});

it('keeps generic page extraction when primaryColumn is the only X-like marker', async () => {
  document.body.innerHTML = '<main><div data-testid="primaryColumn"><p>A genuine generic paragraph.</p></div></main>';
  expect((await extractBlocks(document)).map(block => block.input.sourceText)).toEqual(['A genuine generic paragraph.']);
});

it('preserves source heading typography and semantics in an external X translation', async () => {
  load('x-article');
  const blocks = await extractBlocks(document);
  const heading = blocks.find(block => block.parent.id === 'x-title')!;
  const renderer = new DomRenderer();
  renderer.render(heading, '构建可靠的智能体');
  const translation = document.querySelector<HTMLElement>('[data-pl-owned="translation"]')!;
  expect(translation.getAttribute('role')).toBe('heading');
  expect(translation.getAttribute('aria-level')).toBe('1');
  const sourceStyle = getComputedStyle(heading.parent);
  const translatedStyle = getComputedStyle(translation);
  expect(translatedStyle.fontSize).toBe(sourceStyle.fontSize);
  expect(translatedStyle.fontWeight).toBe(sourceStyle.fontWeight);
  document.body.style.color = 'rgb(242, 242, 242)';
  expect(getComputedStyle(translation).color).toBe(getComputedStyle(heading.parent).color);
  renderer.restore();
});
