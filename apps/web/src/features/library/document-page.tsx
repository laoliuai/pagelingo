import { lazy, Suspense, useRef, useState } from 'react';
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
import { SourceDetails } from './source-details';
import { PdfSource } from './pdf-source';
const ReaderPage = lazy(() => import('../reader/reader-page').then(module => ({ default: module.ReaderPage })));
const WebReaderPage = lazy(() => import('../web-reader/web-reader-page').then(module => ({ default: module.WebReaderPage })));
export function DocumentPage() {
  const { user, epoch } = useSession();
  const { id } = useParams();
  return <DocumentScope key={`${user?.id}:${epoch}:${id}`} />;
}
function DocumentScope() {
  const { id } = useParams();
  const [search, setSearch] = useSearchParams();
  const { user, epoch } = useSession();
  const query = useQuery({
    queryKey: [user!.id, 'document', id, epoch],
    queryFn: ({ signal }) => apiRequest<DocumentSummary>(`/api/v1/documents/${encodeURIComponent(id!)}`, { signal }),
  });
  // Refreshing the mutable document head must not replace the already-opened Reader.
  const [pinnedReader, setPinnedReader] = useState<string>();
  const [versionError, setVersionError] = useState('');
  const selection = useRef(0);
  async function selectPdfVersion(versionId?: string) {
    const sequence = ++selection.current;
    setVersionError('');
    if (versionId) { setSearch({ versionId }); return; }
    try {
      const current = await query.refetch({ throwOnError: true });
      if (sequence !== selection.current) return;
      setPinnedReader(current.data?.reader?.versionId);
      setSearch({});
    } catch (error) {
      if (sequence === selection.current) setVersionError(errorMessage(error));
    }
  }
  if (query.data?.reader && !pinnedReader) setPinnedReader(query.data.reader.versionId);
  const openedVersion = search.get('versionId') ?? pinnedReader;
  const document = query.data;
  return <section className="document-page">
    <Link className="back-link" to="/library">← 返回资料库</Link>
    {query.isPending && <p role="status">正在加载资料…</p>}
    <Feedback message={query.error
      ? query.error instanceof ApiError && query.error.status === 404
        ? '资料不存在或当前账号无权读取。' : errorMessage(query.error)
      : ''} error />
    <Feedback message={versionError} error />
    {query.isError && <Button onClick={() => void query.refetch()}>重试加载</Button>}
    {document && <OrganizationPanel documentId={document.id}>
      {document.kind !== 'pdf' && <SourceDetails document={document}
        readerVersionId={openedVersion} historical={search.has('versionId')}
        revisionId={search.get('sourceRevisionId') ?? undefined} />}
    </OrganizationPanel>}
    {document && !isPdfReadableDocument(document) && <>
      <PageHeader title={document.title}
        description={`${webSaveLabel(document.saveStatus)} · ${webProcessingLabel(document.processingStatus)}`}
        action={<a href={document.url} target="_blank" rel="noopener noreferrer">打开原网站</a>} />
      {document.reader ? <Suspense fallback={<p>正在加载阅读器…</p>}>
        <WebReaderPage key={document.id} document={document} versionId={openedVersion} />
      </Suspense> : <>
        {document.kind !== 'repository' && document.kind !== 'paper' && <WebJobStatus documentId={document.id} />}
        <Button onClick={() => void query.refetch()}>刷新归档状态</Button>
        <p>{document.kind === 'repository' || document.kind === 'paper'
          ? '打开“管理资料”查看固定来源、已保存材料与更新操作。'
          : '尚无归档正文。可使用浏览器扩展保存当前网页。'}</p>
      </>}
    </>}
    {document && isPdfReadableDocument(document) && <>
      <PageHeader title={document.title}
        description={openedVersion ? 'PDF 阅读版本 · 原件按所选阅读包固定' : 'PDF 原件 · 原文已保存 · 等待本地处理'}
        action={document.kind === 'pdf' ? <BundleImportDialog targetDocument={document} onImported={() => {}} /> : undefined} />
      {openedVersion ? <Suspense fallback={<p role="status">正在加载阅读器…</p>}>
        <ReaderPage documentId={document.id} versionId={openedVersion} onVersionSelect={versionId => void selectPdfVersion(versionId)} />
      </Suspense> : <PdfSource key={document.id} sourceUrl={`/api/v1/documents/${document.id}/source`} title={document.title} />}
    </>}
  </section>;
}
