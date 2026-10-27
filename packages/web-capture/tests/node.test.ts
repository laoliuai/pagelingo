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
  } finally { await worker.terminate(); }
});
