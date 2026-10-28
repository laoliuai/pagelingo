import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { LibraryPage as LibraryResult } from '@pagelingo/document-contracts';
import { useSession } from '../../app/session';
import { apiRequest, errorMessage } from '../../shared/api-client';
import { PageHeader } from '../../shared/layouts/page-header';
import { Button } from '../../shared/ui/button';
import { LibraryFilters } from './library-filters';
import { TaxonomyControls } from './taxonomy-controls';
import { Feedback } from '../../shared/ui/toast';
import { DocumentRow } from './document-row';
import { BundleImportDialog } from './bundle-import-dialog';
import { LinkDialog } from './link-dialog';
import { UploadDialog } from './upload-dialog';
export function LibraryPage() {
  const { user, epoch } = useSession();
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').slice(0, 200);
  const rawPage = Number(params.get('page') ?? 1);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const query = useQuery({
    queryKey: [user!.id, 'documents', epoch, params.toString()],
    queryFn: ({ signal }) =>
      apiRequest<LibraryResult>(
        `/api/v1/library?${params}`,
        { signal },
      ),
  });
  return (
    <section className="library-page">
      <PageHeader
        title="资料库"
        description="保存值得阅读的资料，慢慢理解。仅当前账号可见。"
        action={<div className="library-actions"><LinkDialog /><BundleImportDialog onImported={() => {}} /><UploadDialog /></div>}
      />
      <div className="library-management-actions"><TaxonomyControls /><Link to="/trash">回收站</Link></div>
      <LibraryFilters key={params.toString()} params={params} apply={setParams} />
      {query.isPending && <p role="status">正在加载资料…</p>}
      <Feedback message={query.error ? errorMessage(query.error) : ''} error />
      {query.isError && <Button onClick={() => void query.refetch()}>重试加载</Button>}
      {query.data && (
        <>
          <div className="library-summary">
            <span>全部资料</span>
            <span>共 {query.data.total} 份资料</span>
          </div>
          {query.data.items.length ? (
            <div className="document-list">
              {query.data.items.map(({ document, organization }) => (
                <div key={document.id}><DocumentRow document={{ ...document, title: organization.title }} /><p className="organization-summary">{({unread: '未读', reading: '在读', read: '已读'})[organization.readingStatus]}</p></div>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <h2>{q ? '没有匹配的资料' : '还没有资料'}</h2>
              <p>{q ? '试试其他标题关键词。' : '添加网页链接、上传 PDF 或导入阅读包，开始你的阅读。'}</p>
            </div>
          )}
          <div className="pagination" aria-label="资料分页">
            <Button
              disabled={page <= 1}
              onClick={() => setParams(previous => { const next = new URLSearchParams(previous); next.set('page', String(page - 1)); return next; })}
            >
              上一页
            </Button>
            <span>第 {query.data.page} 页</span>
            <Button
              disabled={page * query.data.pageSize >= query.data.total}
              onClick={() => setParams(previous => { const next = new URLSearchParams(previous); next.set('page', String(page + 1)); return next; })}
            >
              下一页
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
