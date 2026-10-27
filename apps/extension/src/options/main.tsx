import { SiteConnection } from './site-connection';
import { StrictMode, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantSettings } from './assistant-settings';
import { defaultSettings, settingsSchema, type UserSettings } from '../settings/schema';
import { readSettings, saveSettings } from '../settings/storage';
import { errorMessage } from '../shared/types';
import { apiHostPattern, requireConnection } from '../settings/connection';
import { testLlmConnection } from '../shared/messaging';
import { GlossaryEditor } from './glossary-editor';
import '../ui/style.css';

function Options() {
  const [settings, setSettings] = useState<UserSettings>(structuredClone(defaultSettings));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [connection, setConnection] = useState('');
  const [cache, setCache] = useState<{
    translations: number;
    documents: number;
    bytes: number;
    warning?: string;
  }>();
  const [cacheMessage, setCacheMessage] = useState('');
  const [clearing, setClearing] = useState(false);
  const [glossaryPending, setGlossaryPending] = useState(false);

  useEffect(() => {
    void readSettings()
      .then(setSettings)
      .catch((error: unknown) => setError(errorMessage(error)))
      .finally(() => setLoading(false));
    void manageCache('stats');
  }, []);

  async function manageCache(action: 'stats' | 'translations' | 'documents' | 'all') {
    setClearing(true);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'extension:cache', action });
      if (!result?.ok) throw new Error('无法读取缓存，请重新打开设置。');
      setCache(result.value);
      if (action !== 'stats') setCacheMessage('缓存已清理；正在执行的任务仍会保存后续结果。');
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setClearing(false);
    }
  }

  function update<K extends keyof UserSettings>(key: K, value: UserSettings[K]) {
    setSettings((previous) => ({ ...previous, [key]: value }));
    setSaved(false);
    setConnection('');
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    setError('');
    if (glossaryPending) {
      setError('请先确认词表导入，或完成 / 取消词条编辑。');
      return;
    }
    const parsed = settingsSchema.safeParse(settings);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；'));
      return;
    }
    setSaving(true);
    try {
      await saveSettings(parsed.data);
      setSettings(parsed.data);
      setSaved(true);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function authorizeAndTest() {
    setError('');
    setConnection('');
    try {
      if (glossaryPending) throw new Error('请先确认词表导入，或完成 / 取消词条编辑。');
      const parsed = settingsSchema.safeParse(settings);
      if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => issue.message).join('；'));
      requireConnection(parsed.data);
      // Call permissions.request synchronously in the button's user-gesture handler.
      const authorization = chrome.permissions.request({ origins: [apiHostPattern(parsed.data.baseUrl)] });
      setTesting(true);
      if (!(await authorization)) throw new Error('API 服务未获授权，请允许访问后重试。');
      await saveSettings(parsed.data);
      setSettings(parsed.data);
      setSaved(true);
      const result = await testLlmConnection(parsed.data);
      setConnection(`连接成功 · ${result.model} · ${result.elapsedMs} ms。测试译文：${result.sample}`);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setTesting(false);
    }
  }

  return (
    <main className="settings">
      <header className="settings-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            译
          </span>
          <div>
            <h1>PageLingo</h1>
            <p>为技术阅读，留出更多专注。</p>
          </div>
        </div>
        <span className="pill">0.4 · 阅读助手</span>
      </header>
      <h2 className="page-heading">阅读偏好与翻译设置</h2>
      <p className="intro">设置保存在当前浏览器。配置并授权 LLM 服务后，即可翻译网页正文和选中内容。</p>
      <SiteConnection />
      <form
        onSubmit={(event) => {
          void save(event);
        }}
      >
        <fieldset disabled={loading || saving || testing} className="settings-fields">
          <section className="card">
            <div className="section-title">
              <span className="step">01</span>
              <div>
                <h2>阅读方式</h2>
                <p>选择翻译后的默认显示方式。</p>
              </div>
            </div>
            <label className="field">
              默认显示方式
              <select
                value={settings.displayMode}
                onChange={(event) => update('displayMode', event.target.value as UserSettings['displayMode'])}
              >
                <option value="bilingual">中英对照 · 原文在上</option>
                <option value="translation">仅译文 · 复杂段落保留原文</option>
                <option value="source">原文</option>
              </select>
            </label>
            <p className="hint">目标语言：简体中文。显示方式切换会复用当前译文。</p>
          </section>
          <section className="card">
            <div className="section-title">
              <span className="step">02</span>
              <div>
                <h2>LLM API</h2>
                <p>使用 OpenAI-compatible Chat Completions 服务。连接测试会发送一句短文本。</p>
              </div>
            </div>
            <label className="field">
              Base URL
              <input
                type="url"
                placeholder="https://api.example.com/v1"
                autoComplete="off"
                value={settings.baseUrl}
                onChange={(event) => update('baseUrl', event.target.value)}
              />
            </label>
            <div className="field">
              <label htmlFor="api-key">API Key</label>
              <div className="input-action">
                <input
                  id="api-key"
                  type={showKey ? 'text' : 'password'}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="仅保存在本地"
                  value={settings.apiKey}
                  onChange={(event) => update('apiKey', event.target.value)}
                />
                <button type="button" aria-pressed={showKey} onClick={() => setShowKey(!showKey)}>
                  {showKey ? '隐藏' : '显示'}
                </button>
              </div>
            </div>
            <div className="field-grid">
              <label className="field">
                Model
                <input
                  placeholder="服务提供的模型 ID"
                  value={settings.model}
                  onChange={(event) => update('model', event.target.value)}
                />
              </label>
              <label className="field">
                Temperature
                <input
                  type="number"
                  min="0"
                  max="0.3"
                  step="0.1"
                  value={settings.temperature}
                  onChange={(event) => update('temperature', event.target.valueAsNumber)}
                />
              </label>
            </div>
            <details>
              <summary>接口兼容设置</summary>
              <div className="field-grid">
                <label className="field">
                  JSON 输出方式
                  <select
                    value={settings.responseFormat}
                    onChange={(event) =>
                      update('responseFormat', event.target.value as UserSettings['responseFormat'])
                    }
                  >
                    <option value="json-object">JSON Object</option>
                    <option value="json-schema">JSON Schema（需服务支持）</option>
                    <option value="text">仅提示词要求 JSON</option>
                  </select>
                </label>
                <label className="field">
                  每次输出 Token 上限
                  <input
                    type="number"
                    min="128"
                    max="32768"
                    step="128"
                    value={settings.maxOutputTokens}
                    onChange={(event) => update('maxOutputTokens', event.target.valueAsNumber)}
                  />
                </label>
                <label className="field">
                  Token 参数
                  <select
                    value={settings.maxTokensParameter}
                    onChange={(event) =>
                      update('maxTokensParameter', event.target.value as UserSettings['maxTokensParameter'])
                    }
                  >
                    <option value="max_tokens">max_tokens</option>
                    <option value="max_completion_tokens">max_completion_tokens</option>
                  </select>
                </label>
                <label className="field">
                  思考模式
                  <select
                    value={settings.thinkingMode}
                    onChange={(event) =>
                      update('thinkingMode', event.target.value as UserSettings['thinkingMode'])
                    }
                  >
                    <option value="auto">自动（DeepSeek 官方接口关闭思考）</option>
                    <option value="default">服务默认</option>
                    <option value="disabled">关闭（需兼容 thinking 参数）</option>
                  </select>
                </label>
                <label className="field">
                  响应方式
                  <select
                    value={settings.stream ? 'stream' : 'json'}
                    onChange={(event) => update('stream', event.target.value === 'stream')}
                  >
                    <option value="json">完整 JSON 响应</option>
                    <option value="stream">SSE 流式响应（需服务支持）</option>
                  </select>
                </label>
                <label className="field">
                  每次输入 Token 预算
                  <input
                    type="number"
                    min="1500"
                    max="100000"
                    value={settings.maxInputTokens}
                    onChange={(event) => update('maxInputTokens', event.target.valueAsNumber)}
                  />
                </label>
                <label className="field">
                  模型上下文 Token 上限
                  <input
                    type="number"
                    min="4096"
                    max="1000000"
                    value={settings.contextWindowTokens}
                    onChange={(event) => update('contextWindowTokens', event.target.valueAsNumber)}
                  />
                </label>
              </div>
            </details>
            <p className="hint">
              Token
              预算使用通用估算。每个服务最多同时执行两个请求；单个分片首次请求加最多两次重试。首响应与读取空闲限时
              25 秒，总时限 120 秒。
            </p>
            <p className="hint">
              Base URL 填 API 根地址，例如 /v1，不包含 /chat/completions。密钥不参与同步，不传给网页内容脚本。
            </p>
            <button
              type="button"
              onClick={() => {
                void authorizeAndTest();
              }}
            >
              {testing ? '正在测试连接…' : '授权并测试连接'}
            </button>
            {connection && (
              <p role="status" className="success">
                {connection}
              </p>
            )}
          </section>
          <section className="card">
            <div className="section-title">
              <span className="step">04</span>
              <div>
                <h2>本地缓存</h2>
                <p>已验证译文保存于此扩展的本地数据库，30 天过期。</p>
              </div>
            </div>
            <label className="field">
              缓存容量预算（MiB）
              <input
                type="number"
                min="1"
                max="256"
                value={settings.cacheMaxMiB}
                onChange={(event) => update('cacheMaxMiB', event.target.valueAsNumber)}
              />
            </label>
            <p className="hint">
              {cache
                ? `${cache.translations} 条译文 · ${cache.documents} 份文档记录 · ${(cache.bytes / 1024 / 1024).toFixed(2)} MiB`
                : '正在读取缓存…'}
              。实际可用容量同时受浏览器配额限制。
            </p>
            {cache?.warning && (
              <p role="alert" className="error">
                {cache.warning}
              </p>
            )}
            <div className="row actions">
              <button
                type="button"
                disabled={clearing}
                onClick={() => {
                  void manageCache('translations');
                }}
              >
                清理译文缓存
              </button>
              <button
                type="button"
                disabled={clearing}
                onClick={() => {
                  void manageCache('documents');
                }}
              >
                清理文档缓存
              </button>
              <button
                type="button"
                disabled={clearing}
                onClick={() => {
                  void manageCache('all');
                }}
              >
                清理全部缓存
              </button>
            </div>
            {cacheMessage && (
              <p role="status" className="success">
                {cacheMessage}
              </p>
            )}
          </section>
          <GlossaryEditor
            entries={settings.customGlossary}
            domain={settings.glossaryDomain}
            onChange={(entries) => update('customGlossary', entries)}
            onDomainChange={(domain) => update('glossaryDomain', domain)}
            onPendingChange={setGlossaryPending}
          />
          <AssistantSettings value={settings.assistant} onChange={(value) => update('assistant', value)} />
          <footer className="save-bar">
            <div aria-live="polite">
              {glossaryPending ? (
                <span className="hint">请先确认词表导入，或完成 / 取消词条编辑。</span>
              ) : saved ? (
                <span className="success">设置已保存在本地</span>
              ) : (
                <span className="hint">{loading ? '正在读取设置…' : '修改后请保存设置'}</span>
              )}
            </div>
            <button className="primary" type="submit" disabled={glossaryPending}>
              {saving ? '保存中…' : '保存设置'}
            </button>
          </footer>
        </fieldset>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
