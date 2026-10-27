import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReadingAssistant } from '../../src/assistant/controller';
import { conversationLockName } from '../../src/assistant/storage';
import { defaultSettings } from '../../src/settings/schema';
import type { AssistantDelivery } from '../../src/shared/assistant';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const delivery = (key: string, tabId = 1): AssistantDelivery => ({
  id: key,
  windowId: 1,
  tabId,
  document: {
    key, revision: '1', title: key,
    blocks: [{ id: 'p1', kind: 'paragraph', text: `Article ${key}`, sectionPath: [] }],
    warnings: [],
  },
});
let assistant: ReadingAssistant;
let articles: Map<number, AssistantDelivery>;
let requests: { messages: { role: string; content: string }[] }[];
let held: Set<string>;

beforeEach(() => {
  held = new Set();
  // Web Locks hold ownership until the callback's promise settles, including
  // asynchronous IndexedDB writes. Only ifAvailable requests are used here.
  vi.stubGlobal('navigator', {
    locks: {
      async request<T>(name: string, _options: { ifAvailable: true }, fn: (lock: object | null) => Promise<T>) {
        if (held.has(name)) return fn(null);
        held.add(name);
        try { return await fn({ name }); }
        finally { held.delete(name); }
      },
      async query() { return { held: [...held].map((name) => ({ name })) }; },
    },
  });
  articles = new Map();
  const settings = {
    ...defaultSettings, baseUrl: 'https://model.invalid', model: 'test-model',
    assistant: { ...defaultSettings.assistant, stream: false },
  };
  vi.stubGlobal('chrome', {
    storage: {
      local: { setAccessLevel: async () => {}, get: async () => ({ settings }) },
      session: { setAccessLevel: async () => {} },
    },
    permissions: { contains: async () => true },
    runtime: {
      sendMessage: async ({ tabId }: { tabId: number }) => ({ ok: true, value: articles.get(tabId) }),
    },
  });
  requests = [];
  vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
    requests.push(JSON.parse(options.body as string));
    return new Response(JSON.stringify({
      choices: [{ index: 0, message: { content: 'Saved answer' }, finish_reason: 'stop' }],
    }));
  });
  assistant = new ReadingAssistant();
});

afterEach(async () => {
  await assistant.dispose();
  vi.unstubAllGlobals();
});

async function loadArticle(key = crypto.randomUUID(), tabId = 1) {
  const article = delivery(key, tabId);
  articles.set(tabId, article);
  await assistant.load(article);
  return article;
}

async function pendingDraft(text = 'First question') {
  const entered = gate();
  const release = gate();
  const save = assistant.store.save.bind(assistant.store);
  vi.spyOn(assistant.store, 'save').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return save(...args);
  });
  const draft = assistant.setDraft({ text });
  await entered.promise;
  return { draft, release: release.resolve };
}

it('sends after its own pending draft save releases the conversation lock', async () => {
  const article = await loadArticle();
  const pending = await pendingDraft();
  expect(held.has(conversationLockName(article.document.key))).toBe(true);
  const send = assistant.send();
  pending.release();
  await Promise.all([pending.draft, send]);

  expect(assistant.snapshot.error).toBe('');
  expect(requests).toHaveLength(1);
  expect((await assistant.store.get(article.document.key))?.messages).toMatchObject([
    { role: 'user', text: 'First question' },
    { role: 'assistant', text: 'Saved answer', status: 'completed' },
  ]);
});

it('still rejects a lock held by another window and can send after a rejected draft', async () => {
  const article = await loadArticle();
  const key = conversationLockName(article.document.key);
  held.add(key);
  await expect(assistant.setDraft({ text: 'First question' })).rejects.toThrow('其他窗口');
  await assistant.send();
  expect(assistant.snapshot.error).toContain('另一个窗口');
  expect(requests).toEqual([]);
  expect((await assistant.store.get(article.document.key))?.messages ?? []).toEqual([]);

  held.delete(key);
  await assistant.send();
  expect(assistant.snapshot.error).toBe('');
  expect((await assistant.store.get(article.document.key))?.messages[1]).toMatchObject({
    role: 'assistant', status: 'completed', text: 'Saved answer',
  });
});

it('cancels a send while waiting for its own draft without requesting a model', async () => {
  const article = await loadArticle();
  const pending = await pendingDraft();
  const send = assistant.send();
  assistant.stop();
  pending.release();
  await Promise.all([pending.draft, send]);

  expect(assistant.snapshot.busy).toBe(false);
  expect(assistant.snapshot.error).toBe('');
  expect(requests).toEqual([]);
  expect((await assistant.store.get(article.document.key))?.messages).toEqual([]);
});

it('keeps the article and question captured at send while drafts and the visible article change', async () => {
  const article = await loadArticle();
  const pending = await pendingDraft();
  const send = assistant.send();
  const edit = assistant.setDraft({ text: 'Later question' });
  const other = delivery(crypto.randomUUID(), 2);
  articles.set(2, other);
  const load = assistant.load(other);
  pending.release();
  await Promise.all([pending.draft, edit, load, send]);

  expect(assistant.snapshot.error).toBe('');
  expect(assistant.snapshot.delivery?.document.key).toBe(other.document.key);
  expect((await assistant.store.get(article.document.key))?.messages).toMatchObject([
    { role: 'user', text: 'First question' },
    { role: 'assistant', status: 'completed', text: 'Saved answer' },
  ]);
  expect((await assistant.store.get(other.document.key))?.messages ?? []).toEqual([]);
  expect(requests).toHaveLength(1);
  expect(requests[0].messages.at(-1)?.content).toContain('First question');
  expect(JSON.stringify(requests[0])).toContain(`Article ${article.document.key}`);
});
