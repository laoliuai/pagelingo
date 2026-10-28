import { useCallback, useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { sourceDetailsSchema, sourceVersionsSchema, type ArxivSourceRevision, type DocumentSummary, type SourceAssetInfo, type SourceRevision } from '@pagelingo/document-contracts';
import { useSession } from '../../app/session';
import { ApiError, apiRequest, errorMessage } from '../../shared/api-client';
import { Button } from '../../shared/ui/button';
import { BundleImportDialog } from './bundle-import-dialog';

type ImportRetention = (revision: ArxivSourceRevision, retained: boolean) => void;
export function RevisionMaterials({ document, revision, importDisabled, onImportRetained }: {
  document: DocumentSummary; revision: SourceRevision; importDisabled?: boolean; onImportRetained?: ImportRetention;
}) {
  const retained = useCallback((value: boolean) => {
    if (revision.kind === 'arxiv') onImportRetained?.(revision, value);
  }, [revision, onImportRetained]);
  const material = (asset: SourceAssetInfo, title: string) => <div key={asset.assetId}>
    <a href={`/api/v1/documents/${document.id}/source-assets/${asset.assetId}`} download>{title}</a>
    <p className="muted">{asset.filename} · {asset.bytes.toLocaleString()} 字节 · SHA256 <code>{asset.sha256}</code></p>
  </div>;
  return <div className="source-materials">
    {revision.kind === 'github' ? <>
      <p>{revision.repository.owner}/{revision.repository.name} · {revision.repository.description}</p>
      <p>固定 commit：<code>{revision.commitSha ?? '尚未取得'}</code></p>
      {revision.readme ? <>
        <p>README：{revision.readme.path} · blob <code>{revision.readme.blobSha}</code></p>
        {material(revision.readme.raw, '下载 README 原文')}
        {revision.readme.renderedHtml && material(revision.readme.renderedHtml, '下载 README HTML 附件')}
        {!revision.sourceVersionId && <p>已保存原始材料，阅读预览暂不可用。</p>}
      </> : <p>尚无 README 材料。</p>}
    </> : <>
      <p>arXiv {revision.baseId}v{revision.version}</p>
      <h4>{revision.title}</h4><p>{revision.authors.join('、')}</p><p>{revision.summary}</p>
      <p className="muted">发布：{revision.publishedAt} · 更新：{revision.updatedAt}</p>
      {revision.pdf && revision.sourceVersionId ? <>
        {material(revision.pdf, '下载所选版本 PDF')}
        <a href={`/api/v1/assets/${revision.pdf.assetId}/content`} target="_blank" rel="noopener noreferrer">打开所选版本原件</a>
        <BundleImportDialog targetDocument={document} targetRevision={revision} disabled={importDisabled} onRetainedChange={retained} onImported={() => {}} />
      </> : <p>仅保存元信息，尚无可读 PDF 原件。</p>}
    </>}
    <p className="muted">采集：{revision.capturedAt}</p>
  </div>;
}

export function SourceVersions({ document, disabled = false, onRetainedChange }: {
  document: DocumentSummary; disabled?: boolean; onRetainedChange?: (retained: boolean) => void;
}) {
  const { user, epoch } = useSession();
  const [selectedId, setSelectedId] = useState('');
  const [retainedRevision, setRetainedRevision] = useState<ArxivSourceRevision | null>(null);
  const retain = useCallback<ImportRetention>((revision, retained) => {
    setRetainedRevision(previous => retained ? revision : previous?.id === revision.id ? null : previous);
  }, []);
  useEffect(() => { onRetainedChange?.(retainedRevision !== null); }, [retainedRevision, onRetainedChange]);
  const locked = disabled || retainedRevision !== null;
  const query = useInfiniteQuery({
    queryKey: [user!.id, 'source-versions', document.id, epoch], initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => sourceVersionsSchema.parse(await apiRequest(`/api/v1/documents/${document.id}/source-versions${pageParam ? `?cursor=${pageParam}` : ''}`, { signal })),
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  const selected = retainedRevision ?? query.data?.pages.flatMap(page => page.items).find(item => item.id === selectedId);
  return <details className="source-versions"><summary>来源版本与材料</summary>
    <p className="muted">选择历史材料不会切换下方已打开的正文。阅读入口只列出此来源版本已验证的阅读包。</p>
    <label>来源版本 <select aria-label="来源版本" value={selectedId} disabled={locked} onChange={event => { if (!locked) setSelectedId(event.target.value); }}>
      <option value="">请选择来源版本</option>
      {query.data?.pages.flatMap(page => page.items).map(item => <option key={item.id} value={item.id}>{item.kind === 'arxiv' ? `v${item.version}` : item.commitSha?.slice(0, 12) ?? '仅元信息'} · {item.capturedAt}</option>)}
    </select></label>
    <Button disabled={locked} onClick={() => void query.refetch()}>刷新来源版本</Button>
    {query.hasNextPage && <Button onClick={() => void query.fetchNextPage()}>更多来源版本</Button>}
    {query.error && <p role="alert">{errorMessage(query.error)}<Button onClick={() => void query.refetch()}>重试来源版本</Button></p>}
    {selected && <section aria-label={retainedRevision ? '待确认的论文导入' : '所选历史来源'}>
      {retainedRevision && <p>本次导入继续使用已选择的论文原件；确认或取消后可切换来源版本。</p>}
      <RevisionMaterials document={document} revision={selected} importDisabled={disabled} onImportRetained={retain} />
      {!locked && <RevisionReaders key={selected.id} document={document} revision={selected} />}
    </section>}
  </details>;
}
function RevisionReaders({ document, revision }: { document: DocumentSummary; revision: SourceRevision }) {
  const { user, epoch } = useSession();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: [user!.id, 'source-readers', document.id, revision.id, epoch, page], enabled: open,
    queryFn: async ({ signal }) => {
      const path = revision.kind === 'arxiv' ? 'reader-versions' : 'web-reader/versions';
      const versions = await apiRequest<{ items: { id: string }[]; total: number }>(`/api/v1/documents/${document.id}/${path}?pageSize=20&page=${page}`, { signal });
      const checks = await Promise.all(versions.items.map(async item => {
        try {
          const details = sourceDetailsSchema.parse(await apiRequest(`/api/v1/documents/${document.id}/source-details?revisionId=${revision.id}&readerVersionId=${item.id}`, { signal }));
          return details.kind !== 'link' && details.current?.id === revision.id ? item.id : null;
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        }
      }));
      return { items: checks.filter((id): id is string => id !== null), total: versions.total };
    },
  });
  return <div><Button onClick={() => setOpen(true)}>查找此来源的阅读版本</Button>
    {open && query.isPending && <p role="status">正在核对阅读版本…</p>}
    {query.data?.items.map((id, index) => <p key={id}><Link to={`/library/${document.id}?versionId=${id}&sourceRevisionId=${revision.id}`}>阅读已验证版本 {index + 1}</Link></p>)}
    {query.data && !query.data.items.length && <p>本组尚无匹配的阅读包。</p>}
    {open && <><Button disabled={page === 1} onClick={() => setPage(value => value - 1)}>上一组阅读版本</Button><Button disabled={!query.data || page * 20 >= query.data.total} onClick={() => setPage(value => value + 1)}>下一组阅读版本</Button></>}
    {query.error && <p role="alert">{errorMessage(query.error)}</p>}
  </div>;
}
