import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { collectOriginalCapture, CaptureUnavailableError } from '../../src/archive/collector';

const captureId = 'a90c086e-f741-4e18-8192-cb6da71f523c';
async function capture(html: string, url: string) {
  const dom = new JSDOM(html, { url });
  try { return await collectOriginalCapture(dom.window.document, { captureId }); }
  finally { dom.window.close(); }
}
it('preserves blog article structure, links, tables and repeated paragraphs', async () => {
  const result = await capture('<nav>Navigation</nav><article><h2>Topic</h2><p>Repeated</p><p>Repeated</p><table><tr><th>Label</th><td>Value</td></tr></table><a href="/reference">Reference</a></article><footer>Footer</footer>', 'https://blog.example/post?chapter=2&utm_source=test#part');
  expect(result.snapshot.html).toContain('<h2');
  expect(result.snapshot.html).toContain('<table');
  expect(result.snapshot.html).not.toMatch(/Navigation|Footer/);
  expect(result.snapshot.sourceUrl).toBe('https://blog.example/post?chapter=2#part');
  expect(result.snapshot.html).toContain('https://blog.example/reference');
});
it('collects requested X main-post media, author and time but not quotes or replies', async () => {
  const result = await capture('<main data-testid="primaryColumn"><article data-testid="tweet"><div data-testid="User-Name">Alice</div><a href="/alice/status/123"><time datetime="2026-10-01T00:00:00Z">Today</time></a><div data-testid="tweetText">Main text <a href="https://example.org">External</a></div><div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/main.jpg"></div><div data-testid="quoteTweet"><div data-testid="tweetText">Quoted</div><img src="https://pbs.twimg.com/quote.jpg"></div></article><article data-testid="tweet"><a href="/bob/status/456"><time>Today</time></a><div data-testid="tweetText">Reply</div></article></main>', 'https://x.com/alice/status/123');
  expect(result.kind).toBe('x-post');
  expect(result.metadata.author).toBe('Alice');
  expect(result.metadata.publishedAt).toBe('2026-10-01T00:00:00.000Z');
  expect(result.snapshot.html).toContain('Main text');
  expect(result.snapshot.html).not.toMatch(/Quoted|Reply|quote.jpg/);
  expect(result.pendingResources.map(resource => resource.url)).toEqual(['https://pbs.twimg.com/main.jpg']);
});
it('does not substitute a loaded reply when the requested X post is absent', async () => {
  await expect(capture('<main data-testid="primaryColumn"><article data-testid="tweet"><a href="/bob/status/456"><time>Today</time></a><div data-testid="tweetText">Reply</div></article></main>', 'https://x.com/alice/status/123')).rejects.toBeInstanceOf(CaptureUnavailableError);
});
it('selects only an explicit Zhihu answer and falls back to link on ambiguous question pages', async () => {
  const html = '<div class="AnswerItem" data-aid="11"><div class="RichContent-inner"><p>First answer</p></div></div><div class="AnswerItem" data-aid="22"><div class="RichContent-inner"><p>Second answer</p></div></div>';
  const result = await capture(html, 'https://www.zhihu.com/question/1/answer/22');
  expect(result.kind).toBe('answer');
  expect(result.snapshot.html).toContain('Second answer');
  expect(result.snapshot.html).not.toContain('First answer');
  await expect(capture(html, 'https://www.zhihu.com/question/1')).rejects.toMatchObject({ fallback: { kind: 'link-only', warnings: [expect.stringMatching(/独立回答/)] } });
});
it('preserves WeChat identity query and lazy image source', async () => {
  const result = await capture('<h1 id="activity-name">WeChat title</h1><div id="js_content"><p>Article body</p><img data-src="https://mmbiz.qpic.cn/image.png"></div><div>Login navigation</div>', 'https://mp.weixin.qq.com/s?__biz=abc&mid=123&idx=2&sn=def&utm_source=test');
  expect(result.snapshot.sourceUrl).toBe('https://mp.weixin.qq.com/s?__biz=abc&mid=123&idx=2&sn=def');
  expect(result.pendingResources[0]?.url).toBe('https://mmbiz.qpic.cn/image.png');
  expect(result.snapshot.html).not.toContain('Login navigation');
});
it('captures a loaded media-only X main post without borrowing reply text', async () => {
  const result = await capture('<main data-testid="primaryColumn"><article data-testid="tweet"><a href="/alice/status/123"><time>Today</time></a><div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/only.jpg"></div></article><article data-testid="tweet"><a href="/bob/status/456"><time>Today</time></a><div data-testid="tweetText">Reply</div></article></main>', 'https://x.com/alice/status/123');
  expect(result.pendingResources.map(resource => resource.url)).toEqual(['https://pbs.twimg.com/only.jpg']);
  expect(result.snapshot.html).not.toContain('Reply');
});
it('derives X metadata from original wrappers rather than translated DOM text', async () => {
  const result = await capture('<main data-testid="primaryColumn"><article data-testid="tweet"><a href="/alice/status/123"><time>Today</time></a><div data-testid="tweetText"><span data-pl-source style="display:none">Original post</span><span data-pl-owned="translation">译文</span></div></article></main>', 'https://x.com/alice/status/123');
  expect(result.metadata.title).toBe('Original post');
});
it('marks collapsed Zhihu answers and truncated X text incomplete without expanding controls', async () => {
  const zhihu = await capture('<div class="AnswerItem" data-aid="11"><div class="RichContent-inner"><p>Loaded answer excerpt.</p></div><button class="ContentItem-more">Expand</button></div>', 'https://www.zhihu.com/question/1/answer/11');
  expect(zhihu.snapshot.scope.completeWithinScope).toBe(false);
  expect(zhihu.snapshot.scope.warnings.join(' ')).toMatch(/expand/i);
  const x = await capture('<main data-testid="primaryColumn"><article data-testid="tweet"><a href="/alice/status/123"><time>Today</time></a><div data-testid="tweetText">Loaded post excerpt.</div><button data-testid="tweet-text-show-more-link">Show more</button></article></main>', 'https://x.com/alice/status/123');
  expect(x.snapshot.scope.completeWithinScope).toBe(false);
  expect(x.snapshot.scope.warnings.join(' ')).toMatch(/expand|truncated/i);
});
it('returns a truthful link fallback if sanitization leaves no article evidence', async () => {
  await expect(capture('<article><div hidden>Hidden application state</div><form>Login<input value="secret"></form></article>', 'https://blog.example/locked')).rejects.toBeInstanceOf(CaptureUnavailableError);
});
it('reads X original metadata without invoking nested custom-element constructors', async () => {
  const dom = new JSDOM('<main data-testid="primaryColumn"><article data-testid="tweet"><a href="/alice/status/123"><time>Today</time></a><div data-testid="tweetText">Original <capture-probe>metadata</capture-probe></div></article></main>', { url: 'https://x.com/alice/status/123' });
  let constructed = 0;
  dom.window.customElements.define('capture-probe', class extends dom.window.HTMLElement { constructor() { super(); constructed++; } });
  const before = constructed;
  try {
    const draft = await collectOriginalCapture(dom.window.document, { captureId });
    expect(draft.metadata.title).toBe('Original metadata');
    expect(constructed).toBe(before);
  } finally { dom.window.close(); }
});
it('preserves the main X external card anchor without quote/reply cards or duplicate inline links', async () => {
  const result = await capture('<main data-testid="primaryColumn"><article data-testid="tweet"><a href="/alice/status/123"><time>Today</time></a><div data-testid="tweetText">Read my article. <a href="https://external.example/inline">Inline source</a></div><div data-testid="card.wrapper"><a href="https://external.example/article"><span>Main external article</span><span role="button">Unrelated card UI</span></a></div><div data-testid="card.wrapper"><a href="https://external.example/inline">Duplicate inline source</a></div><div data-testid="quoteTweet"><div data-testid="card.wrapper"><a href="https://external.example/quoted">Quoted article</a></div></div></article><article data-testid="tweet"><a href="/bob/status/456"><time>Today</time></a><div data-testid="card.wrapper"><a href="https://external.example/reply">Reply article</a></div></article></main>', 'https://x.com/alice/status/123');
  expect(result.snapshot.html).toContain('href="https://external.example/article"');
  expect(result.snapshot.html).toContain('Main external article');
  expect(result.snapshot.html).not.toMatch(/Quoted article|Reply article|Unrelated card UI|Duplicate inline source|external.example\/(?:quoted|reply)/);
  expect(result.snapshot.html.match(/href="https:\/\/external.example\/inline"/g)).toHaveLength(1);
  expect(result.snapshot.scope.completeWithinScope).toBe(true);
});
it('marks an X external card with no safe representable link incomplete', async () => {
  const result = await capture('<main data-testid="primaryColumn"><article data-testid="tweet"><a href="/alice/status/123"><time>Today</time></a><div data-testid="tweetText">Read my article.</div><div data-testid="card.wrapper"><a href="javascript:alert(1)">Broken card</a></div></article></main>', 'https://x.com/alice/status/123');
  expect(result.snapshot.html).not.toContain('javascript:');
  expect(result.snapshot.scope.completeWithinScope).toBe(false);
  expect(result.snapshot.scope.warnings.join(' ')).toMatch(/card.*(unavailable|omitted|represent)/i);
});
