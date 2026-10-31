import { expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { extractPublicArticle } from '../src/node.js';
it('requires a terminable worker and preserves article resources through Readability', async () => {
  expect(() => extractPublicArticle('<p>x</p>', 'https://e.test')).toThrow(/worker/);
  const html = `<html><head><title>Article</title></head><body><nav>Navigation</nav><article><h1>A source article</h1>${'<p>The article is about science and the way we can learn from it. This paragraph has enough content for a public article extraction.</p>'.repeat(6)}<img src="/figure.png" alt="figure"><p><strong>Important</strong> final evidence.</p></article></body></html>`;
  const url = new URL('../src/node.ts', import.meta.url).href;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`import { parentPort } from 'node:worker_threads'; import { extractPublicArticle } from ${JSON.stringify(url)}; parentPort.postMessage(extractPublicArticle(${JSON.stringify(html)}, 'https://e.test/article'));`)}`), { execArgv: ['--import', 'tsx'] });
  try {
    const snapshot = await new Promise<{ html: string; resources: unknown[] }>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    expect(snapshot.html).toContain('Important');
    expect(snapshot.resources).toEqual([{ id: 'r_1', url: 'https://e.test/figure.png', role: 'image' }]);
    expect(snapshot.html).not.toContain('src=');
    expect(Object.keys(snapshot).sort()).toEqual(['html', 'nodeIds', 'resources', 'scope', 'sourceUrl', 'warnings']);
  } finally { await worker.terminate(); }
});
it('reads the exact LaTeXML paper body with footnotes moved out of the sentences', async () => {
  const note = (role: string, text: string) => `<span class="ltx_note ltx_role_${role}"><sup class="ltx_note_mark">1</sup><span class="ltx_note_outer"><span class="ltx_note_content"><sup class="ltx_note_mark">1</sup><span class="ltx_note_type">${role}: </span><span class="ltx_tag ltx_tag_note">1</span>${text}</span></span></span>`;
  const html = `<html><head><title>[1] site title</title></head><body><nav>Site navigation</nav><article class="ltx_document">
    <h1 class="ltx_title ltx_title_document">The paper title</h1>
    <div class="ltx_authors"><span class="ltx_creator"><span class="ltx_personname">Ada Lovelace ${note('thanks', 'Equal contribution.')}</span></span> <span class="ltx_creator"><span class="ltx_personname">Alan Turing <span class="ltx_note ltx_role_footnotemark"><sup class="ltx_note_mark">1</sup><span class="ltx_note_outer"><span class="ltx_note_content"><sup class="ltx_note_mark">1</sup><span class="ltx_note_type">footnotemark: </span>1</span></span></span></span></span></div>
    <section><div class="ltx_para"><p>The first half${note('footnote', 'A remark about the method.')} and the second half stay together.</p></div></section>
    <table class="ltx_equation ltx_eqn_table"><tbody><tr><td class="ltx_eqn_cell ltx_eqn_center_padleft"></td><td class="ltx_eqn_cell"><math display="block"><annotation encoding="application/x-tex">\\frac{a}{b}</annotation></math></td><td class="ltx_eqn_cell ltx_eqn_center_padright"></td><td class="ltx_eqn_cell"><span class="ltx_tag">(2)</span></td></tr></tbody></table>
    <ul class="ltx_itemize"><li><span class="ltx_tag ltx_tag_item">•</span><div class="ltx_para"><p>First bullet.</p></div></li></ul>
    <ol class="ltx_enumerate"><li><span class="ltx_tag ltx_tag_item">1.</span><div class="ltx_para"><p>First step.</p></div></li><li><span class="ltx_tag ltx_tag_item">(ii)</span><div class="ltx_para"><p>Second step.</p></div></li></ol>
    </article></body></html>`;
  const url = new URL('../src/node.ts', import.meta.url).href;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`import { parentPort } from 'node:worker_threads'; import { extractPublicArticleWithMetadata } from ${JSON.stringify(url)}; parentPort.postMessage(extractPublicArticleWithMetadata(${JSON.stringify(html)}, 'https://arxiv.org/html/1v1'));`)}`), { execArgv: ['--import', 'tsx'] });
  try {
    const { snapshot, metadata } = await new Promise<{ snapshot: { html: string }; metadata: { title: string; author: string } }>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    expect(metadata).toMatchObject({ title: 'The paper title', author: 'Ada Lovelace, Alan Turing' });
    expect(snapshot.html).not.toContain('Site navigation');
    expect(snapshot.html).not.toMatch(/thanks:|footnotemark:|footnote:/);
    expect(snapshot.html.replace(/<[^>]+>/g, '')).toContain('The first half1 and the second half stay together.');
    expect(snapshot.html.replace(/<[^>]+>/g, '')).toContain('1 A remark about the method.');
    expect(snapshot.html.replace(/<[^>]+>/g, '')).toContain('1 Equal contribution.');
    expect(snapshot.html).not.toContain('<table');
    expect(snapshot.html).toContain('\\displaystyle \\frac{a}{b}');
    expect(snapshot.html.replace(/<[^>]+>/g, '')).toContain('(2)');
    expect(snapshot.html).not.toContain('•');
    expect(snapshot.html).not.toContain('1.</');
    expect(snapshot.html).toContain('(ii)');
  } finally { await worker.terminate(); }
});
