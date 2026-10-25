// Synthetic pages shared by DOM tests and the Node 24 fixture server.
export const fixtureNames = ['arxiv', 'github-readme', 'technical-doc', 'x-post', 'x-article'] as const;

function page(title: string, style: string, body: string, script = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>${style}</style></head><body>
${body}
${script ? `<script>${script}</script>` : ''}
</body></html>`;
}

function arxivPage(): string {
  return page('Attention and efficient inference — research fixture', `
body{font:16px/1.7 Georgia,serif;margin:0;background:#fff;color:#252525}
nav{padding:12px;background:#eee}.ltx_document{max-width:760px;margin:40px auto;padding:0 22px}
h1{line-height:1.2}code,pre{font-family:monospace;background:#f4f4f4}
pre{padding:14px;overflow:auto}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #bbb;padding:8px}.hidden{display:none}
@media(prefers-color-scheme:dark){body{background:#171b1a;color:#eee}nav,code,pre{background:#292f2b}}
`, `
<nav><p>This navigation should never be translated.</p></nav>
<article class="ltx_document">
  <h1 id="title">Attention and efficient inference</h1>
  <section><h2 id="abstract">Abstract</h2><p id="abstract-text">A <strong>Transformer</strong> uses <a href="/attention" target="_blank" id="paper-link">self-attention</a> to process sequences.</p></section>
  <section><h2 id="method">Method</h2>
    <p id="code-paragraph">Enable <code id="inline-code">torch.compile(model)</code> before running inference.</p>
    <p id="math-paragraph">The loss is <math id="original-math"><mi>L</mi><mo>=</mo><mi>x</mi><msup><mi>y</mi><mn>2</mn></msup></math> under the stated assumptions.</p>
    <pre id="code-block"><code>import torch
model = torch.compile(model)
print("Do not translate this code")</code></pre>
    <blockquote id="quote"><p>Scaling does not guarantee better reasoning.</p><p>Results depend on the evaluation conditions.</p></blockquote>
    <ol id="steps"><li>Prepare the dataset.<ul><li>Remove invalid records.</li><li>Keep the <em>validation split</em> unchanged.</li></ul>Then verify the sample count.</li><li><p>Train with a fixed learning rate.</p></li></ol>
    <table id="results"><caption>Evaluation</caption><thead><tr><th>Method</th><th>Accuracy</th></tr></thead><tbody><tr><td><p>Our approach</p></td><td>92.5%</td></tr><tr><td>Baseline model</td><td>88.2%</td></tr></tbody></table>
    <figure><img id="diagram" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='20'%3E%3C/svg%3E" alt="Architecture diagram"><figcaption>Figure 1: The model architecture.</figcaption></figure>
    <p translate="no">Leave this publisher annotation unchanged.</p>
    <p class="hidden">Invisible metadata is not article content.</p>
    <p contenteditable="true">User editing area.</p>
  </section>
</article>
<footer><p>Publisher footer.</p></footer>
`, `window.originalLinkClicks=0;document.getElementById('paper-link').addEventListener('click',function(event){event.preventDefault();window.originalLinkClicks++});`);
}

function githubPage(): string {
  return page('Project README — fixture', `
body{font:16px/1.6 system-ui;margin:30px auto;max-width:900px;padding:0 20px}
nav{padding:12px;border-bottom:1px solid #bbb}.markdown-body{padding:24px;border:1px solid #ddd;border-radius:8px}
code,pre{background:#eee}pre{padding:18px}table{border-collapse:collapse}td,th{padding:8px;border:1px solid #aaa}
`, `
<nav><p>Code Issues Pull requests Actions</p></nav><article class="markdown-body">
<h1 id="project">Fast inference toolkit</h1><p>Build a <strong>reliable</strong> inference pipeline with <code>PyTorch</code>.</p>
<h2 id="install">Installation</h2><p>Run the following command:</p><pre id="readme-code"><code>pip install inference-toolkit --upgrade</code></pre>
<h2>Quick start</h2><ul><li>Load the checkpoint.</li><li><p>Configure the device.</p><p>Use <code>CUDA</code> when available.</p></li></ul>
<p>Read the <a href="/docs#configuration">configuration guide</a> for more details.</p>
<p><a href="javascript:void(0)">Open an interactive example</a> and inspect the output.</p>
<table><tr><th>Option</th><th>Description</th></tr><tr><td><code>batch_size</code></td><td>Number of samples per batch</td></tr></table>
<p>Literal protection markers can appear in documentation: ⟦A0⟧.</p>
</article>`);
}

function technicalDocPage(): string {
  return page('API guide — documentation fixture', `
body{font:16px/1.7 system-ui;margin:0;color:#27332e}header{padding:20px;border-bottom:1px solid #ddd}
main{display:grid;grid-template-columns:200px minmax(0,720px);gap:36px;max-width:1100px;margin:30px auto;padding:0 24px}
aside{padding:20px;background:#f6f7f6}article{min-width:0}code{background:#eef3ec}
.cards{display:flex;gap:12px}.cards>p{border:1px solid #ddd;padding:12px;flex:1}
@media(prefers-color-scheme:dark){body{background:#171d19;color:#eaf2ec}aside,code{background:#293b2e}}
`, `
<header>API documentation</header><main><aside><p>Getting started</p><p>Reference</p><p>Tutorials</p></aside><article id="doc-content">
<h1 id="api">Using the API</h1><p>Submit a request with a valid <em>authentication token</em>.</p>
<h2 id="retries">Retries<a id="retry-anchor" class="hash-link" href="#retries">&#8203;</a></h2><p>Retry only failed requests. Do <strong>not</strong> retry an authentication error.</p>
<div class="cards"><p>Keep the original request ID.</p><p>Respect the server rate limit.</p></div>
<dl><dt>Timeout</dt><dd>The maximum waiting time.</dd><dt>Endpoint</dt><dd>The URL of the service.</dd></dl>
<p>Version <code>v1.2.0</code> supports this feature.</p>
<p><button id="interactive">Launch example</button> Read the example output.</p>
<p id="changing">This paragraph can be updated by the application.</p>
</article></main>`);
}

function xPostPage(): string {
  const replies = [
    'This reply is deliberately longer than the original post to catch selection by text length.',
    'Replies should not replace the main post as the translation target.',
    'Repeating the reply makes its article the largest generic article on this fixture page.',
    'More unrelated reply text for testing which article the extension chooses.',
    'Even more unrelated reply text; this is not the requested post.',
    'Only the main post permalink identifies the correct article.',
  ].map(text => `<p>${text}</p>`).join('');
  return page('Post about agents / X', `
body{margin:0;font:16px/1.5 system-ui;background:#15202b;color:#f2f2f2}
main{max-width:680px;margin:24px auto}article{border:1px solid #536471;padding:20px;margin-bottom:20px}
[data-testid="tweetText"]{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font-size:20px}
.text-parent{display:flex;flex-direction:column;min-width:0}a{color:#1d9bf0}
aside{position:absolute;left:10000px;width:300px}
`, `
<nav><h2>Home navigation</h2></nav>
<main><div data-testid="primaryColumn"><h2>Post</h2>
<article data-testid="tweet" id="main-post">
  <div data-testid="User-Name">Pramod Goyal <span>@goyal__pramod</span></div>
  <a href="/goyal__pramod/status/2106244243727507733"><time>October 6</time></a>
  <div class="text-parent"><div data-testid="tweetText" lang="en" id="post-text"><span>Language models can use </span><a id="post-link" href="https://example.com/agents">tools</a><span> to solve difficult tasks. A policy chooses the next action. Evaluate the agent with reliable tests before deploying it. Long posts should retain their original text and show the translated text below it.</span></div></div>
  <div role="group"><button>Like <span id="like-count">12</span></button><button>Reply</button></div>
</article>
<article data-testid="tweet" id="long-reply">
  <div data-testid="User-Name">Another author</div>
  <a href="/someone/status/2106244243727507999"><time>Later</time></a>
  <div data-testid="tweetText">${replies}</div>
</article>
</div></main>
<aside><h2>Trending topics</h2><p>Recommended account content should not be translated.</p></aside>
`, `window.postLinkClicks=0;document.getElementById('post-link').addEventListener('click',event=>{event.preventDefault();window.postLinkClicks++;});`);
}

function xArticlePage(): string {
  const items = [
    ['x-item-1', 'Collect representative examples.'],
    ['x-item-2', 'Check the original text after translation.'],
  ].map(([id, text]) => `<li><div class="public-DraftStyleDefault-block" id="${id}">${text}</div></li>`).join('');
  return page('Building reliable agents / X', `
body{font:18px/1.6 system-ui;color:#0f1419;background:#fff}main{max-width:720px;margin:24px auto}
[role="heading"]{font-weight:bold}.longform-unstyled{margin:16px 0}
[data-testid="twitter-article-title"]{font-size:30px}aside{margin-top:24px}
`, `
<nav><h2>Explore</h2></nav><main><div data-testid="primaryColumn">
<div data-testid="twitterArticleReadView">
  <div data-testid="User-Name">Pramod Goyal</div><div id="article-engagement">12 likes</div>
  <div data-testid="twitter-article-title" role="heading" aria-level="1" id="x-title">Building reliable agents</div>
  <div data-testid="twitterArticleRichTextView" id="x-rich-body">
    <div role="heading" aria-level="2" id="x-section">Training and evaluation</div>
    <div data-block="true"><div class="public-DraftStyleDefault-block longform-unstyled" id="x-paragraph-1"><span data-offset-key="a-0-0"><span>Train a </span><strong>policy</strong><span> to choose actions. Evaluate the model with </span><a href="https://example.com/tests">reliable tests</a><span>.</span></span></div></div>
    <div data-block="true"><div class="public-DraftStyleDefault-block longform-unstyled" id="x-paragraph-2"><span>Preserve the code </span><code>agent.step()</code><span> while translating the surrounding explanation.</span></div></div>
    <ul>${items}</ul>
    <div data-block="true"><div data-testid="markdown-code-block" id="x-code-only">def agent_step():<br>    return "Do not translate this code"</div></div>
  </div>
</div>
<article data-testid="tweet"><a href="/someone/status/2106244243727507999"><time>Later</time></a><div data-testid="tweetText"><p>A reply outside the article body must not become the article translation.</p><p>It contains paragraphs unlike the rich text article above.</p><p>The original generic article picker incorrectly prefers this semantic article.</p></div></article>
</div></main><aside><h2>Related content</h2><p>Sidebar recommendation text.</p></aside>`);
}

export function renderFixture(name: string): string {
  switch (name) {
    case 'arxiv': return arxivPage();
    case 'github-readme': return githubPage();
    case 'technical-doc': return technicalDocPage();
    case 'x-post': return xPostPage();
    case 'x-article': return xArticlePage();
    default: throw new Error(`Unknown synthetic page: ${name}`);
  }
}
