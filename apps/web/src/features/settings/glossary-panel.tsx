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
import { GlossaryImport } from './glossary-import';
import './glossary-panel.css';
const PAGE_SIZE = 50;
function GlossaryForm({ value }: { value: GlossaryRevision }) {
  const { user } = useSession();
  const client = useQueryClient();
  const [entries, setEntries] = useState(value.entries);
  const [revision, setRevision] = useState(value.revision);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  // Keeps the row being edited on screen when the edit stops it matching the search.
  const [editing, setEditing] = useState<number>();
  const needle = query.trim().toLowerCase();
  const visible = entries.flatMap((entry, index) =>
    index === editing || `${entry.source} ${entry.target}`.toLowerCase().includes(needle) ? [{ entry, index }] : [],
  );
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  function showAll(nextPage: number) {
    setQuery('');
    setEditing(undefined);
    setPage(nextPage);
  }
  function change(index: number, patch: Partial<GlossaryEntry>) {
    setEditing(index);
    setEntries((previous) => previous.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage('');
    try {
      const parsed = glossaryUpdateSchema.safeParse({ expectedRevision: revision, entries });
      if (!parsed.success) {
        const invalid = parsed.error.issues[0]?.path[1];
        const row = typeof invalid === 'number' ? invalid : undefined;
        // The bad row may be on another page or hidden by the search.
        if (row !== undefined) showAll(Math.floor(row / PAGE_SIZE));
        setError(true);
        setMessage(
          `${row === undefined ? '' : `第 ${row + 1} 条：`}请填写有效术语。固定翻译需填写译词，原词最多 120 字、译词最多 240 字。`,
        );
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
        <GlossaryImport
          entries={entries}
          onImported={(merged, summary) => {
            setEntries(merged);
            showAll(0);
            setError(false);
            setMessage(summary);
          }}
        />
        {entries.length > 0 && (
          <Field label="搜索术语">
            <Input
              type="search"
              placeholder="搜索原词或译词"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setEditing(undefined);
                setPage(0);
              }}
              // Enter in a form field would otherwise save the whole glossary.
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault();
              }}
            />
          </Field>
        )}
        {entries.length === 0 && <p className="muted">尚未添加个人术语。</p>}
        {entries.length > 0 && visible.length === 0 && <p className="muted">没有匹配的术语。</p>}
        <div className="glossary-entries" key={currentPage}>
          {visible.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(({ entry, index }) => (
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
                onClick={() => {
                  setEditing(undefined);
                  setEntries((previous) => previous.filter((_, i) => i !== index));
                }}
              >
                删除
              </Button>
            </div>
          ))}
        </div>
        {pageCount > 1 && (
          <div className="glossary-pager">
            <Button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
              上一页
            </Button>
            <span className="muted">
              第 {currentPage + 1} / {pageCount} 页
            </span>
            <Button type="button" disabled={currentPage + 1 === pageCount} onClick={() => setPage(currentPage + 1)}>
              下一页
            </Button>
          </div>
        )}
        <p className="muted">
          {entries.length} / {MAX_GLOSSARY_ENTRIES} 条{needle ? `，匹配 ${visible.length} 条` : ''}
        </p>
        <Feedback message={message} error={error} />
        <div className="form-actions">
          <Button
            type="button"
            disabled={entries.length >= MAX_GLOSSARY_ENTRIES}
            onClick={() => {
              showAll(Math.floor(entries.length / PAGE_SIZE));
              setEntries((previous) => [...previous, { source: '', target: '', policy: 'translate', domain: 'all' }]);
            }}
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
