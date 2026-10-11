import {
  assistantRequestSchema,
  assistantDeliverySchema,
  pendingAssistantKey,
  type AssistantDelivery,
} from '../shared/assistant';
import { webDocumentKey } from '@pagelingo/assistant-core';
import { isTrustedExtensionSender } from '../shared/translation';
import { errorMessage } from '../shared/types';
import { openAssistantPanel } from '../shared/assistant-panel';
type EnsureContent = (tabId: number) => Promise<void>;

export async function captureAssistant(
  tabId: number,
  ensureContent: EnsureContent,
  selectionText?: string,
): Promise<AssistantDelivery> {
  const before = await chrome.tabs.get(tabId);
  await ensureContent(tabId);
  const result = await chrome.tabs.sendMessage(
    tabId,
    { type: 'assistant:read', includeSelection: selectionText !== undefined, selectionText },
    { frameId: 0 },
  );
  if (!result?.ok) throw new Error(result?.error ?? '无法读取文章，请在目标页面右键打开阅读助手。');
  const after = await chrome.tabs.get(tabId);
  if (!after.url || after.url !== before.url) throw new Error('页面已切换，请在当前文章重新打开助手。');
  const data = assistantDeliverySchema.parse({
    id: crypto.randomUUID(),
    windowId: after.windowId,
    tabId,
    document: result.value.document,
    quote: result.value.quote,
  });
  if (data.document.key !== webDocumentKey(after.url)) throw new Error('文章地址已变化，请重新打开助手。');
  return data;
}
export async function deliverAssistant(tabId: number, ensureContent: EnsureContent, selectionText?: string) {
  const data = await captureAssistant(tabId, ensureContent, selectionText);
  const key = pendingAssistantKey(data.windowId);
  await navigator.locks.request(key, async () => {
    const old = (await chrome.storage.session.get(key))[key];
    const pending = Array.isArray(old) ? old : [];
    if (pending.length >= 20) throw new Error('待添加引用过多，请先在侧栏处理已有引用。');
    await chrome.storage.session.set({ [key]: [...pending, data] });
  });
  return data;
}
export function handleAssistantRequest(
  request: unknown,
  sender: chrome.runtime.MessageSender,
  reply: (value: unknown) => void,
  ensureContent: EnsureContent,
): boolean {
  if (!isTrustedExtensionSender(sender)) return false;
  const parsed = assistantRequestSchema.safeParse(request);
  if (!parsed.success) return false;
  void (async () => {
    const message = parsed.data;
    if (message.type === 'extension:assistant-context')
      return captureAssistant(message.tabId, ensureContent, message.selectionText);
    if (message.type === 'extension:assistant-deliver')
      return deliverAssistant(message.tabId, ensureContent, message.selectionText);
    if (message.type === 'extension:assistant-pending')
      return (
        (await chrome.storage.session.get(pendingAssistantKey(message.windowId)))[
          pendingAssistantKey(message.windowId)
        ] ?? []
      );
    if (message.type === 'extension:assistant-ack') {
      const key = pendingAssistantKey(message.windowId);
      await navigator.locks.request(key, async () => {
        const old = (await chrome.storage.session.get(key))[key];
        const pending = Array.isArray(old) ? old : [];
        const remaining = pending.filter(
          (p) =>
            !assistantDeliverySchema.safeParse(p).success ||
            assistantDeliverySchema.parse(p).id !== message.id,
        );
        if (remaining.length) await chrome.storage.session.set({ [key]: remaining });
        else await chrome.storage.session.remove(key);
      });
      return null;
    }
    await ensureContent(message.tabId);
    const result = await chrome.tabs.sendMessage(
      message.tabId,
      { type: 'assistant:reveal', blockId: message.blockId, revision: message.revision },
      { frameId: 0 },
    );
    if (!result?.ok) throw new Error(result?.error ?? '无法定位原文。');
    return null;
  })()
    .then((value) => reply({ ok: true, value }))
    .catch((error) => reply({ ok: false, error: errorMessage(error) }));
  return true;
}
export function configureAssistantMenus() {
  chrome.contextMenus.create({
    id: 'pagelingo-assistant-open',
    title: 'PageLingo：打开阅读助手',
    contexts: ['page'],
    documentUrlPatterns: ['http://*/*', 'https://*/*'],
  });
  chrome.contextMenus.create({
    id: 'pagelingo-assistant-add',
    title: 'PageLingo：添加到对话',
    contexts: ['selection'],
    documentUrlPatterns: ['http://*/*', 'https://*/*'],
  });
}
export function openAssistantMenu(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
  ensureContent: EnsureContent,
): boolean {
  if (!['pagelingo-assistant-open', 'pagelingo-assistant-add'].includes(String(info.menuItemId)))
    return false;
  if (tab?.id === undefined || (info.frameId && info.frameId !== 0)) return true;
  const tabId = tab.id;
  // Preserve the native user gesture: open before any asynchronous page capture.
  void openAssistantPanel(tabId).catch(() => {
    void chrome.action.setBadgeText({ tabId, text: '!' });
  });
  void deliverAssistant(
    tabId,
    ensureContent,
    info.menuItemId === 'pagelingo-assistant-add' ? info.selectionText : undefined,
  )
    .then(() => chrome.action.setBadgeText({ tabId, text: '' }))
    .catch(() => {
      void chrome.action.setBadgeText({ tabId, text: '!' });
      void chrome.action.setTitle({ tabId, title: 'PageLingo：无法读取文章，请点击扩展图标后重试。' });
    });
  return true;
}
