import { afterEach, expect, it, vi } from 'vitest';
import { handleAssistantRequest, openAssistantMenu } from '../../src/background/assistant';

afterEach(() => vi.unstubAllGlobals());
it('opens the native panel synchronously before asynchronous capture and stages a quote without a model request', async () => {
  const order: string[] = [];
  const pending: Record<string, unknown> = {};
  const badge = vi.fn(async () => {});
  vi.stubGlobal('chrome', {
    runtime: { id: 'extension', getURL: (p: string) => `chrome-extension://extension/${p}` },
    sidePanel: {
      setOptions: vi.fn(() => {
        order.push('configure');
        return Promise.resolve();
      }),
      open: vi.fn(() => {
        order.push('open');
        return Promise.resolve();
      }),
    },
    tabs: {
      get: vi.fn(async () => ({ id: 1, windowId: 2, url: 'https://example.test/article' })),
      sendMessage: vi.fn(async () => ({
        ok: true,
        value: {
          document: {
            key: 'web:https://example.test/article',
            revision: 'v1',
            title: 'Example',
            blocks: [],
            warnings: [],
          },
          quote: {
            id: 'q',
            documentKey: 'web:https://example.test/article',
            revision: 'v1',
            label: 'Reference',
            text: 'np.reshape',
            kind: 'code',
            blockIds: [],
          },
        },
      })),
    },
    storage: {
      session: {
        get: vi.fn(async () => pending),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(pending, values)),
      },
    },
    action: { setBadgeText: badge, setTitle: vi.fn() },
  });
  vi.stubGlobal('navigator', {
    locks: { request: async (_key: string, callback: () => Promise<unknown>) => callback() },
  });
  const ensure = vi.fn(async () => {
    order.push('capture');
  });
  expect(
    openAssistantMenu(
      {
        menuItemId: 'pagelingo-assistant-add',
        selectionText: 'np.reshape',
      } as chrome.contextMenus.OnClickData,
      { id: 1, windowId: 2 } as chrome.tabs.Tab,
      ensure,
    ),
  ).toBe(true);
  expect(order).toEqual(['configure', 'open']);
  expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 1 });
  expect(chrome.sidePanel.setOptions).toHaveBeenCalledWith({
    tabId: 1,
    path: 'src/sidepanel/index.html?tabId=1',
    enabled: true,
  });
  await vi.waitFor(() => expect(badge).toHaveBeenCalled());
  expect(order).toEqual(['configure', 'open', 'capture']);
  expect(pending['assistantPending:2']).toEqual([
    expect.objectContaining({ quote: expect.objectContaining({ text: 'np.reshape' }) }),
  ]);
});
it('rejects assistant commands originating in an ordinary web page or content script', () => {
  vi.stubGlobal('chrome', {
    runtime: { id: 'extension', getURL: (p: string) => `chrome-extension://extension/${p}` },
  });
  const reply = vi.fn();
  const ensure = vi.fn();
  expect(
    handleAssistantRequest(
      { type: 'extension:assistant-deliver', tabId: 1 },
      { id: 'extension', url: 'https://example.test/article' },
      reply,
      ensure,
    ),
  ).toBe(false);
  expect(reply).not.toHaveBeenCalled();
  expect(ensure).not.toHaveBeenCalled();
});
