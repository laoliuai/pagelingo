import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createWebJobRequestSchema, webJobListSchema, webJobSchema, type CreateWebJobRequest, type WebReaderDescriptor, type ProviderProfile, type GlossaryRevision, type WebJob } from '@pagelingo/document-contracts';
import { useSession } from '../../app/session';
import { apiRequest, apiSessionSignal, errorMessage } from '../../shared/api-client';
import { Button } from '../../shared/ui/button';
const statusLabels: Record<WebJob['status'], string> = { queued: '排队中', running: '进行中', 'paused-config': '等待配置确认', partial: '部分完成', completed: '已完成', failed: '失败', cancelled: '已取消' };
export function WebJobStatus({ documentId, descriptor, selection = [], selectionMode = false, onSelectionMode, onPublished }: { documentId: string; descriptor?: WebReaderDescriptor; selection?: string[]; selectionMode?: boolean; onSelectionMode?: (value: boolean) => void; onPublished?: (id: string) => void }) {
  const { user } = useSession(); const cache = useQueryClient(); const [language, setLanguage] = useState(''); const [pending, setPending] = useState(false), [error, setError] = useState('');
  const [followUntil, setFollowUntil] = useState(0), [chosen, setChosen] = useState<string>();
  const scope = useRef(new AbortController());
  const attempt = useRef<CreateWebJobRequest | undefined>(undefined);
  const [canRetryStart, setCanRetryStart] = useState(false);
  const inputScope = JSON.stringify([user!.id, documentId, descriptor?.source.sourceVersionId, descriptor?.parseId, language.trim().toLowerCase(), [...selection].sort()]);
  useEffect(() => {
    scope.current.abort(); scope.current = new AbortController();
    attempt.current = undefined; setCanRetryStart(false); setPending(false); setError('');
    return () => scope.current.abort();
  }, [inputScope]);
  useEffect(() => { setChosen(undefined); }, [user!.id, documentId, descriptor?.source.sourceVersionId, descriptor?.parseId]);
  const filter = descriptor ? `?sourceVersionId=${descriptor.source.sourceVersionId}&parseId=${descriptor.parseId}` : '';
  const list = useQuery({ queryKey: [user!.id, 'web-jobs', documentId, filter], queryFn: async ({ signal }) => webJobListSchema.parse(await apiRequest(`/api/v1/documents/${documentId}/web-jobs${filter}`, { signal })), refetchInterval: query => Date.now() < followUntil || query.state.data?.items.some(job => ['queued', 'running'].includes(job.status)) ? 1500 : false });
  const id = chosen ?? list.data?.items[0]?.id;
  const job = useQuery({ queryKey: [user!.id, 'web-job', id], enabled: !!id, queryFn: async ({ signal }) => webJobSchema.parse(await apiRequest(`/api/v1/web-jobs/${id}`, { signal })), refetchInterval: query => Date.now() < followUntil || ['queued', 'running'].includes(query.state.data?.status ?? '') ? 1500 : false });
  const published = job.data?.readerVersionId;
  useEffect(() => { if (published && published !== descriptor?.versionId) onPublished?.(published); }, [published, descriptor?.versionId, onPublished]);
  async function act(action: 'start' | 'retry-start' | 'cancel' | 'retry') {
    if (pending) return; setPending(true); setError('');
    const signal = AbortSignal.any([scope.current.signal, apiSessionSignal()]);
    try {
      let result: WebJob;
      if (action === 'start' || action === 'retry-start') {
        if (!descriptor) return;
        if (action === 'start') {
          attempt.current = undefined; setCanRetryStart(false);
          const [profile, glossary] = await Promise.all([
            apiRequest<ProviderProfile>('/api/v1/settings/provider', { signal }),
            apiRequest<GlossaryRevision>('/api/v1/settings/glossary', { signal }),
          ]);
          signal.throwIfAborted();
          const input = createWebJobRequestSchema.safeParse({
            requestId: crypto.randomUUID(), sourceVersionId: descriptor.source.sourceVersionId,
            parseId: descriptor.parseId, profileRevision: profile.revision, glossaryRevision: glossary.revision,
            ...(language.trim() ? { sourceLanguage: language.trim() } : {}),
            ...(selection.length ? { selectionBlockIds: selection } : {}),
          });
          if (!input.success) throw Error('请填写明确的源语言代码，如 en、ja、fr；所选段落必须属于此版本。');
          attempt.current = input.data;
        }
        if (!attempt.current) return;
        result = webJobSchema.parse(await apiRequest(`/api/v1/documents/${documentId}/web-jobs`, { method: 'POST', body: attempt.current, signal }));
        signal.throwIfAborted();
        attempt.current = undefined; setCanRetryStart(false);
      } else {
        if (!job.data) return;
        result = webJobSchema.parse(await apiRequest(`/api/v1/web-jobs/${job.data.id}/${action}`, { method: 'POST', body: action === 'cancel' ? {} : { profileRevision: job.data.profileRevision ?? 0, glossaryRevision: job.data.glossaryRevision ?? 0 }, signal }));
      }
      signal.throwIfAborted(); cache.setQueryData([user!.id, 'web-job', result.id], result); setChosen(result.id); setFollowUntil(Date.now() + 15000);
      await list.refetch();
    } catch (error) {
      if (!signal.aborted) {
        setCanRetryStart(!!attempt.current);
        setError(error instanceof Error && !(error as { code?: string }).code ? error.message : errorMessage(error));
      }
    }
    finally { if (!signal.aborted) setPending(false); }
  }
  return <details className="reader-settings web-jobs"><summary>翻译任务</summary><p>任务状态与保存、来源完整性、当前译文分别记录。打开与恢复阅读不会启动模型请求。</p>
    <div aria-label="任务状态">{job.data ? `${job.data.kind === 'fetch-link' ? '获取原文' : '翻译'} · ${statusLabels[job.data.status]} · ${job.data.completedUnits}/${job.data.totalUnits}` : list.isPending ? '正在查询任务…' : '暂无任务'}</div>
    {list.data && list.data.items.length > 1 && <label>已有任务 <select value={id} onChange={event => setChosen(event.target.value)}>{list.data.items.map(item => <option value={item.id} key={item.id}>{item.createdAt.slice(0,19)} · {statusLabels[item.status]}</option>)}</select></label>}
    {descriptor && <>
      <Button aria-pressed={selectionMode} onClick={() => onSelectionMode?.(!selectionMode)}>
        {selectionMode ? '结束段落选择' : '选择翻译段落'}
      </Button>
      <label>源语言 <input aria-label="源语言" placeholder={`${descriptor.index.language.sourceLanguage ?? 'en / ja / fr'}（不确定时必填）`} maxLength={63} value={language} onChange={event => setLanguage(event.target.value)} /></label>
      <p>{selection.length ? `仅翻译已选 ${selection.length} 段` : '翻译整篇可翻译文本'}；按当前模型配置与术语表开始，可能产生费用。</p>
      <Button disabled={pending} onClick={() => void act('start')}>开始新一轮翻译</Button>
      <a href="/settings">模型配置</a>
    </>}
    {job.data && ['queued','running','paused-config','partial'].includes(job.data.status) && <Button disabled={pending} onClick={() => void act('cancel')}>取消任务</Button>}
    {canRetryStart && <Button disabled={pending} onClick={() => void act('retry-start')}>重试本次开始</Button>}
    {job.data && ['cancelled','failed','partial','paused-config'].includes(job.data.status) && <Button disabled={pending} onClick={() => void act('retry')}>按原配置重试</Button>}
    <Button onClick={() => { setFollowUntil(Date.now() + 15000); void list.refetch(); if (id) void job.refetch(); }}>刷新任务与成果</Button>
    {(error || job.data?.errorCode || list.error || job.error) && <p role="alert">{error || (job.data?.errorCode === 'PROFILE_CHANGED' ? '模型配置已变化。请确认当前配置并明确开始新一轮翻译，旧结果仍可阅读。' : job.data?.errorCode) || errorMessage(list.error ?? job.error)}</p>}
    {!!job.data?.warnings.length && <details><summary>任务警告</summary><ul>{job.data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    {job.data?.status === 'cancelled' && <p>任务已取消；已确认的部分译文可能稍后发布。可刷新成果，当前阅读版本保持不变。</p>}
  </details>;
}
