import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProviderProfile,
  ProviderSettings,
  ProviderTestResult,
} from '@pagelingo/document-contracts';
import { useSession } from '../../app/session';
import { apiRequest, errorMessage } from '../../shared/api-client';
import { PageHeader } from '../../shared/layouts/page-header';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { Input } from '../../shared/ui/input';
import { Badge } from '../../shared/ui/badge';
import { Feedback } from '../../shared/ui/toast';
import { Confirm } from '../../shared/ui/alert-dialog';
import { ChangePassword } from '../auth/change-password';
import { DevicesPanel } from './devices-panel';
function ProviderForm({ profile }: { profile: ProviderProfile }) {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(profile);
  const { revision: _revision, hasApiKey: _hasKey, ...initial } = profile;
  const [settings, setSettings] = useState<ProviderSettings>(initial);
  const [apiKey, setApiKey] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  function update<K extends keyof ProviderSettings>(key: K, value: ProviderSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }
  async function save(action: 'keep' | 'delete' = 'keep') {
    const next = await apiRequest<ProviderProfile>('/api/v1/settings/provider', {
      method: 'PUT',
      body: {
        expectedRevision: saved.revision,
        settings,
        key:
          action === 'delete'
            ? { action: 'delete' }
            : apiKey
              ? { action: 'replace', value: apiKey }
              : { action: 'keep' },
      },
    });
    setApiKey('');
    setSaved(next);
    queryClient.setQueryData([user!.id, 'provider'], next);
    return next;
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage('');
    try {
      await save();
      setError(false);
      setMessage('配置已保存');
    } catch (error) {
      setApiKey('');
      setError(true);
      setMessage(errorMessage(error));
    } finally {
      setPending(false);
    }
  }
  async function testConnection() {
    setPending(true);
    setMessage('');
    try {
      const { revision: _r, hasApiKey: _k, ...savedSettings } = saved;
      if (apiKey || JSON.stringify(settings) !== JSON.stringify(savedSettings)) await save();
      const result = await apiRequest<ProviderTestResult>('/api/v1/settings/provider/test', {
        method: 'POST',
        body: {},
      });
      setError(false);
      setMessage(result.ok ? `连接成功 · 配置版本 ${result.profileRevision}` : '连接未成功');
    } catch (error) {
      setApiKey('');
      setError(true);
      setMessage(errorMessage(error));
      throw error;
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="form-panel">
      <div className="panel-heading">
        <h2>翻译模型</h2>
        <Badge active={saved.hasApiKey}>{saved.hasApiKey ? '已保存 Key' : '未配置 Key'}</Badge>
      </div>
      <p>此配置属于当前账号。API Key 仅在保存时发送，不会回显。留空保留已有 Key。</p>
      <form onSubmit={submit}>
        <fieldset disabled={pending}>
          <Field label="Base URL">
            <Input
              type="url"
              autoComplete="off"
              placeholder="https://api.example.com/v1"
              value={settings.baseUrl}
              onChange={(e) => update('baseUrl', e.target.value)}
            />
          </Field>
          <Field label="API Key">
            <Input
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={saved.hasApiKey ? '留空保留已保存的 Key' : '填写你的 API Key'}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </Field>
          <Field label="模型名称">
            <Input
              autoComplete="off"
              placeholder="填写服务商提供的模型名称"
              value={settings.model}
              onChange={(e) => update('model', e.target.value)}
            />
          </Field>
          <details>
            <summary>高级模型参数</summary>
            <div className="advanced-grid">
              <Field label="温度">
                <Input
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  value={settings.temperature}
                  onChange={(e) => update('temperature', Number(e.target.value))}
                />
              </Field>
              <Field label="输出 Token 上限">
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={settings.maxOutputTokens}
                  onChange={(e) => update('maxOutputTokens', Number(e.target.value))}
                />
              </Field>
              <Field label="输入 Token 上限">
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={settings.maxInputTokens}
                  onChange={(e) => update('maxInputTokens', Number(e.target.value))}
                />
              </Field>
              <Field label="上下文窗口 Token">
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={settings.contextWindowTokens}
                  onChange={(e) => update('contextWindowTokens', Number(e.target.value))}
                />
              </Field>
              <Field label="响应格式">
                <select
                  value={settings.responseFormat}
                  onChange={(e) =>
                    update('responseFormat', e.target.value as ProviderSettings['responseFormat'])
                  }
                >
                  <option value="json-object">JSON object</option>
                  <option value="json-schema">JSON schema</option>
                  <option value="text">Text</option>
                </select>
              </Field>
              <Field label="输出上限参数">
                <select
                  value={settings.maxTokensParameter}
                  onChange={(e) =>
                    update(
                      'maxTokensParameter',
                      e.target.value as ProviderSettings['maxTokensParameter'],
                    )
                  }
                >
                  <option value="max_tokens">max_tokens</option>
                  <option value="max_completion_tokens">max_completion_tokens</option>
                </select>
              </Field>
              <Field label="思考模式">
                <select
                  value={settings.thinkingMode}
                  onChange={(e) =>
                    update('thinkingMode', e.target.value as ProviderSettings['thinkingMode'])
                  }
                >
                  <option value="auto">自动</option>
                  <option value="default">默认</option>
                  <option value="disabled">关闭</option>
                </select>
              </Field>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={settings.stream}
                  onChange={(e) => update('stream', e.target.checked)}
                />
                流式响应
              </label>
            </div>
          </details>
          <Feedback message={message} error={error} />
          <div className="form-actions">
            <Confirm
              trigger={
                <Button type="button" disabled={pending}>
                  测试连接
                </Button>
              }
              title="测试模型连接？"
              description="未保存的修改会先保存。测试将产生一次模型请求，可能产生费用。普通读取不会自动测试。"
              action="保存并测试"
              onConfirm={testConnection}
            />
            <Button primary type="submit" disabled={pending}>
              {pending ? '处理中…' : '保存配置'}
            </Button>
          </div>
        </fieldset>
      </form>
      {saved.hasApiKey && (
        <div className="key-action">
          <Confirm
            title="删除已保存的 API Key？"
            description="删除后无法发起模型请求。其他配置将保留，当前输入的模型参数会一并保存。"
            action="确认删除 Key"
            trigger={<Button disabled={pending}>删除已保存 Key</Button>}
            onConfirm={async () => {
              setPending(true);
              try {
                await save('delete');
                setError(false);
                setMessage('Key 已删除');
              } finally {
                setApiKey('');
                setPending(false);
              }
            }}
          />
        </div>
      )}
    </section>
  );
}
export function ProviderPage() {
  const { user } = useSession();
  const profile = useQuery({
    queryKey: [user!.id, 'provider'],
    queryFn: ({ signal }) => apiRequest<ProviderProfile>('/api/v1/settings/provider', { signal }),
  });
  return (
    <>
      <PageHeader title="模型与账户" description="使用自己的 API，为资料生成译文。" />
      {profile.isPending && <p role="status">加载配置…</p>}
      <Feedback message={profile.error ? errorMessage(profile.error) : ''} error />
      {profile.data && <ProviderForm profile={profile.data} />}
      <DevicesPanel />
      <ChangePassword />
    </>
  );
}
