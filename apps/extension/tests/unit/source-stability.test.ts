import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PageController } from '../../src/content/page-controller';
import { extractBlocks } from '../../src/dom/extractor';
import { DomRenderer } from '../../src/dom/renderer';
import { MockProvider } from '@pagelingo/translation-core/testing';

let controller: PageController | undefined;
beforeEach(() => {
  const html = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/x-article.html'), 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
  document.body.removeAttribute('style'); document.documentElement.lang = 'en';
  history.replaceState({}, '', '/goyal__pramod/status/2106244243727507733');
});
afterEach(() => { controller?.dispose(); controller = undefined; });

async function start(): Promise<PageController> {
  controller = new PageController(document);
  controller.start('bilingual');
  await vi.waitFor(() => expect(document.querySelector('[data-pl-owned="translation"]')).not.toBeNull());
  return controller;
}

it('keeps source bindings current when a site changes only layout and tracking attributes', async () => {
  const blocks = await extractBlocks(document);
  const paragraph = blocks.find(block => block.parent.id === 'x-paragraph-1')!;
  const renderer = new DomRenderer(); renderer.render(paragraph, `译文：${paragraph.input.protectedText}`);
  const originalSpan = document.querySelector<HTMLElement>('#x-paragraph-1 > span')!;
  originalSpan.className = 'hydrated'; originalSpan.style.width = '620px'; originalSpan.dataset.renderRevision = '2';
  expect(renderer.isCurrent(paragraph)).toBe(true);
  renderer.restore();
  expect(originalSpan.className).toBe('hydrated');
});

it('finishes an X article during automatic layout, tab title and media updates without user interaction', async () => {
  const task = await start();
  document.title = '(2) Notifications / X';
  document.querySelector<HTMLElement>('#x-paragraph-1 > span')!.style.lineHeight = '1.8';
  document.getElementById('x-rich-body')!.dataset.layoutRevision = '3';
  const media = document.createElement('div'); media.innerHTML = '<img alt="Loading media"><span>Loading 25%</span>';
  document.getElementById('x-rich-body')!.append(media);
  await new Promise(resolve => setTimeout(resolve, 0));
  await vi.waitFor(() => expect(task.status.status).toBe('completed'));
  expect(task.status.completed).toBe(6);
  expect(document.querySelectorAll('[data-pl-owned="translation"]')).toHaveLength(6);
});

it('rebinds identical source recreated by the site and reapplies completed translations', async () => {
  const task = await start();
  const previousTitle = document.getElementById('x-title')!;
  const reader = document.querySelector('[data-testid="twitterArticleReadView"]')!;
  const replacement = reader.cloneNode(true) as HTMLElement;
  for (const output of replacement.querySelectorAll('[data-pl-owned]')) output.remove();
  reader.replaceWith(replacement);
  await new Promise(resolve => setTimeout(resolve, 0));
  await vi.waitFor(() => expect(task.status.status).toBe('completed'));
  expect(previousTitle.isConnected).toBe(false);
  expect(task.status.completed).toBe(6);
  expect(document.querySelectorAll('[data-pl-owned="translation"]')).toHaveLength(6);
  expect(document.getElementById('x-title')!.nextElementSibling?.getAttribute('data-pl-owned')).toBe('translation');
});

for (const change of ['text', 'link', 'code', 'order', 'append'] as const) {
  it(`stops on a real ${change} change and explains the cause`, async () => {
    const task = await start();
    if (change === 'text') document.querySelector('#x-paragraph-1 span span')!.textContent = 'An edited original sentence. ';
    if (change === 'link') document.querySelector('#x-paragraph-1 a')!.setAttribute('href', 'https://example.com/changed');
    if (change === 'code') document.querySelector('#x-paragraph-2 code')!.textContent = 'agent.changed()';
    if (change === 'order') document.getElementById('x-rich-body')!.append(document.getElementById('x-paragraph-1')!.parentNode!);
    if (change === 'append') {
      const paragraph = document.createElement('p'); paragraph.textContent = 'A new original paragraph.';
      document.getElementById('x-rich-body')!.append(paragraph);
    }
    await vi.waitFor(() => expect(task.status.status).toBe('stale'));
    expect(task.status.error).toMatch(/已停止/);
    expect(task.status.error).toMatch(change === 'text' ? /文字|文本/ : change === 'order' ? /顺序/ : change === 'append' ? /段落/ : /链接|代码|公式|结构/);
    expect(document.querySelectorAll('[data-pl-owned="translation"]')).toHaveLength(0);
  });
}

it('still stops when original inline text becomes hidden', async () => {
  const task = await start();
  document.querySelector<HTMLElement>('#x-paragraph-1 span span')!.style.display = 'none';
  await vi.waitFor(() => expect(task.status.status).toBe('stale'));
  expect(document.querySelectorAll('[data-pl-owned="translation"]')).toHaveLength(0);
});

