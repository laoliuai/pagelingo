import { FileText } from 'lucide-react';
import { Link } from 'react-router-dom';
import { readingProgressSchema, type DocumentSummary } from '@pagelingo/document-contracts';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '../../app/session';
import { apiRequest } from '../../shared/api-client';
import { translationLabel } from './import-status';
import { Badge } from '../../shared/ui/badge';
export function DocumentRow({ document }: { document: DocumentSummary }) {
  const { user, epoch } = useSession();
  const progress = useQuery({ queryKey: [user!.id, 'reading-progress', document.id, epoch],
    queryFn: async ({ signal }) => { const value = await apiRequest(`/api/v1/documents/${document.id}/progress`, { signal }); return value === null ? null : readingProgressSchema.parse(value); },
    enabled: document.kind === 'pdf' && !!document.reader, gcTime: 0 });
  if (document.kind !== 'pdf') return null;
  return (
    <article className="document-row">
      <div className="source-icon">
        <FileText size={20} aria-hidden="true" />
      </div>
      <div className="document-info">
        <h2>
          <Link to={`/library/${document.id}`}>{document.title}</Link>
        </h2>
        <p className="muted">{document.originalFilename}</p>
        <div className="document-meta">
          <span>PDF</span>
          <span>
            {new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(
              document.source.bytes / 1024,
            )}{' '}
            KB
          </span>
          <span>{document.reader ? translationLabel(document.reader.translationStatus) : '等待本地处理'}</span>
          {document.reader?.parseCoverage === 'partial' && <span>解析不完整</span>}
        </div>
      </div>
      <div className="document-status">
        <Badge active>原文已保存</Badge>
        {progress.data && <Link to={`/library/${document.id}?versionId=${progress.data.position.readerVersionId}`}>继续上次阅读</Link>}
        <time dateTime={document.createdAt}>{document.createdAt.slice(0, 10)}</time>
      </div>
    </article>
  );
}
