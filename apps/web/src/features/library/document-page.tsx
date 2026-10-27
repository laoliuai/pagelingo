import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { DocumentSummary, ReaderDescriptor } from '@pagelingo/document-contracts';
import { useSession } from '../../app/session';
import { ApiError, apiRequest, errorMessage } from '../../shared/api-client';
import { PageHeader } from '../../shared/layouts/page-header';
import { Button } from '../../shared/ui/button';
import { Feedback } from '../../shared/ui/toast';
import { BundleImportDialog } from './bundle-import-dialog';
import { ReaderStatus } from './import-status';
import { PdfSource } from './pdf-source';
export function DocumentPage() {
  const { id } = useParams();
  const { user } = useSession();
  const query = useQuery({
    queryKey: [user!.id, 'document', id],
    queryFn: ({ signal }) =>
      apiRequest<DocumentSummary>(`/api/v1/documents/${encodeURIComponent(id!)}`, { signal }),
  });
  const reader = useQuery({
    queryKey: [user!.id, 'reader-status', id, query.data?.reader?.versionId],
    enabled: !!query.data?.reader,
    queryFn: ({ signal }) => apiRequest<ReaderDescriptor>(`/api/v1/documents/${encodeURIComponent(id!)}/reader?versionId=${query.data!.reader!.versionId}`, { signal }),
  });
  return (
    <section className="document-page">
      <Link className="back-link" to="/library">
        ← 返回资料库
      </Link>
      {query.isPending && <p role="status">正在加载资料…</p>}
      <Feedback
        message={
          query.error
            ? query.error instanceof ApiError && query.error.status === 404
              ? '资料不存在或当前账号无权读取。'
              : errorMessage(query.error)
            : ''
        }
        error
      />
      {query.isError && <Button onClick={() => void query.refetch()}>重试加载</Button>}
      {query.data && (
        <>
          <PageHeader
            title={query.data.title}
            description={query.data.reader ? 'PDF 原件 · 原文已保存 · 阅读包已导入' : 'PDF 原件 · 原文已保存 · 等待本地处理'}
            action={<BundleImportDialog targetDocument={query.data} onImported={() => {}} />}
          />
          {query.data.reader && <ReaderStatus reader={reader.data ?? query.data.reader} />}
          {reader.isError && <Feedback message="暂时无法读取阅读包详情，请刷新后查看。" error />}
          <PdfSource
            key={query.data.id}
            sourceUrl={`/api/v1/documents/${query.data.id}/source`}
            title={query.data.title}
          />
        </>
      )}
    </section>
  );
}