it('preserves newly loaded inline media when reconciling a generic page in translation mode', async () => {
  document.body.innerHTML = '<article><p id="original">Read the original guide.</p></article>';
  history.replaceState({}, '', '/guide');
  const task = await start();
  task.setMode('translation');
  const paragraph = document.getElementById('original')!;
  const image = document.createElement('img'); image.alt = 'A loaded diagram'; paragraph.append(image);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(task.status.status).toBe('completed');
  expect(task.status.fallback).toBe(1);
  expect(image.parentElement).toBe(paragraph);
  expect(image.closest('[data-pl-source]')).toBeNull();
  expect(document.querySelectorAll('[data-pl-owned="translation"]')).toHaveLength(1);
  task.restore();
  expect(paragraph.textContent).toBe('Read the original guide.');
  expect(image.isConnected).toBe(true);
});

it('reconciles a host-cloned paragraph without retaining copied translations or source wrappers', async () => {
  document.body.innerHTML = '<article><p id="original">Read the original guide.</p></article>';
  history.replaceState({}, '', '/guide');
  const task = await start();
  task.setMode('translation');
  const paragraph = document.getElementById('original')!;
  const replacement = paragraph.cloneNode(true) as HTMLElement;
  paragraph.replaceWith(replacement);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(task.status.status).toBe('completed');
  expect(document.querySelectorAll('[data-pl-owned="translation"]')).toHaveLength(1);
  expect(document.querySelectorAll('[data-pl-source]')).toHaveLength(1);
  task.setMode('bilingual');
  expect((replacement.firstElementChild as HTMLElement).style.display).toBe('contents');
  task.restore();
  expect(document.querySelectorAll('[data-pl-owned], [data-pl-source]')).toHaveLength(0);
  expect(document.getElementById('original')).toBe(replacement);
  expect(replacement.textContent).toBe('Read the original guide.');
});

it('keeps an X translation beside its source when the site moves the paragraph into a new container', async () => {
  const task = await start();
  const paragraph = document.getElementById('x-paragraph-1')!;
  const previousContainer = paragraph.parentElement!;
  const container = document.createElement('div');
  previousContainer.after(container); container.append(paragraph);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(task.status.status).toBe('completed');
  expect(paragraph.nextElementSibling?.getAttribute('data-pl-owned')).toBe('translation');
  expect(document.querySelectorAll('[data-pl-owned="translation"]')).toHaveLength(6);
});

it('ignores changing media labels near the start of X rich text without a separate article title', async () => {
  document.getElementById('x-title')!.remove();
  const media = document.createElement('div'); media.innerHTML = '<img alt="Media"><span>Loading 0%</span>';
  document.getElementById('x-rich-body')!.prepend(media);
  const task = await start();
  media.querySelector('span')!.textContent = 'Loading 50%';
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(task.status.status).toBe('completed');
  expect(document.querySelectorAll('[data-pl-owned="translation"]')).toHaveLength(5);
});

it('uses only filtered original text as X title context sent to the translation provider', async () => {
  const title = document.getElementById('x-title')!;
  title.insertAdjacentHTML('beforeend', '<span hidden>hidden title secret</span><span contenteditable="true">private title draft</span>');
  const generate = vi.spyOn(MockProvider.prototype, 'generate');
  try {
    await start();
    expect(generate.mock.calls.length).toBeGreaterThan(0);
    for (const [request] of generate.mock.calls) {
      expect(request.data.document.title).toBe('Building reliable agents');
      expect(JSON.stringify(request.data)).not.toMatch(/hidden title secret|private title draft/);
    }
  } finally { generate.mockRestore(); }
});

it('moves Chinese back below an identical X paragraph moved within the same container', async () => {
  const task = await start();
  const paragraph = document.getElementById('x-paragraph-1')!;
  paragraph.parentElement!.append(paragraph);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(task.status.status).toBe('completed');
  expect(paragraph.nextElementSibling?.getAttribute('data-pl-owned')).toBe('translation');
  expect(document.querySelectorAll('[data-pl-owned="translation"]')).toHaveLength(6);
});

it('continues when transparent React spans split identical original text', async () => {
  document.body.innerHTML = '<article><p id="original">Read the original guide.</p></article>';
  history.replaceState({}, '', '/guide');
  const generate = vi.spyOn(MockProvider.prototype, 'generate');
  try {
    const task = await start();
    const replacement = document.createElement('p'); replacement.id = 'original';
    replacement.innerHTML = '<span>Read </span><span>the original guide.</span>';
    document.getElementById('original')!.replaceWith(replacement);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(task.status.status).toBe('completed');
    expect(document.querySelectorAll('[data-pl-owned="translation"]')).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(1);
    task.restore();
    expect(document.getElementById('original')).toBe(replacement);
    expect(replacement.innerHTML).toBe('<span>Read </span><span>the original guide.</span>');
  } finally { generate.mockRestore(); }
});

