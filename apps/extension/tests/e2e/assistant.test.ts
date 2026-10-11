import { expect, type BrowserContext, type Page } from '@playwright/test';
import { test } from './extension-fixture';

const host = 'http://127.0.0.1:4317';
type Metrics = {
  chatRequests: number;
  aborted: number;
  chatBodies: { messages: { role: string; content: string }[]; stream: boolean }[];
};
const metrics = async (): Promise<Metrics> => (await fetch(`${host}/llm/metrics`)).json();

async function configure(control: Page, model = 'assistant-model') {
  await fetch(`${host}/llm/reset`, { method: 'POST' });
  await control.getByLabel('Base URL').fill(`${host}/llm`);
  await control.getByLabel('API Key', { exact: true }).fill('local-test-secret');
  await control.getByLabel('Model', { exact: true }).fill(model);
  await save(control);
}
async function save(control: Page) {
  await control.getByRole('button', { name: '保存设置' }).click();
  await expect(control.getByText('设置已保存在本地')).toBeVisible();
}
async function deliver(control: Page, article: Page, selectionText?: string) {
  const result = await control.evaluate(
    async ({ url, selectionText }) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
      if (tab?.id === undefined) throw new Error('Missing article tab');
      return chrome.runtime.sendMessage({
        type: 'extension:assistant-deliver',
        tabId: tab.id,
        selectionText,
      });
    },
    { url: article.url(), selectionText },
  );
  expect(result?.ok, result?.error).toBe(true);
}
async function panelFor(
  context: BrowserContext,
  extensionId: string,
  control: Page,
  article: Page,
  selection?: string,
) {
  await deliver(control, article, selection);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await expect(panel.locator('#question')).toBeEnabled();
  return panel;
}
async function ask(panel: Page, text: string) {
  await panel.getByLabel('你的问题').fill(text);
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.getByRole('button', { name: '重试回答' })).toBeEnabled();
}

test('opens the native side panel from the production popup using a browser gesture', async ({
  context,
  extensionId,
  control,
  page,
}) => {
  await configure(control);
  await page.goto(`${host}/technical-doc`);
  await page.bringToFront();
  const tabId = await control.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)!.id!,
    page.url(),
  );
  const opened = context.waitForEvent('page');
  await control.evaluate(() =>
    chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/index.html'), active: false }),
  );
  const popup = await opened;
  await expect(popup.getByRole('button', { name: '打开阅读助手 ↗' })).toBeEnabled();
  await popup.getByRole('button', { name: '打开阅读助手 ↗' }).click();
  await expect
    .poll(async () =>
      control.evaluate(async () =>
        (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).map((c) => c.documentUrl),
      ),
    )
    .toContain(`chrome-extension://${extensionId}/src/sidepanel/index.html?tabId=${tabId}`);
  const options = await control.evaluate(
    async (tabId) => ({
      defaults: await chrome.sidePanel.getOptions({}),
      tab: await chrome.sidePanel.getOptions({ tabId }),
    }),
    tabId,
  );
  expect(options.defaults.enabled).toBe(false);
  expect(options.tab.enabled).toBe(true);
  expect(options.tab.path).toBe(`src/sidepanel/index.html?tabId=${tabId}`);
  const other = await context.newPage();
  await other.goto(`${host}/github-readme`);
  await other.bringToFront();
  const otherOptions = await control.evaluate(async (url) => {
    const id = (await chrome.tabs.query({})).find((t) => t.url === url)!.id!;
    return chrome.sidePanel.getOptions({ tabId: id });
  }, other.url());
  expect(otherOptions.enabled).toBe(false);
  expect((await metrics()).chatRequests).toBe(0);
});

