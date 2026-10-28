import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { sourceDetailsSchema, type ArxivSourceRevision, type SourceRevision, type DocumentSummary } from '@pagelingo/document-contracts';
import { useSession } from '../../app/session';
import { ApiError, apiRequest, errorMessage } from '../../shared/api-client';
import { Button } from '../../shared/ui/button';
import { SourceRefresh } from './source-refresh';
import { RevisionMaterials, SourceVersions } from './source-versions';
const statuses = { 'link-only': '链接已保存', 'metadata-saved': '元信息已保存', 'source-saved': '来源原件已保存', 'partial-resources': '来源已保存，部分资源缺失', 'fetch-failed': '来源获取失败' };
const warningText = (warning: string) => {
  if (warning.startsWith('SOURCE_READER_REVISION_')) return '此阅读版本对应多个来源版本或缺少来源关联。请在来源版本中明确选择已验证的阅读入口。';
  if (warning === 'SOURCE_PREVIEW_UNAVAILABLE') return '已保存原始材料，阅读预览暂不可用。';
  if (/^[A-Z][A-Z0-9_]+$/.test(warning)) return '部分来源材料未能取得，已保存内容仍可使用。';
  return warning;
};
const jobStatuses: Record<string, string> = { queued: '等待获取', running: '正在获取', completed: '已完成', failed: '获取失败', cancelled: '已取消', partial: '部分完成' };
export function SourceDetails({ document, readerVersionId, revisionId, historical = false }: { document: DocumentSummary; readerVersionId?: string; revisionId?: string; historical?: boolean }) {
  const { user, epoch } = useSession();
  const [retainedRevision, setRetainedRevision] = useState<ArxivSourceRevision | null>(null);
  const [historyRetained, setHistoryRetained] = useState(false);
  const retain = useCallback((revision: ArxivSourceRevision, retained: boolean) => {
    setRetainedRevision(previous => retained ? revision : previous?.id === revision.id ? null : previous);
  }, []);
  const query = useQuery({
    queryKey: [user!.id, 'source-details', document.id, readerVersionId, revisionId, historical, epoch],
    queryFn: async ({ signal }) => {
      const path = `/api/v1/documents/${document.id}/source-details`;
      const read = async (suffix = '') => sourceDetailsSchema.parse(await apiRequest(`${path}${suffix}`, { signal }));
      if (!readerVersionId) return read(revisionId ? `?revisionId=${revisionId}` : '');
      if (revisionId) return read(`?readerVersionId=${readerVersionId}&revisionId=${revisionId}`);
      if (historical) return read(`?readerVersionId=${readerVersionId}`);
      const current = await read();
      if (current.kind === 'link') return current;
      if (current.current) {
        try { return await read(`?readerVersionId=${readerVersionId}&revisionId=${current.current.id}`); }
        catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
      }
      return read(`?readerVersionId=${readerVersionId}`);
    },
  });
  const data = query.data;
  const current = data && data.kind !== 'link' ? data.current : null;
  const materials: SourceRevision[] = current ? [current] : [];
  if (retainedRevision && !materials.some(revision => revision.id === retainedRevision.id)) materials.push(retainedRevision);
  const kind = document.kind === 'paper' ? 'arxiv' : document.kind === 'repository' ? 'github' : null;
  return <section className="source-details" aria-label="来源详情">
    <h3>来源详情{readerVersionId ? ' · 当前打开的阅读版本' : ''}</h3>
    {query.isPending && <p role="status">正在读取来源信息…</p>}
    {query.error && <p role="alert">来源与阅读版本不匹配或暂不可用。{errorMessage(query.error)}</p>}
    {data && <>
      <p>{statuses[data.status]} · <a href={data.url} target="_blank" rel="noopener noreferrer">来源网站</a></p>
      {data.resolution !== 'self' && <p role="status">{data.resolution === 'alias' ? '这份链接已有保存的资料。' : '此来源已有资料；本条目的标题、备注与分类保持独立，请自行核对。'}{data.canonicalDocumentId && <Link to={`/library/${data.canonicalDocumentId}`}>查看本人已保存资料</Link>}</p>}
      {data.warnings.length > 0 && <ul>{data.warnings.map((warning, index) => <li key={index}>{warningText(warning)}</li>)}</ul>}
      {data.latestAttempt && <div aria-label="最近来源请求"><h4>最近来源请求</h4><p>{jobStatuses[data.latestAttempt.status] ?? '处理中'} · {data.latestAttempt.requestedRef ?? '默认版本'}{data.latestAttempt.errorCode && ' · 未取得新来源，已保存材料仍可使用。'}</p></div>}
    </>}
    {materials.map(revision => <section key={revision.id} aria-label={retainedRevision?.id === revision.id ? '待确认的论文导入' : '来源版本材料'}>
      {retainedRevision?.id === revision.id && <p>本次导入继续使用已选择的固定论文原件；来源更新或阅读版本切换不会改变此导入目标。</p>}
      <RevisionMaterials document={document} revision={revision}
        importDisabled={historyRetained || !!retainedRevision && retainedRevision.id !== revision.id}
        onImportRetained={retain} />
    </section>)}
    {kind && <>
      <div hidden={!data || data.kind === 'link' || data.resolution !== 'self'}>
        <SourceRefresh documentId={document.id} kind={kind} onAccepted={async () => { await query.refetch(); }} />
      </div>
      <SourceVersions document={document} disabled={retainedRevision !== null} onRetainedChange={setHistoryRetained} />
    </>}
    <Button onClick={() => void query.refetch()}>刷新来源状态</Button>
  </section>;
}
