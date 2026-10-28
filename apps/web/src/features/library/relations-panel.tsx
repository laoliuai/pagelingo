import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { LibraryPage, DocumentSummary } from '@pagelingo/document-contracts';
import { useSession } from '../../app/session';
import { apiRequest, errorMessage } from '../../shared/api-client';
import { Field } from '../../shared/ui/field';
import { Input } from '../../shared/ui/input';
import { Button } from '../../shared/ui/button';
type Relation = { id: string; fromDocumentId: string; toDocumentId: string; kind: 'related' | 'discovered-from' };
export function RelationsPanel({ documentId }: { documentId: string }) {
  const { user, epoch } = useSession(); const [q, setQ] = useState(''); const [target, setTarget] = useState(''); const [kind, setKind] = useState<Relation['kind']>('related'); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const query = useInfiniteQuery({ queryKey: [user!.id, 'relations', documentId, epoch], initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => apiRequest<{ items: Relation[]; nextCursor: string | null }>(`/api/v1/documents/${documentId}/relations${pageParam ? `?cursor=${pageParam}` : ''}`, { signal }), getNextPageParam: p => p.nextCursor ?? undefined });
  const candidates = useQuery({ queryKey: [user!.id, 'relation-options', epoch, q], queryFn: ({ signal }) => apiRequest<LibraryPage>(`/api/v1/library?${new URLSearchParams({ q, pageSize: '20' })}`, { signal }) });
  async function write(method: string, relation: Omit<Relation, 'id'>) { setBusy(true); setError(''); try { await apiRequest('/api/v1/document-relations', { method, body: relation }); await query.refetch(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } }
  return <section className="relations-panel"><h3>关联资料</h3><p className="muted">选择自己已保存的资料。解除关联保留双方原文。</p>{query.data?.pages.flatMap(p => p.items).map(r => <div key={r.id} className="relation-row"><RelatedTitle id={r.toDocumentId === documentId ? r.fromDocumentId : r.toDocumentId} /><span>{r.kind === 'related' ? '相关资料' : '发现来源'}</span><Button disabled={busy} onClick={() => void write('DELETE', { fromDocumentId: r.fromDocumentId, toDocumentId: r.toDocumentId, kind: r.kind })}>解除关联</Button></div>)}{query.hasNextPage && <Button onClick={() => void query.fetchNextPage()}>更多关联</Button>}<Field label="查找已有资料"><Input maxLength={200} value={q} onChange={e => { setQ(e.target.value); setTarget(''); }} /></Field><Field label="关联目标"><select value={target} onChange={e => setTarget(e.target.value)}><option value="">请选择资料</option>{candidates.data?.items.filter(i => i.document.id !== documentId).map(i => <option key={i.document.id} value={i.document.id}>{i.organization.title}</option>)}</select></Field><Field label="关联方式"><select value={kind} onChange={e => setKind(e.target.value as typeof kind)}><option value="related">相关资料</option><option value="discovered-from">由该资料发现</option></select></Field><Button disabled={!target || busy} onClick={() => void write('POST', { fromDocumentId: documentId, toDocumentId: target, kind })}>添加关联</Button>{(error || query.error || candidates.error) && <p role="alert">{error || errorMessage(query.error ?? candidates.error)}</p>}</section>;
}
function RelatedTitle({ id }: { id: string }) { const { user, epoch } = useSession(); const q = useQuery({ queryKey: [user!.id,'relation-title',id,epoch], queryFn: ({ signal }) => apiRequest<DocumentSummary>(`/api/v1/documents/${id}`, { signal }) }); return <Link to={`/library/${id}`}>{q.data?.title ?? '查看关联资料'}</Link>; }