test('stages code references without a request, preserves Markdown, and restores conversation and draft', async ({
  context,
  extensionId,
  control,
  page,
}, testInfo) => {
  await configure(control);
  const remoteImages: string[] = [];
  context.on('request', (request) => {
    if (request.url().includes('assistant-tracking')) remoteImages.push(request.url());
  });
  await page.goto(`${host}/technical-doc`);
  const code = '    result = np.reshape(x, (2, 3))\n        print(result)\n';
  await page.locator('article').evaluate((article, code) => {
    const pre = document.createElement('pre');
    pre.textContent = code;
    article.append(pre);
    const range = document.createRange();
    range.selectNodeContents(pre);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, code);
  const panel = await panelFor(context, extensionId, control, page, code.replace(/\s+/g, ' ').trim());
  await expect(panel.locator('.draft-quotes .quote-card')).toHaveCount(1);
  expect((await metrics()).chatRequests).toBe(0);
  await ask(panel, '解释这段 NumPy 代码');
  await expect(panel.locator('.markdown')).toContainText('np.reshape');
  expect(await panel.locator('.markdown pre code').textContent()).toContain('\n    print(result)');
  await expect(panel.locator('.markdown a')).toHaveCount(0);
  await expect(panel.locator('.markdown img')).toHaveCount(0);
  expect(remoteImages).toEqual([]);
  expect(
    await panel.evaluate(
      () => (globalThis as typeof globalThis & { assistantUnsafe?: boolean }).assistantUnsafe,
    ),
  ).toBeUndefined();
  const body = (await metrics()).chatBodies[0];
  const content = JSON.parse(body.messages.at(-2)!.content);
  expect(body.messages.at(-1)!.content).toContain(code);
  expect(content.document.blocks.find((b: { kind: string }) => b.kind === 'code').text).toBe(code);
  expect(JSON.stringify(body)).not.toContain('response_format');
  await panel.setViewportSize({ width: 400, height: 860 });
  await panel.screenshot({ path: testInfo.outputPath('assistant-light.png') });
  const lightButton = await panel
    .locator('.header-actions button')
    .first()
    .evaluate((button) => getComputedStyle(button).backgroundColor);
  await panel.emulateMedia({ colorScheme: 'dark' });
  await expect
    .poll(() =>
      panel
        .locator('.header-actions button')
        .first()
        .evaluate((button) => getComputedStyle(button).backgroundColor),
    )
    .not.toBe(lightButton);
  await panel.screenshot({ path: testInfo.outputPath('assistant-dark.png') });
  await panel.emulateMedia({ colorScheme: 'light' });
  await panel.getByLabel('你的问题').fill('待发送的后续问题');
  // Re-opening a real side panel reads the underlying tab. A tab-hosted headless
  // panel is explicitly reconnected to that article after reload instead.
  await panel.reload();
  await deliver(control, page);
  await expect(panel.locator('.chat-message.user')).toHaveCount(1);
  await expect(panel.getByLabel('你的问题')).toHaveValue('待发送的后续问题');
  await ask(panel, '继续解释维度变化');
  const next = (await metrics()).chatBodies.at(-1)!;
  expect(next.messages.some((m) => m.role === 'assistant' && m.content.includes('np.reshape'))).toBe(true);
  await panel.getByRole('button', { name: '历史', exact: true }).click();
  await expect(panel.getByText('本地对话 · 1 篇文章')).toBeVisible();
  const download = panel.waitForEvent('download');
  await panel.getByRole('button', { name: '导出', exact: true }).click();
  const exported = await (await download).createReadStream();
  let json = '';
  for await (const chunk of exported!) json += chunk;
  expect(JSON.parse(json).conversations[0].messages).toHaveLength(4);
  expect(json).not.toContain('local-test-secret');
});

test('retains multiple references delivered before the side panel starts', async ({
  context,
  extensionId,
  control,
  page,
}) => {
  await configure(control);
  await page.goto(`${host}/technical-doc`);
  await deliver(control, page, 'authentication token');
  await deliver(control, page, 'Keep the original request ID.');
  const panel = await panelFor(context, extensionId, control, page, 'Respect the server rate limit.');
  await expect(panel.locator('.draft-quotes .quote-card')).toHaveCount(3);
  expect((await metrics()).chatRequests).toBe(0);
  await ask(panel, '解释这三个引用');
  const content = JSON.parse((await metrics()).chatBodies[0].messages.at(-2)!.content);
  expect(content.selectionSources).toHaveLength(3);
  const prompt = (await metrics()).chatBodies[0].messages.at(-1)!.content;
  for (const quote of [
    'authentication token',
    'Keep the original request ID.',
    'Respect the server rate limit.',
  ])
    expect(prompt).toContain(quote);
});

test('keeps the selected term visible and sends it with a vague question, including on retry', async ({
  context,
  extensionId,
  control,
  page,
}) => {
  await configure(control);
  await page.goto(`${host}/technical-doc`);
  await page.locator('article').evaluate((article) => {
    const heading = document.createElement('h1');
    heading.textContent = 'Scaling the wrong thing';
    const paragraph = document.createElement('p');
    paragraph.textContent = 'We used kubernetes to scale the infrastructure.';
    article.replaceChildren(heading, paragraph);
    const start = paragraph.textContent.indexOf('kubernetes');
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, start);
    range.setEnd(paragraph.firstChild!, start + 'kubernetes'.length);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  const panel = await panelFor(context, extensionId, control, page, 'kubernetes');
  await expect(panel.locator('.draft-quotes .quote-card')).toHaveCount(1);
  expect((await metrics()).chatRequests).toBe(0);
  await ask(panel, '解释一下这个东西');
  const body = (await metrics()).chatBodies[0];
  const content = JSON.parse(body.messages.at(-2)!.content);
  const prompt = body.messages.at(-1)!.content;
  expect(prompt.endsWith('解释一下这个东西')).toBe(true);
  expect(prompt).toContain('kubernetes');
  expect(prompt).not.toContain('Scaling the wrong thing');
  expect(prompt).not.toContain('We used kubernetes to scale the infrastructure.');
  expect(content.selectionSources).toHaveLength(1);
  expect(content.selectionSources[0].label).toBe('Scaling the wrong thing');
  expect(content.document.title).toBe('Scaling the wrong thing');
  const summary = panel.locator('.chat-message.user .quote-card > summary');
  await expect(summary).toContainText('kubernetes');
  await expect(summary).not.toContainText('Scaling the wrong thing');
  await panel.getByRole('button', { name: '重试回答' }).click();
  await expect(panel.getByRole('button', { name: '重试回答' })).toBeEnabled();
  await expect.poll(async () => (await metrics()).chatRequests).toBe(2);
  const retry = JSON.parse((await metrics()).chatBodies[1].messages.at(-2)!.content);
  expect((await metrics()).chatBodies[1].messages.at(-1)!.content).toBe(prompt);
  expect(retry.selectionSources).toEqual(content.selectionSources);
  await expect(panel.locator('.chat-message.user')).toHaveCount(1);
});

test('sends the 22-character RL selection as the final question without expanding it to its parent paragraph', async ({
  context,
  extensionId,
  control,
  page,
}) => {
  await configure(control);
  await page.goto(`${host}/technical-doc`);
  const introduction =
    'Reinforcement learning (RL) has played a crucial role throughout the history of research on large language models (LLMs). ' +
    'Through RL, we created early versions of instruction following models, made important advancements in alignment and safety, and enabled LLMs to solve complex reasoning problems. ' +
    'In this overview, we will cover the fundamentals of RL and the evolution of policy gradient algorithms.';
  await page.locator('article').evaluate((article, introduction) => {
    const heading = document.createElement('h1');
    heading.textContent = 'Reinforcement Learning for LLMs: The Complete Guide';
    article.replaceChildren(heading);
    for (let i = 1; i <= 100; i++) {
      const paragraph = document.createElement('p');
      paragraph.textContent =
        i === 5
          ? introduction
          : 'This chapter discusses policy gradients and model training experiments. '.repeat(30);
      article.append(paragraph);
      if (i === 5) {
        const range = document.createRange();
        range.setStart(paragraph.firstChild!, 0);
        range.setEnd(paragraph.firstChild!, 'Reinforcement learning'.length);
        const selection = document.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }, introduction);
  const panel = await panelFor(context, extensionId, control, page, 'Reinforcement learning');
  await expect(panel.locator('.draft-quotes .quote-preview')).toHaveText('Reinforcement learning');
  await expect(panel.locator('.draft-quotes .quote-count')).toHaveText('22 字符');
  await ask(panel, '这是什么意思？');
  const body = (await metrics()).chatBodies[0];
  const prompt = body.messages.at(-1)!.content;
  const background = JSON.parse(body.messages.at(-2)!.content);
  expect(body.messages.at(-1)!.role).toBe('user');
  expect(prompt).toContain('\nReinforcement learning\n');
  expect(prompt.endsWith('这是什么意思？')).toBe(true);
  expect(prompt).not.toContain('crucial role');
  expect(prompt).not.toContain('r5');
  expect(background.document.coverage).toBe('partial');
  expect(background.document.blocks.find((b: { id: string }) => b.id === 'r5').text).toBe(introduction);
  expect(background.selectionSources[0].sourceBlockIds).toEqual(['r5']);
});

test('sends with Enter, inserts a newline with Shift Enter and ignores IME confirmation', async ({
  context,
  extensionId,
  control,
  page,
}) => {
  await configure(control);
  await page.goto(`${host}/technical-doc`);
  const panel = await panelFor(context, extensionId, control, page);
  const question = panel.getByLabel('你的问题');
  await question.fill('解释这个 API');
  await question.press('Shift+Enter');
  await question.pressSequentially('请给一个示例');
  await expect(question).toHaveValue('解释这个 API\n请给一个示例');
  await question.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }));
  });
  expect((await metrics()).chatRequests).toBe(0);
  await question.press('Enter');
  await expect(panel.getByRole('button', { name: '重试回答' })).toBeEnabled();
  expect((await metrics()).chatBodies[0].messages.at(-1)!.content).toBe('解释这个 API\n请给一个示例');
  await expect(panel.locator('.chat-message.user')).toHaveCount(1);
  await question.fill('继续解释');
  await question.press('Control+Enter');
  await expect(panel.getByRole('button', { name: '重试回答' })).toBeEnabled();
  await expect.poll(async () => (await metrics()).chatRequests).toBe(2);
});

