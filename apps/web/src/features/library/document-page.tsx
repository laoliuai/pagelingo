import { lazy, Suspense } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { isPdfReadableDocument, type DocumentSummary } from '@pagelingo/document-contracts';
import { useSession } from '../../app/session';
import { ApiError, apiRequest, errorMessage } from '../../shared/api-client';
import { PageHeader } from '../../shared/layouts/page-header';
import { Button } from '../../shared/ui/button';
import { Feedback } from '../../shared/ui/toast';
import { BundleImportDialog } from './bundle-import-dialog';
import { WebJobStatus } from '../web-reader/web-job-status';
import { webSaveLabel, webProcessingLabel } from './import-status';
import { OrganizationPanel } from './organization-panel';
import { PdfSource } from './pdf-source';
const ReaderPage = lazy(() => import('../reader/reader-page').then(module => ({ default: module.ReaderPage })));
const WebReaderPage = lazy(() => import('../web-reader/web-reader-page').then(module => ({ default: module.WebReaderPage })));
export function DocumentPage() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const { user, epoch } = useSession();
  const query = useQuery({
    queryKey: [user!.id, 'document', id, epoch],
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
      {query.data && <OrganizationPanel key={`${id}:${epoch}`} documentId={query.data.id} />}
      {query.data && !isPdfReadableDocument(query.data) && <><PageHeader title={query.data.title} description={`${webSaveLabel(query.data.saveStatus)} · ${webProcessingLabel(query.data.processingStatus)}`} action={<a href={query.data.url} target="_blank" rel="noopener noreferrer">打开原网站</a>} />{query.data.reader ? <Suspense fallback={<p>正在加载阅读器…</p>}><WebReaderPage key={query.data.id} document={query.data} versionId={search.get('versionId') ?? undefined} /></Suspense> : <><WebJobStatus documentId={query.data.id} /><Button onClick={() => void query.refetch()}>刷新归档状态</Button><p>尚无归档正文。可使用浏览器扩展保存当前网页。</p></>}</>}
      {query.data && isPdfReadableDocument(query.data) && (
        <>
          <PageHeader
            title={query.data.title}
            description={query.data.reader ? 'PDF 原件 · 原文已保存 · 阅读包已导入' : 'PDF 原件 · 原文已保存 · 等待本地处理'}
            action={<BundleImportDialog targetDocument={query.data} onImported={() => {}} />}
          />
          {query.data.reader ? <Suspense fallback={<p role="status">正在加载阅读器…</p>}><ReaderPage documentId={query.data.id} versionId={search.get('versionId') ?? query.data.reader.versionId} /></Suspense> : <PdfSource
            key={query.data.id}
            sourceUrl={`/api/v1/documents/${query.data.id}/source`}
            title={query.data.title}
          />}
        </>
      )}
    </section>
  );
}
