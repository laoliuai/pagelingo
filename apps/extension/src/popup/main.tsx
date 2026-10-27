import { CapturePanel } from './capture-panel';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { readSettings } from '../settings/storage';
import { sendPageCommand } from '../shared/messaging';
import { openAssistantPanel } from '../shared/assistant-panel';
import { errorMessage, type DisplayMode, type PageCommand, type PageStatus } from '../shared/types';
import '../ui/style.css';

const previewLabels: Record<PageStatus['status'], string> = {
  idle: '准备就绪',
  extracting: '识别正文…',
  translating: '正在生成预览…',
  completed: '预览完成',
  cancelled: '已停止，已完成的预览已保留',
  stale: '已停止：正文已更新',
  error: '暂时无法预览',
  recovering: '正在接续…',
  partial: '部分段落未完成',
};
const translationLabels: Record<PageStatus['status'], string> = {
  idle: '准备就绪',
  extracting: '识别正文…',
  translating: '正在翻译…',
  completed: '翻译完成',
  cancelled: '已停止，已完成译文已保留',
  stale: '已停止：正文已更新',
  error: '翻译未完成',
  recovering: '后台正在恢复…',
  partial: '翻译部分完成',
};

function Popup() {
  const [tabId, setTabId] = useState<number>();
  const [title, setTitle] = useState('当前页面');
  const [mode, setMode] = useState<DisplayMode>('bilingual');
  const [status, setStatus] = useState<PageStatus>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    void (async () => {
      const [settings, tabs] = await Promise.all([
        readSettings(),
        chrome.tabs.query({ active: true, currentWindow: true }),
      ]);
      const tab = tabs[0];
      if (tab?.id === undefined) throw new Error('没有找到当前标签页。');
      if (!active) return;
      setTabId(tab.id);
      setTitle(tab.title ?? '当前页面');
      setMode(settings.displayMode);
      let refreshing = false;
      const refresh = async () => {
        if (refreshing) return;
        refreshing = true;
        try {
          const next = await sendPageCommand(tab.id!, { type: 'page:status' });
          if (active) {
            setStatus(next);
            if (next.status !== 'idle') setMode(next.mode);
          }
        } catch (error) {
          if (active) setError(errorMessage(error));
        } finally {
          refreshing = false;
        }
      };
      await refresh();
      if (active)
        timer = setInterval(() => {
          void refresh();
        }, 700);
    })().catch((error: unknown) => {
      if (active) setError(errorMessage(error));
    });
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  async function command(value: PageCommand): Promise<void> {
    if (tabId === undefined) return;
    setBusy(true);
    setError('');
    try {
      setStatus(await sendPageCommand(tabId, value));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const running = status && ['extracting', 'translating', 'recovering'].includes(status.status);
  const retryable = status && ['stale', 'cancelled', 'partial', 'error'].includes(status.status);
  const stopped = status && ['stale', 'cancelled'].includes(status.status);
  const labels = status?.execution === 'preview' ? previewLabels : translationLabels;
  return (
    <main className="popup">
      <header className="brand">
        <span className="brand-mark" aria-hidden="true">
          译
        </span>
        <div>
          <h1>PageLingo</h1>
          <p>读懂技术，保留原貌</p>
        </div>
        <span className="pill">API 翻译</span>
      </header>
      <div className="page-title" title={title}>
        {title}
      </div>
      <CapturePanel tabId={tabId} />
      <p className="notice">正文将发送到你配置的 LLM 服务。首次使用请在设置页授权并测试连接。</p>
      <button
        className="primary full"
        disabled={busy || running || tabId === undefined}
        onClick={() => {
          void command({ type: 'page:translate', mode });
        }}
      >
        {retryable ? '重新翻译' : '翻译当前页面'}
      </button>
      <button
        className="full local-preview"
        disabled={busy || running || tabId === undefined}
        onClick={() => {
          void command({ type: 'page:preview', mode });
        }}
      >
        预览页面布局
      </button>
      <button
        className="full local-preview"
        disabled={busy || tabId === undefined}
        onClick={() => {
          setError('');
          const opened = openAssistantPanel(tabId!);
          void opened
            .then(async () => {
              const result = await chrome.runtime.sendMessage({ type: 'extension:assistant-deliver', tabId });
              if (!result?.ok) throw new Error(result?.error ?? '无法打开阅读助手。');
            })
            .catch((e) => setError(errorMessage(e)));
        }}
      >
        打开阅读助手 ↗
      </button>
      <fieldset className="mode-picker">
        <legend>显示方式</legend>
        {(
          [
            ['source', '原文'],
            ['translation', '仅译文'],
            ['bilingual', '中英对照'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className={mode === value ? 'selected' : ''}>
            <input
              type="radio"
              name="mode"
              value={value}
              checked={mode === value}
              onChange={() => {
                setMode(value);
                void command({ type: 'page:mode', mode: value });
              }}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <section className="status-panel" aria-live="polite">
        <div className="row">
          <span>{status ? labels[status.status] : '连接页面…'}</span>
          <strong>
            {status?.completed ?? 0} / {status?.total ?? 0} 段
          </strong>
        </div>
        <progress value={status?.completed ?? 0} max={status?.total || 1} aria-label="处理进度" />
        {Boolean(status?.fallback) && (
          <p className="hint">{status?.fallback} 个段落已翻译，同时保留原文以保护公式或页面交互。</p>
        )}
        {Boolean(status?.failed) && <p className="hint">{status?.failed} 个段落未完成，原文已保留。</p>}
        {status?.metrics && (
          <p className="hint">
            请求 {status.metrics.requests} 次 · 重试 {status.metrics.retries} 个分片 · 缓存{' '}
            {status.metrics.cacheHits} 段<br />
            {status.metrics.usageRequests
              ? `已报告 ${status.metrics.totalTokens} Tokens（${status.metrics.usageRequests}/${status.metrics.requests} 次请求提供用量）`
              : '服务未报告 Token 用量'}
            {status.metrics.firstResultMs !== undefined && ` · 首段 ${status.metrics.firstResultMs} ms`} ·{' '}
            {(status.metrics.elapsedMs / 1000).toFixed(1)} s
          </p>
        )}
        {Boolean(status?.recoveries) && <p className="hint">已接续后台 {status?.recoveries} 次。</p>}
        {status?.metrics?.storageWarning && <p className="hint">{status.metrics.storageWarning}</p>}
      </section>
      {(error || status?.error) && (
        <p role="alert" className="error">
          {error || status?.error}
        </p>
      )}
      <div className="row actions">
        <button
          disabled={busy || !running}
          onClick={() => {
            void command({ type: 'page:stop' });
          }}
        >
          {stopped ? '已停止' : '停止'}
        </button>
        <button
          disabled={busy || !status?.total}
          onClick={() => {
            void command({ type: 'page:restore' });
          }}
        >
          恢复页面
        </button>
        <button
          className="text-button"
          onClick={() => {
            void chrome.runtime.openOptionsPage();
          }}
        >
          设置 ↗
        </button>
      </div>
      <p className="footnote">
        预览会在当前网页正文下方插入【布局预览】文本，不调用
        API。选择中英对照后关闭面板即可查看。选中文字后，可在右键菜单中翻译选中内容。
      </p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