test('tab-bound panels retain their own article and consume only their own pending references', async ({
  context,
  extensionId,
  control,
  page,
}) => {
  await configure(control);
  await page.goto(`${host}/technical-doc`);
  const other = await context.newPage();
  await other.goto(`${host}/github-readme`);
  const tabIds = await control.evaluate(
    async (urls) => {
      const tabs = await chrome.tabs.query({});
      return urls.map((url) => tabs.find((t) => t.url === url)!.id!);
    },
    [page.url(), other.url()],
  );
  await deliver(control, page, 'authentication token');
  const first = await context.newPage();
  await first.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html?tabId=${tabIds[0]}`);
  await expect(first.locator('#question')).toBeEnabled();
  await expect(first.locator('.draft-quotes .quote-preview')).toHaveText('authentication token');
  await other.bringToFront();
  await deliver(control, other, 'Fast inference toolkit');
  await expect(first.locator('.article-name')).toHaveText('Using the API');
  await expect(first.locator('.draft-quotes .quote-preview')).toHaveText('authentication token');
  const second = await context.newPage();
  await second.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html?tabId=${tabIds[1]}`);
  await expect(second.locator('#question')).toBeEnabled();
  await expect(second.locator('.article-name')).toHaveText('Fast inference toolkit');
  await expect(second.locator('.draft-quotes .quote-preview')).toHaveText('Fast inference toolkit');
  await other.bringToFront();
  await first.getByRole('button', { name: '接入当前文章', exact: true }).click();
  await expect(first.locator('.article-name')).toHaveText('Using the API');
  await ask(first, '解释这个术语');
  await ask(second, '解释这个项目');
  const requests = (await metrics()).chatBodies;
  expect(JSON.parse(requests[0].messages.at(-2)!.content).document.url).toBe(page.url());
  expect(requests[0].messages.at(-1)!.content).toContain('authentication token');
  expect(JSON.parse(requests[1].messages.at(-2)!.content).document.url).toBe(other.url());
  expect(requests[1].messages.at(-1)!.content).toContain('Fast inference toolkit');
});

