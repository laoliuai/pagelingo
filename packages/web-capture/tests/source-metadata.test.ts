import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';

async function extract(head: string) {
  const html = `<html><head>${head}</head><body><article><h1>Article evidence</h1>${'<p>The reader can learn from this detailed source article. Its original evidence explains the software and the system with several useful examples.</p>'.repeat(6)}</article></body></html>`;
  const entry = new URL('../src/node.ts', import.meta.url).href;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`import { parentPort } from 'node:worker_threads'; import { extractPublicArticleWithMetadata } from ${JSON.stringify(entry)}; parentPort.postMessage(extractPublicArticleWithMetadata(${JSON.stringify(html)}, 'https://blog.example/read'));`)}`), { execArgv: ['--import', 'tsx'] });
  try { return await new Promise<{ metadata?: { title: string | null; author: string | null; publishedAt: string | null }; snapshot: { html: string } }>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }); }
  finally { await worker.terminate(); }
}
it('returns bounded actual title author and date from the same Readability article', async () => {
  const value = await extract('<title>Article evidence</title><meta name="author" content="Ada Reader"><meta property="article:published_time" content="2026-10-01T12:00:00Z"><script>throw new Error("never execute")</script>');
  expect(value.metadata).toEqual({ title: 'Article evidence', author: 'Ada Reader', publishedAt: '2026-10-01T12:00:00.000Z' });
  expect(value.snapshot.html).toContain('original evidence'); expect(value.snapshot.html).not.toContain('never execute');
});
it('does not infer a missing author or date and bounds extracted metadata', async () => {
  const value = await extract(`<title>${'A'.repeat(2500)}</title><meta name="author" content="${'B'.repeat(2500)}"><meta property="article:published_time" content="not a date">`);
  expect(value.metadata?.title?.length).toBeLessThanOrEqual(2000); expect(value.metadata?.author?.length).toBe(2000); expect(value.metadata?.publishedAt).toBeNull();
  expect((await extract('<title>Article evidence</title>')).metadata).toEqual({ title: 'Article evidence', author: null, publishedAt: null });
});
it.each([
  ['2026-02-31T12:00:00Z', null],
  ['2025-02-29', null],
  ['2026-04-31T23:30:00-04:00', null],
  ['2024-02-29', '2024-02-29T00:00:00.000Z'],
  ['2024-02-29T23:30:00-04:00', '2024-03-01T03:30:00.000Z'],
])('preserves calendar validity before timezone conversion: %s', async (date, expected) => {
  const value = await extract(`<meta property="article:published_time" content="${date}">`);
  expect(value.metadata?.publishedAt).toBe(expected);
});
