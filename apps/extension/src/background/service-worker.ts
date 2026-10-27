import { handleArchiveRequest, wakeArchive } from '../archive/background';
import { z } from 'zod';
import { OpenAICompatibleProvider, TranslationEngine } from '@pagelingo/translation-core';
import contentScript from '../content/index.ts?script&iife';
import {
  errorMessage,
  pageCommandSchema,
  type PageCommand,
  type PageStatus,
  type Result,
} from '../shared/types';
import { readSettings, restrictSettingsAccess } from '../settings/storage';
import { settingsSchema, type UserSettings } from '../settings/schema';
import { providerOptions, providerIdentity, requireApiPermission } from '../settings/connection';
import { isTrustedExtensionSender } from '../shared/translation';
import {
  connectTranslation,
  issueTranslationGrant,
  revokeTranslationGrant,
  cancelTranslationSession,
  database,
  scheduler,
} from './translation-jobs';
import { configureAssistantMenus, handleAssistantRequest, openAssistantMenu } from './assistant';

const commandSchema = z.object({
  type: z.literal('extension:command'),
  tabId: z.number().int().nonnegative(),
  command: pageCommandSchema,
});
const connectionSchema = z.object({ type: z.literal('extension:test-connection'), settings: settingsSchema });
const cancelSchema = z.strictObject({ type: z.literal('translation:cancel'), sessionId: z.uuid() });
const cacheSchema = z.object({
  type: z.literal('extension:cache'),
  action: z.enum(['stats', 'translations', 'documents', 'all']),
});

async function ensureContent(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:\/\//.test(tab.url) || /\.pdf(?:[?#]|$)/i.test(tab.url)) {
    throw new Error('请在普通 HTTP/HTTPS 文章页面打开 PageLingo。PDF 和浏览器内部页面暂不支持。');
  }
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { command: { type: 'page:status' } }, { frameId: 0 });
    if (reply?.ok) return;
  } catch {
    /* First invocation in this document. */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [contentScript] });
  } catch {
    throw new Error('无法访问此页面。请在目标页面点击扩展图标后重试，或刷新页面。');
  }
}

async function commandPage(tabId: number, command: PageCommand): Promise<Result<PageStatus>> {
  await ensureContent(tabId);
  const translationSessionId =
    command.type === 'page:translate' || command.type === 'page:selection'
      ? await issueTranslationGrant(tabId)
      : undefined;
  try {
    const result = (await chrome.tabs.sendMessage(
      tabId,
      { command, translationSessionId },
      { frameId: 0 },
    )) as Result<PageStatus>;
    if (!result?.ok && translationSessionId) revokeTranslationGrant(translationSessionId);
    return result;
  } catch (error) {
    if (translationSessionId) revokeTranslationGrant(translationSessionId);
    throw error;
  }
}

async function testConnection(settings: UserSettings) {
  await requireApiPermission(settings);
  const started = performance.now();
  const provider = new OpenAICompatibleProvider({ ...providerOptions(settings), maxOutputTokens: 128 });
  const engine = new TranslationEngine(provider);
  let sample = '';
  await scheduler.run(providerIdentity(settings).endpoint, async () => {
    for await (const batch of engine.translate(
      {
        id: 'connection-test',
        sourceLanguage: 'en',
        blocks: [
          {
            id: 'test',
            kind: 'paragraph',
            content: [{ type: 'text', text: 'The request can be cancelled.' }],
          },
        ],
      },
      { targetLanguage: settings.targetLanguage },
    ))
      sample = batch.translations[0].text;
  });
  return { model: settings.model, elapsedMs: Math.round(performance.now() - started), sample };
}

// Extension pages alone may initiate commands. No generic fetch or arbitrary script RPC.
chrome.runtime.onMessage.addListener((request: unknown, sender, sendResponse) => {
  if (handleArchiveRequest(request, sender, sendResponse, ensureContent)) return true;
  if (handleAssistantRequest(request, sender, sendResponse, ensureContent)) return true;
  const cancel = cancelSchema.safeParse(request);
  if (cancel.success) {
    void cancelTranslationSession(cancel.data.sessionId, sender)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (!isTrustedExtensionSender(sender)) return;
  const cache = cacheSchema.safeParse(request);
  if (cache.success) {
    void (async () => {
      if (cache.data.action !== 'stats') await database.clear(cache.data.action);
      return database.stats();
    })()
      .then((value) => sendResponse({ ok: true, value }))
      .catch(() => sendResponse({ ok: false, error: '缓存暂不可用。' }));
    return true;
  }
  const connection = connectionSchema.safeParse(request);
  if (connection.success) {
    void testConnection(connection.data.settings)
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }
  const parsed = commandSchema.safeParse(request);
  if (!parsed.success) return;
  void commandPage(parsed.data.tabId, parsed.data.command)
    .then(sendResponse)
    .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }));
  return true;
});

chrome.runtime.onConnect.addListener(connectTranslation);

function configure(): void {
  void restrictSettingsAccess().catch(() => console.warn('PageLingo: settings storage unavailable.'));
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'pagelingo-translate-selection',
      title: 'PageLingo：翻译选中内容',
      contexts: ['selection'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
    configureAssistantMenus();
  });
}

chrome.runtime.onInstalled.addListener(configure);
chrome.runtime.onStartup.addListener(() => {
  void restrictSettingsAccess().catch(() => console.warn('PageLingo: settings storage unavailable.'));
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (openAssistantMenu(info, tab, ensureContent)) return;
  if (info.menuItemId !== 'pagelingo-translate-selection' || tab?.id === undefined || !info.selectionText)
    return;
  const tabId = tab.id;
  // Cross-origin iframes are explicitly outside M1 scope.
  if (info.frameId && info.frameId !== 0) return;
  void commandPage(tabId, { type: 'page:selection', text: info.selectionText.slice(0, 30_000) })
    .then((result) => {
      if (!result.ok) throw new Error(result.error);
      return chrome.action.setBadgeText({ tabId, text: '' });
    })
    .catch(() => {
      void chrome.action.setBadgeText({ tabId, text: '!' });
      void chrome.action.setTitle({ tabId, title: 'PageLingo：无法翻译，请打开设置检查 API 配置和授权。' });
    });
});

// Re-establish trusted storage access after a worker restart without retaining secrets in globals.
void readSettings().catch(() => console.warn('PageLingo: check your saved settings.'));
// Only explicitly opened tabs receive their own panel; unrelated tabs stay unobstructed.
void chrome.sidePanel
  .setOptions({ enabled: false })
  .catch(() => console.warn('PageLingo: side panel unavailable.'));

void wakeArchive();
chrome.runtime.onStartup.addListener(() => { void wakeArchive(); });