test('clamps long reference previews to three lines while sending and storing the complete code', async ({
  context,
  extensionId,
  control,
  page,
}, testInfo) => {
  await configure(control);
  await page.goto(`${host}/technical-doc`);
  const code = [
    '    const deployment = {',
    '        name: "selection-preview-example",',
    '        runtime: "kubernetes",',
    '        replicas: 3,',
    '        port: 8080,',
    '    };',
    '    deploy(deployment);',
    '    // Last line must reach the model and local history.',
    '',
  ].join('\n');
  await page.locator('article').evaluate((article, code) => {
    const pre = document.createElement('pre');
    pre.textContent = code;
    article.append(pre);
    const range = document.createRange();
    range.selectNodeContents(pre);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, code);
  const panel = await panelFor(context, extensionId, control, page, code);
  const card = panel.locator('.draft-quotes .quote-card');
  await expect(card).toHaveCount(1);
  await expect(card.locator('summary')).toContainText('代码引用');
  const preview = card.locator('.quote-preview');
  await expect(preview).toHaveText(code);
  for (const width of [280, 400]) {
    await panel.setViewportSize({ width, height: 860 });
    const layout = await preview.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        clamp: style.webkitLineClamp,
        lineHeight: Number.parseFloat(style.lineHeight),
        height: element.clientHeight,
        fullHeight: element.scrollHeight,
      };
    });
    expect(layout.clamp).toBe('3');
    expect(layout.height).toBeLessThanOrEqual(layout.lineHeight * 3 + 1);
    expect(layout.fullHeight).toBeGreaterThan(layout.height);
  }
  await expect(card.locator('.quote-source')).not.toBeVisible();
  await panel.screenshot({ path: testInfo.outputPath('assistant-reference-preview.png') });
  await card.locator(':scope > summary').click();
  await expect(card.locator('.quote-source')).toBeVisible();
  expect(await card.locator(':scope > pre').textContent()).toBe(code);
  await card.locator(':scope > summary').click();
  await ask(panel, '解释这段代码');
  expect((await metrics()).chatBodies[0].messages.at(-1)!.content).toContain(code);
  await panel.reload();
  await deliver(control, page);
  const restored = panel.locator('.chat-message.user .quote-card');
  await expect(restored).toHaveCount(1);
  await restored.locator(':scope > summary').click();
  expect(await restored.locator(':scope > pre').textContent()).toBe(code);
});

