import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '../../app/session';
import { apiRequest, errorMessage } from '../../shared/api-client';
import { Button } from '../../shared/ui/button';
import { Input } from '../../shared/ui/input';
import { Modal } from '../../shared/ui/dialog';
import { Field } from '../../shared/ui/field';
import { useTaxonomy, type TaxonomyItem } from './use-taxonomy';
export function TaxonomyControls() {
  const [open, setOpen] = useState(false);
  return <Modal title="集合与标签" description="分类仅当前账号可见。删除分类只解除归类，保留所有资料。" open={open} onOpenChange={setOpen} trigger={<Button>管理集合与标签</Button>}><TaxonomyEditor kind="collections" /><TaxonomyEditor kind="tags" /></Modal>;
}
function TaxonomyEditor({ kind }: { kind: 'collections' | 'tags' }) {
  const { user } = useSession(); const cache = useQueryClient();
  const label = kind === 'collections' ? '集合' : '标签';
  const [name, setName] = useState(''); const [q, setQ] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const query = useTaxonomy(kind, q);
  async function write(method: string, id?: string, value?: string) {
    setBusy(true); setError('');
    try { await apiRequest(`/api/v1/${kind}${id ? `/${id}` : ''}`, { method, ...(value === undefined ? {} : { body: { name: value } }) });
      await cache.invalidateQueries({ queryKey: [user!.id] }); if (!id) setName('');
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <section className="taxonomy-editor"><h3>{label}</h3><form onSubmit={e => { e.preventDefault(); void write('POST', undefined, name); }}><Field label={`新${label}名称`}><Input maxLength={80} required value={name} onChange={e => setName(e.target.value)} /></Field><Button disabled={busy}>创建{label}</Button></form><Field label={`查找${label}`}><Input maxLength={80} value={q} onChange={e => setQ(e.target.value)} /></Field>{query.data?.pages.flatMap(p => p.items).map(item => <TaxonomyRow key={item.id} item={item} label={label} busy={busy} write={write} />)}{query.hasNextPage && <Button disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>加载更多{label}</Button>}{(error || query.error) && <p role="alert">{error || errorMessage(query.error)}</p>}</section>;
}
function TaxonomyRow({ item, label, busy, write }: { item: TaxonomyItem; label: string; busy: boolean; write: (method: string, id?: string, value?: string) => Promise<void> }) {
  const [name, setName] = useState(item.name);
  return <form className="taxonomy-row" onSubmit={e => { e.preventDefault(); void write('PATCH', item.id, name); }}><Input aria-label={`${label}名称 ${item.name}`} required maxLength={80} value={name} onChange={e => setName(e.target.value)} /><Button disabled={busy || name === item.name}>重命名</Button><Button type="button" disabled={busy} onClick={() => void write('DELETE', item.id)}>删除{label}</Button></form>;
}