it('keeps existing link translations when the site adds a zero-width anchor', async () => {
  document.body.innerHTML = '<article><p id="original">Read <a href="https://example.com/guide">the guide</a>.</p></article>';
  history.replaceState({}, '', '/guide');
  const generate = vi.spyOn(MockProvider.prototype, 'generate');
  try {
    const task = await start();
    const anchor = document.createElement('a'); anchor.href = '#original'; anchor.textContent = '\u200b';
    document.querySelector('[data-pl-source]')!.prepend(anchor);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(task.status.status).toBe('completed');
    expect(document.querySelectorAll('[data-pl-owned="translation"]')).toHaveLength(1);
    expect(document.querySelector<HTMLAnchorElement>('[data-pl-owned="translation"] a')!.href).toBe('https://example.com/guide');
    expect(anchor.closest('[data-pl-source]')).toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
    task.restore();
    expect(anchor.parentElement).toBe(document.getElementById('original'));
  } finally { generate.mockRestore(); }
});

it('extracts stable translation input while non-block media labels keep changing during cooperative yields', async () => {
  document.body.innerHTML = '<article><p>Read the original guide.</p><div id="media">Loading 0%</div>' + '<span></span>'.repeat(180) + '</article>';
  history.replaceState({}, '', '/guide');
  controller = new PageController(document);
  const task = controller;
  const generate = vi.spyOn(MockProvider.prototype, 'generate');
  let revision = 0;
  const timer = setInterval(() => { document.getElementById('media')!.textContent = `Loading ${++revision}%`; }, 1);
  try {
    task.start('bilingual');
    await vi.waitFor(() => expect(task.status.status).toBe('completed'), { timeout: 3000 });
    expect(task.status.total).toBe(1);
    expect(document.querySelectorAll('[data-pl-owned="translation"]')).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(1);
  } finally { clearInterval(timer); generate.mockRestore(); }
});

it('continues after harmless syntax highlighting splits an unchanged code atom', async () => {
  document.body.innerHTML = '<article><p>Run <code>agent.run()</code> safely.</p></article>';
  history.replaceState({}, '', '/guide');
  const task = await start();
  document.querySelector('code')!.innerHTML = '<span class="token">agent</span>.run()';
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(task.status.status).toBe('completed');
  expect(document.querySelectorAll('[data-pl-owned="translation"]')).toHaveLength(1);
  expect(document.querySelector('[data-pl-owned="translation"] code')!.textContent).toBe('agent.run()');
});

it('stops when a protected MathJax SVG changes its formula geometry without text changes', async () => {
  document.body.innerHTML = '<article><p>Loss <mjx-container jax="SVG"><svg viewBox="0 0 100 50"><path d="M0 0L1 1"></path></svg></mjx-container> decreases.</p></article>';
  history.replaceState({}, '', '/guide');
  const task = await start();
  document.querySelector('path')!.setAttribute('d', 'M0 0L100 100');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(task.status.status).toBe('stale');
  expect(task.status.error).toMatch(/公式|结构/);
  expect(document.querySelectorAll('[data-pl-owned="translation"]')).toHaveLength(0);
});

it('keeps translating unfinished code after syntax highlighting changes only its DOM structure', async () => {
  document.body.innerHTML = '<article>' + '<p>A stable original paragraph.</p>'.repeat(8) + '<p>Run <code>agent.run()</code> safely.</p></article>';
  history.replaceState({}, '', '/guide');
  const task = await start();
  expect(task.status.completed).toBe(8);
  document.querySelector('code')!.innerHTML = '<span class="token">agent</span>.run()';
  await vi.waitFor(() => expect(task.status.status).toBe('completed'));
  expect(task.status.completed).toBe(9);
  expect(task.status.failed).toBe(0);
  expect(document.querySelectorAll('[data-pl-owned="translation"]')).toHaveLength(9);
});

it('still detects visibility changes caused by a CSS selector on a sibling outside the article', async () => {
  document.head.insertAdjacentHTML('beforeend', '<style>#toggle.hide ~ article #sourceText {display:none}</style>');
  document.body.innerHTML = '<div id="toggle"></div><article><p><span id="sourceText">Read the original guide.</span></p></article>';
  history.replaceState({}, '', '/guide');
  const task = await start();
  document.getElementById('toggle')!.className = 'hide';
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(task.status.status).toBe('stale');
  expect(document.querySelectorAll('[data-pl-owned="translation"]')).toHaveLength(0);
});

it('ignores known tracking and layout revision metadata inside a protected formula', async () => {
  document.body.innerHTML = '<article><p>Loss <mjx-container jax="SVG"><svg><path d="M0 0L1 1"></path></svg></mjx-container> decreases.</p></article>';
  history.replaceState({}, '', '/guide');
  const task = await start();
  const formula = document.querySelector<HTMLElement>('mjx-container')!;
  formula.dataset.renderRevision = '2'; formula.dataset.layoutRevision = '3'; formula.dataset.analyticsId = 'local-metadata';
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(task.status.status).toBe('completed');
  expect(document.querySelectorAll('[data-pl-owned="translation"]')).toHaveLength(1);
});