test('stops streaming with the partial answer retained and retries without duplicating the user turn', async ({
  context,
  extensionId,
  control,
  page,
}) => {
  await configure(control, 'assistant-slow-model');
  await page.goto(`${host}/technical-doc`);
  const panel = await panelFor(context, extensionId, control, page);
  await panel.getByLabel('你的问题').fill('解释 np.reshape');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.locator('.markdown')).toContainText('np.reshape');
  await panel.getByRole('button', { name: '停止生成' }).click();
  await expect(panel.getByText('已中断', { exact: true })).toBeVisible();
  await expect(panel.locator('.markdown')).toContainText('np.reshape');
  await panel.getByRole('button', { name: '重试回答' }).click();
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  await expect(panel.locator('.markdown pre')).toBeVisible();
  await expect(panel.locator('.chat-message.user')).toHaveCount(1);
  await expect(panel.locator('.chat-message.assistant')).toHaveCount(1);
  expect((await metrics()).chatRequests).toBe(2);
});

test('supports ordinary JSON responses and keeps provider errors safe when retrying', async ({
  context,
  extensionId,
  control,
  page,
}) => {
  await configure(control, 'assistant-error-model');
  await control.getByText('对话与上下文设置', { exact: true }).click();
  await control.getByLabel('助手响应方式').selectOption('json');
  await save(control);
  await page.goto(`${host}/technical-doc`);
  const panel = await panelFor(context, extensionId, control, page);
  await ask(panel, '解释这个 API');
  await expect(panel.getByRole('alert')).toContainText('503');
  expect(await panel.locator('body').textContent()).not.toContain('local-test-secret');
  await control.getByLabel('Model', { exact: true }).fill('assistant-model');
  await save(control);
  await panel.getByRole('button', { name: '重试回答' }).click();
  await expect(panel.locator('.markdown pre')).toBeVisible();
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  await expect(panel.locator('.chat-message.user')).toHaveCount(1);
  expect((await metrics()).chatBodies.at(-1)!.stream).toBe(false);
});

