import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { webDocumentKey, type ContextMode } from '@pagelingo/assistant-core';
import { ReadingAssistant } from '../assistant/controller';
import { assistantDeliverySchema, pendingAssistantKey } from '../shared/assistant';
import { errorMessage } from '../shared/types';
import { Markdown, QuoteCard } from './message';
import '../ui/style.css';
import './style.css';

const controller = new ReadingAssistant();
const tabParameter = new URL(location.href).searchParams.get('tabId');
const boundTabId =
  tabParameter !== null && /^\d+$/.test(tabParameter) && Number.isSafeInteger(Number(tabParameter))
    ? Number(tabParameter)
    : undefined;
function SidePanel() {
  const state = useSyncExternalStore(controller.subscribe, () => controller.snapshot);
  const [error, setError] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const windowId = useRef<number | undefined>(undefined);
  const received = useRef(new Set<string>());
  const deliveryQueue = useRef<Promise<unknown>>(Promise.resolve());
  const safely = (fn: () => Promise<unknown>) => {
    setError('');
    void fn().catch((e) => setError(errorMessage(e)));
  };
  async function accept(raw: unknown) {
    const delivery = assistantDeliverySchema.parse(raw);
    if (boundTabId !== undefined && delivery.tabId !== boundTabId) return;
    if (received.current.has(delivery.id)) return;
    received.current.add(delivery.id);
    const next = deliveryQueue.current
      .catch(() => {})
      .then(async () => {
        try {
          if (await controller.load(delivery))
            await chrome.runtime.sendMessage({
              type: 'extension:assistant-ack',
              windowId: delivery.windowId,
              id: delivery.id,
            });
        } catch (e) {
          received.current.delete(delivery.id);
          throw e;
        }
      });
    deliveryQueue.current = next;
    return next;
  }
  async function currentArticle() {
    setLoading(true);
    try {
      const tab =
        boundTabId === undefined
          ? (await chrome.tabs.query({ active: true, windowId: windowId.current }))[0]
          : await chrome.tabs.get(boundTabId);
      if (tab?.id === undefined) throw new Error('没有找到当前文章，请在页面右键打开阅读助手。');
      const result = await chrome.runtime.sendMessage({ type: 'extension:assistant-context', tabId: tab.id });
      if (!result?.ok) throw new Error(result?.error ?? '无法读取当前文章。');
      await accept(result.value);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    let active = true;
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && windowId.current !== undefined) {
        const next = changes[pendingAssistantKey(windowId.current)]?.newValue;
        if (Array.isArray(next) && active)
          safely(async () => {
            for (const item of next) await accept(item);
          });
      }
    };
    chrome.storage.onChanged.addListener(changed);
    const activated = (info: { tabId: number; windowId: number }) => {
      // Native tab panels hide on other tabs; their conversation stays attached.
      if (boundTabId !== undefined) return;
      if (info.windowId !== windowId.current || info.tabId === controller.snapshot.delivery?.tabId) return;
      void chrome.tabs
        .get(info.tabId)
        .then((tab) => {
          if (!tab.url?.startsWith(chrome.runtime.getURL('')) && controller.snapshot.delivery)
            controller.detach();
        })
        .catch(() => {});
    };
    const navigated = (tabId: number, change: chrome.tabs.OnUpdatedInfo) => {
      const delivery = controller.snapshot.delivery;
      if (tabId !== delivery?.tabId || !change.url) return;
      try {
        if (webDocumentKey(change.url) !== delivery.document.key) controller.detach();
      } catch {
        controller.detach();
      }
    };
    chrome.tabs.onActivated.addListener(activated);
    chrome.tabs.onUpdated.addListener(navigated);
    void chrome.windows
      .getCurrent()
      .then(async (window) => {
        if (!active || window.id === undefined) return;
        windowId.current = window.id;
        const result = await chrome.runtime.sendMessage({
          type: 'extension:assistant-pending',
          windowId: window.id,
        });
        const pending =
          result?.ok && Array.isArray(result.value)
            ? result.value.filter(
                (item: unknown) =>
                  boundTabId === undefined ||
                  assistantDeliverySchema.safeParse(item).data?.tabId === boundTabId,
              )
            : [];
        if (pending.length) {
          for (const item of pending) await accept(item);
        } else await currentArticle();
        await controller.refreshHistory();
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    const pagehide = () => {
      controller.stop();
    };
    globalThis.addEventListener('pagehide', pagehide);
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(changed);
      chrome.tabs.onActivated.removeListener(activated);
      chrome.tabs.onUpdated.removeListener(navigated);
      globalThis.removeEventListener('pagehide', pagehide);
    };
  }, []);
  useEffect(() => {
    const element = scroll.current;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 180)
      element.scrollTop = element.scrollHeight;
  }, [state.conversation?.messages]);
  async function exportHistory() {
    const records = await controller.store.list();
    const blob = new Blob([JSON.stringify({ schemaVersion: 1, conversations: records }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pagelingo-conversations.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const conversation = state.conversation;
  const last = conversation?.messages.at(-1);
  const context = state.context ?? (last?.role === 'assistant' ? last.context : undefined);
  return (
    <main className="assistant-panel">
      <header className="assistant-header">
        <div>
          <strong>PageLingo</strong>
          <span>阅读助手</span>
        </div>
        <div className="header-actions">
          <button
            onClick={() => {
              setHistoryOpen(!historyOpen);
              safely(() => controller.refreshHistory());
            }}
          >
            历史
          </button>
          <button
            title="打开设置"
            onClick={() => {
              void chrome.runtime.openOptionsPage();
            }}
          >
            设置
          </button>
        </div>
      </header>
      <section className="article-bar">
        <div className="article-name" title={conversation?.title}>
          {conversation?.title ?? '接入当前文章'}
        </div>
        <div className="article-actions">
          <span>{state.delivery ? '当前文章' : conversation ? '历史记录' : '未接入'}</span>
          <button disabled={loading} onClick={() => safely(currentArticle)}>
            {loading ? '读取中…' : '接入当前文章'}
          </button>
          {conversation?.url && (
            <button
              onClick={() => {
                void chrome.tabs.create({ url: conversation.url });
              }}
            >
              打开原文
            </button>
          )}
        </div>
      </section>
      {historyOpen && (
        <section className="history-drawer">
          <div className="row">
            <strong>本地对话 · {state.history.length} 篇文章</strong>
            <button disabled={state.busy} onClick={() => safely(exportHistory)}>
              导出
            </button>
          </div>
          {state.history.length === 0 && <p className="hint">发送问题后，对话会保存到这里。</p>}
          <div className="history-list">
            {state.history.map((item) => (
              <div className="history-item" key={item.key}>
                <button
                  className="history-title"
                  onClick={() =>
                    safely(async () => {
                      await controller.showHistory(item);
                      setHistoryOpen(false);
                    })
                  }
                >
                  {item.title || item.url || item.key}
                  <small>{item.messages.length} 条消息</small>
                </button>
                <button
                  disabled={state.busy}
                  onClick={() => safely(() => controller.deleteConversation(item.key))}
                  aria-label={`删除 ${item.title}`}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
          <button
            disabled={state.busy || state.history.length === 0}
            onClick={() => safely(() => controller.clearHistory())}
          >
            清空对话历史
          </button>
        </section>
      )}
      {(error || state.error) && (
        <p role="alert" className="error assistant-alert">
          {error || state.error}
        </p>
      )}
      {state.notice && <p className="hint assistant-alert">{state.notice}</p>}
      {state.delivery?.document.warnings.map((w) => (
        <p key={w} className="hint assistant-alert">
          {w}
        </p>
      ))}
      <div className="messages" ref={scroll} aria-live="polite">
        {!conversation?.messages.length && (
          <div className="assistant-empty">
            <div className="empty-symbol">↗</div>
            <h1>和文章一起思考</h1>
            <p>
              选中文字或代码，右键「添加到对话」。
              <br />
              写下你的问题，再点击发送。
            </p>
            <p>也可以直接结合当前文章提问。</p>
          </div>
        )}
        {conversation?.messages.map((message, index) => (
          <article key={message.id} className={`chat-message ${message.role}`} data-message-id={message.id}>
            <div className="message-author">
              {message.role === 'user' ? '你' : 'PageLingo'}
              {message.role === 'assistant' && (
                <span>
                  {message.status === 'streaming'
                    ? '生成中'
                    : message.status === 'interrupted'
                      ? '已中断'
                      : message.status === 'error'
                        ? '未完成'
                        : ''}
                </span>
              )}
            </div>
            {message.role === 'user' ? (
              <>
                <div className="sent-quotes">
                  {message.quotes.map((q) => (
                    <QuoteCard key={q.id} quote={q} onReveal={() => safely(() => controller.reveal(q))} />
                  ))}
                </div>
                <div className="user-text">{message.text}</div>
              </>
            ) : (
              <>
                <Markdown text={message.text} />
                {message.error && <p className="hint">{message.error}</p>}
                {index === conversation.messages.length - 1 && message.status !== 'streaming' && (
                  <div className="message-actions">
                    <button
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(message.text)
                          .catch(() => setError('复制失败，请手动选择文字复制。'));
                      }}
                    >
                      复制
                    </button>
                    <button
                      disabled={state.busy || !state.delivery}
                      onClick={() => safely(() => controller.retry(message.id))}
                    >
                      重试回答
                    </button>
                  </div>
                )}
              </>
            )}
          </article>
        ))}
      </div>
      <section className="composer">
        {state.compacting && (
          <p role="status" className="hint">
            正在整理较早的对话记忆，原始记录仍会保留…
          </p>
        )}
        {state.busy && state.runningKey !== conversation?.key && (
          <p className="hint">另一篇文章正在生成，回答会保存到它的对话中。</p>
        )}
        {context && (
          <p className="context-info">
            本次上下文：
            {context.coverage === 'full'
              ? '全文'
              : context.coverage === 'selection'
                ? '仅引用'
                : '文章相关片段'}{' '}
            · {context.blocks}/{context.totalBlocks} 段 · 估算 {context.inputTokens} 输入 Tokens
          </p>
        )}
        <div className="draft-quotes">
          {state.draft?.quotes.map((q) => (
            <QuoteCard
              key={q.id}
              quote={q}
              onReveal={() => safely(() => controller.reveal(q))}
              onRemove={() =>
                safely(() =>
                  controller.setDraft({ quotes: state.draft!.quotes.filter((x) => x.id !== q.id) }),
                )
              }
            />
          ))}
        </div>
        <label className="sr-only" htmlFor="question">
          你的问题
        </label>
        <textarea
          id="question"
          placeholder="结合文章提问，或先添加引用…"
          rows={4}
          value={state.draft?.text ?? ''}
          disabled={!conversation}
          onChange={(e) => {
            void controller.setDraft({ text: e.target.value }).catch(() => {});
          }}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              e.nativeEvent.keyCode !== 229
            ) {
              e.preventDefault();
              safely(() => controller.send());
            }
          }}
        />
        <div className="composer-actions">
          <select
            aria-label="文章上下文范围"
            value={state.draft?.mode ?? 'auto'}
            disabled={!conversation}
            onChange={(e) => safely(() => controller.setDraft({ mode: e.target.value as ContextMode }))}
          >
            <option value="auto">自动选择上下文</option>
            <option value="full">使用全文</option>
            <option value="selection">仅使用引用</option>
          </select>
          {state.busy ? (
            <button onClick={() => controller.stop()}>停止生成</button>
          ) : (
            <button
              className="primary"
              disabled={!state.delivery || !state.draft?.text.trim()}
              onClick={() => safely(() => controller.send())}
            >
              发送
            </button>
          )}
        </div>
        <div className="composer-foot">
          <span>Enter 发送 · Shift + Enter 换行</span>
          <button
            disabled={state.busy || !conversation?.messages.length}
            onClick={() => safely(() => controller.deleteConversation(conversation!.key))}
          >
            清空当前对话
          </button>
        </div>
      </section>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<SidePanel />);
