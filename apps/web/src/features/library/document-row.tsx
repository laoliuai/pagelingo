import { FileText } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { DocumentSummary } from '@pagelingo/document-contracts';
import { translationLabel } from './import-status';
import { Badge } from '../../shared/ui/badge';
export function DocumentRow({ document }: { document: DocumentSummary }) {
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
        <time dateTime={document.createdAt}>{document.createdAt.slice(0, 10)}</time>
      </div>
    </article>
  );
}
