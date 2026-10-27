import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { glossaryUpdateSchema, type GlossaryRevision } from '@pagelingo/document-contracts';
import { MAX_GLOSSARY_ENTRIES, mergeGlossaryEntries, type GlossaryEntry } from '@pagelingo/translation-core';
import { useSession } from '../../app/session';
import { apiRequest, errorMessage } from '../../shared/api-client';
import { Button } from '../../shared/ui/button';
import { Input } from '../../shared/ui/input';
import { Field } from '../../shared/ui/field';
import { Feedback } from '../../shared/ui/toast';
import './glossary-panel.css';
function GlossaryForm({ value }: { value: GlossaryRevision }) {
  const { user } = useSession();
  const client = useQueryClient();
  const [entries, setEntries] = useState(value.entries);
  const [revision, setRevision] = useState(value.revision);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  function change(index: number, patch: Partial<GlossaryEntry>) {
    setEntries((previous) => previous.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage('');
    try {
      const parsed = glossaryUpdateSchema.safeParse({ expectedRevision: revision, entries });
      if (!parsed.success) {
        setError(true);
        setMessage('请填写有效术语。固定翻译需填写译词，原词最多 120 字、译词最多 240 字。');
        return;
      }
      const saved = await apiRequest<GlossaryRevision>('/api/v1/settings/glossary', {
        method: 'PUT',
        body: { ...parsed.data, entries: mergeGlossaryEntries([], parsed.data.entries) },
      });
      setEntries(saved.entries);
      setRevision(saved.revision);
      client.setQueryData([user!.id, 'glossary'], saved);
      setError(false);
      setMessage('术语表已保存，将用于新开始的翻译。');
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
        <p>此术语表仅属于当前账号。相同原词与领域以最后一条为准，已开始的任务保留原术语版本。</p>
        {entries.length === 0 && <p className="muted">尚未添加个人术语。</p>}
        <div className="glossary-entries">
          {entries.map((entry, index) => (
            <div className="glossary-entry" key={index}>
              <Field label={`原词 ${index + 1}`}>
                <Input
                  value={entry.source}
                  maxLength={120}
                  onChange={(e) => change(index, { source: e.target.value })}
                />
              </Field>
              <Field label={`译词 ${index + 1}`}>
                <Input
                  value={entry.target}
                  maxLength={240}
                  onChange={(e) => change(index, { target: e.target.value })}
                />
              </Field>
              <Field label={`处理方式 ${index + 1}`}>
                <select
                  value={entry.policy}
                  onChange={(e) => change(index, { policy: e.target.value as GlossaryEntry['policy'] })}
                >
                  <option value="translate">固定翻译</option>
                  <option value="keep">保留原词</option>
                  <option value="first-bilingual">首次双语</option>
                  <option value="prefer-source">优先原词</option>
                </select>
              </Field>
              <Field label={`领域 ${index + 1}`}>
                <select
                  value={entry.domain}
                  onChange={(e) => change(index, { domain: e.target.value as GlossaryEntry['domain'] })}
                >
                  <option value="all">所有领域</option>
                  <option value="machine-learning">机器学习</option>
                  <option value="software-engineering">软件工程</option>
                  <option value="physics">物理</option>
                  <option value="general-technical">通用技术</option>
                </select>
              </Field>
              <Button
                type="button"
                aria-label={`删除术语 ${index + 1}`}
                onClick={() => setEntries((previous) => previous.filter((_, i) => i !== index))}
              >
                删除
              </Button>
            </div>
          ))}
        </div>
        <p className="muted">
          {entries.length} / {MAX_GLOSSARY_ENTRIES} 条
        </p>
        <Feedback message={message} error={error} />
        <div className="form-actions">
          <Button
            type="button"
            disabled={entries.length >= MAX_GLOSSARY_ENTRIES}
            onClick={() =>
              setEntries((previous) => [...previous, { source: '', target: '', policy: 'translate', domain: 'all' }])
            }
          >
            添加术语
          </Button>
          <Button primary type="submit" disabled={pending}>
            {pending ? '保存中…' : '保存术语表'}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
export function GlossaryPanel() {
  const { user } = useSession();
  const query = useQuery({
    queryKey: [user!.id, 'glossary'],
    queryFn: ({ signal }) => apiRequest<GlossaryRevision>('/api/v1/settings/glossary', { signal }),
  });
  return (
    <section className="form-panel personal-settings-panel" aria-labelledby="glossary-title">
      <h2 id="glossary-title">个人术语表</h2>
      {query.isPending && <p role="status">加载术语表…</p>}
      <Feedback message={query.error ? errorMessage(query.error) : ''} error />
      {query.data && <GlossaryForm key={user!.id} value={query.data} />}
    </section>
  );
}