test('keeps an in-flight answer bound to its article while another article is connected', async ({
  context,
  extensionId,
  control,
  page,
}) => {
  await configure(control, 'assistant-slow-model');
  await page.goto(`${host}/technical-doc`);
  const panel = await panelFor(context, extensionId, control, page);
  await panel.getByLabel('你的问题').fill('解释原来的 API 文档');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.locator('.markdown')).toContainText('np.reshape');
  const other = await context.newPage();
  await other.goto(`${host}/github-readme`);
  await deliver(control, other);
  await expect(panel.locator('.article-name')).toContainText('Fast inference toolkit');
  await expect(panel.locator('.chat-message')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  await ask(panel, '解释这个新项目');
  const current = JSON.parse((await metrics()).chatBodies.at(-1)!.messages.at(-2)!.content);
  expect(current.document.key).toContain('github-readme');
  expect(JSON.stringify(current)).not.toContain('解释原来的 API 文档');
  await deliver(control, page);
  await expect(panel.locator('.user-text')).toHaveText('解释原来的 API 文档');
  await expect(panel.locator('.markdown pre')).toBeVisible();
});

test('evicts older URL histories according to the configured article count', async ({
  context,
  extensionId,
  control,
  page,
}) => {
  await configure(control);
  await control.getByLabel('保留对话的文章数量').fill('2');
  await save(control);
  await page.goto(`${host}/technical-doc`);
  const panel = await panelFor(context, extensionId, control, page);
  await ask(panel, '第一篇');
  const second = await context.newPage();
  await second.goto(`${host}/github-readme`);
  await deliver(control, second);
  await ask(panel, '第二篇');
  const third = await context.newPage();
  await third.goto(`${host}/arxiv`);
  await deliver(control, third);
  await ask(panel, '第三篇');
  await panel.getByRole('button', { name: '历史', exact: true }).click();
  await expect(panel.getByText('本地对话 · 2 篇文章')).toBeVisible();
  await expect(panel.locator('.history-title')).toHaveCount(2);
  expect(await panel.locator('.history-list').textContent()).not.toContain('Using the API');
});

test('reports partial article coverage and rejects an oversized full article before requesting the model', async ({
  context,
  extensionId,
  control,
  page,
}) => {
  await configure(control);
  await control.getByText('对话与上下文设置', { exact: true }).click();
  await control.getByLabel('助手每次输入 Token 预算').fill('2000');
  await save(control);
  await page.goto(`${host}/technical-doc`);
  await page.locator('article').evaluate((article) => {
    for (let i = 0; i < 80; i++) {
      const p = document.createElement('p');
      p.textContent = `Large block ${i}: ` + 'The array function reshapes data. '.repeat(40);
      article.append(p);
    }
  });
  const panel = await panelFor(context, extensionId, control, page);
  await ask(panel, '解释 authentication token');
  await expect(panel.locator('.context-info')).toContainText('文章相关片段');
  const before = (await metrics()).chatRequests;
  await panel.getByLabel('文章上下文范围').selectOption('full');
  await ask(panel, '总结全文');
  await expect(panel.getByRole('alert')).toContainText('全文');
  expect((await metrics()).chatRequests).toBe(before);
});

test('reads original content from a translated page and ignores unrelated oversized selections', async ({
  context,
  extensionId,
  control,
  page,
}) => {
  await configure(control);
  await page.goto(`${host}/technical-doc`);
  await control.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === url)!;
    const result = await chrome.runtime.sendMessage({
      type: 'extension:command',
      tabId: tab.id,
      command: { type: 'page:preview', mode: 'translation' },
    });
    if (!result?.ok) throw new Error(result?.error);
  }, page.url());
  await expect(page.locator('[data-pl-owned="translation"]').first()).toBeVisible();
  await page.locator('aside').evaluate((aside) => {
    aside.textContent = 'z'.repeat(60_000);
    const range = document.createRange();
    range.selectNodeContents(aside);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  const panel = await panelFor(context, extensionId, control, page);
  await expect(panel.locator('.draft-quotes .quote-card')).toHaveCount(0);
  await ask(panel, '解释原文的 authentication token');
  const current = JSON.parse((await metrics()).chatBodies[0].messages.at(-2)!.content);
  expect(JSON.stringify(current.document.blocks)).toContain('Submit a request with a valid');
  expect(JSON.stringify(current.document.blocks)).not.toContain('【布局预览】');
});

