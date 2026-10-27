import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SavePreferences } from '@pagelingo/document-contracts';
import { useSession } from '../../app/session';
import { apiRequest, errorMessage } from '../../shared/api-client';
import { Button } from '../../shared/ui/button';
import { Feedback } from '../../shared/ui/toast';
function PreferencesForm({ value }: { value: SavePreferences }) {
  const { user } = useSession();
  const client = useQueryClient();
  const [enabled, setEnabled] = useState(value.autoTranslate);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(value.revision);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage('');
    try {
      const saved = await apiRequest<SavePreferences>('/api/v1/settings/save-preferences', {
        method: 'PUT',
        body: { expectedRevision: revision, autoTranslate: enabled },
      });
      setRevision(saved.revision);
      client.setQueryData([user!.id, 'save-preferences'], saved);
      setError(false);
      setMessage('偏好已保存，仅应用于以后保存的资料。');
    } catch (e) {
      setError(true);
      setMessage(errorMessage(e));
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <fieldset disabled={pending}>
        <label className="checkbox">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          自动翻译新保存的外文资料
        </label>
        <p>
          开启后，新保存且语种明确的外文资料会使用你的模型配置，可能产生费用。中文和没有语言的内容无需翻译；短文或混合语种需要手动选择语言。
        </p>
        <p>保存偏好、模型配置和术语表不会启动历史资料。未配置 Key 时仍保存原文。</p>
        <Feedback message={message} error={error} />
        <div className="form-actions">
          <Button primary type="submit" disabled={pending}>
            {pending ? '保存中…' : '保存偏好'}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
export function SavePreferencesPanel() {
  const { user } = useSession();
  const query = useQuery({
    queryKey: [user!.id, 'save-preferences'],
    queryFn: ({ signal }) => apiRequest<SavePreferences>('/api/v1/settings/save-preferences', { signal }),
  });
  return (
    <section className="form-panel personal-settings-panel" aria-labelledby="save-preferences-title">
      <h2 id="save-preferences-title">保存偏好</h2>
      {query.isPending && <p role="status">加载保存偏好…</p>}
      <Feedback message={query.error ? errorMessage(query.error) : ''} error />
      {query.data && <PreferencesForm key={user!.id} value={query.data} />}
    </section>
  );
}
