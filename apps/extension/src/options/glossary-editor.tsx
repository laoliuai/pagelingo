import { useEffect, useState } from 'react';
import { glossaryEntrySchema, glossaryKey, mergeGlossaryEntries, parseGlossaryFile, MAX_GLOSSARY_ENTRIES, MAX_GLOSSARY_FILE_BYTES, type GlossaryEntry } from '@pagelingo/translation-core';
import { errorMessage } from '../shared/types';

const policies: Record<GlossaryEntry['policy'], string> = { keep: '保留英文', translate: '固定译文', 'prefer-source': '优先英文', 'first-bilingual': '双语术语' };
const domains: Record<GlossaryEntry['domain'], string> = { all: '通用', 'machine-learning': '机器学习 / 大模型 / RL', 'software-engineering': '编程 / 软件工程', physics: '物理', 'general-technical': '一般科技' };
const blank = (): GlossaryEntry => ({ source: '', target: '', policy: 'keep', domain: 'all' });
const maxFileMiB = MAX_GLOSSARY_FILE_BYTES / 1024 / 1024;

export function GlossaryEditor({ entries, domain, onChange, onDomainChange, onPendingChange }: {
  entries: GlossaryEntry[]; domain: GlossaryEntry['domain']; onChange: (entries: GlossaryEntry[]) => void;
  onDomainChange: (domain: GlossaryEntry['domain']) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const [query, setQuery] = useState(''); const [page, setPage] = useState(0);
  const [draft, setDraft] = useState<GlossaryEntry>(); const [editKey, setEditKey] = useState<string>();
  const [pending, setPending] = useState<{ entries: GlossaryEntry[]; name: string }>();
  const [paste, setPaste] = useState(''); const [reading, setReading] = useState(false);
  const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const unfinished = Boolean(draft || pending || reading);
  useEffect(() => { onPendingChange(unfinished); }, [unfinished, onPendingChange]);
  const filtered = entries.filter(entry => `${entry.source} ${entry.target}`.toLowerCase().includes(query.trim().toLowerCase()));
  const pageCount = Math.max(1, Math.ceil(filtered.length / 50)); const currentPage = Math.min(page, pageCount - 1);
  const keys = new Set(entries.map(glossaryKey));
  const added = pending?.entries.filter(entry => !keys.has(glossaryKey(entry))).length ?? 0;
  const patch = (value: Partial<GlossaryEntry>) => { setDraft(previous => ({ ...(previous ?? blank()), ...value })); setError(''); };

  function prepare(text: string, format: 'json' | 'csv' | 'tsv', name: string) {
    setPending(undefined); setError(''); setMessage('');
    try {
      const incoming = parseGlossaryFile(text, format);
      mergeGlossaryEntries(entries, incoming);
      setPending({ entries: incoming, name });
    } catch (error) { setError(errorMessage(error)); }
  }
  async function readFile(file: File) {
    setReading(true); setPending(undefined); setError(''); setMessage('');
    try {
      if (file.size > MAX_GLOSSARY_FILE_BYTES) throw new Error(`词表文件不能超过 ${maxFileMiB} MiB。`);
      const extension = file.name.split('.').at(-1)?.toLowerCase();
      if (!['json', 'csv', 'tsv'].includes(extension ?? '')) throw new Error('请选择 JSON、CSV 或 TSV 词表文件。');
      prepare(await file.text(), extension as 'json' | 'csv' | 'tsv', file.name);
    } catch (error) { setError(errorMessage(error)); }
    finally { setReading(false); }
  }
  function confirmImport() {
    if (!pending) return;
    try {
      const merged = mergeGlossaryEntries(entries, pending.entries);
      onChange(merged); setPage(0); setQuery('');
      setMessage(`已合并：新增 ${added} 条，覆盖 ${pending.entries.length - added} 条。请保存设置后重新翻译。`);
      setPending(undefined); setError('');
    } catch (error) { setError(errorMessage(error)); }
  }
  function commitDraft() {
    if (!draft) return;
    const parsed = glossaryEntrySchema.safeParse(draft);
    if (!parsed.success) { setError(parsed.error.issues.map(issue => issue.message).join('；')); return; }
    try {
      const current = editKey ? entries.filter(entry => glossaryKey(entry) !== editKey) : entries;
      onChange(mergeGlossaryEntries(current, [parsed.data]));
      setDraft(undefined); setEditKey(undefined); setError('');
      setMessage('词条已添加或更新。请保存设置后重新翻译。');
    } catch (error) { setError(errorMessage(error)); }
  }
  function exportJson() {
    const blob = new Blob([JSON.stringify(entries, null, 2) + '\n'], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = 'personal-glossary.en-zh.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <section className="card">
    <div className="section-title"><span className="step">03</span><div><h2>个人术语表</h2><p>导入文件、查看和修改词条。保存后用于网页正文、标题及选中翻译。</p></div></div>
    <label className="field">术语适用领域<select value={domain} onChange={event => onDomainChange(event.target.value as GlossaryEntry['domain'])}>
      {Object.entries(domains).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select></label>
    <p className="hint">所选领域和通用词条生效；同词同时命中时，所选领域优先。保留英文和固定译名会受到保护，代码和公式保持原样。</p>
    <label className="field">导入词表文件<input type="file" accept=".json,.csv,.tsv" disabled={reading} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (file) void readFile(file);
    }} /></label>
    <p className="hint">支持 JSON 数组或有表头的 CSV / TSV，最多 {maxFileMiB} MiB、{MAX_GLOSSARY_ENTRIES.toLocaleString('en-US')} 个词条。重复键按原词（忽略大小写和首尾空格）＋领域判断，后面的覆盖前面的；文件中未出现的词条继续保留。</p>
    {reading && <p role="status">正在读取词表…</p>}
    <details><summary>从表格粘贴批量导入</summary>
      <label className="field">批量词条<textarea rows={6} value={paste} onChange={event => setPaste(event.target.value)} placeholder={'source\ttarget\tpolicy\tdomain\nharness\t\tkeep\tmachine-learning'} /></label>
      <p className="hint">表头包含 source、target。policy 和 domain 可省略：有译文默认固定翻译，无译文默认保留英文，领域默认通用。</p>
      <button type="button" disabled={!paste.trim()} onClick={() => prepare(paste, /^[\s\uFEFF]*[\[{]/.test(paste) ? 'json' : paste.split(/\r?\n/)[0].includes('\t') ? 'tsv' : 'csv', '粘贴内容')}>预览粘贴词表</button>
    </details>
    {pending && <div className="glossary-preview" role="status">
      <p>{pending.name}：{pending.entries.length} 个不同词条，新增 {added} 条，覆盖 {pending.entries.length - added} 条。</p>
      <p className="hint">文件内部有重复键时也采用最后一条。</p>
      <div className="glossary-actions"><button type="button" onClick={confirmImport}>确认合并词表</button><button type="button" onClick={() => setPending(undefined)}>取消导入</button></div>
    </div>}
    {error && <p role="alert" className="error">{error}</p>}
    {message && <p role="status" className="success">{message}</p>}
    <div className="glossary-actions"><button type="button" onClick={() => { setDraft(blank()); setEditKey(undefined); setError(''); }}>添加术语</button><button type="button" disabled={!entries.length} onClick={exportJson}>导出 JSON 词表</button></div>
    {draft && <div className="glossary-draft">
      <div className="field-grid"><label className="field">术语原词<input value={draft.source} onChange={event => patch({ source: event.target.value })} /></label><label className="field">术语译文<input value={draft.target} onChange={event => patch({ target: event.target.value })} /></label></div>
      <div className="field-grid"><label className="field">术语策略<select value={draft.policy} onChange={event => patch({ policy: event.target.value as GlossaryEntry['policy'] })}>{Object.entries(policies).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="field">词条领域<select value={draft.domain} onChange={event => patch({ domain: event.target.value as GlossaryEntry['domain'] })}>{Object.entries(domains).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
      <div className="glossary-actions"><button type="button" onClick={commitDraft}>添加或更新词条</button><button type="button" onClick={() => { setDraft(undefined); setEditKey(undefined); setError(''); }}>取消编辑</button></div>
    </div>}
    <label className="field">搜索术语<input type="search" placeholder="搜索英文原词或中文译文" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
    <p className="hint">当前共 {entries.length} 条，匹配 {filtered.length} 条。导入和编辑结果会显示在下面，点击页面底部“保存设置”后生效。</p>
    {filtered.length ? <><div className="table-scroll"><table className="glossary-table"><thead><tr><th>原词</th><th>译文 / 释义</th><th>策略</th><th>领域</th><th>操作</th></tr></thead><tbody>
      {filtered.slice(currentPage * 50, currentPage * 50 + 50).map(entry => <tr key={glossaryKey(entry)}><td>{entry.source}</td><td>{entry.target || '—'}</td><td>{policies[entry.policy]}</td><td>{domains[entry.domain]}</td>
        <td><div className="glossary-actions"><button type="button" onClick={() => { setDraft({ ...entry }); setEditKey(glossaryKey(entry)); setError(''); }}>编辑</button><button type="button" onClick={() => onChange(entries.filter(term => glossaryKey(term) !== glossaryKey(entry)))}>删除</button></div></td></tr>)}
    </tbody></table></div>
    <div className="row"><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><span className="hint">第 {currentPage + 1} / {pageCount} 页</span><button type="button" disabled={currentPage + 1 === pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button></div></> : <div className="empty-state">{entries.length ? '没有匹配的词条。' : '还没有个人术语，可以导入词表文件或手工添加。'}</div>}
  </section>;
}
