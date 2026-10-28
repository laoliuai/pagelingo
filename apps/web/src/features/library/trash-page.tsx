import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '../../app/session';
import { apiRequest, errorMessage } from '../../shared/api-client';
import { PageHeader } from '../../shared/layouts/page-header';
import { Button } from '../../shared/ui/button';
import { Confirm } from '../../shared/ui/alert-dialog';
type TrashItem = { documentId: string; title: string; lifecycleEpoch: number; deletedAt: string; purgeAfter: string; status: 'retained' | 'processing' };
type Receipt = { id: string; documentId: string; status: 'processing' | 'completed' };
export function TrashPage() {
  const { user, epoch } = useSession(); const cache = useQueryClient(); const [error, setError] = useState(''); const [busy, setBusy] = useState(''); const [receipts, setReceipts] = useState<Record<string,Receipt & {title?:string}>>({});
  const query = useInfiniteQuery({ queryKey: [user!.id, 'trash', epoch], initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => apiRequest<{items:TrashItem[];nextCursor:string|null}>(`/api/v1/trash${pageParam ? `?cursor=${pageParam}` : ''}`, {signal}), getNextPageParam: p => p.nextCursor ?? undefined });
  async function restore(item: TrashItem) { setBusy(item.documentId); setError(''); try { await apiRequest(`/api/v1/documents/${item.documentId}/restore`, {method:'POST',body:{expectedEpoch:item.lifecycleEpoch}}); await cache.invalidateQueries({queryKey:[user!.id,'documents']}); await query.refetch(); } catch(e) { setError(`恢复未完成：${errorMessage(e)}`); await query.refetch(); } finally {setBusy('');} }
  async function purge(id: string) { const r=await apiRequest<Receipt>(`/api/v1/trash/${id}`, {method:'DELETE'}); setReceipts(previous=>({...previous,[id]:{...r,title:items.find(item=>item.documentId===id)?.title}})); await query.refetch(); }
  const items=query.data?.pages.flatMap(p=>p.items) ?? [];
  return <section><Link to="/library">返回资料库</Link><PageHeader title="回收站" description="资料保留 30 天。恢复会核对原件是否仍可用；永久删除后无法恢复。" />{query.isPending && <p role="status">正在加载回收站…</p>}{(error || query.error) && <p role="alert">{error || errorMessage(query.error)}<Button onClick={()=>void query.refetch()}>重试加载回收站</Button></p>}{items.map(item=><article className="trash-item" key={item.documentId}><div><h2>{item.title}</h2><p className="muted">删除于 {item.deletedAt.slice(0,10)} · 保留至 {item.purgeAfter.slice(0,10)}</p></div>{receipts[item.documentId] ? null : item.status==='processing' ? <ReceiptStatus documentId={item.documentId} /> : <div className="form-actions"><Button disabled={!!busy} onClick={()=>void restore(item)}>恢复</Button><Confirm trigger={<Button>永久删除</Button>} title="永久删除这份资料？" description="原件、阅读内容及收藏信息将被永久清理，无法恢复。其他资料仍会保留。" action="确认永久删除" onConfirm={()=>purge(item.documentId)} /></div>}</article>)}{Object.values(receipts).map(receipt=><ReceiptStatus key={receipt.id} documentId={receipt.documentId} initial={receipt} title={receipt.title} />)}{!query.isPending && !items.length && !Object.keys(receipts).length && <p>回收站为空。</p>}{query.hasNextPage && <Button onClick={()=>void query.fetchNextPage()}>更多回收站资料</Button>}</section>;
}
function ReceiptStatus({documentId,initial,title}:{documentId:string;initial?:Receipt;title?:string}) { const {user,epoch}=useSession(); const q=useQuery({queryKey:[user!.id,'purge-receipt',documentId,epoch],initialData:initial,queryFn:({signal})=>apiRequest<Receipt>(`/api/v1/trash/${documentId}/receipt`,{signal}),refetchInterval:q=>q.state.data?.status==='completed'?false:1000});return <p role="status">{title && <strong>{title}：</strong>}<span>{q.data?.status==='completed'?'已永久删除':'正在永久清理'}</span>{q.error && '（暂时无法确认进度，稍后重试）'}</p>; }
