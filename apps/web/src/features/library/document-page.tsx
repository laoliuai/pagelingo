import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { DocumentSummary } from '@pagelingo/document-contracts';
import { useSession } from '../../app/session';
import { ApiError, apiRequest, errorMessage } from '../../shared/api-client';
import { PageHeader } from '../../shared/layouts/page-header';
import { Button } from '../../shared/ui/button';
import { Feedback } from '../../shared/ui/toast';
import { PdfSource } from './pdf-source';
export function DocumentPage() {
  const { id } = useParams();
  const { user } = useSession();
  const query = useQuery({
    queryKey: [user!.id, 'document', id],
    queryFn: ({ signal }) =>
      apiRequest<DocumentSummary>(`/api/v1/documents/${encodeURIComponent(id!)}`, { signal }),
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
            description="PDF 原件 · 原文已保存 · 等待本地处理"
          />
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
