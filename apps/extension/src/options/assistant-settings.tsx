import type { UserSettings } from '../settings/schema';
export function AssistantSettings({
  value,
  onChange,
}: {
  value: UserSettings['assistant'];
  onChange: (value: UserSettings['assistant']) => void;
}) {
  const update = <K extends keyof UserSettings['assistant']>(key: K, next: UserSettings['assistant'][K]) =>
    onChange({ ...value, [key]: next });
  return (
    <section className="card">
      <div className="section-title">
        <span className="step">05</span>
        <div>
          <h2>阅读助手</h2>
          <p>在侧栏结合当前文章、引用和历史对话提问。</p>
        </div>
      </div>
      <div className="field-grid">
        <label className="field">
          保留对话的文章数量
          <input
            type="number"
            min="1"
            max="500"
            value={value.historyLimit}
            onChange={(e) => update('historyLimit', e.target.valueAsNumber)}
          />
        </label>
        <label className="field">
          对话历史容量（MiB）
          <input
            type="number"
            min="1"
            max="256"
            value={value.historyMaxMiB}
            onChange={(e) => update('historyMaxMiB', e.target.valueAsNumber)}
          />
        </label>
      </div>
      <label className="field">
        助手模型（留空复用翻译模型）
        <input
          value={value.model}
          placeholder="默认使用上面的 Model"
          onChange={(e) => update('model', e.target.value)}
        />
      </label>
      <details>
        <summary>对话与上下文设置</summary>
        <div className="field-grid">
          <label className="field">
            助手每次输入 Token 预算
            <input
              type="number"
              min="1500"
              max="100000"
              value={value.maxInputTokens}
              onChange={(e) => update('maxInputTokens', e.target.valueAsNumber)}
            />
          </label>
          <label className="field">
            助手每次输出 Token 上限
            <input
              type="number"
              min="128"
              max="32768"
              value={value.maxOutputTokens}
              onChange={(e) => update('maxOutputTokens', e.target.valueAsNumber)}
            />
          </label>
          <label className="field">
            助手 Temperature
            <input
              type="number"
              min="0"
              max="2"
              step="0.1"
              value={value.temperature}
              onChange={(e) => update('temperature', e.target.valueAsNumber)}
            />
          </label>
          <label className="field">
            助手响应方式
            <select
              value={value.stream ? 'stream' : 'json'}
              onChange={(e) => update('stream', e.target.value === 'stream')}
            >
              <option value="stream">流式响应</option>
              <option value="json">普通响应（兼容模式）</option>
            </select>
          </label>
        </div>
      </details>
      <label className="field">
        个人阅读偏好
        <textarea
          rows={3}
          maxLength={2000}
          placeholder="例如：先简要解释，再给一个最小代码示例。"
          value={value.preferences}
          onChange={(e) => update('preferences', e.target.value)}
        />
      </label>
      <p className="hint">
        复用现有 API 地址、密钥、Token 参数和模型上下文上限；对话不使用翻译的 JSON
        输出协议。较长历史会调用模型整理摘要，完整原始记录仍保存在本地。历史超过上限时，优先清理较早使用的文章。翻译缓存与对话历史分别管理。
      </p>
    </section>
  );
}