test('prevents concurrent runs on one document and preserves later questions from another panel', async ({
  context,
  extensionId,
  control,
  page,
}) => {
  await configure(control, 'assistant-long-model');
  await page.goto(`${host}/technical-doc`);
  const first = await panelFor(context, extensionId, control, page);
  const second = await context.newPage();
  await second.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await deliver(control, page);
  await expect(second.locator('#question')).toBeEnabled();
  await first.getByLabel('你的问题').fill('第一个窗口的问题');
  await first.getByRole('button', { name: '发送', exact: true }).click();
  await expect(first.locator('.markdown')).toContainText('np.reshape');
  await second.getByLabel('你的问题').fill('第二个窗口的问题');
  await second.getByRole('button', { name: '发送', exact: true }).click();
  await expect(second.getByRole('alert')).toContainText('另一个窗口');
  expect((await metrics()).chatRequests).toBe(1);
  await first.getByRole('button', { name: '停止生成' }).click();
  await expect(first.getByText('已中断', { exact: true })).toBeVisible();
  await control.getByLabel('Model', { exact: true }).fill('assistant-model');
  await save(control);
  await second.getByRole('button', { name: '发送', exact: true }).click();
  await expect(second.getByRole('button', { name: '重试回答' })).toBeEnabled();
  await expect(second.locator('.chat-message.user')).toHaveCount(2);
  await expect(second.locator('.user-text').first()).toHaveText('第一个窗口的问题');
  await expect(second.locator('.user-text').last()).toHaveText('第二个窗口的问题');
});

test('restores an interrupted stream after the panel closes and retries the same question', async ({
  context,
  extensionId,
  control,
  page,
}) => {
  await configure(control, 'assistant-long-model');
  await page.goto(`${host}/technical-doc`);
  let panel = await panelFor(context, extensionId, control, page);
  await panel.getByLabel('你的问题').fill('关闭窗口前的问题');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.locator('.markdown')).toContainText('np.reshape');
  await panel.close();
  await control.getByLabel('Model', { exact: true }).fill('assistant-model');
  await save(control);
  panel = await panelFor(context, extensionId, control, page);
  await expect(panel.getByText('已中断', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '重试回答' }).click();
  await expect(panel.locator('.markdown pre')).toBeVisible();
  await expect(panel.locator('.chat-message.user')).toHaveCount(1);
});

test('persists memory summaries while retaining every original message', async ({
  context,
  extensionId,
  control,
  page,
}) => {
  await configure(control);
  await control.getByText('对话与上下文设置', { exact: true }).click();
  await control.getByLabel('助手每次输入 Token 预算').fill('4000');
  await save(control);
  await page.goto(`${host}/technical-doc`);
  const panel = await panelFor(context, extensionId, control, page);
  for (let i = 0; i < 9; i++)
    await ask(panel, `Question ${i}: explain np.reshape. ` + 'Important context. '.repeat(25));
  const calls = await metrics();
  expect(calls.chatRequests).toBeGreaterThan(9);
  const final = JSON.parse(calls.chatBodies.at(-1)!.messages.at(-2)!.content);
  expect(final.earlierConversationSummary).toContain('较早对话的摘要');
  await expect(panel.locator('.chat-message')).toHaveCount(18);
  await panel.reload();
  await deliver(control, page);
  await expect(panel.locator('.chat-message')).toHaveCount(18);
  await ask(panel, '后续短问题');
  const next = JSON.parse((await metrics()).chatBodies.at(-1)!.messages.at(-2)!.content);
  expect(next.earlierConversationSummary).toContain('较早对话的摘要');
});
test('detaches an old conversation after navigation in the same tab and reconnects the new article', async ({
  context,
  extensionId,
  control,
  page,
}) => {
  await configure(control);
  await page.goto(`${host}/technical-doc`);
  const panel = await panelFor(context, extensionId, control, page);
  await ask(panel, '原文章的问题');
  await page.goto(`${host}/github-readme`);
  await expect(
    panel.getByText('页面已切换。当前对话仍属于上面的文章，请在新文章右键打开助手或重新接入。'),
  ).toBeVisible();
  await panel.getByLabel('你的问题').fill('新文章的问题');
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await deliver(control, page);
  await expect(panel.locator('.article-name')).toContainText('Fast inference toolkit');
  await expect(panel.locator('.chat-message')).toHaveCount(0);
  await ask(panel, '新文章的问题');
  expect(JSON.stringify((await metrics()).chatBodies.at(-1))).not.toContain('原文章的问题');
});
